import { aiInputToUserMessage, aiTurnInputToContent } from "./http";
import { canonicalizeAiConversationAttachments } from "./file-context";
import { aiResourceMarker } from "./resource-markers";
import { sql } from "bun";
import type { AiConversationService, AiDraftContentPart } from "./types";
import { aiConversations } from "./store";
import { logger } from "../services/logging";
import { AI_FILES_MAX_CONVERSATION_BYTES_DEFAULT } from "./files-store";

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
  await sql`CREATE INDEX IF NOT EXISTS ai_queued_messages_pending ON ai.queued_messages(conversation_id, position) WHERE status IN ('pending','failed')`.simple();
  await sql`CREATE TABLE IF NOT EXISTS ai.queued_message_files (
    message_id uuid NOT NULL REFERENCES ai.queued_messages(id) ON DELETE CASCADE,
    path text NOT NULL, bytes bytea NOT NULL, media_type text NOT NULL, size bigint NOT NULL,
    origin text NOT NULL, dictation_recorded_at timestamptz, updated_at timestamptz NOT NULL, version bigint NOT NULL,
    PRIMARY KEY(message_id, path)
  )`.simple();
  await sql`DROP TRIGGER IF EXISTS ai_live_queued_messages_changed ON ai.queued_messages`.simple();
  await sql`CREATE TRIGGER ai_live_queued_messages_changed AFTER INSERT OR UPDATE OR DELETE ON ai.queued_messages
    FOR EACH ROW EXECUTE FUNCTION ai.live_conversation_child_changed('conversation-detail,conversation-list')`.simple();
};

export const listQueuedMessages = async (conversationId: string) => {
  const rows = await sql<{ id: string; content: AiDraftContentPart[]; error: string | null }[]>`
    SELECT id, content, error FROM ai.queued_messages
    WHERE conversation_id = ${conversationId}::uuid AND status IN ('pending','failed') ORDER BY position`;
  return rows.map((row) => ({ id: row.id, content: row.content, failed: Boolean(row.error) }));
};

export const queuedMessageAccepted = async (conversationId: string, id: string) => {
  const [row] = await sql`SELECT id FROM ai.queued_messages WHERE id=${id}::uuid AND conversation_id=${conversationId}::uuid`;
  return Boolean(row);
};

export const enqueueChatMessage = async (id: string, input: Submission, content: AiDraftContentPart[]) =>
  sql.begin(async (tx) => {
    const [conversation] = await tx<{ draft_revision: number; project_id: string | null }[]>`
    SELECT draft_revision, project_id FROM ai.conversations WHERE id = ${input.conversationId}::uuid AND archived_at IS NULL FOR UPDATE`;
    if (!conversation) throw new AiMessageQueueConflict("Conversation not found.");
    const [existing] =
      await tx`SELECT id FROM ai.queued_messages WHERE id = ${id}::uuid AND conversation_id = ${input.conversationId}::uuid`;
    if (existing) return;
    if (Number(conversation.draft_revision) !== input.expectedDraftRevision)
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
    await tx`INSERT INTO ai.queued_messages(id, conversation_id, submission, content) VALUES (${id}::uuid, ${input.conversationId}::uuid, (${JSON.stringify(submission)}::text)::jsonb, (${JSON.stringify(content)}::text)::jsonb)`;
    for (const file of input.runConfig.files?.attached ?? []) {
      const copied =
        await tx`INSERT INTO ai.queued_message_files(message_id,path,bytes,media_type,size,origin,dictation_recorded_at,updated_at,version)
      SELECT ${id}::uuid,path,bytes,media_type,size,origin,dictation_recorded_at,updated_at,version FROM ai.files
      WHERE conversation_id = ${input.conversationId}::uuid AND path = ${file.path} AND version = ${file.version ?? -1} RETURNING path`;
      if (!copied.length) throw new AiMessageQueueConflict("An attached file changed before the message was queued.");
    }
    await tx`UPDATE ai.conversations SET draft_content = '[]'::jsonb, draft_revision = draft_revision + 1, draft_updated_at = now(), last_used_at = now(), done = CASE WHEN done IS TRUE THEN NULL ELSE done END WHERE id = ${input.conversationId}::uuid`;
  });

/** Cancellation and retry share the conversation lock with promotion. */
export const updateQueuedMessage = async (conversationId: string, id: string, action: "cancel" | "retry") =>
  sql.begin(async (tx) => {
    await tx`SELECT id FROM ai.conversations WHERE id = ${conversationId}::uuid FOR UPDATE`;
    const changed = await tx`UPDATE ai.queued_messages SET status = ${action === "cancel" ? "cancelled" : "pending"}, error = NULL
    WHERE id = ${id}::uuid AND conversation_id = ${conversationId}::uuid AND status IN ('pending','failed') RETURNING id`;
    if (action === "cancel" && changed.length) {
      await tx`DELETE FROM ai.queued_message_files WHERE message_id = ${id}::uuid`;
      await tx`UPDATE ai.queued_messages SET submission = '{}'::jsonb, content = '[]'::jsonb WHERE id = ${id}::uuid`;
    }
    return Boolean(changed.length);
  });

/** Edit only queued text; immutable attachments and the independent composer draft stay intact. */
export const editQueuedMessage = async (conversationId: string, id: string, text: string) =>
  sql.begin(async (tx) => {
    await tx`SELECT id FROM ai.conversations WHERE id = ${conversationId}::uuid FOR UPDATE`;
    const [row] = await tx<{ submission: Submission; content: AiDraftContentPart[] }[]>`SELECT submission, content FROM ai.queued_messages
    WHERE id = ${id}::uuid AND conversation_id = ${conversationId}::uuid AND status IN ('pending','failed') FOR UPDATE`;
    if (!row) return false;
    const content: AiDraftContentPart[] = [{ type: "text", text }, ...row.content.filter((part) => part.type !== "text")];
    const parts = content.map((part) =>
      part.type === "text"
        ? part
        : part.type === "file"
          ? { type: "attachment" as const, path: part.path, mediaType: part.mediaType, size: part.size }
          : { type: "text" as const, text: aiResourceMarker(part) },
    );
    const { message } = aiInputToUserMessage(aiTurnInputToContent({ content: parts }));
    const userMessage = canonicalizeAiConversationAttachments(message, row.submission.runConfig.files);
    if (userMessage.role !== "user") throw new Error("Queued message must be a user message.");
    const submission = { ...row.submission, userMessage, runConfig: { ...row.submission.runConfig, input: userMessage.content } };
    await tx`UPDATE ai.queued_messages SET submission = (${JSON.stringify(submission)}::text)::jsonb,
    content = (${JSON.stringify(content)}::text)::jsonb WHERE id = ${id}::uuid`;
    return true;
  });

/** Existing turn creation owns execution and recovery; the DB lock owns FIFO and deduplication. */
export const drainQueuedMessages = async (
  enqueue: (job: { conversationId: string; turnId: string }) => Promise<unknown>,
  conversationId?: string,
) => {
  const rows = await sql<{ id: string; conversation_id: string; submission: Submission }[]>`
    SELECT q.id, q.conversation_id, q.submission FROM ai.queued_messages q
    JOIN ai.conversations c ON c.id = q.conversation_id
    WHERE q.status = 'pending' AND c.archived_at IS NULL AND c.created_by_user_id IS NOT NULL
      AND (${conversationId ?? null}::uuid IS NULL OR q.conversation_id = ${conversationId ?? null}::uuid)
      AND NOT EXISTS (SELECT 1 FROM ai.queued_messages earlier WHERE earlier.conversation_id = q.conversation_id AND earlier.position < q.position AND earlier.status IN ('pending','failed'))
      AND NOT EXISTS (SELECT 1 FROM ai.turns t WHERE t.conversation_id = q.conversation_id AND t.status IN ('queued','running','waiting_for_action'))
    ORDER BY q.position LIMIT ${AI_MESSAGE_QUEUE_LIMIT}`;
  for (const row of rows) {
    try {
      const result = await aiConversations.submitChatTurn({ ...row.submission, queuedMessageId: row.id });
      await enqueue({ conversationId: row.conversation_id, turnId: result.turn.id });
    } catch (error) {
      // Another dispatcher may have consumed it or a new foreground turn may have won.
      const reason = error instanceof Error ? error.message : String(error);
      if (reason === "Queued message is no longer ready." || reason.includes("idx_ai_turns_one_active_per_conversation")) continue;
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
