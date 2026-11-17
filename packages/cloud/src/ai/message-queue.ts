import type { SQL } from "bun";
import { sql } from "../runtime/clients";

import { logger } from "../services/logging";
import { coreSettings } from "../services/settings/api";
import { aiChatAccessSubject, isAssistantChatTurn } from "./assistant-models";
import { editAiDraftText } from "./draft-content";
import { canonicalizeAiConversationAttachments } from "./file-context";
import { AI_FILES_MAX_CONVERSATION_BYTES_DEFAULT } from "./files-store";
import { aiInputToUserMessage, aiTurnInputToContent } from "./http";
import { AI_QUEUE_RETRYABLE_ERRORS, AI_QUEUE_SWEEP_INTERVAL_MS, AI_QUEUED_START_TIMEOUT_MS, isAiQueueRetryableError } from "./queue-waits";
import { AiQuotaError, aiQuotas } from "./quotas";
import { aiResourceMarker } from "./resource-markers";
import { readAiSettingsState } from "./settings";
import { aiConversations } from "./store";
import type { AiConversationService, AiDraftContentPart, AiSettingsState } from "./types";
import { isAiSettingsError } from "./validate";

const log = logger("ai:message-queue");
/** Composer capacity agreed for the queue; automation places are counted separately below. */
export const AI_MESSAGE_QUEUE_LIMIT = 20;
/** Separate from composer capacity: bound automation bursts without spending a person's slots. */
export const AUTOMATION_QUEUE_LIMIT = 32;
/** A scheduled source may leave one pending message; its next run must observe chat_busy. */
export const AUTOMATION_QUEUE_SOURCE_LIMIT = 1;
/** Operational breadth per drain, retained at 32 chats to bound serial transactions independently of queue capacity. */
const AI_QUEUE_SWEEP_CHAT_LIMIT = 32;
export class AiMessageQueueConflict extends Error {}

export type QueuedChatSubmission = Parameters<AiConversationService["submitChatTurn"]>[0];
type Submission = QueuedChatSubmission;
export type ValidateQueuedChatStart = ((
  input: Submission,
  db: SQL,
  state: AiSettingsState | undefined,
  messageId: string,
) => Promise<Submission>) & {
  /** One scalar SQL expression over queued row q; wrapped because queries are thenable. */
  expiredReason?: () => Promise<{ expression: SQL.Query<unknown> }>;
};
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
  // Last quota refusal check for fair sweep ordering; also schedules the next dispatch_failed attempt after 15 seconds.
  // This timestamp never proves successful quota admission: assertAllowed runs afresh on every attempt.
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
    created_at timestamptz NOT NULL DEFAULT now()
  )`.simple();
  await sql`CREATE INDEX IF NOT EXISTS ai_chat_send_receipts_key ON ai.chat_send_receipts(account_id,operation,key_hash,created_at DESC)`.simple();
  await sql`CREATE OR REPLACE FUNCTION ai.chat_send_receipt_immutable() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'Chat send receipts are immutable'; END;
    $$ LANGUAGE plpgsql`.simple();
  // The immutable trigger follows a completed backfill, including on earlier versions of this migration.
  // Backfill and trigger commit together now; a failed start can repeat safely without rescanning on every start.
  await sql.begin(async (tx) => {
    await tx`LOCK TABLE ai.chat_send_receipts IN SHARE ROW EXCLUSIVE MODE`;
    const [migration] = await tx<{ done: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid='ai.chat_send_receipts'::regclass AND tgname='chat_send_receipt_immutable') AS done`;
    if (!migration!.done) {
      await tx`INSERT INTO ai.chat_send_receipts(id,account_id,operation,key_hash,input_hash,conversation_id,chat_id,origin,turn_trigger,queued_message_id,created_at)
    SELECT q.id,(q.submission#>>'{runConfig,send,accountId}')::uuid,'ai.chat.send',
      q.submission#>>'{runConfig,send,keyHash}',q.submission#>>'{runConfig,send,requestHash}',q.conversation_id,c.short_id,
      q.origin,q.submission#>'{runConfig,turnTrigger}',q.id,q.created_at
    FROM ai.queued_messages q JOIN ai.conversations c ON c.id=q.conversation_id
      JOIN auth.users owner ON owner.id=(q.submission#>>'{runConfig,send,accountId}')::uuid
    WHERE q.submission#>>'{runConfig,send,keyHash}' IS NOT NULL
      AND q.origin IS NOT NULL AND q.submission#>'{runConfig,turnTrigger}' IS NOT NULL
    ON CONFLICT DO NOTHING`.simple();
      await tx`CREATE TRIGGER chat_send_receipt_immutable BEFORE UPDATE ON ai.chat_send_receipts
        FOR EACH ROW EXECUTE FUNCTION ai.chat_send_receipt_immutable()`.simple();
    }
  });
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
  const rows = await sql<{ id: string; content: AiDraftContentPart[]; status: string; error: string | null }[]>`
    SELECT id, content, status, error FROM ai.queued_messages
    WHERE conversation_id = ${conversationId}::uuid AND (status='pending' OR (status='failed' AND automation_source IS NULL)) ORDER BY position`;
  return rows.map((row) => ({
    id: row.id,
    content: row.content,
    failed: Boolean(row.error),
    error: row.error,
    retrying: row.status === "pending" && row.error === "dispatch_failed",
  }));
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
export const updateQueuedMessage = async (conversationId: string, id: string, action: "cancel" | "retry") => {
  const timeZone = action === "retry" ? (await coreSettings.get<string>("app.timezone")) || "UTC" : "UTC";
  return sql.begin(async (tx) => {
    await tx`SELECT id FROM ai.conversations WHERE id = ${conversationId}::uuid FOR UPDATE`;
    const changed =
      await tx`UPDATE ai.queued_messages SET status = ${action === "cancel" ? "cancelled" : "pending"}, error = NULL, revision=revision+1
    WHERE id = ${id}::uuid AND conversation_id = ${conversationId}::uuid AND (status='pending' OR (status='failed' AND automation_source IS NULL))
      AND (${action}='cancel' OR automation_source IS NULL)
      AND (${action}='cancel' OR NOT (submission->'runConfig' ? 'codeOrigin')
        OR (created_at AT TIME ZONE ${timeZone})::date >= (clock_timestamp() AT TIME ZONE ${timeZone})::date) RETURNING id`;
    if (action === "cancel" && changed.length) {
      await tx`DELETE FROM ai.queued_message_files WHERE message_id = ${id}::uuid`;
      await tx`UPDATE ai.queued_messages SET submission = CASE WHEN submission->'runConfig' ? 'send' THEN jsonb_build_object('runConfig',jsonb_build_object('send',submission#>'{runConfig,send}','turnTrigger',submission#>'{runConfig,turnTrigger}')) ELSE '{}'::jsonb END,
        content = '[]'::jsonb WHERE id = ${id}::uuid`;
    }
    return Boolean(changed.length);
  });
};

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
    content = (${JSON.stringify(content)}::text)::jsonb, revision=revision+1 WHERE id = ${id}::uuid`;
    return true;
  });

/** What a retired entry keeps: only its send receipt and initiator. */
const retiredSubmission = (db: SQL) =>
  db`CASE WHEN submission->'runConfig' ? 'send' THEN jsonb_build_object('runConfig',jsonb_build_object('send',submission#>'{runConfig,send}','turnTrigger',submission#>'{runConfig,turnTrigger}')) ELSE '{}'::jsonb END`;

/** Expired or invalid Code messages leave the queue even while something ahead of them blocks the chat;
 * otherwise one stuck chat would keep its owner's other Codes busy. One statement, bounded by the queue
 * limit; rows another dispatcher holds are left to it. */
const retireExpiredCodeStarts = async (
  expiredReason: NonNullable<ValidateQueuedChatStart["expiredReason"]>,
  conversationId: string | undefined,
) => {
  const { expression: reason } = await expiredReason();
  await sql`WITH expired AS (
      SELECT q.id, ${reason} AS reason FROM ai.queued_messages q
      WHERE q.status='pending' AND q.submission->'runConfig' ? 'codeOrigin' AND ${reason} IS NOT NULL
        AND (${conversationId ?? null}::uuid IS NULL OR q.conversation_id = ${conversationId ?? null}::uuid)
      ORDER BY q.position LIMIT ${AUTOMATION_QUEUE_LIMIT} FOR UPDATE OF q SKIP LOCKED
    ), retired AS (
      UPDATE ai.queued_messages SET status='failed', error=expired.reason, submission=${retiredSubmission(sql)}, content='[]'::jsonb
      FROM expired WHERE ai.queued_messages.id = expired.id RETURNING ai.queued_messages.id
    )
    DELETE FROM ai.queued_message_files f USING retired WHERE f.message_id = retired.id`;
};

/** Read the current payload and revision only after taking the same lock as edits/cancellation. */
export const drainQueuedMessages = async (
  enqueue: (job: { conversationId: string; turnId: string }) => Promise<unknown>,
  conversationId?: string,
  validateStart?: ValidateQueuedChatStart,
) => {
  if (validateStart?.expiredReason)
    await retireExpiredCodeStarts(validateStart.expiredReason, conversationId).catch((error) =>
      log.warn("Expired Code messages could not be retired", {
        code: "queue_expiry_failed",
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  const chats = await sql<{ conversation_id: string; person: boolean }[]>`
    SELECT q.conversation_id,q.automation_source IS NULL AS person FROM ai.queued_messages q JOIN ai.conversations c ON c.id=q.conversation_id
    WHERE (q.status='pending' OR (q.status='failed' AND q.automation_source IS NULL AND q.error IN ${sql([...AI_QUEUE_RETRYABLE_ERRORS])}))
      AND (q.error IS DISTINCT FROM 'dispatch_failed' OR q.quota_checked_at IS NULL
        OR q.quota_checked_at <= clock_timestamp() - (${AI_QUEUE_SWEEP_INTERVAL_MS} * interval '1 millisecond'))
      AND (${Boolean(validateStart)} OR q.automation_source IS NULL)
      AND (q.automation_source IS NOT NULL OR (c.archived_at IS NULL AND c.created_by_user_id IS NOT NULL))
      AND NOT EXISTS (SELECT 1 FROM ai.queued_messages earlier WHERE earlier.conversation_id=q.conversation_id
        AND earlier.position<q.position AND (earlier.status='pending' OR (earlier.status='failed' AND earlier.automation_source IS NULL)))
      AND (${conversationId ?? null}::uuid IS NULL OR q.conversation_id=${conversationId ?? null}::uuid)
      AND NOT EXISTS (SELECT 1 FROM ai.turns t WHERE t.conversation_id=q.conversation_id
        AND NOT COALESCE(t.run_config ? 'background',false) AND t.status IN ('queued','running','waiting_for_action'))
    ORDER BY q.quota_checked_at NULLS FIRST,q.position LIMIT ${AI_QUEUE_SWEEP_CHAT_LIMIT}`;
  for (const chat of chats) {
    // Composer settings use their normal cache; load the catalog snapshot before holding the chat lock.
    const personSettings = chat.person
      ? await readAiSettingsState().then(
          (state) => ({ state }),
          (error: unknown) => ({ error }),
        )
      : undefined;
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
              quota_checked_at: Date | null;
              created_at: Date;
              error: string | null;
              automation_source: string | null;
            }[]
          >`
          SELECT id,submission,revision::text,status,error,automation_source,quota_checked_at,created_at FROM ai.queued_messages
          WHERE conversation_id=${chat.conversation_id}::uuid AND (status='pending' OR (status='failed' AND automation_source IS NULL))
          ORDER BY position LIMIT 1 FOR UPDATE`;
          if (!row || (row.status === "failed" && !isAiQueueRetryableError(row.error))) return null;
          if (!row.automation_source && (!conversation || conversation.archived_at || !conversation.created_by_user_id)) return null;
          // Recheck the retry deadline after locking: another dispatcher may just have failed this head.
          let dispatchExpired = false;
          if (row.error === "dispatch_failed" && row.quota_checked_at) {
            const [retry] = await tx<{ due: boolean; expired: boolean }[]>`SELECT ${row.created_at}::timestamptz <=
              clock_timestamp() - (${AI_QUEUED_START_TIMEOUT_MS} * interval '1 millisecond') AS expired,
              ${row.quota_checked_at}::timestamptz <=
              clock_timestamp() - (${AI_QUEUE_SWEEP_INTERVAL_MS} * interval '1 millisecond') AS due`;
            dispatchExpired = retry!.expired;
            if (!retry!.due && !dispatchExpired) return null;
          }
          const needsSettings = isAssistantChatTurn(row.submission.runConfig) || Boolean(row.submission.runConfig.send);
          // If a different kind of head replaced the selected one, prefetch on the next sweep.
          if (!row.automation_source && needsSettings && !personSettings) return null;
          // Runtime startup/shutdown is not a permanent source refusal. Leave work for the next host sweep.
          if (row.automation_source && !validateStart) return null;
          try {
            // Reuse the queued-turn deadline; composer entries otherwise have no expiry.
            if (dispatchExpired) throw new AiQueuedChatStartError("dispatch_failed");
            // Savepoint prevents a failed submission from committing partial turn/message writes.
            const result = await tx.savepoint(async (attempt) => {
              let input = row.submission;
              if (row.automation_source && !input.runConfig.send) throw new AiQueuedChatStartError("source_restricted");
              if (!row.automation_source && needsSettings && personSettings && "error" in personSettings) throw personSettings.error;
              const state = !needsSettings
                ? undefined
                : row.automation_source
                  ? await readAiSettingsState(attempt)
                  : personSettings && "state" in personSettings
                    ? personSettings.state
                    : undefined;
              if (validateStart && input.runConfig.send) input = await validateStart(input, attempt, state, row.id);
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
            // The savepoint rolled back: lock contention, serialization retries and cancellation leave admission unchanged.
            if (
              typeof error === "object" &&
              error !== null &&
              (("errno" in error && ["55P03", "40P01", "40001", "57014"].includes(String(error.errno))) ||
                ("code" in error && ["55P03", "40P01", "40001", "57014"].includes(String(error.code))))
            )
              return null;
            const reason = error instanceof Error ? error.message : String(error);
            if (reason === "Queued message is no longer ready." || reason.includes("idx_ai_turns_one_active_per_conversation")) return null;
            const code =
              error instanceof AiQuotaError || error instanceof AiQueuedChatStartError
                ? error.code
                : isAiSettingsError(error)
                  ? error.aiError.code
                  : "dispatch_failed";
            const terminal = error instanceof AiQuotaError || error instanceof AiQueuedChatStartError || isAiSettingsError(error);
            await tx`UPDATE ai.queued_messages SET status=${terminal ? "failed" : "pending"},error=${code},
              quota_checked_at=clock_timestamp(),revision=revision+1,
              submission=CASE WHEN ${terminal && Boolean(row.automation_source)} THEN ${retiredSubmission(tx)} ELSE submission END,
              content=CASE WHEN ${terminal && Boolean(row.automation_source)} THEN '[]'::jsonb ELSE content END
              WHERE id=${row.id}::uuid`;
            if (terminal && row.automation_source) await tx`DELETE FROM ai.queued_message_files WHERE message_id=${row.id}::uuid`;
            log.warn("Queued message could not start", {
              conversationId: chat.conversation_id,
              messageId: row.id,
              code,
              retryExpired: dispatchExpired,
              errorType: error instanceof Error ? error.constructor.name : "unknown",
            });
            return terminal && row.automation_source ? { failed: true as const } : null;
          }
        })
        .catch((error: unknown) => {
          log.warn("Queued chat dispatch will be retried", {
            code: "dispatch_failed",
            conversationId: chat.conversation_id,
            errorType: error instanceof Error ? error.constructor.name : "unknown",
          });
          return null;
        });
      if (!outcome) break;
      const { turnId } = outcome;
      if (turnId !== undefined) {
        // A failed wake is recovered by the ordinary turn sweep; never fail an already committed admission.
        await enqueue({ conversationId: chat.conversation_id, turnId }).catch(() =>
          log.warn("Queued turn wake failed", { conversationId: chat.conversation_id, turnId }),
        );
        break;
      }
    }
  }
};
