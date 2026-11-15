import type { Message } from "@k2b/nessi";
import { sql } from "../runtime/clients";
import { logger } from "../services/logging";
import { toPgTextArray } from "../services/postgres";
import { isUnknownActionOutcome } from "./action-review";
import { aiChatAccessSubject, isAssistantChatTurn } from "./assistant-models";
import { assertPersonalChatWriter } from "./chat-writer";
import { editAiDraftText } from "./draft-content";
import { canonicalizeAiConversationAttachments } from "./file-context";
import { AI_FILES_MAX_CONVERSATION_BYTES_DEFAULT } from "./files-store";
import { aiInputToUserMessage, aiTurnInputToContent } from "./http";
import { type AiOriginViewer, projectAiMessageOrigins } from "./message-origin";
import type { AiQueuedMessage, AiSendQueuedMessageResult } from "./queue-contracts";
import { AI_MESSAGE_QUEUE_LIMIT, type AiStoredMessageOrigin } from "./queue-contracts";
import { aiQueueInterruptionContext, type InterruptedStep } from "./queue-interruption-context";
import { AiQuotaError, aiQuotas } from "./quotas";
import { aiResourceMarker } from "./resource-markers";
import { aiConversations } from "./store";
import { finishAiTurnAbort } from "./turn-abort";
import { AI_ACTION_BUDGET_MS } from "./turn-action-budget";
import { queuedClientInterruptionState } from "./turn-interruption";
import type { AiConversationService, AiDraftContentPart } from "./types";

const log = logger("ai:message-queue");

export { AI_MESSAGE_QUEUE_LIMIT } from "./queue-contracts";
export class AiMessageQueueConflict extends Error {}

type Submission = Parameters<AiConversationService["submitChatTurn"]>[0];

const originForQueueActor = (
  actor: Submission["runConfig"]["actor"],
  conversation: { created_by_user_id: string | null },
): AiStoredMessageOrigin => {
  if (actor?.kind === "user") return { kind: "person", id: actor.user.id };
  if (actor) return { kind: "automation", id: actor.serviceAccount.id };
  if (!conversation.created_by_user_id) throw new AiMessageQueueConflict("A queue writer is required.");
  return { kind: "person", id: conversation.created_by_user_id };
};

export const migrateAiMessageQueue = async () => {
  await sql`CREATE TABLE IF NOT EXISTS ai.queued_messages (
    id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES ai.conversations(id) ON DELETE CASCADE,
    position bigint GENERATED ALWAYS AS IDENTITY, submission jsonb NOT NULL, content jsonb NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','failed','submitted','cancelled')),
    error text, created_at timestamptz NOT NULL DEFAULT now()
  )`.simple();
  await sql`ALTER TABLE ai.queued_messages ADD COLUMN IF NOT EXISTS quota_checked_at TIMESTAMPTZ`.simple();
  await sql`ALTER TABLE ai.queued_messages
    ADD COLUMN IF NOT EXISTS origin jsonb,
    ADD COLUMN IF NOT EXISTS author_user_id uuid,
    ADD COLUMN IF NOT EXISTS send_requested_at timestamptz,
    ADD COLUMN IF NOT EXISTS interrupted_turn_id uuid REFERENCES ai.turns(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS interruption_steps jsonb,
    ADD COLUMN IF NOT EXISTS interruption_deadline timestamptz,
    ADD COLUMN IF NOT EXISTS interruption_client_calls text[],
    ADD COLUMN IF NOT EXISTS submitted_turn_id uuid REFERENCES ai.turns(id) ON DELETE SET NULL`.simple();
  // Legacy entries belonged to the chat owner. Never discard an existing queue above the new limit.
  await sql`UPDATE ai.queued_messages q SET origin = jsonb_build_object('kind','person','id',COALESCE(q.submission#>>'{runConfig,actor,user,id}',c.created_by_user_id::text,'unknown')),
    author_user_id = c.created_by_user_id FROM ai.conversations c WHERE c.id=q.conversation_id AND q.origin IS NULL`.simple();
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS ai_queued_messages_one_send_now ON ai.queued_messages(conversation_id)
    WHERE send_requested_at IS NOT NULL AND status IN ('pending','failed')`.simple();
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
    FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.error IS DISTINCT FROM NEW.error OR OLD.content IS DISTINCT FROM NEW.content OR OLD.send_requested_at IS DISTINCT FROM NEW.send_requested_at)
    EXECUTE FUNCTION ai.live_conversation_child_changed('conversation-detail,conversation-list')`.simple();
};

export const listQueuedMessages = async (
  conversationId: string,
  viewer: AiOriginViewer = {},
): Promise<Array<AiQueuedMessage & { failed: boolean }>> => {
  const rows = await sql<
    {
      id: string;
      content: AiDraftContentPart[];
      error: string | null;
      origin: AiStoredMessageOrigin;
      author_user_id: string | null;
      created_at: Date;
      send_requested_at: Date | null;
    }[]
  >`
    SELECT id, content, error, origin, author_user_id, created_at, send_requested_at FROM ai.queued_messages
    WHERE conversation_id = ${conversationId}::uuid AND status IN ('pending','failed') ORDER BY position`;
  const origins = await projectAiMessageOrigins(
    rows.map((row) => row.origin),
    viewer,
  );
  return rows.map((row, index) => ({
    id: row.id,
    content: row.content,
    text: row.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n"),
    origin: origins[index]!,
    state: row.send_requested_at ? "sending" : row.error ? "failed" : "pending",
    createdAt: new Date(row.created_at).toISOString(),
    authorIsViewer: Boolean(viewer.userId && row.author_user_id === viewer.userId),
    failed: Boolean(row.error),
  }));
};

/** Durable receipt survives promotion and cancellation; absence from the queue is never proof of failure. */
export const queuedMessageReceipt = async (conversationId: string, id: string): Promise<AiSendQueuedMessageResult | null> => {
  const [row] = await sql<{ status: string; send_requested_at: Date | null; turn_id: string | null }[]>`
    SELECT q.status, q.send_requested_at, t.short_id AS turn_id FROM ai.queued_messages q
    LEFT JOIN ai.turns t ON t.id=q.submitted_turn_id WHERE q.id=${id}::uuid AND q.conversation_id=${conversationId}::uuid`;
  return row
    ? { id, state: row.status === "submitted" ? "submitted" : row.send_requested_at ? "sending" : "failed", turnId: row.turn_id }
    : null;
};

/** One serialized request. An entry keeps its FIFO position even when explicitly sent ahead. */
export const requestQueuedMessageSendNow = async (conversationId: string, id: string) =>
  sql.begin(async (tx) => {
    const [conversation] = await tx`SELECT id FROM ai.conversations WHERE id=${conversationId}::uuid AND archived_at IS NULL FOR UPDATE`;
    if (!conversation) return null;
    const [entry] = await tx<{ status: string; send_requested_at: Date | null }[]>`
    SELECT status,send_requested_at FROM ai.queued_messages WHERE id=${id}::uuid AND conversation_id=${conversationId}::uuid`;
    if (!entry || entry.status === "cancelled") return null;
    if (entry.status === "submitted" || entry.send_requested_at) return { interrupt: null };
    const [other] = await tx`SELECT id FROM ai.queued_messages WHERE conversation_id=${conversationId}::uuid
    AND status IN ('pending','failed') AND send_requested_at IS NOT NULL`;
    if (other) throw new AiMessageQueueConflict("Another queued message is being sent.");
    const [active] = await tx<{ id: string }[]>`SELECT id FROM ai.turns WHERE conversation_id=${conversationId}::uuid
    AND NOT COALESCE(run_config ? 'background',false) AND status IN ('queued','running','waiting_for_action') FOR UPDATE`;
    const [client] = active
      ? await tx<{ deadline: Date; call_ids: string[] }[]>`SELECT array_agg(p.call_id) AS call_ids, LEAST(t.deadline,
      min(p.created_at) + (${AI_ACTION_BUDGET_MS} * interval '1 millisecond')) AS deadline
    FROM ai.pending_actions p JOIN ai.turns t ON t.id=p.turn_id WHERE p.turn_id=${active.id}::uuid
    AND p.kind='client_tool' AND (p.status='pending' OR (p.status='resolved' AND NOT p.consumed_inline
      AND NOT EXISTS (SELECT 1 FROM ai.messages m WHERE m.loop_id=p.turn_id::text AND m.role='tool_result'
        AND m.message->>'callId'=regexp_replace(p.call_id,'-client-[0-9]+$','')))) GROUP BY t.deadline`
      : [];
    const interrupt = active
      ? await aiConversations.requestTurnAbort({ conversationId, turnId: active.id, reason: "queue_interrupt" }, { db: tx })
      : null;
    const steps = active
      ? await tx<{ call_id: string; tool_name: string; started: boolean }[]>`
    SELECT call_id,tool_name,started_at IS NOT NULL AS started FROM ai.tool_calls WHERE turn_id=${active.id}::uuid
    AND completed_at IS NULL ORDER BY started_at NULLS LAST,call_id`
      : [];
    await tx`UPDATE ai.queued_messages SET send_requested_at=clock_timestamp(), interrupted_turn_id=${active?.id ?? null}::uuid,
    interruption_deadline=${client?.deadline ?? null}, interruption_client_calls=${toPgTextArray(client?.call_ids)}::text[],
    interruption_steps=${JSON.stringify(steps.map((step) => ({ callId: step.call_id, name: step.tool_name, started: step.started })))}::jsonb,
    status='pending', error=NULL WHERE id=${id}::uuid`;
    return { interrupt: active && interrupt ? { turnId: active.id, request: interrupt, waitingForClient: Boolean(client) } : null };
  });

export const queuedMessageAccepted = async (conversationId: string, id: string) => {
  const [row] = await sql`SELECT id FROM ai.queued_messages WHERE id=${id}::uuid AND conversation_id=${conversationId}::uuid`;
  return Boolean(row);
};

export const assertQueuedMessageQuota = async (conversationId: string, id: string): Promise<void> => {
  const [row] = await sql<{ submission: Submission }[]>`SELECT submission FROM ai.queued_messages
    WHERE id=${id}::uuid AND conversation_id=${conversationId}::uuid AND status IN ('pending','failed')`;
  if (!row) return;
  const subject = row.submission.runConfig.accessSubject ?? aiChatAccessSubject(row.submission.runConfig.actor);
  try {
    if (isAssistantChatTurn(row.submission.runConfig) && subject) await aiQuotas.assertAllowed(subject, row.submission.modelId);
  } catch (error) {
    if (error instanceof AiQuotaError)
      await sql`UPDATE ai.queued_messages SET status='failed',error=${error.code},quota_checked_at=clock_timestamp()
        WHERE id=${id}::uuid AND conversation_id=${conversationId}::uuid AND status IN ('pending','failed') AND send_requested_at IS NULL`;
    throw error;
  }
};

export const enqueueChatMessage = async (id: string, input: Submission, content: AiDraftContentPart[]) =>
  sql.begin(async (tx) => {
    const [conversation] = await tx<{ draft_revision: number; project_id: string | null; created_by_user_id: string | null }[]>`
    SELECT draft_revision, project_id, created_by_user_id FROM ai.conversations WHERE id = ${input.conversationId}::uuid AND archived_at IS NULL FOR UPDATE`;
    if (!conversation) throw new AiMessageQueueConflict("Conversation not found.");
    const subject = input.runConfig.accessSubject ?? aiChatAccessSubject(input.runConfig.actor);
    if (subject) assertPersonalChatWriter(subject, conversation.created_by_user_id);
    const [existing] =
      await tx`SELECT id FROM ai.queued_messages WHERE id = ${id}::uuid AND conversation_id = ${input.conversationId}::uuid`;
    if (existing) return;
    if (input.expectedDraftRevision !== undefined && Number(conversation.draft_revision) !== input.expectedDraftRevision)
      throw new AiMessageQueueConflict("Conversation draft changed before the message was queued.");
    if (input.expectedProjectId !== undefined && conversation.project_id !== input.expectedProjectId)
      throw new AiMessageQueueConflict("Conversation Project changed before the message was queued.");
    const [count] = await tx<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM ai.queued_messages WHERE conversation_id = ${input.conversationId}::uuid AND status IN ('pending','failed')`;
    if (count!.count >= AI_MESSAGE_QUEUE_LIMIT) throw new AiMessageQueueConflict("The message queue is full (20 messages).");
    const [size] = await tx<
      { size: number }[]
    >`SELECT COALESCE(sum(f.size),0)::float8 AS size FROM ai.queued_message_files f JOIN ai.queued_messages q ON q.id = f.message_id WHERE q.conversation_id = ${input.conversationId}::uuid`;
    if (
      Number(size!.size) + (input.runConfig.files?.attached ?? []).reduce((sum, file) => sum + file.size, 0) >
      AI_FILES_MAX_CONVERSATION_BYTES_DEFAULT
    )
      throw new AiMessageQueueConflict("Queued attachments exceed the conversation file budget.");
    const { expectedDraftRevision, ...submission } = input;
    const origin = input.runConfig.writerOrigin ?? originForQueueActor(input.runConfig.actor, conversation);
    await tx`INSERT INTO ai.queued_messages(id, conversation_id, submission, content, origin, author_user_id)
      VALUES (${id}::uuid, ${input.conversationId}::uuid, (${JSON.stringify(submission)}::text)::jsonb,
        (${JSON.stringify(content)}::text)::jsonb, (${JSON.stringify(origin)}::text)::jsonb, ${origin.kind === "person" ? origin.id : null}::uuid)`;
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
  });

/** Cancellation and retry share the conversation lock with promotion. */
export const updateQueuedMessage = async (conversationId: string, id: string, action: "cancel" | "retry") =>
  sql.begin(async (tx) => {
    await tx`SELECT id FROM ai.conversations WHERE id = ${conversationId}::uuid FOR UPDATE`;
    const changed = await tx`UPDATE ai.queued_messages SET status = ${action === "cancel" ? "cancelled" : "pending"}, error = NULL
    WHERE id = ${id}::uuid AND conversation_id = ${conversationId}::uuid AND status IN ('pending','failed')
      AND NOT EXISTS (SELECT 1 FROM ai.queued_messages q WHERE q.conversation_id=${conversationId}::uuid AND q.send_requested_at IS NOT NULL AND q.status IN ('pending','failed')) RETURNING id`;
    if (action === "cancel" && changed.length) {
      await tx`UPDATE ai.inter_chat_messages SET status='failed',error='removed_from_queue' WHERE id=${id}::uuid AND status='pending'`;
      await tx`DELETE FROM ai.queued_message_files WHERE message_id = ${id}::uuid`;
      await tx`UPDATE ai.queued_messages SET submission = '{}'::jsonb, content = '[]'::jsonb WHERE id = ${id}::uuid`;
    }
    return Boolean(changed.length);
  });

/** Edit only queued text; immutable attachments and the independent composer draft stay intact. */
export const editQueuedMessage = async (conversationId: string, id: string, text: string, authorUserId: string) =>
  sql.begin(async (tx) => {
    await tx`SELECT id FROM ai.conversations WHERE id = ${conversationId}::uuid FOR UPDATE`;
    const [row] = await tx<{ submission: Submission; content: AiDraftContentPart[] }[]>`SELECT submission, content FROM ai.queued_messages
    WHERE id = ${id}::uuid AND conversation_id = ${conversationId}::uuid AND status IN ('pending','failed')
      AND author_user_id=${authorUserId}::uuid
      AND NOT EXISTS (SELECT 1 FROM ai.queued_messages q WHERE q.conversation_id=${conversationId}::uuid AND q.send_requested_at IS NOT NULL AND q.status IN ('pending','failed')) FOR UPDATE`;
    if (!row) return false;
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
    content = (${JSON.stringify(content)}::text)::jsonb WHERE id = ${id}::uuid`;
    return true;
  });

/** Reconcile durable effect receipts; never infer a successful interruption from a lost worker. */
export const reconcileQueuedInterruptions = async (conversationId?: string): Promise<void> => {
  const rows = await sql<{ id: string; conversation_id: string; interrupted_turn_id: string }[]>`
    SELECT id,conversation_id,interrupted_turn_id FROM ai.queued_messages WHERE status='pending'
    AND send_requested_at IS NOT NULL AND interrupted_turn_id IS NOT NULL
    AND (${conversationId ?? null}::uuid IS NULL OR conversation_id=${conversationId ?? null}::uuid)
    ORDER BY send_requested_at LIMIT ${AI_MESSAGE_QUEUE_LIMIT}`;
  for (const row of rows) {
    const ready = await sql.begin(async (tx) => {
      await tx`SELECT id FROM ai.conversations WHERE id=${row.conversation_id}::uuid FOR UPDATE`;
      const [entry] = await tx<
        { expired: boolean; expected_count: number; client_wait: boolean; steps: InterruptedStep[] }[]
      >`SELECT interruption_deadline < now() AS expired, COALESCE(cardinality(interruption_client_calls),0) AS expected_count, interruption_deadline IS NOT NULL AS client_wait, interruption_steps AS steps
        FROM ai.queued_messages WHERE id=${row.id}::uuid AND status='pending' AND send_requested_at IS NOT NULL FOR UPDATE`;
      if (!entry) return false;
      const [turn] = await tx<
        { ownerless: boolean }[]
      >`SELECT (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at < now()) AS ownerless
        FROM ai.turns WHERE id=${row.interrupted_turn_id}::uuid AND cancellation_reason='queue_interrupt'
        AND status IN ('queued','running','waiting_for_action') FOR UPDATE`;
      if (!turn) return false;
      const actions = await tx<
        { status: "pending" | "resolved" | "aborted"; resolved_event: import("@k2b/nessi").InboundEvent | null; late: boolean }[]
      >`
        SELECT p.status,p.resolved_event,p.resolved_at > q.interruption_deadline AS late
        FROM ai.pending_actions p JOIN ai.queued_messages q ON q.id=${row.id}::uuid
        WHERE p.turn_id=${row.interrupted_turn_id}::uuid AND p.call_id=ANY(q.interruption_client_calls) FOR UPDATE OF p`;
      let state: "waiting" | "confirmed" | "unconfirmed" = "waiting";
      if (entry.client_wait) {
        state = queuedClientInterruptionState({
          expectedCount: entry.expected_count,
          expired: entry.expired,
          actions: actions.map((action) => ({ status: action.status, resolvedEvent: action.resolved_event, late: action.late })),
        });
      } else if (turn.ownerless) {
        const results = await tx<{ message: Message }[]>`SELECT message FROM ai.messages
          WHERE loop_id=${row.interrupted_turn_id}::text AND role='tool_result'`;
        const outcomes = new Map(
          results.flatMap(({ message }) => (message.role === "tool_result" ? [[message.callId, message.result] as const] : [])),
        );
        state = (entry.steps ?? []).some(
          (step) => step.started && (!outcomes.has(step.callId) || isUnknownActionOutcome(outcomes.get(step.callId))),
        )
          ? "unconfirmed"
          : "confirmed";
      }
      if (state === "unconfirmed") {
        await tx`UPDATE ai.queued_messages SET status='failed',error='interruption_unconfirmed',send_requested_at=NULL,
          interruption_deadline=NULL,interruption_client_calls=NULL,interrupted_turn_id=NULL,interruption_steps=NULL WHERE id=${row.id}::uuid`;
        await tx`UPDATE ai.turns SET cancel_requested_at=NULL,cancellation_reason=NULL WHERE id=${row.interrupted_turn_id}::uuid
          AND cancellation_reason='queue_interrupt'`;
        return false;
      }
      return state === "confirmed" && turn.ownerless;
    });
    if (ready)
      await finishAiTurnAbort(
        { conversationId: row.conversation_id, turnId: row.interrupted_turn_id },
        { found: true, ownerless: true, status: "waiting_for_action" },
      );
  }
};

/** Existing turn creation owns execution and recovery; the DB lock owns FIFO and deduplication. */
export const drainQueuedMessages = async (
  enqueue: (job: { conversationId: string; turnId: string }) => Promise<unknown>,
  conversationId?: string,
) => {
  await reconcileQueuedInterruptions(conversationId);
  const rows = await sql<
    {
      id: string;
      conversation_id: string;
      submission: Submission;
      origin: AiStoredMessageOrigin;
      interrupted_turn_id: string | null;
      interruption_steps: InterruptedStep[] | null;
    }[]
  >`
    SELECT q.id, q.conversation_id, q.submission, q.origin, q.interrupted_turn_id, q.interruption_steps FROM ai.queued_messages q
    JOIN ai.conversations c ON c.id = q.conversation_id
    WHERE (q.status = 'pending' OR (q.status = 'failed' AND q.error IN ('quota_exhausted','quota_usage_unknown'))) AND c.archived_at IS NULL AND c.created_by_user_id IS NOT NULL
      AND (${conversationId ?? null}::uuid IS NULL OR q.conversation_id = ${conversationId ?? null}::uuid)
      AND (q.send_requested_at IS NOT NULL OR (
        NOT EXISTS (SELECT 1 FROM ai.queued_messages priority WHERE priority.conversation_id=q.conversation_id AND priority.status IN ('pending','failed') AND priority.send_requested_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM ai.queued_messages earlier WHERE earlier.conversation_id = q.conversation_id AND earlier.position < q.position AND earlier.status IN ('pending','failed'))))
      AND NOT EXISTS (SELECT 1 FROM ai.turns t WHERE t.conversation_id = q.conversation_id AND NOT COALESCE(t.run_config ? 'background', false) AND t.status IN ('queued','running','waiting_for_action'))
    ORDER BY q.quota_checked_at NULLS FIRST, q.position LIMIT ${AI_MESSAGE_QUEUE_LIMIT}`;
  for (const row of rows) {
    try {
      const quotaSubject = row.submission.runConfig.accessSubject ?? aiChatAccessSubject(row.submission.runConfig.actor);
      if (isAssistantChatTurn(row.submission.runConfig) && quotaSubject) await aiQuotas.assertAllowed(quotaSubject, row.submission.modelId);
      await sql`UPDATE ai.queued_messages SET status='pending', error=NULL WHERE id=${row.id}::uuid AND status='failed' AND error IN ('quota_exhausted','quota_usage_unknown')`;
      let systemPrompt = row.submission.runConfig.systemPrompt;
      if (row.interrupted_turn_id) {
        const [messages, chat, turn] = await Promise.all([
          aiConversations.listTurnMessages({
            conversationId: row.conversation_id,
            loopId: row.interrupted_turn_id,
            includeCompacted: true,
          }),
          aiConversations.getConversation({ conversationId: row.conversation_id }),
          aiConversations.getTurn({ conversationId: row.conversation_id, turnId: row.interrupted_turn_id }),
        ]);
        systemPrompt = [
          systemPrompt,
          aiQueueInterruptionContext({
            turnId: turn?.shortId ?? "",
            messages,
            steps: row.interruption_steps ?? [],
            todoPlan: chat?.todoPlan,
            origin: row.origin,
          }),
        ]
          .filter(Boolean)
          .join("\n\n");
      }
      const result = await aiConversations.submitChatTurn({
        ...row.submission,
        runConfig: { ...row.submission.runConfig, writerOrigin: row.origin, systemPrompt },
        queuedMessageId: row.id,
      });
      await enqueue({ conversationId: row.conversation_id, turnId: result.turn.id });
    } catch (error) {
      if (error instanceof AiQuotaError) {
        await sql`UPDATE ai.queued_messages SET status='failed', error=${error.code}, send_requested_at=NULL, quota_checked_at=clock_timestamp() WHERE id=${row.id}::uuid AND status IN ('pending','failed')`;
        continue;
      }
      // Another dispatcher may have consumed it or a new foreground turn may have won.
      const reason = error instanceof Error ? error.message : String(error);
      if (reason === "Queued message is no longer ready." || reason.includes("idx_ai_turns_one_active_per_conversation")) continue;
      await sql`UPDATE ai.queued_messages SET status = 'failed', error = 'dispatch_failed', send_requested_at=NULL WHERE id = ${row.id}::uuid AND status = 'pending'`;
      log.error("Queued message dispatch failed", {
        conversationId: row.conversation_id,
        messageId: row.id,
        code: "queue_dispatch_failed",
        errorType: error instanceof Error ? error.name : "unknown",
      });
    }
  }
};
