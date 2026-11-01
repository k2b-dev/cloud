import type { CodeTestResult } from "@k2b/cloud/code";
import { z } from "zod";

/** Operations listed per version; a version names a bounded set, and the list stays small enough for the approval page. */
const TRIAL_OPERATION_LIMIT = 50;

/**
 * What Core itself saw when a version was submitted, never what its author claims: `check` always passed, because
 * submission refuses anything else. `tests` and `trial` come from the author's test/*.json fixtures, which ran against
 * fake data. `trial` lists the calls those runs made, so a reviewer sees what the Code does. Immutable with the submission.
 */
export const CodeVersionEvidenceSchema = z
  .object({
    version: z.literal(1),
    tests: z
      .object({
        state: z.enum(["passed", "failed", "none", "unavailable"]),
        passed: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
        /** Stable failure code when the fixtures could not run or the run as a whole failed. */
        error: z.string().nullable(),
      })
      .strict(),
    trial: z
      .object({
        runs: z.number().int().nonnegative(),
        calls: z.array(z.object({ operation: z.string(), count: z.number().int().positive() }).strict()),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type CodeVersionEvidence = z.infer<typeof CodeVersionEvidenceSchema>;

export const NO_TESTS_EVIDENCE: CodeVersionEvidence = {
  version: 1,
  tests: { state: "none", passed: 0, total: 0, error: null },
  trial: null,
};

/** Failure codes that say nothing about the Code: the fixtures did not get to run. */
const NOT_RUN = new Set([
  "code_test_checker_unavailable",
  "code_test_runner_unavailable",
  "code_test_cancelled",
  "code_job_busy",
  "code_job_time_limit",
  "code_job_cancelled",
  "code_job_failed",
]);

export const unavailableEvidence = (error: string): CodeVersionEvidence => ({
  version: 1,
  tests: { state: "unavailable", passed: 0, total: 0, error },
  trial: null,
});

/** Reduce a complete test result to the facts a reviewer needs. Call contents stay out: only operations and counts. */
export function codeVersionEvidence(result: CodeTestResult): CodeVersionEvidence {
  if (!result.ok && !result.cases.length && result.error && NOT_RUN.has(result.error)) return unavailableEvidence(result.error);
  const counts = new Map<string, number>();
  let runs = 0;
  for (const testCase of result.cases)
    for (const run of testCase.runs) {
      runs++;
      for (const call of run.calls) counts.set(call.operation, (counts.get(call.operation) ?? 0) + 1);
    }
  const passed = result.cases.filter((testCase) => testCase.ok).length;
  return {
    version: 1,
    tests: {
      state: result.ok ? "passed" : "failed",
      passed,
      total: result.cases.length,
      error: result.ok ? null : result.error,
    },
    trial: runs
      ? {
          runs,
          calls: [...counts]
            .map(([operation, count]) => ({ operation, count }))
            .sort((a, b) => b.count - a.count || a.operation.localeCompare(b.operation))
            .slice(0, TRIAL_OPERATION_LIMIT),
        }
      : null,
  };
}
