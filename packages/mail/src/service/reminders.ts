import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import type { CancelConversationReminder, SetConversationReminder } from "../contracts";
import { withShortIdDb } from "../lib/short-id";
import { requireMailboxAccess, requireVisibleConversation } from "./access";
import { type MailRequestContext, userBackedActor } from "./auth";
import { lockMailboxForCollaboration } from "./collaboration";
import { enqueueCollaborationNotifications } from "./notification-outbox";

type SqlClient = typeof sql;

type ReminderRow = {
  id: string;
  conversation_id: string;
  user_id: string;
  due_at: Date | string;
  state: ConversationReminder["state"];
  revision: string | number;
  created_at: Date | string;
  updated_at: Date | string;
};

export type ConversationReminder = {
  id: string;
  conversationId: string;
  userId: string;
  dueAt: string;
  state: "pending" | "sent" | "canceled";
  revision: number;
  createdAt: string;
  updatedAt: string;
};

const toIso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();

const mapReminder = (row: ReminderRow): ConversationReminder => ({
  id: row.id,
  conversationId: row.conversation_id,
  userId: row.user_id,
  dueAt: toIso(row.due_at),
  state: row.state,
  revision: Number(row.revision),
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

const reminderColumns = sql`
  id,
  conversation_id,
  user_id,
  due_at,
  state,
  revision,
  created_at,
  updated_at
`;

const requireReminderUser = (context: MailRequestContext): Result<{ id: string }> => {
  const user = userBackedActor(context);
  return user ? ok(user) : fail(err.forbidden("Personal reminders require a user-backed actor"));
};

const lockConversationReminder = async (params: {
  db: SqlClient;
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
  userId: string;
}): Promise<Result<ReminderRow | null>> => {
  const allowed = await lockMailboxForCollaboration(params.context, params.mailboxId, "read", params.db);
  if (!allowed.ok) return allowed;
  const [conversation] = await params.db<{ id: string }[]>`
    SELECT id FROM mail.conversations
    WHERE id = ${params.conversationId}::uuid AND mailbox_id = ${params.mailboxId}::uuid
    FOR UPDATE
  `;
  if (!conversation) return fail(err.notFound("Conversation"));
  const [reminder] = await params.db<ReminderRow[]>`
    SELECT ${reminderColumns}
    FROM mail.conversation_reminders
    WHERE conversation_id = ${params.conversationId}::uuid AND user_id = ${params.userId}::uuid
    FOR UPDATE
  `;
  return ok(reminder ?? null);
};

const lockReminderDeliveryForMutation = async (db: SqlClient, reminderId: string, revision: number): Promise<Result<void>> => {
  const [delivery] = await db<{ state: "pending" | "sending" | "sent" | "skipped" }[]>`
    SELECT state
    FROM mail.collaboration_notification_deliveries
    WHERE kind = 'reminder'
      AND source_id = ${reminderId}::uuid
      AND source_revision = ${revision}
    FOR UPDATE
  `;
  return delivery?.state === "sending" ? fail(err.conflict("Reminder delivery has already started")) : ok();
};

export const getConversationReminder = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
}): Promise<Result<ConversationReminder | null>> => {
  const user = requireReminderUser(params.context);
  if (!user.ok) return user;
  const allowed = await requireMailboxAccess(params.context, params.mailboxId, "read");
  if (!allowed.ok) return allowed;
  const visible = await requireVisibleConversation(allowed.data, params.conversationId);
  if (!visible.ok) return visible;
  const [conversation] = await sql<{ id: string }[]>`
    SELECT id FROM mail.conversations
    WHERE id = ${params.conversationId}::uuid AND mailbox_id = ${params.mailboxId}::uuid
  `;
  if (!conversation) return fail(err.notFound("Conversation"));
  const [row] = await sql<ReminderRow[]>`
    SELECT ${reminderColumns}
    FROM mail.conversation_reminders
    WHERE conversation_id = ${params.conversationId}::uuid AND user_id = ${user.data.id}::uuid
  `;
  return ok(row ? mapReminder(row) : null);
};

export const setConversationReminder = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
  input: SetConversationReminder;
}): Promise<Result<ConversationReminder>> => {
  const user = requireReminderUser(params.context);
  if (!user.ok) return user;
  try {
    return await sql.begin(async (tx): Promise<Result<ConversationReminder>> => {
      const locked = await lockConversationReminder({
        db: tx,
        context: params.context,
        mailboxId: params.mailboxId,
        conversationId: params.conversationId,
        userId: user.data.id,
      });
      if (!locked.ok) return locked;
      const current = locked.data;
      if (params.input.expectedRevision === null && current) {
        return fail(err.conflict("Reminder already exists"));
      }
      if (params.input.expectedRevision !== null && Number(current?.revision ?? 0) !== params.input.expectedRevision) {
        return fail(err.conflict("Reminder was changed by another request"));
      }
      if (current) {
        const mutable = await lockReminderDeliveryForMutation(tx, current.id, Number(current.revision));
        if (!mutable.ok) return mutable;
      }

      const revision = current ? Number(current.revision) + 1 : 1;
      const [row] = current
        ? await tx<ReminderRow[]>`
            UPDATE mail.conversation_reminders
            SET due_at = ${params.input.dueAt}::timestamptz,
                state = 'pending',
                revision = ${revision},
                sent_at = NULL,
                canceled_at = NULL
            WHERE id = ${current.id}::uuid
            RETURNING ${reminderColumns}
          `
        : await withShortIdDb(
            tx,
            "reminder",
            (db, shortId) => db<ReminderRow[]>`
            INSERT INTO mail.conversation_reminders (short_id, mailbox_id, conversation_id, user_id, due_at)
            VALUES (
              ${shortId},
              ${params.mailboxId}::uuid,
              ${params.conversationId}::uuid,
              ${user.data.id}::uuid,
              ${params.input.dueAt}::timestamptz
            )
            RETURNING ${reminderColumns}
          `,
          );
      if (!row) return fail(err.internal("Reminder write returned no row"));
      await tx`
        UPDATE mail.collaboration_notification_deliveries
        SET state = 'skipped', claim_id = NULL, claimed_at = NULL, last_error = 'Reminder was rescheduled'
        WHERE kind = 'reminder'
          AND source_id = ${row.id}::uuid
          AND state IN ('pending', 'sending')
          AND source_revision <> ${revision}
      `;
      await enqueueCollaborationNotifications({
        db: tx,
        kind: "reminder",
        mailboxId: params.mailboxId,
        conversationId: params.conversationId,
        recipientUserIds: [user.data.id],
        sourceId: row.id,
        sourceRevision: revision,
        availableAt: params.input.dueAt,
      });
      return ok(mapReminder(row));
    });
  } catch {
    return fail(err.internal("Failed to save conversation reminder"));
  }
};

export const cancelConversationReminder = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
  input: CancelConversationReminder;
}): Promise<Result<ConversationReminder>> => {
  const user = requireReminderUser(params.context);
  if (!user.ok) return user;
  try {
    return await sql.begin(async (tx): Promise<Result<ConversationReminder>> => {
      const locked = await lockConversationReminder({
        db: tx,
        context: params.context,
        mailboxId: params.mailboxId,
        conversationId: params.conversationId,
        userId: user.data.id,
      });
      if (!locked.ok) return locked;
      const current = locked.data;
      if (!current) return fail(err.notFound("Reminder"));
      if (Number(current.revision) !== params.input.expectedRevision) {
        return fail(err.conflict("Reminder was changed by another request"));
      }
      if (current.state !== "pending") return fail(err.badInput("Only pending reminders can be canceled"));
      const mutable = await lockReminderDeliveryForMutation(tx, current.id, Number(current.revision));
      if (!mutable.ok) return mutable;
      const revision = Number(current.revision) + 1;
      const [row] = await tx<ReminderRow[]>`
        UPDATE mail.conversation_reminders
        SET state = 'canceled', revision = ${revision}, canceled_at = now()
        WHERE id = ${current.id}::uuid
        RETURNING ${reminderColumns}
      `;
      if (!row) return fail(err.internal("Canceled reminder could not be loaded"));
      await tx`
        UPDATE mail.collaboration_notification_deliveries
        SET state = 'skipped', claim_id = NULL, claimed_at = NULL, last_error = 'Reminder was canceled'
        WHERE kind = 'reminder' AND source_id = ${current.id}::uuid AND state IN ('pending', 'sending')
      `;
      return ok(mapReminder(row));
    });
  } catch {
    return fail(err.internal("Failed to cancel conversation reminder"));
  }
};
