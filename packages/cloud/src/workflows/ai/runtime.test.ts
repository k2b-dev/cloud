import { describe, expect, spyOn, test } from "bun:test";
import type { z } from "zod";
import type { RunAiStructuredInput, RunAiStructuredResult } from "../../ai";
import { AiBackgroundAdmissionError, AiBackgroundCostError } from "../../ai/inference-calls";
import { aiModelFixture } from "../../ai/model-fixture";
import { createAiProvider } from "../../ai/provider";
import * as structured from "../../ai/structured";
import * as taskModel from "../../ai/task-model";
import { executeWorkflowAiRequest, processWorkflowAiTask, settleWorkflowAiAttemptFailure } from "./runtime";
import * as store from "./store";
import type { WorkflowAiTask } from "./types";

const task = {
  id: "00000000-0000-4000-8000-000000000001",
  appId: "mail",
  usageUserId: "00000000-0000-4000-8000-000000000003",
  runId: "00000000-0000-4000-8000-000000000002",
  stepKey: "step:extract",
  effectKey: "workflow:extract",
  kind: "extract_data",
  modelId: "model",
  request: {
    kind: "extract_data",
    prompt: "Extract event data",
    input: { subject: "Planning" },
    fields: [
      { name: "ready", type: "boolean", description: "Whether the event is complete", required: true },
      { name: "startsAt", type: "date_time", description: "Start with offset", required: false },
    ],
  },
  inputHash: "a".repeat(64),
  status: "running",
  output: null,
  usage: null,
  attempts: 1,
  errorCode: null,
  errorMessage: null,
  cancelRequestedAt: null,
  createdAt: "2026-08-22T00:00:00.000Z",
  startedAt: "2026-08-22T00:00:00.000Z",
  completedAt: null,
  updatedAt: "2026-08-22T00:00:00.000Z",
} satisfies WorkflowAiTask;

describe("workflow structured AI runtime", () => {
  test("builds and enforces the declared output object", async () => {
    const runStructured = (async <TOutput extends z.ZodType>(
      input: RunAiStructuredInput<TOutput>,
    ): Promise<RunAiStructuredResult<TOutput>> => {
      expect(input.attribution).toEqual({ userId: task.usageUserId, workflowRunId: task.runId, stepKey: task.stepKey });
      return {
        output: input.output.parse({ ready: true, startsAt: "2026-08-22T09:00:00+02:00" }),
        model: { id: "model" },
        structuredMeta: { mode: "native", repaired: false, attempts: 1, usedResponseFormat: true },
      };
    }) as typeof import("../../ai")["runAiStructured"];

    await expect(executeWorkflowAiRequest(task, runStructured, new AbortController().signal)).resolves.toMatchObject({
      output: { ready: true, startsAt: "2026-08-22T09:00:00+02:00" },
    });
  });
});

test("background cost stop fails the workflow task without scheduling another attempt", async () => {
  const claim = spyOn(store, "claimWorkflowAiTask").mockResolvedValue(task);
  const cancel = spyOn(store, "workflowAiTaskCancellationRequested").mockResolvedValue(false);
  const fail = spyOn(store, "failWorkflowAiTask").mockResolvedValue(null);
  const requeue = spyOn(store, "requeueWorkflowAiTask").mockResolvedValue(undefined);
  try {
    const outcome = await processWorkflowAiTask(
      task.id,
      { signal: new AbortController().signal, heartbeat: async () => {} },
      {
        maxAttempts: 3,
        cancelPollMs: 500,
        runStructured: async () => {
          throw new AiBackgroundCostError();
        },
      },
    ).catch((error) => {
      expect(error).toMatchObject({ code: "ai_background_cost_stop", retryable: false });
      return settleWorkflowAiAttemptFailure(task.id, error, 0, 3);
    });
    expect(outcome).toBe("failed");
    expect(fail).toHaveBeenCalledTimes(1);
    expect(requeue).not.toHaveBeenCalled();
  } finally {
    claim.mockRestore();
    cancel.mockRestore();
    fail.mockRestore();
    requeue.mockRestore();
  }
});

for (const retryable of [true, false])
  test(`background admission retryable=${retryable} follows the bounded workflow retry policy`, async () => {
    const claim = spyOn(store, "claimWorkflowAiTask").mockResolvedValue(task);
    const cancel = spyOn(store, "workflowAiTaskCancellationRequested").mockResolvedValue(false);
    const fail = spyOn(store, "failWorkflowAiTask").mockResolvedValue(null);
    const requeue = spyOn(store, "requeueWorkflowAiTask").mockResolvedValue(undefined);
    try {
      const outcome = await processWorkflowAiTask(
        task.id,
        {
          signal: new AbortController().signal,
          heartbeat: async () => {},
        },
        {
          maxAttempts: 3,
          cancelPollMs: 500,
          runStructured: async () => {
            throw new AiBackgroundAdmissionError(retryable);
          },
        },
      ).catch((error) => {
        expect(error).toMatchObject({ retryable, code: retryable ? "ai_background_budget_reserved" : "ai_background_budget_insufficient" });
        return settleWorkflowAiAttemptFailure(task.id, error, 0, 3);
      });
      expect(outcome).toBe(retryable ? "retry" : "failed");
      expect(requeue).toHaveBeenCalledTimes(retryable ? 1 : 0);
      expect(fail).toHaveBeenCalledTimes(retryable ? 0 : 1);
    } finally {
      claim.mockRestore();
      cancel.mockRestore();
      fail.mockRestore();
      requeue.mockRestore();
    }
  });

test("a keepalive-only or non-settling runner cannot hold a workflow attempt past its absolute budget", async () => {
  const claim = spyOn(store, "claimWorkflowAiTask").mockResolvedValue(task);
  const cancel = spyOn(store, "workflowAiTaskCancellationRequested").mockResolvedValue(false);
  let providerSignal: AbortSignal | undefined;
  try {
    await expect(
      processWorkflowAiTask(
        task.id,
        {
          signal: new AbortController().signal,
          heartbeat: async () => {},
        },
        {
          maxAttempts: 3,
          cancelPollMs: 500,
          attemptTimeoutMs: 20,
          runStructured: async (input) => {
            providerSignal = input.signal;
            // An SSE provider may continue sending comments without ever completing.
            return new Promise(() => {});
          },
        },
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_AI_TIMEOUT", retryable: true });
    expect(providerSignal?.aborted).toBe(true);
  } finally {
    claim.mockRestore();
    cancel.mockRestore();
  }
});

test("continuous SSE keepalive chunks do not extend the absolute inference deadline", async () => {
  const claim = spyOn(store, "claimWorkflowAiTask").mockResolvedValue(task);
  const cancel = spyOn(store, "workflowAiTaskCancellationRequested").mockResolvedValue(false);
  let keepalive: ReturnType<typeof setInterval> | undefined;
  let chunks = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
            keepalive = setInterval(() => {
              controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
            }, 2);
          },
          cancel() {
            clearInterval(keepalive);
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  try {
    await expect(
      processWorkflowAiTask(
        task.id,
        { signal: new AbortController().signal, heartbeat: async () => {} },
        {
          maxAttempts: 3,
          cancelPollMs: 500,
          attemptTimeoutMs: 50,
          runStructured: async ({ signal }) => {
            const response = await fetch(server.url, { signal });
            if (!response.body) throw new Error("Missing synthetic SSE body");
            for await (const _chunk of response.body) chunks += 1;
            throw new Error("SSE ended without a result");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_AI_TIMEOUT", retryable: true });
    expect(chunks).toBeGreaterThan(0);
  } finally {
    clearInterval(keepalive);
    server.stop(true);
    claim.mockRestore();
    cancel.mockRestore();
  }
});

test("shutdown before claim returns does not start another provider call", async () => {
  const claim = spyOn(store, "claimWorkflowAiTask").mockResolvedValue(task);
  const cancel = spyOn(store, "workflowAiTaskCancellationRequested").mockResolvedValue(false);
  let calls = 0;
  try {
    await expect(
      processWorkflowAiTask(
        task.id,
        { signal: AbortSignal.abort(), heartbeat: async () => {} },
        {
          maxAttempts: 3,
          cancelPollMs: 500,
          runStructured: async () => {
            calls += 1;
            throw new Error("must not call");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_AI_INTERRUPTED", retryable: true });
    expect(calls).toBe(0);
  } finally {
    claim.mockRestore();
    cancel.mockRestore();
  }
});

test("workflow execution keeps its admitted variant and class trace after a class reassignment", async () => {
  const pinned = {
    ...task,
    modelRef: { requestedClass: "thorough", class: "balanced", id: "model" },
    request: { ...task.request, model: { class: "thorough" } },
  } satisfies WorkflowAiTask;
  const profile = aiModelFixture({ id: "model" });
  const resolve = spyOn(structured, "resolveAiWorkflowModel").mockResolvedValue({
    model: { id: "model" },
    profile,
    provider: createAiProvider(profile),
  });
  const run: typeof structured.runAiStructured = async (input) => {
    expect(input.model).toEqual({ id: "model" });
    const resolved = await input.resolveModel?.(input.model);
    expect(resolved?.model).toEqual(pinned.modelRef);
    return {
      output: input.output.parse({ ready: true }),
      model: pinned.modelRef,
      structuredMeta: { mode: "native", repaired: false, attempts: 1, usedResponseFormat: true },
    };
  };
  try {
    expect(await executeWorkflowAiRequest(pinned, run, new AbortController().signal)).toMatchObject({ output: { ready: true } });
    expect(resolve).toHaveBeenCalledWith({ id: "model" });
  } finally {
    resolve.mockRestore();
  }
});

test("application retries reauthorize the admitted variant and preserve the original class trace", async () => {
  const pinned = {
    ...task,
    runId: null,
    usageSubject: { type: "user", userId: "person" },
    modelRef: { requestedClass: "fast", class: "balanced", id: "model" },
    request: { ...task.request, model: { class: "fast" } },
  } satisfies WorkflowAiTask;
  const profile = aiModelFixture({ id: "model" });
  const resolve = spyOn(taskModel, "resolveApplicationAiTaskModel").mockResolvedValue({
    model: { id: "model" },
    profile,
    provider: createAiProvider(profile),
  });
  const run: typeof structured.runAiStructured = async (input) => {
    expect(input.usageSubject).toEqual(pinned.usageSubject);
    expect(input.model).toEqual({ id: "model" });
    const resolved = await input.resolveModel?.(input.model);
    expect(resolved?.model).toEqual(pinned.modelRef);
    return {
      output: input.output.parse({ ready: true }),
      model: pinned.modelRef,
      structuredMeta: { mode: "native", repaired: false, attempts: 1, usedResponseFormat: true },
    };
  };
  try {
    expect(await executeWorkflowAiRequest(pinned, run, new AbortController().signal)).toMatchObject({ output: { ready: true } });
    expect(resolve).toHaveBeenCalledWith(pinned.usageSubject, { id: "model" });
    resolve.mockRejectedValue(new Error("Model grant revoked"));
    await expect(executeWorkflowAiRequest(pinned, run, new AbortController().signal)).rejects.toThrow("Model grant revoked");
  } finally {
    resolve.mockRestore();
  }
});
