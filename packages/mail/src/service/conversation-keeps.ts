import { audit, logger } from "@k2b/cloud/services";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { MAX_CONVERSATION_ACTION_MESSAGES } from "../contracts";
import { requireMailboxPermission } from "./access";
import { actorRefFromRequest, auditActorFromRequest, type MailRequestContext } from "./auth";
import { insertActivity } from "./collaboration";
import { mailLive } from "./live";
import { enqueueMessageHydration } from "./sync-runtime";

const log = logger("mail:conversation-keeps");

type SqlClient = typeof sql;
export type ConversationKeep = {
  conversationId: string;
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
const loadKeep = async (db: SqlClient, conversationId: string): Promise<ConversationKeep | null> => {
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
  permission: "read" | "write" | "admin",
  db: SqlClient,
  lock = false,
): Promise<Result<void>> => {
  // Same mailbox lock order as command creation, including folder commands with many conversations.
  if (lock) await db`SELECT id FROM mail.mailboxes WHERE id = ${params.mailboxId}::uuid FOR UPDATE`;
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, permission, db);
  if (!allowed.ok) return allowed;
  const [conversation] = await db`SELECT id FROM mail.conversations
    WHERE id = ${params.conversationId}::uuid AND mailbox_id = ${params.mailboxId}::uuid
    ${lock ? sql`FOR UPDATE` : sql``}`;
  return conversation ? ok() : fail(err.notFound("Conversation"));
};
export const getConversationKeep = async (params: KeepParams): Promise<Result<ConversationKeep | null>> => {
  const allowed = await requireConversation(params, "read", sql);
  return allowed.ok ? ok(await loadKeep(sql, params.conversationId)) : allowed;
};
const recordKeep = async (db: SqlClient, params: KeepParams, release: boolean): Promise<void> => {
  await insertActivity({
    db,
    ...params,
    action: release ? "conversation.keep_released" : "conversation.kept",
    targetType: "conversation",
    targetId: params.conversationId,
  });
  await audit.record(
    {
      action: release ? "mail.conversation.keep.release" : "mail.conversation.keep",
      outcome: "allowed",
      actor: auditActorFromRequest(params.context),
      target: { type: "conversation", id: params.conversationId },
      requestId: params.context.requestId,
      metadata: { mailboxId: params.mailboxId },
    },
    db,
  );
};
export const keepConversation = async (params: KeepParams): Promise<Result<ConversationKeep>> => {
  const result = await sql.begin(async (db) => {
    const allowed = await requireConversation(params, "write", db, true);
    if (!allowed.ok) return allowed;
    const actor = actorRefFromRequest(params.context);
    const actorId = actor.kind === "user" ? actor.userId : actor.kind === "service_account" ? actor.serviceAccountId : null;
    const inserted = await db`INSERT INTO mail.conversation_keeps (conversation_id, mailbox_id, kept_by_kind, kept_by_id)
      VALUES (${params.conversationId}::uuid, ${params.mailboxId}::uuid, ${actor.kind}, ${actorId}::uuid)
      ON CONFLICT DO NOTHING RETURNING conversation_id`;
    if (inserted.length) await recordKeep(db, params, false);
    const keep = await loadKeep(db, params.conversationId);
    if (!keep) throw new Error("Conversation keep insert returned no row");
    const messages = await db<{ id: string }[]>`SELECT message.id FROM mail.message_contents message
      JOIN mail.conversation_messages link ON link.message_id = message.id
      WHERE link.conversation_id = ${params.conversationId}::uuid AND message.hydration_status <> 'complete'
      ORDER BY message.internal_date DESC, message.id DESC LIMIT ${MAX_CONVERSATION_ACTION_MESSAGES}`;
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
  return ok(result.data.keep);
};
export const releaseConversationKeep = async (params: KeepParams): Promise<Result<{ conversationId: string; released: boolean }>> => {
  const result = await sql.begin(async (db) => {
    const allowed = await requireConversation(params, "admin", db, true);
    if (!allowed.ok) {
      return allowed.error.code === "FORBIDDEN"
        ? fail(err.forbidden("Only people who manage this mailbox can stop keeping a conversation"))
        : allowed;
    }
    const removed =
      await db`DELETE FROM mail.conversation_keeps WHERE conversation_id = ${params.conversationId}::uuid RETURNING conversation_id`;
    if (removed.length) {
      await db`UPDATE mail.message_placements placement SET deleted_at = now(), updated_at = now()
        FROM mail.remote_message_refs ref, mail.conversation_messages link
        WHERE placement.remote_message_ref_id = ref.id AND ref.stale_at IS NOT NULL
          AND placement.deleted_at IS NULL AND link.message_id = placement.message_id
          AND link.conversation_id = ${params.conversationId}::uuid`;
      await recordKeep(db, params, true);
    }
    return ok({ conversationId: params.conversationId, released: removed.length > 0 });
  });
  if (result.ok && result.data.released) mailLive.wake();
  return result;
};
