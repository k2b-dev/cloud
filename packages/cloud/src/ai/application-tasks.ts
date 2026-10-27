import type { SQL } from "bun";
import { env } from "../config/env";
import type { AccessSubject } from "../server/services/access";
import { WorkflowAiAdmissionError, type WorkflowAiScope, workflowAiHash, workflowAiModelHash } from "../workflows/ai/policy";
import { submitWorkflowAiTask } from "../workflows/ai/runtime";
import {
  createWorkflowAiTask,
  getWorkflowAiTask,
  getWorkflowAiTaskByEffectKey,
  releaseApplicationAiTaskByEffectKey,
} from "../workflows/ai/store";
import { type AiTaskRequestInput, assertAiTaskRequestSize } from "./task-contracts";
import { resolveApplicationAiTaskModel } from "./task-model";

export type ApplicationAiTaskInput = {
  appId: string;
  scopeId: string;
  effectKey: string;
  task: string;
  request: AiTaskRequestInput;
  source: WorkflowAiScope;
  usageSubject?: AccessSubject;
  signal: AbortSignal;
};

export type ApplicationAiTaskKey = Pick<ApplicationAiTaskInput, "appId" | "scopeId" | "effectKey" | "usageSubject">;

const applicationEffectKey = (input: ApplicationAiTaskKey): string =>
  `application:${workflowAiHash({ app: input.appId, scope: input.scopeId, subject: input.usageSubject ?? null, effect: input.effectKey })}`;

/** Call in the transaction settling the application request, including discarded or failed requests. */
export const releaseApplicationAiTask = (input: ApplicationAiTaskKey, db?: SQL): Promise<boolean> =>
  releaseApplicationAiTaskByEffectKey({ appId: input.appId, scopeId: input.scopeId, effectKey: applicationEffectKey(input) }, db);

export { deleteApplicationAiTasks, listUnreleasedApplicationAiTaskSources } from "../workflows/ai/store";

const waitForTask = (signal: AbortSignal, delayMs = 250) =>
  new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });

/** One durable inference in the shared AI runtime, without creating a workflow. */
export const runApplicationAiTask = async (input: ApplicationAiTaskInput) => {
  input.signal.throwIfAborted();
  assertAiTaskRequestSize(input.request);
  const effectKey = applicationEffectKey(input);
  let task = await getWorkflowAiTaskByEffectKey(effectKey);
  if (!task) {
    const resolved = await resolveApplicationAiTaskModel(input.usageSubject, input.request.model);
    const admissionSignal = AbortSignal.any([input.signal, AbortSignal.timeout(env.WORKFLOW_AI_QUEUE_TIMEOUT_MS)]);
    for (;;) {
      input.signal.throwIfAborted();
      if (admissionSignal.aborted) throw new WorkflowAiAdmissionError("WORKFLOW_AI_QUEUE_TIMEOUT");
      try {
        task = (
          await createWorkflowAiTask({
            owner: { appId: input.appId, scopeId: input.scopeId, usageSubject: input.usageSubject },
            stepKey: input.task,
            effectKey,
            request: input.request,
            modelId: resolved.profile.id,
            modelRef: resolved.model,
            modelConfigHash: workflowAiModelHash(resolved.profile),
            scope: input.source,
          })
        ).task;
        break;
      } catch (error) {
        if (!(error instanceof WorkflowAiAdmissionError) || !error.retryable) throw error;
        await waitForTask(admissionSignal, 500).catch(() => {
          input.signal.throwIfAborted();
          throw new WorkflowAiAdmissionError("WORKFLOW_AI_QUEUE_TIMEOUT");
        });
      }
    }
  }

  if (task.status === "queued") await submitWorkflowAiTask(task.id);
  let current = task;
  for (;;) {
    input.signal.throwIfAborted();
    if (current.status === "succeeded") return { output: current.output, usage: current.usage, input: current.request.input };
    if (current.status === "failed" || current.status === "canceled")
      throw Object.assign(new Error("Application AI task did not complete. Retry the operation or inspect AI availability."), {
        code: current.errorCode ?? "WORKFLOW_AI_FAILED",
      });
    await waitForTask(input.signal);
    const latest = await getWorkflowAiTask(task.id);
    if (!latest) throw new WorkflowAiAdmissionError("WORKFLOW_AI_SOURCE_UNAVAILABLE");
    current = latest;
  }
};
