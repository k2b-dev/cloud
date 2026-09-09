import { err, fail, ok, type Result } from "@k2b/stdlib";
import { logger } from "@k2b/cloud/services";
import { sql } from "bun";
import type { MergeConversationsInput, ReassignConversationMessageInput, SplitConversationInput } from "../contracts";
import { withShortIdDb } from "../lib/short-id";
import { actorRefFromRequest, type MailRequestContext } from "./auth";
import { requireMailboxCollaborationPermission } from "./collaboration";
import { mergeConversationReferencesInTransaction } from "./conversation-reference";
import { deriveConversationWorkState, isAutomaticSubmission } from "./conversation-work-state";
import { type MailConversationChangedEvent, publishMailCollaborationEvent } from "./events";
import { parseMessageProtocolFacts } from "./message-protocol";
import { MAIL_NOTIFICATION_DEFINITION_IDS } from "./notification-targets";

type SqlClient = typeof sql;
type ThreadActor = { kind: "user" | "service_account"; id: string };
const SPLIT_MESSAGES_CHANGED = "SPLIT_MESSAGES_CHANGED";
const log = logger("mail:conversations");

type LockedConversation = {
  id: string;
  revision: string | number;
};

export type ConversationThreadState = {
  id: string;
  revision: number;
  messageCount: number;
};

export type MergeConversationsResult = {
  target: ConversationThreadState;
  removedConversationId: string;
  movedMessageCount: number;
};

export type SplitConversationResult = {
  source: ConversationThreadState;
  created: ConversationThreadState;
  movedMessageCount: number;
};

export type ReassignConversationMessageResult = {
  source: ConversationThreadState;
  target: ConversationThreadState;
  messageId: string;
  movedCommentCount: number;
};

const actorIdentity = (context: MailRequestContext): ThreadActor => {
  const actor = actorRefFromRequest(context);
  if (actor.kind === "user") return { kind: actor.kind, id: actor.userId };
  if (actor.kind === "service_account") return { kind: actor.kind, id: actor.serviceAccountId };
  throw new Error("Request actor cannot change conversation threading");
};

const lockMailbox = async (context: MailRequestContext, mailboxId: string, db: SqlClient): Promise<Result<void>> => {
  const [mailbox] = await db<{ id: string }[]>`
    SELECT id FROM mail.mailboxes
    WHERE id = ${mailboxId}::uuid AND deleted_at IS NULL
    FOR UPDATE
  `;
  if (!mailbox) return fail(err.notFound("Mailbox"));
  const allowed = await requireMailboxCollaborationPermission(context, mailboxId, "write", db);
  return allowed.ok ? ok() : allowed;
};

const recomputeConversation = async (params: {
  db: SqlClient;
  conversationId: string;
  incrementRevision: boolean;
  deriveCollaboration: boolean;
}): Promise<ConversationThreadState> => {
  const [projection] = await params.db<
    {
      id: string;
      revision: string | number;
      work_status: "needs_action" | "waiting" | "done";
      snoozed_until: Date | string | null;
      message_count: number;
      latest_message_at: Date | string;
      latest_inbound_at: Date | string | null;
      latest_outbound_at: Date | string | null;
      latest_subject: string;
      participant_summary: string;
      latest_outbound: boolean;
      latest_in_reply_to: string | null;
      latest_reference_ids: string[];
      latest_protocol_facts: Record<string, unknown> | string;
    }[]
  >`
    WITH classified AS (
      SELECT
        message.id AS message_id,
        message.subject,
        message.internal_date,
        message.in_reply_to,
        message.reference_ids,
        message.protocol_facts,
        EXISTS (
          SELECT 1
          FROM mail.message_addresses sender
          JOIN mail.sender_identities identity
            ON identity.mailbox_id = conversation.mailbox_id
           AND lower(identity.from_address) = sender.normalized_email
          WHERE sender.message_id = message.id AND sender.role = 'from'
        ) AS outbound
      FROM mail.conversations conversation
      JOIN mail.conversation_messages link ON link.conversation_id = conversation.id
      JOIN mail.message_contents message ON message.id = link.message_id
      WHERE conversation.id = ${params.conversationId}::uuid
    ),
    timeline AS (
      SELECT
        COUNT(*)::int AS message_count,
        MAX(internal_date) AS latest_message_at,
        MAX(internal_date) FILTER (WHERE NOT outbound) AS latest_inbound_at,
        MAX(internal_date) FILTER (WHERE outbound) AS latest_outbound_at
      FROM classified
    ),
    latest AS (
      SELECT message_id, subject, outbound, in_reply_to, reference_ids, protocol_facts
      FROM classified
      ORDER BY internal_date DESC, message_id DESC
      LIMIT 1
    ),
    participant_labels AS (
      SELECT DISTINCT ON (address.normalized_email)
        address.normalized_email,
        COALESCE(NULLIF(address.display_name, ''), address.email) AS label
      FROM mail.message_addresses address
      JOIN latest ON latest.message_id = address.message_id
      WHERE (latest.outbound AND address.role IN ('to', 'cc', 'bcc'))
         OR (NOT latest.outbound AND address.role = 'from')
      ORDER BY address.normalized_email, address.position
    ),
    participants AS (
      SELECT COALESCE(string_agg(label, ', ' ORDER BY label), '') AS summary
      FROM participant_labels
    )
    SELECT
      conversation.id,
      conversation.revision,
      conversation.work_status,
      conversation.snoozed_until,
      timeline.message_count,
      timeline.latest_message_at,
      timeline.latest_inbound_at,
      timeline.latest_outbound_at,
      latest.subject AS latest_subject,
      participants.summary AS participant_summary,
      latest.outbound AS latest_outbound,
      latest.in_reply_to AS latest_in_reply_to,
      latest.reference_ids AS latest_reference_ids,
      latest.protocol_facts AS latest_protocol_facts
    FROM mail.conversations conversation, timeline, latest, participants
    WHERE conversation.id = ${params.conversationId}::uuid
      AND timeline.message_count > 0
    FOR UPDATE OF conversation
  `;
  if (!projection) throw new Error("Conversation projection cannot be recomputed without messages");

  const protocolFacts = parseMessageProtocolFacts(
    typeof projection.latest_protocol_facts === "string" ? JSON.parse(projection.latest_protocol_facts) : projection.latest_protocol_facts,
  );
  const transition = params.deriveCollaboration
    ? deriveConversationWorkState(projection.work_status, {
        direction: projection.latest_outbound ? "outbound" : "inbound",
        intent:
          projection.latest_outbound && (projection.latest_in_reply_to || projection.latest_reference_ids.length > 0)
            ? "observed_reply"
            : "observed_message",
        automatic: isAutomaticSubmission(protocolFacts.autoSubmitted),
      })
    : { workStatus: projection.work_status, clearSnooze: false };
  const [state] = await params.db<{ id: string; revision: string | number }[]>`
    UPDATE mail.conversations
    SET
      subject = ${projection.latest_subject},
      participant_summary = ${projection.participant_summary},
      latest_message_at = ${projection.latest_message_at}::timestamptz,
      latest_inbound_at = ${projection.latest_inbound_at}::timestamptz,
      latest_outbound_at = ${projection.latest_outbound_at}::timestamptz,
      work_status = ${transition.workStatus},
      snoozed_until = CASE WHEN ${transition.clearSnooze} THEN NULL ELSE snoozed_until END,
      revision = revision + CASE WHEN ${params.incrementRevision} THEN 1 ELSE 0 END
    WHERE id = ${params.conversationId}::uuid
    RETURNING id, revision
  `;
  if (!state) throw new Error("Conversation disappeared while its projection was recomputed");
  return { id: state.id, revision: Number(state.revision), messageCount: projection.message_count };
};

const pinConversationMessages = async (params: {
  db: SqlClient;
  mailboxId: string;
  conversationId: string;
  reason: "merge" | "split";
  actor: ThreadActor;
}): Promise<void> => {
  await params.db`
    INSERT INTO mail.conversation_thread_overrides (
      message_id, mailbox_id, conversation_id, reason, actor_kind, actor_id
    )
    SELECT
      link.message_id,
      ${params.mailboxId}::uuid,
      ${params.conversationId}::uuid,
      ${params.reason},
      ${params.actor.kind},
      ${params.actor.id}::uuid
    FROM mail.conversation_messages link
    WHERE link.conversation_id = ${params.conversationId}::uuid
    ON CONFLICT (message_id) DO UPDATE SET
      mailbox_id = EXCLUDED.mailbox_id,
      conversation_id = EXCLUDED.conversation_id,
      reason = EXCLUDED.reason,
      actor_kind = EXCLUDED.actor_kind,
      actor_id = EXCLUDED.actor_id,
      revision = mail.conversation_thread_overrides.revision + 1,
      updated_at = now()
  `;
};

const lockConversationNotificationDeliveries = async (params: { db: SqlClient; conversationIds: string[] }): Promise<Result<void>> => {
  const deliveries = await params.db<{ state: string }[]>`
    SELECT state
    FROM mail.collaboration_notification_deliveries
    WHERE conversation_id IN (
      SELECT value::uuid FROM jsonb_array_elements_text(${params.conversationIds}::jsonb)
    )
    ORDER BY id
    FOR UPDATE
  `;
  return deliveries.some((delivery) => delivery.state === "sending")
    ? fail(err.conflict("Conversation notifications are currently being delivered; retry shortly"))
    : ok();
};

const refreshCoreNotificationTargets = async (params: { db: SqlClient; conversationId: string }): Promise<void> => {
  await params.db`
    UPDATE notifications.events event
    SET target_href =
      '/api/mail/mailboxes/' || mailbox.short_id ||
      '/notification-targets/' || delivery.kind || '/' || delivery.source_short_id
    FROM mail.collaboration_notification_deliveries delivery
    JOIN mail.mailboxes mailbox ON mailbox.id = delivery.mailbox_id
    WHERE delivery.conversation_id = ${params.conversationId}::uuid
      AND event.recipient_user_id = delivery.recipient_user_id
      AND event.definition_id = ${MAIL_NOTIFICATION_DEFINITION_IDS.reminder}
      AND event.idempotency_key =
        'mail:reminder:' || delivery.source_id::text || ':' || delivery.source_revision::text || ':' || delivery.recipient_user_id::text
  `;
};

const moveMessageComments = async (params: {
  db: SqlClient;
  sourceConversationId: string;
  targetConversationId: string;
  messageIds: string[];
}): Promise<number> => {
  const moved = await params.db<{ id: string }[]>`
    UPDATE mail.conversation_comments comment
    SET conversation_id = ${params.targetConversationId}::uuid
    WHERE comment.conversation_id = ${params.sourceConversationId}::uuid
      AND comment.referenced_message_id IN (
        SELECT value::uuid FROM jsonb_array_elements_text(${params.messageIds}::jsonb)
      )
    RETURNING comment.id
  `;
  return moved.length;
};

const mergeConversationReminders = async (params: {
  db: SqlClient;
  targetConversationId: string;
  sourceConversationId: string;
}): Promise<{ moved: number; discardedConflicts: number }> => {
  await params.db`
    UPDATE mail.collaboration_notification_deliveries
    SET conversation_id = ${params.targetConversationId}::uuid
    WHERE conversation_id = ${params.sourceConversationId}::uuid
  `;
  await params.db`
    UPDATE mail.collaboration_notification_deliveries delivery
    SET
      state = 'skipped',
      claim_id = NULL,
      claimed_at = NULL,
      last_error = 'Target conversation reminder was preserved during merge'
    FROM mail.conversation_reminders source_reminder
    WHERE source_reminder.conversation_id = ${params.sourceConversationId}::uuid
      AND delivery.kind = 'reminder'
      AND delivery.source_id = source_reminder.id
      AND delivery.state = 'pending'
      AND EXISTS (
        SELECT 1
        FROM mail.conversation_reminders target_reminder
        WHERE target_reminder.conversation_id = ${params.targetConversationId}::uuid
          AND target_reminder.user_id = source_reminder.user_id
      )
  `;
  const conflicts = await params.db<{ id: string }[]>`
    DELETE FROM mail.conversation_reminders source_reminder
    USING mail.conversation_reminders target_reminder
    WHERE source_reminder.conversation_id = ${params.sourceConversationId}::uuid
      AND target_reminder.conversation_id = ${params.targetConversationId}::uuid
      AND target_reminder.user_id = source_reminder.user_id
    RETURNING source_reminder.id
  `;
  const moved = await params.db<{ id: string }[]>`
    UPDATE mail.conversation_reminders
    SET conversation_id = ${params.targetConversationId}::uuid
    WHERE conversation_id = ${params.sourceConversationId}::uuid
    RETURNING id
  `;
  return { moved: moved.length, discardedConflicts: conflicts.length };
};

const insertThreadActivity = async (params: {
  db: SqlClient;
  mailboxId: string;
  conversationId: string;
  context: MailRequestContext;
  action: string;
  metadata: Record<string, unknown>;
}): Promise<string> => {
  const actor = actorIdentity(params.context);
  const [activity] = await params.db<{ id: string | number }[]>`
    INSERT INTO mail.activity_events (
      mailbox_id, conversation_id, actor_kind, actor_id, action, outcome, target_type, target_id, metadata
    ) VALUES (
      ${params.mailboxId}::uuid,
      ${params.conversationId}::uuid,
      ${actor.kind},
      ${actor.id}::uuid,
      ${params.action},
      'confirmed',
      'conversation',
      ${params.conversationId}::uuid,
      ${params.metadata}::jsonb
    )
    RETURNING id
  `;
  if (!activity) throw new Error("Conversation threading activity insert returned no row");
  return String(activity.id);
};

const publishEvents = async (events: Array<Omit<MailConversationChangedEvent, "type" | "at">>): Promise<void> => {
  await Promise.all(events.map((event) => publishMailCollaborationEvent(event)));
};

export const mergeConversations = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  targetConversationId: string;
  input: MergeConversationsInput;
}): Promise<Result<MergeConversationsResult>> => {
  if (params.targetConversationId === params.input.sourceConversationId) {
    return fail(err.badInput("Source and target conversation must be different"));
  }
  try {
    const events: Array<Omit<MailConversationChangedEvent, "type" | "at">> = [];
    const result = await sql.begin(async (tx): Promise<Result<MergeConversationsResult>> => {
      const allowed = await lockMailbox(params.context, params.mailboxId, tx);
      if (!allowed.ok) return allowed;
      const conversationIds = [params.targetConversationId, params.input.sourceConversationId].sort();
      const rows = await tx<LockedConversation[]>`
        SELECT id, revision
        FROM mail.conversations
        WHERE mailbox_id = ${params.mailboxId}::uuid
          AND id IN (SELECT value::uuid FROM jsonb_array_elements_text(${conversationIds}::jsonb))
        ORDER BY id
        FOR UPDATE
      `;
      const byId = new Map(rows.map((row) => [row.id, row]));
      const target = byId.get(params.targetConversationId);
      const source = byId.get(params.input.sourceConversationId);
      if (!target) return fail(err.notFound("Target conversation"));
      if (!source) return fail(err.notFound("Source conversation"));
      if (Number(target.revision) !== params.input.expectedTargetRevision) {
        return fail(err.conflict("Target conversation was changed by another collaborator"));
      }
      if (Number(source.revision) !== params.input.expectedSourceRevision) {
        return fail(err.conflict("Source conversation was changed by another collaborator"));
      }
      const notificationsAvailable = await lockConversationNotificationDeliveries({ db: tx, conversationIds });
      if (!notificationsAvailable.ok) return notificationsAvailable;

      const moved = await tx<{ message_id: string }[]>`
        UPDATE mail.conversation_messages
        SET conversation_id = ${params.targetConversationId}::uuid, added_by = 'manual'
        WHERE conversation_id = ${params.input.sourceConversationId}::uuid
        RETURNING message_id
      `;
      if (moved.length === 0) return fail(err.badInput("Source conversation has no messages"));

      await tx`
        UPDATE mail.conversation_comments
        SET conversation_id = ${params.targetConversationId}::uuid
        WHERE conversation_id = ${params.input.sourceConversationId}::uuid
      `;
      const reminderMerge = await mergeConversationReminders({
        db: tx,
        targetConversationId: params.targetConversationId,
        sourceConversationId: params.input.sourceConversationId,
      });
      await refreshCoreNotificationTargets({ db: tx, conversationId: params.targetConversationId });
      const movedLocalTags = await tx<{ tag_id: string }[]>`
        INSERT INTO mail.conversation_local_tags (
          mailbox_id, conversation_id, tag_id, assigned_by_actor_kind, assigned_by_actor_id, created_at
        )
        SELECT
          mailbox_id,
          ${params.targetConversationId}::uuid,
          tag_id,
          assigned_by_actor_kind,
          assigned_by_actor_id,
          created_at
        FROM mail.conversation_local_tags
        WHERE conversation_id = ${params.input.sourceConversationId}::uuid
        ON CONFLICT DO NOTHING
        RETURNING tag_id
      `;
      await tx`
        UPDATE mail.drafts
        SET conversation_id = ${params.targetConversationId}::uuid
        WHERE conversation_id = ${params.input.sourceConversationId}::uuid
      `;
      await tx`
        UPDATE mail.automatic_reply_effects
        SET conversation_id = ${params.targetConversationId}::uuid
        WHERE conversation_id = ${params.input.sourceConversationId}::uuid
      `;
      const referenceMerge = await mergeConversationReferencesInTransaction({
        db: tx,
        mailboxId: params.mailboxId,
        targetConversationId: params.targetConversationId,
        sourceConversationId: params.input.sourceConversationId,
      });
      await tx`
        UPDATE mail.conversation_thread_overrides
        SET
          conversation_id = ${params.targetConversationId}::uuid,
          reason = 'merge',
          revision = revision + 1,
          updated_at = now()
        WHERE conversation_id = ${params.input.sourceConversationId}::uuid
      `;
      await tx`DELETE FROM mail.conversations WHERE id = ${params.input.sourceConversationId}::uuid`;

      const actor = actorIdentity(params.context);
      await pinConversationMessages({
        db: tx,
        mailboxId: params.mailboxId,
        conversationId: params.targetConversationId,
        reason: "merge",
        actor,
      });
      const targetState = await recomputeConversation({
        db: tx,
        conversationId: params.targetConversationId,
        incrementRevision: true,
        deriveCollaboration: false,
      });
      const activityId = await insertThreadActivity({
        db: tx,
        mailboxId: params.mailboxId,
        conversationId: params.targetConversationId,
        context: params.context,
        action: "conversation.merged",
        metadata: {
          sourceConversationId: params.input.sourceConversationId,
          movedMessageCount: moved.length,
          reason: params.input.reason ?? null,
          targetRevision: targetState.revision,
          movedReminderCount: reminderMerge.moved,
          discardedReminderConflictCount: reminderMerge.discardedConflicts,
          movedReferenceCount: referenceMerge.moved,
          movedLocalTagCount: movedLocalTags.length,
          primaryReference: referenceMerge.primaryValue,
        },
      });
      events.push({
        mailboxId: params.mailboxId,
        conversationId: params.targetConversationId,
        reason: "threading",
        targetId: params.input.sourceConversationId,
        activityId,
      });
      return ok({ target: targetState, removedConversationId: params.input.sourceConversationId, movedMessageCount: moved.length });
    });
    if (result.ok) await publishEvents(events);
    return result;
  } catch (error) {
    log.error("Failed to merge conversations", {
      mailboxId: params.mailboxId,
      targetConversationId: params.targetConversationId,
      sourceConversationId: params.input.sourceConversationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return fail(err.internal("Failed to merge conversations"));
  }
};

export const reassignConversationMessage = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  sourceConversationId: string;
  messageId: string;
  input: ReassignConversationMessageInput;
}): Promise<Result<ReassignConversationMessageResult>> => {
  if (params.sourceConversationId === params.input.targetConversationId) {
    return fail(err.badInput("Source and target conversation must be different"));
  }
  try {
    const events: Array<Omit<MailConversationChangedEvent, "type" | "at">> = [];
    const result = await sql.begin(async (tx): Promise<Result<ReassignConversationMessageResult>> => {
      const allowed = await lockMailbox(params.context, params.mailboxId, tx);
      if (!allowed.ok) return allowed;

      const conversationIds = [params.sourceConversationId, params.input.targetConversationId].sort();
      const rows = await tx<LockedConversation[]>`
        SELECT id, revision
        FROM mail.conversations
        WHERE mailbox_id = ${params.mailboxId}::uuid
          AND id IN (SELECT value::uuid FROM jsonb_array_elements_text(${conversationIds}::jsonb))
        ORDER BY id
        FOR UPDATE
      `;
      const byId = new Map(rows.map((row) => [row.id, row]));
      const source = byId.get(params.sourceConversationId);
      const target = byId.get(params.input.targetConversationId);
      if (!source) return fail(err.notFound("Source conversation"));
      if (!target) return fail(err.notFound("Target conversation"));
      if (Number(source.revision) !== params.input.expectedSourceRevision) {
        return fail(err.conflict("Source conversation was changed by another collaborator"));
      }
      if (Number(target.revision) !== params.input.expectedTargetRevision) {
        return fail(err.conflict("Target conversation was changed by another collaborator"));
      }

      const notificationsAvailable = await lockConversationNotificationDeliveries({ db: tx, conversationIds });
      if (!notificationsAvailable.ok) return notificationsAvailable;
      const [counts] = await tx<{ total: number; selected: number }[]>`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE message_id = ${params.messageId}::uuid)::int AS selected
        FROM mail.conversation_messages
        WHERE conversation_id = ${params.sourceConversationId}::uuid
      `;
      if (!counts || counts.selected !== 1) return fail(err.notFound("Message in source conversation"));
      if (counts.total <= 1) {
        return fail(err.badInput("Move the whole conversation instead of removing its only message"));
      }

      const moved = await tx<{ message_id: string }[]>`
        UPDATE mail.conversation_messages
        SET conversation_id = ${params.input.targetConversationId}::uuid, added_by = 'manual'
        WHERE conversation_id = ${params.sourceConversationId}::uuid
          AND message_id = ${params.messageId}::uuid
        RETURNING message_id
      `;
      if (moved.length !== 1)
        throw Object.assign(new Error("Conversation message changed during reassignment"), { code: SPLIT_MESSAGES_CHANGED });

      const movedCommentCount = await moveMessageComments({
        db: tx,
        sourceConversationId: params.sourceConversationId,
        targetConversationId: params.input.targetConversationId,
        messageIds: [params.messageId],
      });
      const actor = actorIdentity(params.context);
      await pinConversationMessages({
        db: tx,
        mailboxId: params.mailboxId,
        conversationId: params.sourceConversationId,
        reason: "split",
        actor,
      });
      await pinConversationMessages({
        db: tx,
        mailboxId: params.mailboxId,
        conversationId: params.input.targetConversationId,
        reason: "merge",
        actor,
      });
      const sourceState = await recomputeConversation({
        db: tx,
        conversationId: params.sourceConversationId,
        incrementRevision: true,
        deriveCollaboration: false,
      });
      const targetState = await recomputeConversation({
        db: tx,
        conversationId: params.input.targetConversationId,
        incrementRevision: true,
        deriveCollaboration: true,
      });
      const metadata = {
        messageId: params.messageId,
        sourceConversationId: params.sourceConversationId,
        targetConversationId: params.input.targetConversationId,
        movedCommentCount,
        reason: params.input.reason ?? null,
        sourceRevision: sourceState.revision,
        targetRevision: targetState.revision,
      };
      const sourceActivityId = await insertThreadActivity({
        db: tx,
        mailboxId: params.mailboxId,
        conversationId: params.sourceConversationId,
        context: params.context,
        action: "conversation.message_reassigned",
        metadata,
      });
      const targetActivityId = await insertThreadActivity({
        db: tx,
        mailboxId: params.mailboxId,
        conversationId: params.input.targetConversationId,
        context: params.context,
        action: "conversation.message_reassigned",
        metadata,
      });
      events.push(
        {
          mailboxId: params.mailboxId,
          conversationId: params.sourceConversationId,
          reason: "threading",
          targetId: params.input.targetConversationId,
          activityId: sourceActivityId,
        },
        {
          mailboxId: params.mailboxId,
          conversationId: params.input.targetConversationId,
          reason: "threading",
          targetId: params.sourceConversationId,
          activityId: targetActivityId,
        },
      );
      return ok({
        source: sourceState,
        target: targetState,
        messageId: params.messageId,
        movedCommentCount,
      });
    });
    if (result.ok) await publishEvents(events);
    return result;
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === SPLIT_MESSAGES_CHANGED) {
      return fail(err.conflict("Conversation messages changed during reassignment; retry with the latest revision"));
    }
    log.error("Failed to reassign conversation message", {
      mailboxId: params.mailboxId,
      sourceConversationId: params.sourceConversationId,
      targetConversationId: params.input.targetConversationId,
      messageId: params.messageId,
      error: error instanceof Error ? error.message : String(error),
    });
    return fail(err.internal("Failed to reassign conversation message"));
  }
};

export const splitConversation = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
  input: SplitConversationInput;
}): Promise<Result<SplitConversationResult>> => {
  try {
    const events: Array<Omit<MailConversationChangedEvent, "type" | "at">> = [];
    const result = await sql.begin(async (tx): Promise<Result<SplitConversationResult>> => {
      const allowed = await lockMailbox(params.context, params.mailboxId, tx);
      if (!allowed.ok) return allowed;
      const [source] = await tx<LockedConversation[]>`
        SELECT id, revision
        FROM mail.conversations
        WHERE id = ${params.conversationId}::uuid AND mailbox_id = ${params.mailboxId}::uuid
        FOR UPDATE
      `;
      if (!source) return fail(err.notFound("Conversation"));
      if (Number(source.revision) !== params.input.expectedRevision) {
        return fail(err.conflict("Conversation was changed by another collaborator"));
      }
      const notificationsAvailable = await lockConversationNotificationDeliveries({
        db: tx,
        conversationIds: [params.conversationId],
      });
      if (!notificationsAvailable.ok) return notificationsAvailable;
      const [counts] = await tx<{ total: number; selected: number }[]>`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (
            WHERE message_id IN (
              SELECT value::uuid FROM jsonb_array_elements_text(${params.input.messageIds}::jsonb)
            )
          )::int AS selected
        FROM mail.conversation_messages
        WHERE conversation_id = ${params.conversationId}::uuid
      `;
      if (!counts || counts.selected !== params.input.messageIds.length) {
        return fail(err.badInput("Every selected message must belong to the source conversation"));
      }
      if (counts.selected >= counts.total) {
        return fail(err.badInput("A split must leave at least one message in the source conversation"));
      }

      const createdRows = await withShortIdDb(
        tx,
        "conversation",
        (db, shortId) => db<{ id: string }[]>`
        INSERT INTO mail.conversations (short_id, mailbox_id, latest_message_at)
        SELECT ${shortId}, ${params.mailboxId}::uuid, MAX(message.internal_date)
        FROM mail.message_contents message
        WHERE message.id IN (
          SELECT value::uuid FROM jsonb_array_elements_text(${params.input.messageIds}::jsonb)
        )
        RETURNING id
      `,
      );
      const [created] = createdRows;
      if (!created) return fail(err.internal("Split conversation insert returned no row"));
      const moved = await tx<{ message_id: string }[]>`
        UPDATE mail.conversation_messages
        SET conversation_id = ${created.id}::uuid, added_by = 'manual'
        WHERE conversation_id = ${params.conversationId}::uuid
          AND message_id IN (
            SELECT value::uuid FROM jsonb_array_elements_text(${params.input.messageIds}::jsonb)
          )
        RETURNING message_id
      `;
      if (moved.length !== params.input.messageIds.length) {
        throw Object.assign(new Error("Conversation messages changed during split"), { code: SPLIT_MESSAGES_CHANGED });
      }

      const movedCommentCount = await moveMessageComments({
        db: tx,
        sourceConversationId: params.conversationId,
        targetConversationId: created.id,
        messageIds: params.input.messageIds,
      });
      const actor = actorIdentity(params.context);
      await pinConversationMessages({
        db: tx,
        mailboxId: params.mailboxId,
        conversationId: params.conversationId,
        reason: "split",
        actor,
      });
      await pinConversationMessages({
        db: tx,
        mailboxId: params.mailboxId,
        conversationId: created.id,
        reason: "split",
        actor,
      });
      const sourceState = await recomputeConversation({
        db: tx,
        conversationId: params.conversationId,
        incrementRevision: true,
        deriveCollaboration: false,
      });
      const createdState = await recomputeConversation({
        db: tx,
        conversationId: created.id,
        incrementRevision: false,
        deriveCollaboration: true,
      });
      const metadata = {
        sourceConversationId: params.conversationId,
        createdConversationId: created.id,
        movedMessageCount: moved.length,
        movedCommentCount,
        reason: params.input.reason ?? null,
      };
      const sourceActivityId = await insertThreadActivity({
        db: tx,
        mailboxId: params.mailboxId,
        conversationId: params.conversationId,
        context: params.context,
        action: "conversation.split",
        metadata,
      });
      const createdActivityId = await insertThreadActivity({
        db: tx,
        mailboxId: params.mailboxId,
        conversationId: created.id,
        context: params.context,
        action: "conversation.created_by_split",
        metadata,
      });
      events.push(
        {
          mailboxId: params.mailboxId,
          conversationId: params.conversationId,
          reason: "threading",
          targetId: created.id,
          activityId: sourceActivityId,
        },
        {
          mailboxId: params.mailboxId,
          conversationId: created.id,
          reason: "threading",
          targetId: params.conversationId,
          activityId: createdActivityId,
        },
      );
      return ok({ source: sourceState, created: createdState, movedMessageCount: moved.length });
    });
    if (result.ok) await publishEvents(events);
    return result;
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === SPLIT_MESSAGES_CHANGED) {
      return fail(err.conflict("Conversation messages changed during split; retry with the latest revision"));
    }
    return fail(err.internal("Failed to split conversation"));
  }
};
