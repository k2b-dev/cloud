import { sql } from "bun";
import { lazySync } from "../_internal/process-sync";
import { logger, trace } from "../services/logging";
import { superviseRuntimeTask } from "../services/runtime-lifecycle";
import { aiModelAccess } from "./model-access";
import { aiProjects } from "./projects";
import { AiTranscriptionError, describeTranscriptionFailure, type RunAiTranscriptionInput, runAiTranscription } from "./transcription";

const log = logger("ai:dictations");
const queue = lazySync((sync) =>
  sync.queue<{ id: string }>({ id: "cloud-ai-dictations", owner: "cloud", delivery: { ackWaitMs: 45_000, maxAttempts: 50 } }),
);
export const enqueueAiDictation = async (shortId: string): Promise<void> => {
  const [task] = await sql<
    { id: string }[]
  >`SELECT id FROM ai.dictations WHERE short_id = ${shortId} AND status = 'queued' AND disposition = 'pending'`;
  if (task) await queue().send({ data: { id: task.id }, orderingKey: task.id });
};
const MAX_ATTEMPTS = 3; // Same automatic attempt budget as workflow inference.
const LEASE_MS = 45_000;

type ClaimedDictation = {
  id: string;
  conversation_id: string;
  user_id: string;
  source_path: string;
  source_bytes: Uint8Array;
  language: string | null;
  model_profile_id: string;
  attempts: number;
};

/** Nessi 0.12 exposes normalized messages, not typed HTTP errors. Fail closed for unknown errors. */
export const isRetryableDictationError = (error: unknown): boolean => {
  if (error instanceof AiTranscriptionError) return error.retryable;
  if (!(error instanceof Error)) return false;
  return (
    /^(openai|openai-compatible) (408|409|425|429|5\d\d): /.test(error.message) ||
    /^(openai|openai-compatible) connection failed: /.test(error.message)
  );
};

export const processAiDictation = async (
  id: string,
  signal: AbortSignal,
  run: (input: RunAiTranscriptionInput) => Promise<{ text: string; modelProfileId: string }> = runAiTranscription,
): Promise<void> => {
  const token = crypto.randomUUID();
  const [task] = await sql<ClaimedDictation[]>`
    UPDATE ai.dictations SET status = 'running', lease_token = ${token}, lease_until = now() + ${LEASE_MS} * interval '1 millisecond', attempts = attempts + 1, updated_at = now()
    WHERE id = ${id} AND disposition = 'pending' AND source_bytes IS NOT NULL AND attempts < ${MAX_ATTEMPTS}
      AND ((status = 'queued' AND next_attempt_at <= now()) OR (status = 'running' AND lease_until < now()))
    RETURNING id, conversation_id, user_id, source_path, source_bytes, language, model_profile_id, attempts
  `;
  if (!task) return;
  const span = await trace.start({
    name: "ai.dictation",
    source: "ai:dictations",
    category: "ai",
    attributes: { dictationId: id, conversationId: task.conversation_id, modelProfileId: task.model_profile_id, attempt: task.attempts },
  });
  let failure: AiTranscriptionError | undefined;
  const canceled = new AbortController();
  const combined = AbortSignal.any([signal, canceled.signal]);
  let checking = false;
  const heartbeat = async () => {
    if (checking) return;
    checking = true;
    try {
      const [row] = await sql`UPDATE ai.dictations d SET lease_until = now() + ${LEASE_MS} * interval '1 millisecond'
        FROM ai.conversations c WHERE d.id = ${id} AND d.lease_token = ${token} AND d.status = 'running' AND d.disposition = 'pending'
          AND c.id = d.conversation_id AND c.created_by_user_id = d.user_id AND c.archived_at IS NULL RETURNING d.id`;
      if (!row) canceled.abort();
    } catch {
      canceled.abort();
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(() => void heartbeat(), 3_000);
  try {
    const [conversation] = await sql<
      { project_id: string | null }[]
    >`SELECT project_id FROM ai.conversations WHERE id = ${task.conversation_id} AND created_by_user_id = ${task.user_id} AND archived_at IS NULL`;
    if (!conversation) throw new Error("Conversation unavailable.");
    const subject = { type: "user" as const, userId: task.user_id };
    await aiModelAccess.assertAllowed(task.model_profile_id, subject);
    if (conversation.project_id && !(await aiProjects.snapshot(conversation.project_id, subject)))
      throw new Error("Project access unavailable.");
    const result = await run({
      task: "dictation",
      traceParent: span,
      file: new Blob([new Uint8Array(task.source_bytes)]),
      filename: task.source_path,
      requestedModelId: task.model_profile_id,
      language: task.language ?? undefined,
      signal: combined,
      attribution: { userId: task.user_id, conversationId: task.conversation_id },
    });
    combined.throwIfAborted();
    // Same text payload ceiling as the existing file-write endpoint.
    if (result.text.length > 12_000_000) throw new Error("Transcript exceeds the text file limit.");
    await sql`UPDATE ai.dictations SET status = 'succeeded', result = ${result.text}, source_bytes = NULL, lease_token = NULL, lease_until = NULL, error_code = NULL, updated_at = now()
      WHERE id = ${id} AND lease_token = ${token} AND status = 'running' AND disposition = 'pending'`;
  } catch (error) {
    failure = describeTranscriptionFailure(error, "configuration", combined.aborted);
    const interrupted = signal.aborted;
    const retry = !canceled.signal.aborted && task.attempts < MAX_ATTEMPTS && (interrupted || isRetryableDictationError(error));
    log[combined.aborted ? "info" : retry ? "warn" : "error"](failure.message, {
      dictationId: id,
      traceId: span.traceId,
      modelProfileId: task.model_profile_id,
      attempt: task.attempts,
      retry,
      errorCode: failure.code,
    });
    await sql`UPDATE ai.dictations SET status = ${retry ? "queued" : "failed"}, lease_token = NULL, lease_until = NULL,
      error_code = ${retry ? null : failure.code}, next_attempt_at = now() + ${task.attempts * 2} * interval '1 second', updated_at = now()
      WHERE id = ${id} AND lease_token = ${token} AND status = 'running' AND disposition = 'pending'`;
  } finally {
    clearInterval(timer);
    await trace.end({ context: span, status: failure ? "error" : "ok", statusMessage: failure?.message });
  }
};

/** DB recovery is authoritative, including a crash after upload commit but before enqueue. */
export const sweepAiDictations = async (): Promise<void> => {
  await sql`UPDATE ai.dictations SET status = 'failed', error_code = 'attempts_exhausted', lease_token = NULL, lease_until = NULL, updated_at = now()
    WHERE disposition = 'pending' AND attempts >= ${MAX_ATTEMPTS} AND (status = 'queued' OR (status = 'running' AND lease_until < now()))`;
  const tasks = await sql<{ id: string }[]>`SELECT id FROM ai.dictations WHERE disposition = 'pending'
    AND ((status = 'queued' AND next_attempt_at <= now()) OR (status = 'running' AND lease_until < now())) ORDER BY updated_at LIMIT 100`;
  for (const task of tasks) await queue().send({ data: { id: task.id }, orderingKey: task.id });
};

export const startAiDictationRuntime = (): (() => void) => {
  const controller = new AbortController();
  void superviseRuntimeTask({
    name: "AI dictation worker",
    signal: controller.signal,
    run: async (signal) => {
      const worker = await queue().process({ concurrency: 2, signal }, (message) => processAiDictation(message.data.id, message.signal));
      try {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
      } finally {
        worker.stop();
      }
    },
    onError: () => log.warn("Dictation worker unavailable; retrying"),
  });
  let sweeping = false;
  const sweep = async () => {
    if (sweeping || controller.signal.aborted) return;
    sweeping = true;
    try {
      await sweepAiDictations();
    } catch {
      log.warn("Dictation recovery unavailable; retrying");
    } finally {
      sweeping = false;
    }
  };
  void sweep();
  const timer = setInterval(() => void sweep(), 15_000);
  return () => {
    controller.abort();
    clearInterval(timer);
  };
};
