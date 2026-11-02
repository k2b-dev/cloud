import { expect, test } from "bun:test";
import type { CodeTestResult } from "@k2b/cloud/code";
import { CodeVersionEvidenceSchema, codeVersionEvidence } from "./version-evidence";

const call = (operation: string) => ({ sequence: 1, operation }) as CodeTestResult["cases"][number]["runs"][number]["calls"][number];
const run = (operations: string[], ok = true) => ({
  entrypoint: "weekly",
  ok,
  error: null,
  value: null,
  calls: operations.map(call),
  failures: [],
});
const result = (overrides: Partial<CodeTestResult>): CodeTestResult => ({
  version: 1,
  mode: "test",
  ok: true,
  error: null,
  diagnostics: [],
  cases: [],
  ...overrides,
});

test("passed fixtures become counts and calls per operation, without any call content", () => {
  const evidence = codeVersionEvidence(
    result({
      cases: [
        { name: "a", file: "test/a.json", ok: true, runs: [run(["mail.read", "spaces.task.create"]), run(["mail.read"])] },
        { name: "b", file: "test/b.json", ok: true, runs: [run(["mail.read"])] },
      ],
    }),
  );
  expect(evidence).toEqual({
    version: 1,
    tests: { state: "passed", passed: 2, total: 2, error: null },
    trial: {
      runs: 3,
      calls: [
        { operation: "mail.read", count: 3 },
        { operation: "spaces.task.create", count: 1 },
      ],
    },
  });
  expect(CodeVersionEvidenceSchema.safeParse(evidence).success).toBe(true);
});

test("a failing case is a finding about the Code, a missing runner is not", () => {
  const failed = codeVersionEvidence(
    result({
      ok: false,
      error: "code_test_failed",
      cases: [
        { name: "a", file: "test/a.json", ok: true, runs: [run([])] },
        { name: "b", file: "test/b.json", ok: false, runs: [run([], false)] },
      ],
    }),
  );
  expect(failed.tests).toEqual({ state: "failed", passed: 1, total: 2, error: "code_test_failed" });
  expect(codeVersionEvidence(result({ ok: false, error: "code_test_invalid_fixture" })).tests.state).toBe("failed");
  expect(codeVersionEvidence(result({ ok: false, error: "code_test_runner_unavailable" }))).toEqual({
    version: 1,
    tests: { state: "unavailable", passed: 0, total: 0, error: "code_test_runner_unavailable" },
    trial: null,
  });
});
