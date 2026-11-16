import type { SQL } from "bun";
import { sql } from "../runtime/clients";

import { logger } from "../services/logging";
import { aiChatAccessSubject, isAssistantChatTurn } from "./assistant-models";
import { editAiDraftText } from "./draft-content";
import { canonicalizeAiConversationAttachments } from "./file-context";
import { AI_FILES_MAX_CONVERSATION_BYTES_DEFAULT } from "./files-store";
import { aiInputToUserMessage, aiTurnInputToContent } from "./http";
import { AI_QUEUE_RETRYABLE_ERRORS, isAiQueueRetryableError } from "./queue-waits";
import { AiQuotaError, aiQuotas } from "./quotas";
import { aiResourceMarker } from "./resource-markers";
import { aiConversations } from "./store";
import type { AiConversationService, AiDraftContentPart } from "./types";

const log = logger("ai:message-queue");
export const AI_MESSAGE_QUEUE_LIMIT = 32;
export class AiMessageQueueConflict extends Error {}

type Submission = Parameters<AiConversationService["submitChatTurn"]>[0];

export const migrateAiMessageQueue = async () => {
  await sql`CREATE TABLE IF NOT EXISTS ai.queued_messages (
    id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES ai.conversations(id) ON DELETE CASCADE,
    position bigint GENERATED ALWAYS AS IDENTITY, submission jsonb NOT NULL, content jsonb NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','failed','submitted','cancelled')),
    error text, created_at timestamptz NOT NULL DEFAULT now()
  )`.simple();
  await sql.begin(async (tx) => {
    const [originColumn] = await tx<{ present: boolean }[]>`SELECT EXISTS (
      SELECT 1 FROM information_schema.columns WHERE table_schema='ai' AND table_name='queued_messages' AND column_name='origin'
    ) AS present`;
    await tx`ALTER TABLE ai.queued_messages ADD COLUMN IF NOT EXISTS origin jsonb,
      ADD COLUMN IF NOT EXISTS author_user_id uuid`.simple();
    if (!originColumn!.present)
      await tx`UPDATE ai.queued_messages q SET origin=jsonb_build_object('kind','person','id',COALESCE(q.submission#>>'{runConfig,actor,user,id}',c.created_by_user_id::text)),
        author_user_id=c.created_by_user_id FROM ai.conversations c WHERE c.id=q.conversation_id
        AND COALESCE(q.submission#>>'{runConfig,actor,user,id}',c.created_by_user_id::text) IS NOT NULL`.simple();
  });
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS ai_queued_messages_send_key
    ON ai.queued_messages((submission#>>'{runConfig,send,accountId}'),(submission#>>'{runConfig,send,keyHash}'))
    WHERE submission#>>'{runConfig,send,keyHash}' IS NOT NULL`.simple();
  await sql`ALTER TABLE ai.queued_messages ADD COLUMN IF NOT EXISTS quota_checked_at TIMESTAMPTZ`.simple();
  await sql`CREATE INDEX IF NOT EXISTS ai_queued_messages_pending ON ai.queued_messages(conversation_id, position) WHERE status IN ('pending','failed')`.simple();
  await sql`CREATE TABLE IF NOT EXISTS ai.queued_message_files (
    message_id uuid NOT NULL REFERENCES ai.queued_messages(id) ON DELETE CASCADE,
    path text NOT NULL, bytes bytea NOT NULL, media_type text NOT NULL, size bigint NOT NULL,
    origin text NOT NULL, dictation_recorded_at timestamptz, updated_at timestamptz NOT NULL, version bigint NOT NULL,
    PRIMARY KEY(message_id, path)
  )`.simple();
  await sql`DROP TRIGGER IF EXISTS ai_live_queued_messages_changed ON ai.queued_messages`.simple();
  await sql`CREATE TRIGGER ai_live_queued_messages_changed AFTER INSERT OR DELETE ON ai.queued_messages
    FOR EACH ROW EXECUTE FUNCTION ai.live_conversation_child_changed('conversation-detail,conversation-list')`.simple();
  await sql`DROP TRIGGER IF EXISTS ai_live_queued_messages_updated ON ai.queued_messages`.simple();
  await sql`CREATE TRIGGER ai_live_queued_messages_updated AFTER UPDATE ON ai.queued_messages
    FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.error IS DISTINCT FROM NEW.error OR OLD.content IS DISTINCT FROM NEW.content)
    EXECUTE FUNCTION ai.live_conversation_child_changed('conversation-detail,conversation-list')`.simple();
};

export const listQueuedMessages = async (conversationId: string) => {
  const rows = await sql<{ id: string; content: AiDraftContentPart[]; error: string | null; code: boolean }[]>`
    SELECT id, content, error, submission->'runConfig' ? 'codeOrigin' AS code FROM ai.queued_messages
    WHERE conversation_id = ${conversationId}::uuid AND status IN ('pending','failed') ORDER BY position`;
  // A Code message waiting for an allowance is still queued, as the send status reports it.
  return rows.map((row) => ({
    id: row.id,
    content: row.content,
    failed: Boolean(row.error) && !(row.code && isAiQueueRetryableError(row.error)),
  }));
};

export const queuedMessageAccepted = async (conversationId: string, id: string) => {
  const [row] = await sql`SELECT id FROM ai.queued_messages WHERE id=${id}::uuid AND conversation_id=${conversationId}::uuid`;
  return Boolean(row);
};

export const enqueueChatMessage = async (id: string, input: Submission, content: AiDraftContentPart[], db?: SQL) => {
  const enqueue = async (tx: SQL) => {
    const [conversation] = await tx<{ draft_revision: number; project_id: string | null; created_by_user_id: string | null }[]>`
    SELECT draft_revision, project_id, created_by_user_id FROM ai.conversations WHERE id = ${input.conversationId}::uuid AND archived_at IS NULL FOR UPDATE`;
    if (!conversation) throw new AiMessageQueueConflict("Conversation not found.");
    const [existing] =
      await tx`SELECT id FROM ai.queued_messages WHERE id = ${id}::uuid AND conversation_id = ${input.conversationId}::uuid`;
    if (existing) return;
    if (input.expectedDraftRevision !== undefined && Number(conversation.draft_revision) !== input.expectedDraftRevision)
      throw new AiMessageQueueConflict("Conversation draft changed before the message was queued.");
    if (conversation.project_id !== input.expectedProjectId)
      throw new AiMessageQueueConflict("Conversation Project changed before the message was queued.");
    const [count] = await tx<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM ai.queued_messages WHERE conversation_id = ${input.conversationId}::uuid AND status IN ('pending','failed')`;
    if (count!.count >= AI_MESSAGE_QUEUE_LIMIT) throw new AiMessageQueueConflict("The message queue is full (32 messages).");
    const [size] = await tx<
      { size: number }[]
    >`SELECT COALESCE(sum(f.size),0)::float8 AS size FROM ai.queued_message_files f JOIN ai.queued_messages q ON q.id = f.message_id WHERE q.conversation_id = ${input.conversationId}::uuid`;
    if (
      Number(size!.size) + (input.runConfig.files?.attached ?? []).reduce((sum, file) => sum + file.size, 0) >
      AI_FILES_MAX_CONVERSATION_BYTES_DEFAULT
    )
      throw new AiMessageQueueConflict("Queued attachments exceed the conversation file budget.");
    const { expectedDraftRevision, ...submission } = input;
    const origin = input.runConfig.writerOrigin ?? null;
    const author = origin?.kind === "person" ? origin.id : null;
    await tx`INSERT INTO ai.queued_messages(id, conversation_id, submission, content, origin, author_user_id)
      VALUES (${id}::uuid, ${input.conversationId}::uuid, (${JSON.stringify(submission)}::text)::jsonb,
        (${JSON.stringify(content)}::text)::jsonb, (${JSON.stringify(origin)}::text)::jsonb, ${author}::uuid)`;
    for (const file of input.runConfig.files?.attached ?? []) {
      const copied =
        await tx`INSERT INTO ai.queued_message_files(message_id,path,bytes,media_type,size,origin,dictation_recorded_at,updated_at,version)
      SELECT ${id}::uuid,path,bytes,media_type,size,origin,dictation_recorded_at,updated_at,version FROM ai.files
      WHERE conversation_id = ${input.conversationId}::uuid AND path = ${file.path} AND version = ${file.version ?? -1} RETURNING path`;
      if (!copied.length) throw new AiMessageQueueConflict("An attached file changed before the message was queued.");
    }
    if (input.expectedDraftRevision !== undefined)
      await tx`UPDATE ai.conversations SET draft_content = '[]'::jsonb, draft_revision = draft_revision + 1, draft_updated_at = now(), last_used_at = now(), done = CASE WHEN done IS TRUE THEN NULL ELSE done END WHERE id = ${input.conversationId}::uuid`;
    else
      await tx`UPDATE ai.conversations SET last_used_at = now(), done = CASE WHEN done IS TRUE THEN NULL ELSE done END WHERE id = ${input.conversationId}::uuid`;
  };
  return db ? enqueue(db) : sql.begin(enqueue);
};

/** Cancellation and retry share the conversation lock with promotion. */
export const updateQueuedMessage = async (conversationId: string, id: string, action: "cancel" | "retry") =>
  sql.begin(async (tx) => {
    await tx`SELECT id FROM ai.conversations WHERE id = ${conversationId}::uuid FOR UPDATE`;
    const changed = await tx`UPDATE ai.queued_messages SET status = ${action === "cancel" ? "cancelled" : "pending"}, error = NULL
    WHERE id = ${id}::uuid AND conversation_id = ${conversationId}::uuid AND status IN ('pending','failed') RETURNING id`;
    if (action === "cancel" && changed.length) {
      await tx`DELETE FROM ai.queued_message_files WHERE message_id = ${id}::uuid`;
      await tx`UPDATE ai.queued_messages SET submission = CASE WHEN submission->'runConfig' ? 'send' THEN jsonb_build_object('runConfig',jsonb_build_object('send',submission#>'{runConfig,send}','turnTrigger',submission#>'{runConfig,turnTrigger}')) ELSE '{}'::jsonb END,
        content = '[]'::jsonb WHERE id = ${id}::uuid`;
    }
    return Boolean(changed.length);
  });

/** Edit only queued text; immutable attachments and the independent composer draft stay intact. */
/** Text from a source without a signed-in session restricts the queued turn; editing stays possible. */
export const editQueuedMessage = async (conversationId: string, id: string, text: string, source: { signedInSession: boolean }) =>
  sql.begin(async (tx) => {
    await tx`SELECT id FROM ai.conversations WHERE id = ${conversationId}::uuid FOR UPDATE`;
    const [row] = await tx<{ submission: Submission; content: AiDraftContentPart[] }[]>`SELECT submission, content FROM ai.queued_messages
    WHERE id = ${id}::uuid AND conversation_id = ${conversationId}::uuid AND status IN ('pending','failed') FOR UPDATE`;
    if (!row) return false;
    if (row.submission.runConfig.writerOrigin && row.submission.runConfig.writerOrigin.kind !== "person") return false;
    const content = editAiDraftText(row.content, text);
    const parts = content.map((part) =>
      part.type === "text"
        ? part
        : part.type === "project-file"
          ? { type: "text" as const, text: `Project file: ${part.path}` }
          : part.type === "file"
            ? { type: "attachment" as const, path: part.path, mediaType: part.mediaType, size: part.size }
            : { type: "text" as const, text: aiResourceMarker({ ref: part.ref, title: part.title, icon: part.icon, href: part.href }) },
    );
    const { message } = aiInputToUserMessage(aiTurnInputToContent({ content: parts }));
    const userMessage = canonicalizeAiConversationAttachments(message, row.submission.runConfig.files);
    if (userMessage.role !== "user") throw new Error("Queued message must be a user message.");
    const submission = {
      ...row.submission,
      userMessage,
      runConfig: {
        ...row.submission.runConfig,
        ...(source.signedInSession ? {} : { sourceRestricted: true as const }),
        input: userMessage.content,
        selectedSkillIds: [
          ...new Set(content.flatMap((part) => (part.type === "resource" && part.ref.type === "core.ai.skill" ? [part.ref.id] : []))),
        ],
      },
    };
    await tx`UPDATE ai.queued_messages SET submission = (${JSON.stringify(submission)}::text)::jsonb,
    content = (${JSON.stringify(content)}::text)::jsonb WHERE id = ${id}::uuid`;
    return true;
  });

/** Existing turn creation owns execution and recovery; the DB lock owns FIFO and deduplication. */
/** Host-owned check right before a Code-started entry becomes a turn. A refusal listed in
 * AI_QUEUE_RETRYABLE_ERRORS keeps the entry waiting; any other refusal cancels it. */
export type AdmitQueuedCodeStart = (submission: Submission, messageId: string) => Promise<string | null>;

/** Remove a queued entry for good, keeping only its send receipt and initiator. */
const retireQueuedMessage = async (id: string, error: string) => {
  await sql.begin(async (tx) => {
    const changed = await tx`UPDATE ai.queued_messages SET status='cancelled', error=${error},
        submission = CASE WHEN submission->'runConfig' ? 'send' THEN jsonb_build_object('runConfig',jsonb_build_object('send',submission#>'{runConfig,send}','turnTrigger',submission#>'{runConfig,turnTrigger}')) ELSE '{}'::jsonb END,
        content='[]'::jsonb
      WHERE id=${id}::uuid AND status IN ('pending','failed') RETURNING id`;
    if (changed.length) await tx`DELETE FROM ai.queued_message_files WHERE message_id=${id}::uuid`;
  });
};

export const drainQueuedMessages = async (
  enqueue: (job: { conversationId: string; turnId: string }) => Promise<unknown>,
  conversationId?: string,
  admitCodeStart?: AdmitQueuedCodeStart,
) => {
  const waits = sql([...AI_QUEUE_RETRYABLE_ERRORS]);
  // A Code message waiting for its allowance never holds back the person's later messages.
  const rows = await sql<{ id: string; conversation_id: string; submission: Submission }[]>`
    SELECT q.id, q.conversation_id, q.submission FROM ai.queued_messages q
    JOIN ai.conversations c ON c.id = q.conversation_id
    WHERE (q.status = 'pending' OR (q.status = 'failed' AND q.error IN ${waits})) AND c.archived_at IS NULL AND c.created_by_user_id IS NOT NULL
      AND (${conversationId ?? null}::uuid IS NULL OR q.conversation_id = ${conversationId ?? null}::uuid)
      AND NOT EXISTS (SELECT 1 FROM ai.queued_messages earlier WHERE earlier.conversation_id = q.conversation_id AND earlier.position < q.position
        AND (earlier.status = 'pending' OR (earlier.status = 'failed' AND NOT (earlier.submission->'runConfig' ? 'codeOrigin' AND earlier.error IN ${waits}))))
      AND NOT EXISTS (SELECT 1 FROM ai.turns t WHERE t.conversation_id = q.conversation_id AND NOT COALESCE(t.run_config ? 'background', false) AND t.status IN ('queued','running','waiting_for_action'))
    ORDER BY q.quota_checked_at NULLS FIRST, q.position LIMIT ${AI_MESSAGE_QUEUE_LIMIT}`;
  for (const row of rows) {
    try {
      if (row.submission.runConfig.codeOrigin) {
        // Code without a host check stays queued for the next sweep instead of starting unchecked.
        if (!admitCodeStart) continue;
        // A failing host check is not a refusal: the message keeps waiting for the next sweep.
        const refused = await admitCodeStart(row.submission, row.id).catch(() => undefined);
        if (refused === undefined) continue;
        if (refused && isAiQueueRetryableError(refused)) {
          await sql`UPDATE ai.queued_messages SET status='failed', error=${refused}, quota_checked_at=clock_timestamp() WHERE id=${row.id}::uuid AND status IN ('pending','failed')`;
          continue;
        }
        if (refused) {
          await retireQueuedMessage(row.id, refused);
          continue;
        }
      }
      const quotaSubject = aiChatAccessSubject(row.submission.runConfig.actor);
      if (isAssistantChatTurn(row.submission.runConfig) && quotaSubject) await aiQuotas.assertAllowed(quotaSubject, row.submission.modelId);
      // Back to pending and the turn itself commit together under the chat lock, or not at all.
      const result = await sql.begin(async (tx) => {
        await tx`SELECT id FROM ai.conversations WHERE id=${row.conversation_id}::uuid FOR UPDATE`;
        await tx`UPDATE ai.queued_messages SET status='pending', error=NULL WHERE id=${row.id}::uuid AND status='failed' AND error IN ${tx([...AI_QUEUE_RETRYABLE_ERRORS])}`;
        return aiConversations.submitChatTurn({ ...row.submission, queuedMessageId: row.id }, tx);
      });
      await enqueue({ conversationId: row.conversation_id, turnId: result.turn.id });
    } catch (error) {
      if (error instanceof AiQuotaError) {
        await sql`UPDATE ai.queued_messages SET status='failed', error=${error.code}, quota_checked_at=clock_timestamp() WHERE id=${row.id}::uuid AND status IN ('pending','failed')`;
        continue;
      }
      // Another dispatcher may have consumed it or a new foreground turn may have won.
      const reason = error instanceof Error ? error.message : String(error);
      if (reason === "Queued message is no longer ready." || reason.includes("idx_ai_turns_one_active_per_conversation")) continue;
      // A Code message that cannot start is withdrawn with its reason; it never holds the chat or its owner.
      if (row.submission.runConfig.codeOrigin) await retireQueuedMessage(row.id, "dispatch_failed");
      else
        await sql`UPDATE ai.queued_messages SET status = 'failed', error = 'dispatch_failed' WHERE id = ${row.id}::uuid AND status = 'pending'`;
      log.error("Queued message dispatch failed", {
        conversationId: row.conversation_id,
        messageId: row.id,
        code: "queue_dispatch_failed",
        errorType: error instanceof Error ? error.name : "unknown",
      });
    }
  }
};
