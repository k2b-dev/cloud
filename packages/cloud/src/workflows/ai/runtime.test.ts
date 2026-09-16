import * as store from "./store";
import { AiBackgroundAdmissionError, AiBackgroundCostError } from "../../ai/inference-calls";
import { describe, expect, test, spyOn } from "bun:test";
import type { z } from "zod";
import type { RunAiStructuredInput, RunAiStructuredResult } from "../../ai";
import { executeWorkflowAiRequest, processWorkflowAiTask, settleWorkflowAiAttemptFailure } from "./runtime";
import type { WorkflowAiTask } from "./types";

const task = {
  id: "00000000-0000-4000-8000-000000000001",
  appId: "mail",
  usageUserId: "00000000-0000-4000-8000-000000000003",
  runId: "00000000-0000-4000-8000-000000000002",
  stepKey: "step:extract",
  effectKey: "workflow:extract",
  kind: "extract_data",
  modelProfileId: "model",
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
        modelProfileId: "model",
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
