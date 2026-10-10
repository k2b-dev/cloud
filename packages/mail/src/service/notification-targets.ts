import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { conversationVisibleTo, requireMailboxAccess } from "./access";
import { type MailRequestContext, userBackedActor } from "./auth";
import type { CollaborationNotificationKind } from "./notification-outbox";

type SqlClient = typeof sql;

export const MAIL_NOTIFICATION_DEFINITION_IDS: Record<CollaborationNotificationKind, string> = {
  reminder: "mail.conversationReminder",
};

export const mailNotificationTargetHref = (params: {
  mailboxId: string;
  kind: CollaborationNotificationKind;
  sourceId: string;
}): `/${string}` =>
  `/api/mail/mailboxes/${encodeURIComponent(params.mailboxId)}/notification-targets/${params.kind}/${encodeURIComponent(params.sourceId)}`;

const conversationHref = (params: { mailboxId: string; conversationId: string }): `/${string}` =>
  `/app/mail/${encodeURIComponent(params.mailboxId)}?conversation=${encodeURIComponent(params.conversationId)}`;

export const resolveMailNotificationTarget = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  kind: CollaborationNotificationKind;
  sourceId: string;
  db?: SqlClient;
}): Promise<Result<{ href: `/${string}` }>> => {
  const db = params.db ?? sql;
  const allowed = await requireMailboxAccess(params.context, params.mailboxId, "read", db);
  if (!allowed.ok) return allowed;

  const user = userBackedActor(params.context);
  if (!user) return fail(err.notFound("Notification target"));
  const [reminder] = await db<{ mailbox_short_id: string; conversation_short_id: string }[]>`
    SELECT mailbox.short_id AS mailbox_short_id, conversation.short_id AS conversation_short_id
    FROM mail.conversation_reminders reminder
    JOIN mail.conversations conversation ON conversation.id = reminder.conversation_id
    JOIN mail.mailboxes mailbox ON mailbox.id = reminder.mailbox_id
    WHERE reminder.id = ${params.sourceId}::uuid
      AND reminder.user_id = ${user.id}::uuid
      AND conversation.mailbox_id = ${params.mailboxId}::uuid
      AND ${conversationVisibleTo(allowed.data, sql`conversation.id`)}
  `;
  if (reminder) {
    return ok({ href: conversationHref({ mailboxId: reminder.mailbox_short_id, conversationId: reminder.conversation_short_id }) });
  }
  const [delivery] = await db<{ mailbox_short_id: string; conversation_short_id: string }[]>`
    SELECT mailbox.short_id AS mailbox_short_id, conversation.short_id AS conversation_short_id
    FROM mail.collaboration_notification_deliveries delivery
    JOIN mail.conversations conversation ON conversation.id = delivery.conversation_id
    JOIN mail.mailboxes mailbox ON mailbox.id = delivery.mailbox_id
    WHERE delivery.kind = 'reminder'
      AND delivery.source_id = ${params.sourceId}::uuid
      AND delivery.recipient_user_id = ${user.id}::uuid
      AND delivery.mailbox_id = ${params.mailboxId}::uuid
      AND conversation.mailbox_id = ${params.mailboxId}::uuid
      AND ${conversationVisibleTo(allowed.data, sql`conversation.id`)}
    ORDER BY delivery.source_revision DESC
    LIMIT 1
  `;
  return delivery
    ? ok({ href: conversationHref({ mailboxId: delivery.mailbox_short_id, conversationId: delivery.conversation_short_id }) })
    : fail(err.notFound("Notification target"));
};
