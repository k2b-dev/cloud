import { StructuredOutputError } from "@k2b/nessi";
import type { Job, Worker } from "@k2b/sync";
import { z } from "zod";
import { lazySync } from "../../_internal/process-sync";
import { isAiSettingsError, type RunAiStructuredInput, runAiStructured } from "../../ai";

import type { WorkflowJsonValue } from "../contracts";
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
import type { WorkflowAiRequest, WorkflowAiTask } from "./types";

const JOB_ID = "cloud.workflow-ai";
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_CANCEL_POLL_MS = 500;
const HEARTBEAT_INTERVAL_MS = 10_000;

type StructuredRunner = typeof runAiStructured;

export type WorkflowAiRuntimeOptions = {
  runStructured?: StructuredRunner;
  maxAttempts?: number;
  cancelPollMs?: number;
};

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

const asJson = (value: unknown): WorkflowJsonValue => JSON.parse(JSON.stringify(value)) as WorkflowJsonValue;
const choiceEnum = (values: string[]) => z.enum(values as [string, ...string[]]);
const structuredOutputSchema = (fields: Extract<WorkflowAiRequest, { kind: "extract_data" }>["fields"]) => {
  const shape: Record<string, z.ZodType> = {};
  for (const field of fields) {
    let schema: z.ZodType =
      field.type === "text"
        ? z.string().max(field.maxLength ?? 20_000)
        : field.type === "number"
          ? z.number()
          : field.type === "boolean"
            ? z.boolean()
            : field.type === "date_time"
              ? z.iso.datetime({ offset: true })
              : choiceEnum(field.choices!);
    if (!field.required) schema = schema.optional();
    shape[field.name] = schema.describe(field.description);
  }
  return z.object(shape).strict();
};

export const executeWorkflowAiRequest = async (task: WorkflowAiTask, runStructured: StructuredRunner, signal: AbortSignal) => {
  const request = task.request;
  const common = {
    appId: task.appId,
    requestedModelId: task.modelProfileId,
    signal,
    temperature: 0,
  } satisfies Partial<RunAiStructuredInput<z.ZodType>>;

  if (request.kind === "generate_text") {
    const result = await runStructured({
      ...common,
      task: "workflow-generate-text",
      systemPrompt: request.prompt,
      input: request.input === undefined ? "Create the requested text." : JSON.stringify(request.input),
      outputName: "generated_text",
      output: z.object({ text: z.string().max(request.maxOutputChars) }),
      maxOutputTokens: Math.min(8_192, Math.max(64, Math.ceil(request.maxOutputChars / 2))),
    });
    return { output: result.output.text as WorkflowJsonValue, usage: result.usage ? asJson(result.usage) : null };
  }

  if (request.kind === "classify") {
    const result = await runStructured({
      ...common,
      task: "workflow-classify",
      systemPrompt: `${request.prompt}\nReturn exactly one of the declared choices.`,
      input: JSON.stringify(request.input),
      outputName: "classification",
      output: z.object({ choice: choiceEnum(request.choices) }),
      maxOutputTokens: 200,
    });
    return { output: result.output.choice as WorkflowJsonValue, usage: result.usage ? asJson(result.usage) : null };
  }

  if (request.kind === "extract_data") {
    const result = await runStructured({
      ...common,
      task: "workflow-extract-data",
      systemPrompt: `${request.prompt}\nReturn only the declared fields. Do not invent values that are not supported by the input.`,
      input: JSON.stringify(request.input),
      outputName: "structured_data",
      output: structuredOutputSchema(request.fields),
      maxOutputTokens: 4_096,
    });
    return { output: asJson(result.output), usage: result.usage ? asJson(result.usage) : null };
  }

  const maximum = request.maxChoices ?? request.choices.length;
  const result = await runStructured({
    ...common,
    task: "workflow-classify-many",
    systemPrompt: `${request.prompt}\nReturn only unique values from the declared choices.`,
    input: JSON.stringify(request.input),
    outputName: "classifications",
    output: z.object({ choices: z.array(choiceEnum(request.choices)).min(request.minChoices).max(maximum) }),
    maxOutputTokens: 500,
  });
  const selected = new Set(result.output.choices);
  return {
    output: request.choices.filter((choice) => selected.has(choice)) as WorkflowJsonValue,
    usage: result.usage ? asJson(result.usage) : null,
  };
};

const retryableError = (error: unknown): boolean => {
  if (isAiSettingsError(error)) return false;
  if (error instanceof StructuredOutputError) return error.code === "loop_failed";
  return true;
};

const errorCode = (error: unknown): string => {
  if (isAiSettingsError(error)) return error.aiError.code.toUpperCase();
  if (error instanceof StructuredOutputError) return `WORKFLOW_AI_${error.code.toUpperCase()}`;
  return "WORKFLOW_AI_PROVIDER_ERROR";
};

export const processWorkflowAiTask = async (
  taskId: string,
  ctx: { signal: AbortSignal; heartbeat(): Promise<void> },
  options: Required<WorkflowAiRuntimeOptions>,
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

const workflowAiJob = (maxAttempts: number) =>
  lazySync((sync) => {
    const handle = sync.job<{ taskId: string }>({
      id: JOB_ID,
      owner: "cloud",
      delivery: { ackWaitMs: 30_000, maxAttempts, backoffMs: [1_000, 2_000] },
    });
    return handle;
  });

let activeJob: Job<{ taskId: string }> | null = null;
let activeWorker: Worker | null = null;

export const startWorkflowAiRuntime = async (input: WorkflowAiRuntimeOptions = {}): Promise<void> => {
  if (activeJob) return;
  const options: Required<WorkflowAiRuntimeOptions> = {
    runStructured: input.runStructured ?? runAiStructured,
    maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    cancelPollMs: input.cancelPollMs ?? DEFAULT_CANCEL_POLL_MS,
  };
  const next = workflowAiJob(options.maxAttempts)();
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
