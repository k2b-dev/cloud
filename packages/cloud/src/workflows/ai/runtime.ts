import { StructuredOutputError } from "@k2b/nessi";
import { type Job, StoreFullError, type Worker } from "@k2b/sync";
import { lazySync } from "../../_internal/process-sync";
import { isAiSettingsError, runAiStructured } from "../../ai";
import { AiBackgroundAdmissionError, AiBackgroundCostError } from "../../ai/inference-calls";
import { resolveAiWorkflowModel } from "../../ai/structured";
import { executeAiTask } from "../../ai/task-execution";
import { env } from "../../config/env";
import { WorkflowAiAdmissionError, workflowAiModelHash } from "./policy";

import {
  claimWorkflowAiTask,
  completeWorkflowAiTask,
  expireWorkflowAiTasks,
  failWorkflowAiTask,
  getWorkflowAiTask,
  heartbeatWorkflowAiTask,
  listRecoverableWorkflowAiTaskIds,
  markWorkflowAiTaskCanceledIfRequested,
  requeueWorkflowAiTask,
  wakeWorkflowAiTask,
  workflowAiTaskCancellationRequested,
} from "./store";
import type { WorkflowAiTask } from "./types";

export const WORKFLOW_AI_JOB_ID = "cloud.workflow-ai.v2";
const MAX_ATTEMPTS = 3;
const DEFAULT_CANCEL_POLL_MS = 500;
const HEARTBEAT_INTERVAL_MS = 10_000;

type StructuredRunner = typeof runAiStructured;

export type WorkflowAiRuntimeOptions = {
  runStructured?: StructuredRunner;
  cancelPollMs?: number;
  attemptTimeoutMs?: number;
};

/** Attempt budget shared by the job declaration and the Postgres-side settle logic. */
export type WorkflowAiProcessOptions = Required<Omit<WorkflowAiRuntimeOptions, "attemptTimeoutMs">> & {
  maxAttempts: number;
  attemptTimeoutMs?: number;
};

const workflowAiJob = lazySync((sync) =>
  sync.job<{ taskId: string }>({
    id: WORKFLOW_AI_JOB_ID,
    whenFull: "reject",
    owner: "cloud",
    delivery: {
      maxInFlight: env.WORKFLOW_AI_BUDGET.globalConcurrent,
      ackWaitMs: 30_000,
      maxAttempts: MAX_ATTEMPTS,
      backoffMs: [1_000, 2_000],
    },
  }),
);

class WorkflowAiAttemptError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

type WorkflowAiAttemptFailure = Pick<WorkflowAiAttemptError, "code" | "message" | "retryable">;

export const settleWorkflowAiAttemptFailure = async (
  taskId: string,
  error: WorkflowAiAttemptFailure,
  failureCount: number,
  maxAttempts: number,
): Promise<"canceled" | "retry" | "failed"> => {
  if (await workflowAiTaskCancellationRequested(taskId)) {
    await markWorkflowAiTaskCanceledIfRequested(taskId);
    return "canceled";
  }
  if (error.retryable && failureCount + 1 < maxAttempts) {
    await requeueWorkflowAiTask(taskId);
    return "retry";
  }
  await failWorkflowAiTask(taskId, { code: error.code, message: error.message });
  return "failed";
};

export const executeWorkflowAiRequest = async (task: WorkflowAiTask, runStructured: StructuredRunner, signal: AbortSignal) =>
  executeAiTask(
    task.request,
    {
      appId: task.appId,
      attribution: { workflowRunId: task.runId, stepKey: task.stepKey, userId: task.usageUserId },
      requestedModelId: task.modelProfileId,
      ...(task.modelConfigHash
        ? {
            resolveModel: async () => {
              const resolved = await resolveAiWorkflowModel(task.modelProfileId);
              if (workflowAiModelHash(resolved.profile) !== task.modelConfigHash)
                throw new WorkflowAiAdmissionError("WORKFLOW_AI_MODEL_CHANGED");
              return resolved;
            },
          }
        : {}),
      signal,
      taskPrefix: "workflow",
    },
    runStructured,
  );

const retryableError = (error: unknown): boolean => {
  if (error instanceof WorkflowAiAdmissionError) return error.retryable;
  if (error instanceof AiBackgroundAdmissionError) return error.retryable;
  if (error instanceof AiBackgroundCostError) return false;
  if (isAiSettingsError(error)) return false;
  if (error instanceof StructuredOutputError) return error.code === "loop_failed";
  return true;
};

const errorCode = (error: unknown): string => {
  if (error instanceof WorkflowAiAdmissionError) return error.code;
  if (error instanceof AiBackgroundCostError || error instanceof AiBackgroundAdmissionError) return error.code;
  if (isAiSettingsError(error)) return error.aiError.code.toUpperCase();
  if (error instanceof StructuredOutputError) return `WORKFLOW_AI_${error.code.toUpperCase()}`;
  return "WORKFLOW_AI_PROVIDER_ERROR";
};

export const processWorkflowAiTask = async (
  taskId: string,
  ctx: { signal: AbortSignal; heartbeat(): Promise<void> },
  options: WorkflowAiProcessOptions,
): Promise<void> => {
  const task = await claimWorkflowAiTask(taskId);
  if (!task) {
    const terminal = await getWorkflowAiTask(taskId);
    if (terminal && ["succeeded", "failed", "canceled"].includes(terminal.status)) await wakeWorkflowAiTask(terminal);
    return;
  }
  if (task.status === "canceled") return;

  const controller = new AbortController();
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Workflow AI attempt deadline exceeded. Retry the workflow or inspect the provider."));
  }, options.attemptTimeoutMs ?? env.WORKFLOW_AI_ATTEMPT_TIMEOUT_MS);
  let canceled = false;
  let monitorError: unknown;
  let checking = false;
  let lastHeartbeat = Date.now();
  const abortForShutdown = () => controller.abort(ctx.signal.reason ?? new Error("Workflow AI runtime stopped"));
  ctx.signal.addEventListener("abort", abortForShutdown, { once: true });
  if (ctx.signal.aborted) abortForShutdown();

  const monitor = setInterval(() => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    void (async () => {
      try {
        if (await workflowAiTaskCancellationRequested(task.id)) {
          canceled = true;
          controller.abort(new Error("Workflow canceled"));
          return;
        }
        if (Date.now() - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
          await ctx.heartbeat();
          await heartbeatWorkflowAiTask(task.id);
          lastHeartbeat = Date.now();
        }
      } catch (error) {
        monitorError = error;
        controller.abort(error);
      } finally {
        checking = false;
      }
    })();
  }, options.cancelPollMs);

  try {
    controller.signal.throwIfAborted();
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(controller.signal.reason);
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    const result = await Promise.race([executeWorkflowAiRequest(task, options.runStructured, controller.signal), aborted]);
    if (canceled || (await workflowAiTaskCancellationRequested(task.id))) {
      await markWorkflowAiTaskCanceledIfRequested(task.id);
      return;
    }
    await completeWorkflowAiTask(task.id, result.output, result.usage);
  } catch (error) {
    if (canceled || (await workflowAiTaskCancellationRequested(task.id))) {
      await markWorkflowAiTaskCanceledIfRequested(task.id);
      return;
    }
    if (timedOut) {
      throw new WorkflowAiAttemptError(
        "WORKFLOW_AI_TIMEOUT",
        "Workflow AI attempt deadline exceeded. Retry the workflow or inspect the provider.",
        true,
      );
    }
    if (ctx.signal.aborted || monitorError) {
      throw new WorkflowAiAttemptError("WORKFLOW_AI_INTERRUPTED", "Workflow AI task was interrupted.", true);
    }
    throw new WorkflowAiAttemptError(
      errorCode(error),
      error instanceof Error ? error.message : "Workflow AI provider call failed.",
      retryableError(error),
    );
  } finally {
    clearInterval(monitor);
    clearTimeout(deadline);
    ctx.signal.removeEventListener("abort", abortForShutdown);
  }
};

let activeJob: Job<{ taskId: string }> | null = null;
let activeWorker: Worker | null = null;
let recoveryTimer: ReturnType<typeof setInterval> | null = null;
let recovery: Promise<void> | null = null;
let shutdown: AbortController | null = null;

const recover = (): Promise<void> => {
  recovery ??= expireWorkflowAiTasks(env.WORKFLOW_AI_QUEUE_TIMEOUT_MS).finally(() => {
    recovery = null;
  });
  return recovery;
};

export const startWorkflowAiRuntime = async (input: WorkflowAiRuntimeOptions = {}): Promise<void> => {
  if (activeJob) return;
  const options: WorkflowAiProcessOptions = {
    runStructured: input.runStructured ?? runAiStructured,
    maxAttempts: MAX_ATTEMPTS,
    cancelPollMs: input.cancelPollMs ?? DEFAULT_CANCEL_POLL_MS,
    attemptTimeoutMs: input.attemptTimeoutMs ?? env.WORKFLOW_AI_ATTEMPT_TIMEOUT_MS,
  };
  const next = workflowAiJob();
  activeJob = next;
  const controller = new AbortController();
  shutdown = controller;
  try {
    activeWorker = await next.process({ concurrency: env.WORKFLOW_AI_BUDGET.globalConcurrent }, async (context) => {
      try {
        await processWorkflowAiTask(
          context.input.taskId,
          { signal: AbortSignal.any([context.signal, controller.signal]), heartbeat: () => context.heartbeat() },
          options,
        );
      } catch (caught) {
        if (controller.signal.aborted) {
          // Shutdown is not a provider failure. Persist before drain lets the process exit.
          if (!(await markWorkflowAiTaskCanceledIfRequested(context.input.taskId))) await requeueWorkflowAiTask(context.input.taskId);
          throw caught;
        }
        const error =
          caught instanceof WorkflowAiAttemptError
            ? caught
            : new WorkflowAiAttemptError("WORKFLOW_AI_RUNTIME_ERROR", caught instanceof Error ? caught.message : String(caught), true);
        const outcome = await settleWorkflowAiAttemptFailure(context.input.taskId, error, context.failureCount, options.maxAttempts);
        if (outcome === "retry") throw error;
        // Postgres owns the terminal result, including intentional cancellation.
      }
    });
    await recover();
    for (const taskId of await listRecoverableWorkflowAiTaskIds()) {
      try {
        await submitWorkflowAiTask(taskId);
      } catch (error) {
        // Submission already persists and wakes the failed task; recover the others.
        console.error("Workflow AI task resubmission failed", { taskId, error });
      }
    }
    recoveryTimer = setInterval(() => {
      void recover().catch((error) => console.error("Workflow AI recovery failed", error));
    }, HEARTBEAT_INTERVAL_MS);
  } catch (error) {
    await stopWorkflowAiRuntime();
    throw error;
  }
};

export const submitWorkflowAiTask = async (taskId: string): Promise<void> => {
  if (!activeJob) throw new Error("Workflow AI runtime is not started.");
  try {
    await activeJob.submit({ key: `task:${taskId}`, coalesce: true, input: { taskId } });
  } catch (error) {
    const failure = new WorkflowAiAttemptError(
      error instanceof StoreFullError ? "WORKFLOW_AI_QUEUE_FULL" : "WORKFLOW_AI_SUBMISSION_FAILED",
      "Workflow AI queue could not accept the task. Retry the workflow after capacity or connectivity recovers.",
      true,
    );
    await failWorkflowAiTask(taskId, failure);
    throw failure;
  }
};

export const stopWorkflowAiRuntime = async (): Promise<void> => {
  const worker = activeWorker;
  worker?.stop();
  shutdown?.abort(new Error("Workflow AI runtime stopped"));
  if (recoveryTimer) clearInterval(recoveryTimer);
  recoveryTimer = null;

  // Sync's existing drain budget bounds settlement; do not exit before DB requeue.
  try {
    await worker?.drain();
  } finally {
    // The recovery timer already reports its failure. Always allow a later start,
    // including when drain rejects, while preserving the drain error for callers.
    await recovery?.catch(() => {});
    activeWorker = null;
    activeJob = null;
    shutdown = null;
  }
};
