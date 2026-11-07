import { expect, test } from "bun:test";
import { env } from "@k2b/cloud/config";
import { startIncomingAutomationBackfillInputSchema } from "./contracts";

test("Mail pilot budget and deliberate recompute are explicit", () => {
  expect(env.WORKFLOW_AI_BUDGET).toEqual({
    maxStepsPerSource: 2,
    tasksPerMinute: 10,
    burst: 20,
    sourcesPer24Hours: 2000,
    scopeConcurrent: 1,
    globalConcurrent: 4,
  });
  const operation = { operationId: "00000000-0000-4000-8000-000000000001", expectedRevision: 1, recomputeAi: true };
  expect(startIncomingAutomationBackfillInputSchema.safeParse(operation).success).toBe(false);
  expect(startIncomingAutomationBackfillInputSchema.safeParse({ ...operation, retryFailed: true }).success).toBe(true);
});
