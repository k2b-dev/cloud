import { audit, logger } from "@k2b/cloud/services";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { MAX_CONVERSATION_ACTION_MESSAGES } from "../contracts";
import { isCurrentPlatformAdmin, requireMailboxAccess, requireVisibleConversation } from "./access";
import { actorRefFromRequest, auditActorFromRequest, capByCredentialScopes, type MailRequestContext } from "./auth";
import { insertActivity } from "./collaboration";
import { isKeptConversation } from "./conversation-keep-rules";
import { mailLive } from "./live";
import { enqueueMessageHydration } from "./sync-runtime";

const log = logger("mail:conversation-keeps");

type SqlClient = typeof sql;
export type ConversationKeep = {
  conversationId: string;
  canLift: boolean;
  keptAt: string;
  keptBy: { kind: "user" | "service_account" | "workflow" | "system"; id: string | null; displayName: string; avatarHash: string | null };
};
type KeepParams = { context: MailRequestContext; mailboxId: string; conversationId: string };
type KeepRow = {
  conversation_id: string;
  kept_at: Date | string;
  kept_by_kind: ConversationKeep["keptBy"]["kind"];
  kept_by_id: string | null;
  display_name: string;
  avatar_hash: string | null;
};
const loadKeep = async (db: SqlClient, conversationId: string): Promise<Omit<ConversationKeep, "canLift"> | null> => {
  const [row] = await db<KeepRow[]>`
    SELECT keep.*, COALESCE(NULLIF(actor_user.display_name, ''), actor_user.uid, actor_service.name, actor_workflow.name,
      CASE keep.kept_by_kind WHEN 'workflow' THEN 'Workflow' WHEN 'system' THEN 'System'
      WHEN 'user' THEN 'Former user' ELSE 'Former service account' END) AS display_name,
      actor_user.avatar_hash
    FROM mail.conversation_keeps keep
    LEFT JOIN auth.users actor_user ON keep.kept_by_kind = 'user' AND actor_user.id = keep.kept_by_id
    LEFT JOIN auth.service_accounts actor_service ON keep.kept_by_kind = 'service_account' AND actor_service.id = keep.kept_by_id
    LEFT JOIN workflows.version actor_version ON keep.kept_by_kind = 'workflow' AND actor_version.id = keep.kept_by_id
    LEFT JOIN workflows.workflow actor_workflow ON actor_workflow.id = actor_version.workflow_id
    WHERE keep.conversation_id = ${conversationId}::uuid
  `;
  return row
    ? {
        conversationId: row.conversation_id,
        keptAt: new Date(row.kept_at).toISOString(),
        keptBy: { kind: row.kept_by_kind, id: row.kept_by_id, displayName: row.display_name, avatarHash: row.avatar_hash },
      }
    : null;
};
const requireConversation = async (
  params: KeepParams,
  permission: "read" | "write",
  db: SqlClient,
  lock = false,
): Promise<Result<void>> => {
  // Same mailbox lock order as command creation, including folder commands with many conversations.
  if (lock) await db`SELECT id FROM mail.mailboxes WHERE id = ${params.mailboxId}::uuid FOR UPDATE`;
  const access = await requireMailboxAccess(params.context, params.mailboxId, permission, db);
  if (!access.ok) return access;
  const visible = await requireVisibleConversation(access.data, params.conversationId, db);
  if (!visible.ok) return visible;
  const [conversation] = await db`SELECT id FROM mail.conversations
    WHERE id = ${params.conversationId}::uuid AND mailbox_id = ${params.mailboxId}::uuid
    ${lock ? sql`FOR UPDATE` : sql``}`;
  return conversation ? ok() : fail(err.notFound("Conversation"));
};
export const getConversationKeep = async (params: KeepParams): Promise<Result<ConversationKeep | null>> => {
  const allowed = await requireConversation(params, "read", sql);
  if (!allowed.ok) return allowed;
  const keep = await loadKeep(sql, params.conversationId);
  return ok(keep ? { ...keep, canLift: await canLiftConversationKeeps(params.context) } : null);
};
const recordKeep = async (
  db: SqlClient,
  params: KeepParams,
  release: boolean,
  carriedFrom?: string,
  reason?: string | null,
): Promise<void> => {
  await insertActivity({
    db,
    ...params,
    action: release ? "conversation.keep_released" : "conversation.kept",
    targetType: "conversation",
    targetId: params.conversationId,
    metadata: { ...(carriedFrom ? { carriedFrom } : {}), ...(release ? { reason: reason ?? null } : {}) },
  });
  await recordConversationKeepAudit(
    params,
    release ? "mail.conversation.keep.release" : "mail.conversation.keep",
    "allowed",
    { ...(carriedFrom ? { carriedFrom } : {}), ...(release ? { reason: reason ?? null } : {}) },
    db,
  );
};

export const LIFT_KEEP_FORBIDDEN = "Only a Cloud administrator can stop keeping a conversation";

/** Kept-content administration never runs under durable workflow or automation authority. */
export const canReadKeptConversations = async (context: MailRequestContext): Promise<boolean> =>
  context.actor.delegation?.credentialKind !== "mandate" &&
  capByCredentialScopes(context, "admin") === "admin" &&
  (await isCurrentPlatformAdmin(context));

/** Only people with a current Cloud admin role, including their personal API keys, may lift a keep. */
export const canLiftConversationKeeps = async (context: MailRequestContext): Promise<boolean> =>
  (context.actor.kind === "user" || context.actor.serviceAccount.kind === "user_delegated") && (await canReadKeptConversations(context));

/** Authorization for a release review is independent of mailbox visibility and includes deleted mailboxes. */
export const getConversationKeepReleaseSubject = async (
  context: MailRequestContext,
  mailboxId: string,
  conversationId: string,
): Promise<Result<{ subject: string | null }>> => {
  if (!(await canLiftConversationKeeps(context))) return fail(err.forbidden(LIFT_KEEP_FORBIDDEN));
  const [row] = await sql<{ subject: string | null }[]>`SELECT subject FROM mail.conversations
    WHERE id = ${conversationId}::uuid AND mailbox_id = ${mailboxId}::uuid`;
  return row ? ok(row) : fail(err.notFound("Conversation"));
};

export const recordConversationKeepAudit = async (
  params: KeepParams,
  action: "mail.conversation.keep" | "mail.conversation.keep.release" | "mail.conversation.keep.view" | "mail.conversation.keep.export",
  outcome: "allowed" | "denied",
  metadata: Record<string, unknown> = {},
  db: SqlClient = sql,
): Promise<void> => {
  await audit.record(
    {
      action,
      outcome,
      actor: auditActorFromRequest(params.context),
      target: { type: "conversation", id: params.conversationId },
      requestId: params.context.requestId,
      metadata: { ...metadata, mailboxId: params.mailboxId, principal: actorRefFromRequest(params.context) },
    },
    db,
  );
};

/** Whether moving messages from one conversation into another makes the other kept; ask before moving them. */
export const keepCarriesOver = async (db: SqlClient, sourceConversationId: string, targetConversationId: string): Promise<boolean> => {
  const [row] = await db<{ carries: boolean }[]>`
    SELECT ${isKeptConversation(sql`${sourceConversationId}::uuid`)} AND NOT ${isKeptConversation(sql`${targetConversationId}::uuid`)} AS carries
  `;
  return row?.carries === true;
};
/**
 * A merge, split, or reassignment carried a keep into another conversation, which the `mail.conversation_messages`
 * trigger already stored with the original keeper and time. The activity and audit name who moved the messages.
 */
export const recordCarriedKeep = (db: SqlClient, params: KeepParams & { sourceConversationId: string }): Promise<void> =>
  recordKeep(
    db,
    { context: params.context, mailboxId: params.mailboxId, conversationId: params.conversationId },
    false,
    params.sourceConversationId,
  );
export const keepConversation = async (params: KeepParams): Promise<Result<ConversationKeep>> => {
  const result = await sql.begin(async (db) => {
    const allowed = await requireConversation(params, "write", db, true);
    if (!allowed.ok) {
      await recordConversationKeepAudit(params, "mail.conversation.keep", "denied", {}, db);
      return allowed;
    }
    const actor = actorRefFromRequest(params.context);
    const actorId = actor.kind === "user" ? actor.userId : actor.kind === "service_account" ? actor.serviceAccountId : null;
    const inserted = await db`INSERT INTO mail.conversation_keeps (conversation_id, mailbox_id, kept_by_kind, kept_by_id)
      VALUES (${params.conversationId}::uuid, ${params.mailboxId}::uuid, ${actor.kind}, ${actorId}::uuid)
      ON CONFLICT DO NOTHING RETURNING conversation_id`;
    if (inserted.length) await recordKeep(db, params, false);
    const keep = await loadKeep(db, params.conversationId);
    if (!keep) throw new Error("Conversation keep insert returned no row");
    // A message whose loading already failed gets its tries back while the server still has it, so an earlier
    // outage does not leave it without a copy. A message over the size limit stays failed: no try can load it.
    const messages = await db<{ id: string }[]>`
      WITH pending AS (
        SELECT message.id, message.internal_date FROM mail.message_contents message
        JOIN mail.conversation_messages link ON link.message_id = message.id
        WHERE link.conversation_id = ${params.conversationId}::uuid AND message.hydration_status <> 'complete'
          AND message.hydration_error_code IS DISTINCT FROM 'MESSAGE_TOO_LARGE'
        ORDER BY message.internal_date DESC, message.id DESC LIMIT ${MAX_CONVERSATION_ACTION_MESSAGES}
      ), retried AS (
        UPDATE mail.message_contents message
        SET hydration_status = CASE WHEN message.plain_text IS NOT NULL OR message.sanitized_html IS NOT NULL THEN 'body' ELSE 'envelope' END,
          hydration_attempt = 0, hydration_error_code = NULL
        FROM pending WHERE message.id = pending.id AND message.hydration_status = 'failed'
          AND EXISTS (SELECT 1 FROM mail.remote_message_refs live WHERE live.message_id = message.id AND live.stale_at IS NULL)
      )
      SELECT id FROM pending ORDER BY internal_date DESC, id DESC`;
    return ok({ keep, messageIds: messages.map((message) => message.id) });
  });
  if (!result.ok) return result;
  mailLive.wake();
  // The keep is saved; the mailbox's own hydration loads these later if a job cannot be queued now.
  for (const id of result.data.messageIds) {
    await enqueueMessageHydration(id).catch((error) =>
      log.warn("Failed to queue hydration for a kept message", {
        messageId: id,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  return ok({ ...result.data.keep, canLift: await canLiftConversationKeeps(params.context) });
};
export const releaseConversationKeep = async (
  params: KeepParams & { reason?: string | null },
): Promise<Result<{ conversationId: string; released: boolean }>> => {
  if (!(await canLiftConversationKeeps(params.context))) {
    await recordConversationKeepAudit(params, "mail.conversation.keep.release", "denied", {
      reason: params.reason?.trim().slice(0, 500).toWellFormed() || null,
    });
    return fail(err.forbidden(LIFT_KEEP_FORBIDDEN));
  }
  const reason = params.reason?.trim().toWellFormed() || null;
  if (reason && reason.length > 500) return fail(err.badInput("Reason must be at most 500 characters"));
  const result = await sql.begin(async (db) => {
    // Match the keep/command lock order, including soft-deleted mailboxes. No mailbox grant is required.
    await db`SELECT id FROM mail.mailboxes WHERE id = ${params.mailboxId}::uuid FOR UPDATE`;
    const [conversation] = await db`SELECT id FROM mail.conversations
      WHERE id = ${params.conversationId}::uuid AND mailbox_id = ${params.mailboxId}::uuid FOR UPDATE`;
    if (!conversation) return fail(err.notFound("Conversation"));
    const removed =
      await db`DELETE FROM mail.conversation_keeps WHERE conversation_id = ${params.conversationId}::uuid RETURNING conversation_id`;
    if (removed.length) {
      await db`UPDATE mail.message_placements placement SET deleted_at = now(), updated_at = now()
        FROM mail.remote_message_refs ref, mail.conversation_messages link
        WHERE placement.remote_message_ref_id = ref.id AND ref.stale_at IS NOT NULL
          AND placement.deleted_at IS NULL AND link.message_id = placement.message_id
          AND link.conversation_id = ${params.conversationId}::uuid`;
      await recordKeep(db, params, true, undefined, reason);
    }
    return ok({ conversationId: params.conversationId, released: removed.length > 0 });
  });
  if (result.ok && result.data.released) mailLive.wake();
  return result;
};
