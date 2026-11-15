import type { SQL } from "bun";
import { sql } from "../runtime/clients";

import { logger } from "../services/logging";
import { aiChatAccessSubject, isAssistantChatTurn } from "./assistant-models";
import { editAiDraftText } from "./draft-content";
import { canonicalizeAiConversationAttachments } from "./file-context";
import { AI_FILES_MAX_CONVERSATION_BYTES_DEFAULT } from "./files-store";
import { aiInputToUserMessage, aiTurnInputToContent } from "./http";
import { AiQuotaError, aiQuotas } from "./quotas";
import { aiResourceMarker } from "./resource-markers";
import { readAiSettingsState } from "./settings";
import { aiConversations } from "./store";
import type { AiConversationService, AiDraftContentPart, AiSettingsState } from "./types";

const log = logger("ai:message-queue");
export const AI_MESSAGE_QUEUE_LIMIT = 32;
/** Separate from composer capacity: bound automation bursts without spending a person's slots. */
export const AUTOMATION_QUEUE_LIMIT = 32;
/** A scheduled source may leave one pending message; its next run must observe chat_busy. */
export const AUTOMATION_QUEUE_SOURCE_LIMIT = 1;
export class AiMessageQueueConflict extends Error {}

export type QueuedChatSubmission = Parameters<AiConversationService["submitChatTurn"]>[0];
type Submission = QueuedChatSubmission;
export type ValidateQueuedChatStart = (input: Submission, db: SQL, state?: AiSettingsState) => Promise<Submission>;
export class AiQueuedChatStartError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const automationSource = (input: Submission) => {
  const origin = input.runConfig.writerOrigin;
  return origin && origin.kind !== "person" ? `${origin.kind}:${origin.id}` : null;
};

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
  await sql`ALTER TABLE ai.queued_messages ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS automation_source text`.simple();
  await sql`UPDATE ai.queued_messages SET automation_source=(origin->>'kind') || ':' || (origin->>'id')
    WHERE automation_source IS NULL AND origin->>'kind' IN ('automation','chat')`.simple();
  // Admission survives queue payload cleanup and conversation deletion. Only execution state changes elsewhere.
  await sql`CREATE TABLE IF NOT EXISTS ai.chat_send_receipts (
    id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE, operation text NOT NULL CHECK(operation='ai.chat.send'),
    key_hash text NOT NULL, input_hash text NOT NULL, conversation_id uuid NOT NULL, chat_id text NOT NULL,
    origin jsonb NOT NULL, turn_trigger jsonb NOT NULL, queued_message_id uuid NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(account_id,operation,key_hash)
  )`.simple();
  await sql`INSERT INTO ai.chat_send_receipts(id,account_id,operation,key_hash,input_hash,conversation_id,chat_id,origin,turn_trigger,queued_message_id)
    SELECT q.id,(q.submission#>>'{runConfig,send,accountId}')::uuid,'ai.chat.send',
      q.submission#>>'{runConfig,send,keyHash}',q.submission#>>'{runConfig,send,requestHash}',q.conversation_id,c.short_id,
      q.origin,q.submission#>'{runConfig,turnTrigger}',q.id
    FROM ai.queued_messages q JOIN ai.conversations c ON c.id=q.conversation_id
      JOIN auth.users owner ON owner.id=(q.submission#>>'{runConfig,send,accountId}')::uuid
    WHERE q.submission#>>'{runConfig,send,keyHash}' IS NOT NULL
      AND q.origin IS NOT NULL AND q.submission#>'{runConfig,turnTrigger}' IS NOT NULL
    ON CONFLICT DO NOTHING`.simple();
  await sql`CREATE OR REPLACE FUNCTION ai.chat_send_receipt_immutable() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'Chat send receipts are immutable'; END;
    $$ LANGUAGE plpgsql`.simple();
  await sql`DROP TRIGGER IF EXISTS chat_send_receipt_immutable ON ai.chat_send_receipts`.simple();
  await sql`CREATE TRIGGER chat_send_receipt_immutable BEFORE UPDATE ON ai.chat_send_receipts
    FOR EACH ROW EXECUTE FUNCTION ai.chat_send_receipt_immutable()`.simple();
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
  const rows = await sql<{ id: string; content: AiDraftContentPart[]; error: string | null }[]>`
    SELECT id, content, error FROM ai.queued_messages
    WHERE conversation_id = ${conversationId}::uuid AND (status='pending' OR (status='failed' AND automation_source IS NULL)) ORDER BY position`;
  return rows.map((row) => ({ id: row.id, content: row.content, failed: Boolean(row.error) }));
};

export const queuedMessageAccepted = async (conversationId: string, id: string) => {
  const [row] = await sql`SELECT id FROM ai.queued_messages WHERE id=${id}::uuid AND conversation_id=${conversationId}::uuid`;
  return Boolean(row);
};

/** Dedicated capability insertion never consumes the person's draft. */
export const enqueueAutomationChatMessage = (id: string, input: Submission, content: AiDraftContentPart[], db: SQL) => {
  if (input.expectedDraftRevision !== undefined) throw new AiMessageQueueConflict("A send cannot consume a draft.");
  return enqueueChatMessage(id, input, content, db);
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
    const source = automationSource(input);
    const [count] = await tx<{ count: number; same_source: number }[]>`
      SELECT count(*)::int AS count,count(*) FILTER(WHERE automation_source=${source})::int AS same_source
      FROM ai.queued_messages WHERE conversation_id=${input.conversationId}::uuid
        AND (CASE WHEN ${source}::text IS NULL THEN automation_source IS NULL AND status IN ('pending','failed')
          ELSE automation_source IS NOT NULL AND status='pending' END)`;
    if (
      source
        ? count!.count >= AUTOMATION_QUEUE_LIMIT || count!.same_source >= AUTOMATION_QUEUE_SOURCE_LIMIT
        : count!.count >= AI_MESSAGE_QUEUE_LIMIT
    )
      throw new AiMessageQueueConflict("The message queue has no free slot for this source.");
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
    await tx`INSERT INTO ai.queued_messages(id, conversation_id, submission, content, origin, author_user_id, automation_source)
      VALUES (${id}::uuid, ${input.conversationId}::uuid, (${JSON.stringify(submission)}::text)::jsonb,
        (${JSON.stringify(content)}::text)::jsonb, (${JSON.stringify(origin)}::text)::jsonb, ${author}::uuid, ${source})`;
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
    const changed =
      await tx`UPDATE ai.queued_messages SET status = ${action === "cancel" ? "cancelled" : "pending"}, error = NULL, revision=revision+1
    WHERE id = ${id}::uuid AND conversation_id = ${conversationId}::uuid AND (status='pending' OR (status='failed' AND automation_source IS NULL))
      AND (${action}='cancel' OR automation_source IS NULL) RETURNING id`;
    if (action === "cancel" && changed.length) {
      await tx`DELETE FROM ai.queued_message_files WHERE message_id = ${id}::uuid`;
      await tx`UPDATE ai.queued_messages SET submission = CASE WHEN submission->'runConfig' ? 'send' THEN jsonb_build_object('runConfig',jsonb_build_object('send',submission#>'{runConfig,send}','turnTrigger',submission#>'{runConfig,turnTrigger}')) ELSE '{}'::jsonb END,
        content = '[]'::jsonb WHERE id = ${id}::uuid`;
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
        input: userMessage.content,
        selectedSkillIds: [
          ...new Set(content.flatMap((part) => (part.type === "resource" && part.ref.type === "core.ai.skill" ? [part.ref.id] : []))),
        ],
      },
    };
    await tx`UPDATE ai.queued_messages SET submission = (${JSON.stringify(submission)}::text)::jsonb,
    content = (${JSON.stringify(content)}::text)::jsonb, revision=revision+1 WHERE id = ${id}::uuid`;
    return true;
  });

/** Read the current payload and revision only after taking the same lock as edits/cancellation. */
export const drainQueuedMessages = async (
  enqueue: (job: { conversationId: string; turnId: string }) => Promise<unknown>,
  conversationId?: string,
  validateStart?: ValidateQueuedChatStart,
) => {
  const chats = await sql<{ conversation_id: string }[]>`
    SELECT q.conversation_id FROM ai.queued_messages q JOIN ai.conversations c ON c.id=q.conversation_id
    WHERE (q.status='pending' OR (q.status='failed' AND q.automation_source IS NULL AND q.error IN ('quota_exhausted','quota_usage_unknown')))
      AND (${Boolean(validateStart)} OR q.automation_source IS NULL)
      AND (q.automation_source IS NOT NULL OR (c.archived_at IS NULL AND c.created_by_user_id IS NOT NULL))
      AND NOT EXISTS (SELECT 1 FROM ai.queued_messages earlier WHERE earlier.conversation_id=q.conversation_id
        AND earlier.position<q.position AND (earlier.status='pending' OR (earlier.status='failed' AND earlier.automation_source IS NULL)))
      AND (${conversationId ?? null}::uuid IS NULL OR q.conversation_id=${conversationId ?? null}::uuid)
      AND NOT EXISTS (SELECT 1 FROM ai.turns t WHERE t.conversation_id=q.conversation_id
        AND NOT COALESCE(t.run_config ? 'background',false) AND t.status IN ('queued','running','waiting_for_action'))
    ORDER BY q.quota_checked_at NULLS FIRST,q.position LIMIT ${AI_MESSAGE_QUEUE_LIMIT}`;
  for (const chat of chats) {
    // At most the automation capacity can fail in one drain; person failures still stop FIFO.
    for (let remaining = AUTOMATION_QUEUE_LIMIT + 1; remaining > 0; remaining--) {
      const outcome = await sql
        .begin(async (tx) => {
          const [conversation] = await tx<{ archived_at: unknown; created_by_user_id: string | null }[]>`
          SELECT archived_at,created_by_user_id FROM ai.conversations WHERE id=${chat.conversation_id}::uuid FOR UPDATE`;
          const [busy] = await tx`SELECT id FROM ai.turns WHERE conversation_id=${chat.conversation_id}::uuid
          AND NOT COALESCE(run_config ? 'background',false) AND status IN ('queued','running','waiting_for_action') LIMIT 1`;
          if (busy) return null;
          const [row] = await tx<
            {
              id: string;
              submission: Submission;
              revision: string;
              status: string;
              error: string | null;
              automation_source: string | null;
            }[]
          >`
          SELECT id,submission,revision::text,status,error,automation_source FROM ai.queued_messages
          WHERE conversation_id=${chat.conversation_id}::uuid AND (status='pending' OR (status='failed' AND automation_source IS NULL))
          ORDER BY position LIMIT 1 FOR UPDATE`;
          if (!row || (row.status === "failed" && !["quota_exhausted", "quota_usage_unknown"].includes(row.error ?? ""))) return null;
          if (!row.automation_source && (!conversation || conversation.archived_at || !conversation.created_by_user_id)) return null;
          // Runtime startup/shutdown is not a permanent source refusal. Leave work for the next host sweep.
          if (row.automation_source && !validateStart) return null;
          try {
            // Savepoint prevents a failed submission from committing partial turn/message writes.
            const result = await tx.savepoint(async (attempt) => {
              let input = row.submission;
              if (row.automation_source && !input.runConfig.send) throw new AiQueuedChatStartError("source_restricted");
              const state = isAssistantChatTurn(input.runConfig) || input.runConfig.send ? await readAiSettingsState(attempt) : undefined;
              if (validateStart && input.runConfig.send) input = await validateStart(input, attempt, state);
              await attempt`UPDATE ai.queued_messages SET submission=(${JSON.stringify(input)}::text)::jsonb WHERE id=${row.id}::uuid`;
              input = { ...input, queuedMessageId: row.id, queuedMessageRevision: row.revision };
              const quotaSubject = aiChatAccessSubject(input.runConfig.actor);
              if (isAssistantChatTurn(input.runConfig) && quotaSubject)
                await aiQuotas.assertAllowed(quotaSubject, input.modelId, state, attempt);
              await attempt`UPDATE ai.queued_messages SET status='pending',error=NULL WHERE id=${row.id}::uuid`;
              return aiConversations.submitChatTurn(input, attempt);
            });
            return { turnId: result.turn.id };
          } catch (error) {
            if (
              typeof error === "object" &&
              error !== null &&
              (("errno" in error && ["40P01", "40001", "55P03", "57014"].includes(String(error.errno))) ||
                ("code" in error && ["40P01", "40001", "55P03", "57014"].includes(String(error.code))))
            )
              return null;
            const reason = error instanceof Error ? error.message : String(error);
            if (reason === "Queued message is no longer ready." || reason.includes("idx_ai_turns_one_active_per_conversation")) return null;
            const code = error instanceof AiQuotaError || error instanceof AiQueuedChatStartError ? error.code : "dispatch_failed";
            await tx`UPDATE ai.queued_messages SET status='failed',error=${code},quota_checked_at=clock_timestamp(),revision=revision+1 WHERE id=${row.id}::uuid`;
            if (row.automation_source) await tx`DELETE FROM ai.queued_message_files WHERE message_id=${row.id}::uuid`;
            log.warn("Queued message could not start", { conversationId: chat.conversation_id, messageId: row.id, code });
            return row.automation_source ? { failed: true as const } : null;
          }
        })
        .catch((error: unknown) => {
          log.warn("Queued chat dispatch will be retried", {
            conversationId: chat.conversation_id,
            errorType: error instanceof Error ? error.name : "unknown",
          });
          return null;
        });
      if (!outcome) break;
      if ("turnId" in outcome) {
        // A failed wake is recovered by the ordinary turn sweep; never fail an already committed admission.
        await enqueue({ conversationId: chat.conversation_id, turnId: outcome.turnId }).catch(() =>
          log.warn("Queued turn wake failed", { conversationId: chat.conversation_id, turnId: outcome.turnId }),
        );
        break;
      }
    }
  }
};
