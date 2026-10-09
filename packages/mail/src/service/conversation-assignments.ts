import { accounts, logger, notifications } from "@k2b/cloud/services";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { app } from "../config";
import type { UpdateConversationCollaboration } from "../contracts";
import { conversationVisibleTo, getMailboxAccess } from "./access";
import { type MailRequestContext, userBackedActor } from "./auth";
import {
  applyConversationAssignments,
  applyConversationCollaboration,
  type ConversationAssignmentChange,
  type ConversationAssignmentResult,
  type ConversationCollaboration,
} from "./collaboration";

const log = logger("mail:assignments");

/** Sends one notification for a committed assignment; self-assignment, unassignment, and unchanged assignees stay silent. */
const notifyAssignee = async (params: {
  context: MailRequestContext;
  change: ConversationAssignmentChange;
  locale: string;
}): Promise<void> => {
  const actor = userBackedActor(params.context);
  const { change } = params;
  if (change.added.length === 0 || change.activityIds.length === 0) return;
  // The lowest activity id identifies this committed batch, so a repeated send cannot duplicate it.
  const batchId = change.activityIds.reduce((lowest, id) => (BigInt(id) < BigInt(lowest) ? id : lowest));
  for (const added of change.added) {
    if (actor?.id === added.userId) continue;
    try {
      const user = await accounts.users.get({ id: added.userId });
      if (!user) continue;
      const [mailbox] = await sql<
        { id: string }[]
      >`SELECT id FROM mail.mailboxes WHERE short_id = ${change.mailbox.shortId} AND deleted_at IS NULL`;
      if (!mailbox) continue;
      const access = await getMailboxAccess(
        { actor: { kind: "user", user }, accessSubject: { type: "user", userId: user.id } },
        mailbox.id,
      );
      if (!access) continue;
      const visible = await sql<
        { short_id: string }[]
      >`SELECT short_id FROM mail.conversations WHERE mailbox_id = ${mailbox.id}::uuid AND short_id IN (SELECT value FROM jsonb_array_elements_text(${added.conversationIds}::jsonb)) AND ${conversationVisibleTo(access, sql`id`)}`;
      const visibleIds = new Set(visible.map((row) => row.short_id));
      const conversationIds = added.conversationIds.filter((id) => visibleIds.has(id));
      if (conversationIds.length === 0) continue;
      await notifications.send(app.notifications.conversationsAssigned, {
        recipient: { userId: added.userId },
        data: {
          mailboxId: change.mailbox.shortId,
          mailboxName: change.mailbox.name,
          conversationIds,
          assignedBy: actor?.displayName || actor?.uid || null,
        },
        idempotencyKey: `assignment:${batchId}:${added.userId}`,
        sentBy: actor?.id,
        locale: params.locale,
      });
    } catch (error) {
      // The assignment is committed; a lost notice must not turn it into a failed request.
      log.warn("Failed to send Mail assignment notification", {
        mailboxId: change.mailbox.shortId,
        conversations: change.conversationIds.length,
        error: error instanceof Error ? error.message : "Notification send failed",
      });
    }
  }
};

/**
 * Assigns or unassigns up to `MAIL_CONVERSATION_BATCH_LIMIT` conversations of
 * one mailbox and notifies each newly added user once for their conversations.
 */
export const assignConversations = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  /** Public conversation ids, as the transport received them. */
  conversationIds: readonly string[];
  assigneeUserIds: readonly string[];
  mode: "add" | "remove" | "replace";
  /** Locale for the notification; the request locale at a request seam. */
  locale: string;
}): Promise<Result<ConversationAssignmentResult>> => {
  const applied = await applyConversationAssignments(params);
  if (!applied.ok) return applied;
  await notifyAssignee({ ...params, change: applied.data.change });
  return ok(applied.data.result);
};

/** Assigns one public conversation through the same atomic modes and notification path as a batch. */
export const assignConversation = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
  assigneeUserIds: readonly string[];
  mode: "add" | "remove" | "replace";
  locale: string;
}): Promise<Result<ConversationCollaboration>> => {
  const applied = await applyConversationAssignments({ ...params, conversationIds: [params.conversationId] });
  if (!applied.ok) return applied;
  const collaboration = applied.data.collaborations.get(params.conversationId);
  if (!collaboration) return fail(err.notFound("Conversation"));
  await notifyAssignee({ ...params, change: applied.data.change });
  return ok(collaboration);
};

/**
 * Updates one conversation's assignee, completion, or snooze and notifies a
 * newly assigned person the same way `assignConversations` does.
 */
export const updateConversationCollaboration = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
  input: UpdateConversationCollaboration;
  /** Locale for the notification; the request locale at a request seam. */
  locale: string;
}): Promise<Result<ConversationCollaboration>> => {
  const applied = await applyConversationCollaboration(params);
  if (!applied.ok) return applied;
  const { collaboration, assignment } = applied.data;
  if (assignment) {
    await notifyAssignee({ ...params, change: assignment });
  }
  return ok(collaboration);
};
