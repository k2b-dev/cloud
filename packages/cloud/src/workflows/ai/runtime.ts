import { StructuredOutputError } from "@k2b/nessi";
import type { Job, Worker } from "@k2b/sync";
import { lazySync } from "../../_internal/process-sync";
import { isAiSettingsError, runAiStructured } from "../../ai";
import { AiBackgroundAdmissionError, AiBackgroundCostError } from "../../ai/inference-calls";
import { executeAiTask } from "../../ai/task-execution";

import {
  claimWorkflowAiTask,
  completeWorkflowAiTask,
  failWorkflowAiTask,
  getWorkflowAiTask,
  listRecoverableWorkflowAiTaskIds,
  markWorkflowAiTaskCanceledIfRequested,
  requeueWorkflowAiTask,
  wakeWorkflowAiTask,
  workflowAiTaskCancellationRequested,
} from "./store";
import type { WorkflowAiTask } from "./types";

const JOB_ID = "cloud.workflow-ai";
const MAX_ATTEMPTS = 3;
const DEFAULT_CANCEL_POLL_MS = 500;
const HEARTBEAT_INTERVAL_MS = 10_000;

type StructuredRunner = typeof runAiStructured;

export type WorkflowAiRuntimeOptions = {
  runStructured?: StructuredRunner;
  cancelPollMs?: number;
};

/** Attempt budget shared by the job declaration and the Postgres-side settle logic. */
export type WorkflowAiProcessOptions = Required<WorkflowAiRuntimeOptions> & { maxAttempts: number };

const workflowAiJob = lazySync((sync) =>
  sync.job<{ taskId: string }>({
    id: JOB_ID,
    owner: "cloud",
    delivery: { ackWaitMs: 30_000, maxAttempts: MAX_ATTEMPTS, backoffMs: [1_000, 2_000] },
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
      signal,
      taskPrefix: "workflow",
    },
    runStructured,
  );

const retryableError = (error: unknown): boolean => {
  if (error instanceof AiBackgroundAdmissionError) return error.retryable;
  if (error instanceof AiBackgroundCostError) return false;
  if (isAiSettingsError(error)) return false;
  if (error instanceof StructuredOutputError) return error.code === "loop_failed";
  return true;
};

const errorCode = (error: unknown): string => {
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
  let canceled = false;
  let monitorError: unknown;
  let checking = false;
  let lastHeartbeat = Date.now();
  const abortForShutdown = () => controller.abort(ctx.signal.reason ?? new Error("Workflow AI runtime stopped"));
  ctx.signal.addEventListener("abort", abortForShutdown, { once: true });

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
    const result = await executeWorkflowAiRequest(task, options.runStructured, controller.signal);
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
    ctx.signal.removeEventListener("abort", abortForShutdown);
  }
};

let activeJob: Job<{ taskId: string }> | null = null;
let activeWorker: Worker | null = null;

export const startWorkflowAiRuntime = async (input: WorkflowAiRuntimeOptions = {}): Promise<void> => {
  if (activeJob) return;
  const options: WorkflowAiProcessOptions = {
    runStructured: input.runStructured ?? runAiStructured,
    maxAttempts: MAX_ATTEMPTS,
    cancelPollMs: input.cancelPollMs ?? DEFAULT_CANCEL_POLL_MS,
  };
  const next = workflowAiJob();
  activeJob = next;
  try {
    activeWorker = await next.process({ concurrency: 1 }, async (context) => {
      try {
        await processWorkflowAiTask(context.input.taskId, context, options);
      } catch (caught) {
        const error =
          caught instanceof WorkflowAiAttemptError
            ? caught
            : new WorkflowAiAttemptError("WORKFLOW_AI_RUNTIME_ERROR", caught instanceof Error ? caught.message : String(caught), true);
        const outcome = await settleWorkflowAiAttemptFailure(context.input.taskId, error, context.failureCount, options.maxAttempts);
        if (outcome === "retry") throw error;
        // Postgres owns the terminal result, including intentional cancellation.
      }
    });
    for (const taskId of await listRecoverableWorkflowAiTaskIds()) await submitWorkflowAiTask(taskId);
  } catch (error) {
    stopWorkflowAiRuntime();
    throw error;
  }
};

export const submitWorkflowAiTask = async (taskId: string): Promise<void> => {
  if (!activeJob) throw new Error("Workflow AI runtime is not started.");
  await activeJob.submit({ key: `task:${taskId}`, coalesce: true, input: { taskId } });
};

export const stopWorkflowAiRuntime = (): void => {
  activeWorker?.stop();

  activeWorker = null;
  activeJob = null;
};
