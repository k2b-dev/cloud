import { expect, test } from "bun:test";
import { env } from "@k2b/cloud/config";

test("retained Mail AI budget stays explicit", () => {
  expect(env.WORKFLOW_AI_BUDGET).toEqual({
    maxStepsPerSource: 2,
    tasksPerMinute: 10,
    burst: 20,
    sourcesPer24Hours: 2000,
    scopeConcurrent: 1,
    globalConcurrent: 4,
  });
});
