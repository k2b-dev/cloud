import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import type { RunAiStructuredInput, RunAiStructuredResult } from "../../ai";
import { executeWorkflowAiRequest } from "./runtime";
import type { WorkflowAiTask } from "./types";

describe("workflow structured AI runtime", () => {
  test("builds and enforces the declared output object", async () => {
    const task = {
      id: "00000000-0000-4000-8000-000000000001",
      appId: "mail",
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
    const runStructured = (async <TOutput extends z.ZodType>(
      input: RunAiStructuredInput<TOutput>,
    ): Promise<RunAiStructuredResult<TOutput>> => ({
      output: input.output.parse({ ready: true, startsAt: "2026-08-22T09:00:00+02:00" }),
      modelProfileId: "model",
      structuredMeta: { mode: "native", repaired: false, attempts: 1, usedResponseFormat: true },
    })) as typeof import("../../ai")["runAiStructured"];

    await expect(executeWorkflowAiRequest(task, runStructured, new AbortController().signal)).resolves.toMatchObject({
      output: { ready: true, startsAt: "2026-08-22T09:00:00+02:00" },
    });
  });
});
