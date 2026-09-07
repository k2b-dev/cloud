import { isDeepStrictEqual } from "node:util";
import type { InboundEvent, Input, Message } from "@k2b/nessi";
import type { QueueMessage } from "@k2b/sync";
import { z } from "zod";
import { lazySync } from "../_internal/process-sync";
import type { RequestActor } from "../server";
import { logger } from "../services/logging";
import { superviseRuntimeTask } from "../services/runtime-lifecycle";

import { type AiToolApprovalContext, aiTurnAllowsRememberedApprovals, rememberAiToolApproval } from "./approvals";
import { aiChatAccessSubject, selectAssistantAiModelId } from "./assistant-models";
import { AiTurnExecutor } from "./executor";
import { canonicalizeAiConversationAttachments, snapshotAiConversationFiles } from "./file-context";
import { startAiInvalidationRuntime, stopAiInvalidationRuntime } from "./live-outbox";
import { isAiVisionModelConfigured } from "./settings";
import { aiConversations } from "./store";
import { publishAiTurnAbort, publishAiWireEvent } from "./stream";
import { aiToolAudit } from "./tool-audit";
import type {
  AiChatTurnRunConfig,
  AiClientToolId,
  AiCompactionTurnRunConfig,
  AiConversationFileSnapshot,
  AiConversationResourceObservation,
  AiInterChatMessage,
  AiModelPolicy,
  AiPendingTurnAction,
  AiStoredMessage,
  AiTurn,
  AiTurnFinalizedAction,
  AiTurnFinalizedEvent,
  AiTurnToolSource,
} from "./types";
import { isAiImageMediaType } from "./types";
import { validateAiTurnRequest } from "./validate";

export type { ValidateAiTurnInput } from "./validate";
export { isAiSettingsError, validateAiTurnRequest } from "./validate";

const log = logger("ai:runtime");

const AI_WORKER_ID = `worker-${crypto.randomUUID()}`;
const AI_TURN_LEASE_MS = 45_000;
const AI_TURN_HEARTBEAT_MS = 3_000;
const AI_TURN_WORKER_CONCURRENCY = 8;
const AI_TURN_MAX_ATTEMPTS = 5;
const AI_TURN_RUN_BUDGET_MS = 10 * 60_000;
const AI_SWEEP_INTERVAL_MS = 15_000;

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

type AiTurnJob = { conversationId: string; turnId: string };

const aiTurnQueue = lazySync((sync) => {
  const handle = sync.queue<AiTurnJob>({
    id: "cloud-ai-turns",
    owner: "cloud",
    delivery: { ackWaitMs: AI_TURN_LEASE_MS, maxAttempts: 50 },
  });

  return handle;
});

// No idempotency key: the DB claim is the only gate, so re-enqueues (recovery,
// continuation, stale-sweep) are always allowed and never silently swallowed.
const enqueueAiTurn = (job: AiTurnJob): Promise<unknown> => aiTurnQueue().send({ data: job, orderingKey: job.conversationId });

/** Enqueue a turn created atomically by another durable AI workflow. */
export const enqueueExistingAiTurn = (input: AiTurnJob): Promise<unknown> => enqueueAiTurn(input);

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

export type SubmitAiChatTurnInput = {
  /** Only interactive Assistant HTTP handlers set this server-owned marker. */
  assistantChat?: true;
  conversationId: string;
  /** Stable public ID exposed as runtime context, not instructions. */
  chatId?: string;
  input: Input;
  userMessage: Message;
  actor?: RequestActor;
  locale?: string;
  modelPolicy?: AiModelPolicy;
  requestedModelId?: string;
  /** Optional instructions that apply only to this turn. */
  systemPrompt?: string;
  project?: AiChatTurnRunConfig["project"];
  clientToolIds?: AiClientToolId[];
  toolSource?: AiTurnToolSource;
  canInspectAttachedImages?: boolean;
  toolApprovalContext?: AiToolApprovalContext;
  /** Retry-in-place: drop active messages with seq >= this before creating the turn. */
  truncateFromSeq?: number;
  expectedDraftRevision?: number;
  expectedProjectId?: string | null;
  resources?: AiConversationResourceObservation[];
  expectedFiles?: ReadonlyArray<{ path: string; version: number }>;
  fileSnapshot?: AiConversationFileSnapshot;
  retrySourceTurnId?: string;
};

export const submitAiChatTurn = async (input: SubmitAiChatTurnInput): Promise<{ turn: AiTurn; message: AiStoredMessage }> => {
  if (input.clientToolIds?.length && input.toolSource?.kind !== "default") {
    throw new Error("Optional client tools require the default tool source.");
  }
  const files = input.fileSnapshot ?? (await snapshotAiConversationFiles(input.conversationId, input.userMessage, input.expectedFiles));
  const userMessage = canonicalizeAiConversationAttachments(input.userMessage, files);
  const inputMessage = canonicalizeAiConversationAttachments(
    { role: "user", content: typeof input.input === "string" ? [input.input] : input.input },
    files,
  );
  const canonicalInput = files?.attached.length ? inputMessage.content : input.input;
  const hasImageAttachments = Boolean(files?.attached.some((file) => isAiImageMediaType(file.mediaType)));
  const canInspectAttachedImages =
    input.canInspectAttachedImages ??
    (input.toolSource?.kind === "default" && (await isAiVisionModelConfigured(input.modelPolicy?.allowedDataBoundaries)));
  const requestedModelId = input.assistantChat
    ? await selectAssistantAiModelId(aiChatAccessSubject(input.actor), input.requestedModelId, input.modelPolicy)
    : input.requestedModelId;
  const { resolved } = await validateAiTurnRequest({
    input: canonicalInput,
    hasImageAttachments,
    canInspectAttachedImages,
    modelPolicy: input.modelPolicy,
    requestedModelId,
  });
  const runConfig: AiChatTurnRunConfig = {
    kind: "chat",
    ...(input.assistantChat ? { assistantChat: true } : {}),
    input: canonicalInput,
    chatId: input.chatId,
    actor: input.actor,
    ...(input.locale ? { locale: input.locale } : {}),
    modelPolicy: input.modelPolicy,
    requestedModelId,
    systemPrompt: input.systemPrompt,
    project: input.project,
    files,
    canInspectAttachedImages,
    clientToolIds: input.clientToolIds,
    toolSource: input.toolSource ?? { kind: "none" },
    toolApprovalContext: input.toolApprovalContext,
  };

  const submitted = await aiConversations.submitChatTurn({
    conversationId: input.conversationId,
    modelProfileId: resolved.profile.id,
    runConfig,
    userMessage,
    truncateFromSeq: input.truncateFromSeq,
    expectedDraftRevision: input.expectedDraftRevision,
    expectedProjectId: input.expectedProjectId,
    resources: input.resources,
    retrySourceTurnId: input.retrySourceTurnId,
  });

  await enqueueAiTurn({ conversationId: input.conversationId, turnId: submitted.turn.id });
  return submitted;
};

export const deliverAiInterChatMessage = async (input: {
  message: AiInterChatMessage;
  chatId?: string;
  actor: RequestActor;
  locale?: string;
  modelPolicy?: AiModelPolicy;
  systemPrompt?: string;
  project?: AiChatTurnRunConfig["project"];
  sourceHref?: string;
  toolSource?: AiTurnToolSource;
  toolApprovalContext?: AiToolApprovalContext;
}): Promise<
  { delivered: false; reason: "not_found" | "busy" | "failed" } | { delivered: true; message: AiInterChatMessage; turn: AiTurn }
> => {
  const text = [`Assistant message from chat ${input.message.sourceChatId} (${input.message.sourceTitle}):`, input.message.text].join(
    "\n\n",
  );
  const { resolved } = await validateAiTurnRequest({ input: text, modelPolicy: input.modelPolicy });
  const runConfig: AiChatTurnRunConfig = {
    kind: "chat",
    input: text,
    chatId: input.chatId,
    actor: input.actor,
    ...(input.locale ? { locale: input.locale } : {}),
    modelPolicy: input.modelPolicy,
    systemPrompt: input.systemPrompt,
    project: input.project,
    toolSource: input.toolSource ?? { kind: "none" },
    toolApprovalContext: input.toolApprovalContext,
  };
  const delivered = await aiConversations.deliverInterChatMessage({
    messageId: input.message.id,
    modelProfileId: resolved.profile.id,
    runConfig,
    userMessage: { role: "user", content: [{ type: "text", text }] },
    sourceHref: input.sourceHref,
  });
  if (delivered.delivered) await enqueueAiTurn({ conversationId: delivered.message.targetConversationId, turnId: delivered.turn.id });
  return delivered;
};

export type SubmitAiCompactionInput = {
  conversationId: string;
  actor?: RequestActor;
  modelPolicy?: AiModelPolicy;
  requestedModelId?: string;
};

export const submitAiCompaction = async (input: SubmitAiCompactionInput): Promise<{ turn: AiTurn }> => {
  const { resolved } = await validateAiTurnRequest({ input: "", modelPolicy: input.modelPolicy, requestedModelId: input.requestedModelId });
  const runConfig: AiCompactionTurnRunConfig = {
    kind: "compact",
    actor: input.actor,
    modelPolicy: input.modelPolicy,
    requestedModelId: input.requestedModelId,
  };
  const turn = await aiConversations.createCompactionTurn({
    conversationId: input.conversationId,
    modelProfileId: resolved.profile.id,
    runConfig,
  });
  await enqueueAiTurn({ conversationId: input.conversationId, turnId: turn.id });
  return { turn };
};

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

export const abortAiTurn = async (input: { conversationId: string; turnId: string }): Promise<{ ok: true }> => {
  // Capture the wire coordinates before finalization so we can emit turn_finished.
  const active = await aiConversations.getActiveTurn({ conversationId: input.conversationId }).catch(() => null);
  const request = await aiConversations.requestTurnAbort({ ...input, reason: "user" });
  if (!request.found) return { ok: true };

  // Tell any live owner to stop (its heartbeat also detects the cancel flag).
  await publishAiTurnAbort(input).catch(() => undefined);

  if (request.ownerless) {
    const finalized = await aiConversations.completeTurn({ ...input, status: "aborted", error: null });
    if (finalized === "completed") {
      const attempt = active?.turn.id === input.turnId ? active.turn.attempt : 1;
      const seq = (active?.turn.id === input.turnId ? active.liveSeq : 0) + 1;
      await publishAiWireEvent({
        v: 1,
        conversationId: input.conversationId,
        turnId: input.turnId,
        attempt,
        seq,
        type: "turn_finished",
        status: "aborted",
        error: null,
      }).catch(() => undefined);
    }
  }
  return { ok: true };
};

// ---------------------------------------------------------------------------
// Actions (approvals + frontend tool results)
// ---------------------------------------------------------------------------

export const AiTurnActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("approval_response"), approved: z.boolean(), remember: z.literal("always").optional() }),
  z.object({ type: z.literal("tool_result"), result: z.unknown() }),
]);
export type AiTurnActionInput = z.infer<typeof AiTurnActionSchema>;

const actionMatchesResolvedEvent = (action: AiTurnActionInput, event: InboundEvent | null, callId: string): boolean => {
  if (!event || event.callId !== callId) return false;
  if (action.type === "approval_response") return event.type === "approval_response" && event.approved === action.approved;
  return event.type === "tool_result" && isDeepStrictEqual(event.result, action.result);
};

export const listPendingAiTurnActions = async (input: { conversationId: string; turnId: string }): Promise<AiPendingTurnAction[]> => {
  const [actions, config] = await Promise.all([aiConversations.listPendingTurnActions(input), aiConversations.getTurnRunConfig(input)]);
  return aiTurnAllowsRememberedApprovals(config)
    ? actions
    : actions.map((action) => (action.type === "approval_request" ? { ...action, allowAlways: false } : action));
};

export const submitAiTurnAction = async (input: {
  conversationId: string;
  turnId: string;
  callId: string;
  action: AiTurnActionInput;
  toolApprovalContext?: AiToolApprovalContext;
}): Promise<{ ok: true } | { ok: false; status: 400 | 404 | 409; message: string }> => {
  const pending = await aiConversations.getPendingTurnAction(input);
  if (!pending) return { ok: false, status: 404, message: "This request has expired — the assistant already moved on." };
  if (pending.status === "resolved") {
    if (!actionMatchesResolvedEvent(input.action, pending.resolvedEvent, input.callId)) {
      return { ok: false, status: 409, message: "AI action was already resolved with a different response." };
    }
    // Idempotent retry: ensure a continuation is queued and return success.
    await enqueueAiTurn({ conversationId: input.conversationId, turnId: input.turnId }).catch(() => undefined);
    return { ok: true };
  }
  if (pending.status !== "pending") {
    return { ok: false, status: 404, message: "This request has expired — the assistant already moved on." };
  }

  if (input.action.type === "approval_response") {
    if (pending.kind === "client_tool") return { ok: false, status: 400, message: "Frontend tool requests require a tool result." };
    if (input.action.remember === "always") {
      const config = await aiConversations.getTurnRunConfig(input);
      if (!input.action.approved || !pending.allowAlways || !input.toolApprovalContext || !aiTurnAllowsRememberedApprovals(config)) {
        return { ok: false, status: 400, message: "This approval cannot be remembered." };
      }
      await rememberAiToolApproval(input.toolApprovalContext, { toolName: pending.name, approvalScope: pending.approvalScope });
    }
    await aiToolAudit
      .noteApprovalResolved({
        turnId: input.turnId,
        callId: input.callId,
        approvalState: input.action.approved ? (input.action.remember === "always" ? "approved_always" : "approved_once") : "rejected",
      })
      .catch(() => undefined);

    const resolved = await aiConversations.resolvePendingTurnAction({
      ...input,
      event: { type: "approval_response", callId: input.callId, approved: input.action.approved },
    });
    if (!resolved) {
      const raced = await aiConversations.getPendingTurnAction(input);
      if (!raced || !actionMatchesResolvedEvent(input.action, raced.resolvedEvent, input.callId)) {
        return { ok: false, status: 409, message: "AI action was already resolved with a different response." };
      }
    }
  } else {
    if (pending.kind !== "client_tool") return { ok: false, status: 400, message: "Approval requests require an approval response." };
    const resolved = await aiConversations.resolvePendingTurnAction({
      ...input,
      event: { type: "tool_result", callId: input.callId, result: input.action.result },
    });
    if (!resolved) {
      const raced = await aiConversations.getPendingTurnAction(input);
      if (!raced || !actionMatchesResolvedEvent(input.action, raced.resolvedEvent, input.callId)) {
        return { ok: false, status: 409, message: "AI action was already resolved with a different response." };
      }
    }
    await aiToolAudit
      .noteToolCompleted({ turnId: input.turnId, callId: input.callId, result: input.action.result, isError: false })
      .catch(() => undefined);
  }

  await enqueueAiTurn({ conversationId: input.conversationId, turnId: input.turnId });
  return { ok: true };
};

// ---------------------------------------------------------------------------
// Worker + sweep lifecycle
// ---------------------------------------------------------------------------

const runClaimedTurn = async (
  job: AiTurnJob,
  signal: AbortSignal,
  leaseOwner: string,
  onTurnFinalized?: (event: AiTurnFinalizedEvent) => Promise<void>,
): Promise<void> => {
  const claim =
    (await aiConversations.claimTurn({
      ...job,
      leaseOwner,
      leaseMs: AI_TURN_LEASE_MS,
      from: "queue",
      maxAttempts: AI_TURN_MAX_ATTEMPTS,
      runBudgetMs: AI_TURN_RUN_BUDGET_MS,
    })) ??
    (await aiConversations.claimTurn({
      ...job,
      leaseOwner,
      leaseMs: AI_TURN_LEASE_MS,
      from: "waiting",
      maxAttempts: AI_TURN_MAX_ATTEMPTS,
      runBudgetMs: AI_TURN_RUN_BUDGET_MS,
    }));

  if (!claim) return; // Already owned, done, cancelled, or attempt-capped.

  const executor = new AiTurnExecutor({
    leaseOwner,
    heartbeatMs: AI_TURN_HEARTBEAT_MS,
    enqueueContinuation: (input) => enqueueAiTurn(input).then(() => undefined),
    onTurnFinalized,
  });
  await executor.run({ conversationId: job.conversationId, turnId: job.turnId, claim, signal });
};

const processMessage = async (
  message: QueueMessage<AiTurnJob>,
  signal: AbortSignal,
  onTurnFinalized?: (event: AiTurnFinalizedEvent) => Promise<void>,
): Promise<void> => {
  const leaseOwner = `${AI_WORKER_ID}:${message.messageId}:${crypto.randomUUID()}`;
  const touch = setInterval(() => void message.heartbeat().catch(() => undefined), AI_TURN_HEARTBEAT_MS);
  if (typeof touch === "object" && "unref" in touch) touch.unref();
  try {
    await runClaimedTurn(message.data, signal, leaseOwner, onTurnFinalized);
  } catch (error) {
    log.error("AI turn worker error", {
      conversationId: message.data.conversationId,
      turnId: message.data.turnId,
      error: error instanceof Error ? error.message : "AI turn worker failed",
    });
  } finally {
    clearInterval(touch);
  }
};

const publishSweepFinished = async (turn: AiTurnFinalizedAction & { error?: string }, status: "failed" | "aborted"): Promise<void> => {
  await publishAiWireEvent({
    v: 1,
    conversationId: turn.conversationId,
    turnId: turn.turnId,
    attempt: turn.attempt,
    seq: turn.seq,
    type: "turn_finished",
    status,
    error: status === "failed" ? (turn.error ?? "AI turn failed.") : null,
  }).catch(() => undefined);
};

export const sweepAiRuntime = async (onTurnFinalized?: (event: AiTurnFinalizedEvent) => Promise<void>): Promise<void> => {
  const sweep = await aiConversations.sweepTurns({ maxAttempts: AI_TURN_MAX_ATTEMPTS });
  await Promise.all([
    ...sweep.requeued.map((job) => enqueueAiTurn(job).catch(() => undefined)),
    ...sweep.failed.map((turn) => publishSweepFinished(turn, "failed")),
    ...sweep.aborted.map((turn) => publishSweepFinished(turn, "aborted")),
  ]);
  if (onTurnFinalized) {
    await Promise.all([
      ...sweep.failed.map((turn) =>
        onTurnFinalized({ conversationId: turn.conversationId, turnId: turn.turnId, status: "failed", kind: null }),
      ),
      ...sweep.aborted.map((turn) =>
        onTurnFinalized({ conversationId: turn.conversationId, turnId: turn.turnId, status: "aborted", kind: null }),
      ),
    ]);
  }
  if (sweep.requeued.length || sweep.failed.length || sweep.aborted.length) {
    log.info("AI runtime sweep", { requeued: sweep.requeued.length, failed: sweep.failed.length, aborted: sweep.aborted.length });
  }
};

type AiRuntimeState = {
  listeners: Set<(event: AiTurnFinalizedEvent) => Promise<void>>;
  stop: () => void;
};

let running: AiRuntimeState | null = null;
let refCount = 0;

export const startAiRuntime = (
  input: { concurrency?: number; onTurnFinalized?: (event: AiTurnFinalizedEvent) => Promise<void> } = {},
): (() => void) => {
  const listener = input.onTurnFinalized ? (event: AiTurnFinalizedEvent) => input.onTurnFinalized!(event) : null;
  if (running) {
    refCount += 1;
    if (listener) running.listeners.add(listener);
    return releaseAiRuntime(listener);
  }

  const concurrency = Math.min(Math.max(Math.floor(input.concurrency ?? AI_TURN_WORKER_CONCURRENCY), 1), 64);
  const controller = new AbortController();
  const listeners = new Set<(event: AiTurnFinalizedEvent) => Promise<void>>();
  if (listener) listeners.add(listener);
  refCount = 1;
  const dispatchTurnFinalized = async (event: AiTurnFinalizedEvent): Promise<void> => {
    const results = await Promise.allSettled([...listeners].map((notify) => notify(event)));
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
    if (errors.length > 0) throw new AggregateError(errors, `${errors.length} AI turn finalized listener(s) failed`);
  };

  void superviseRuntimeTask({
    name: "AI turn worker",
    signal: controller.signal,
    run: async (signal) => {
      const worker = await aiTurnQueue().process({ concurrency, signal }, (message) =>
        processMessage(message, message.signal, dispatchTurnFinalized),
      );
      try {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
      } finally {
        worker.stop();
      }
    },
    onError: ({ error, failureCount, retryInMs }) =>
      log.error("AI turn worker failed to start; retrying", {
        error: error instanceof Error ? error.message : String(error),
        failureCount,
        retryInMs,
      }),
  });

  const runSweep = () =>
    void sweepAiRuntime(dispatchTurnFinalized).catch((error) =>
      log.warn("AI runtime sweep failed", { error: error instanceof Error ? error.message : "sweep failed" }),
    );
  runSweep();
  const sweepTimer = setInterval(runSweep, AI_SWEEP_INTERVAL_MS);
  if (typeof sweepTimer === "object" && "unref" in sweepTimer) sweepTimer.unref();

  const state: AiRuntimeState = {
    listeners,
    stop: () => {
      if (running !== state) return;
      controller.abort();
      clearInterval(sweepTimer);
      listeners.clear();
      running = null;
      refCount = 0;
    },
  };
  running = state;
  startAiInvalidationRuntime();
  log.info("AI runtime started", { workerId: AI_WORKER_ID, concurrency });
  return releaseAiRuntime(listener);
};

const releaseAiRuntime = (listener: ((event: AiTurnFinalizedEvent) => Promise<void>) | null): (() => void) => {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const state = running;
    if (!state) return;
    if (listener) state.listeners.delete(listener);
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0) {
      state.stop();
      void stopAiInvalidationRuntime();
    }
  };
};

export const __aiRuntimeTest = { actionMatchesResolvedEvent };
