import { expect, test } from "bun:test";
import type { CodeTestResult } from "@k2b/cloud/code";
import { CodeVersionEvidenceSchema, codeVersionEvidence } from "./version-evidence";

const call = (operation: string): CodeTestResult["cases"][number]["runs"][number]["calls"][number] => ({
  sequence: 1,
  operation,
  call: { capability: operation, target: null, refs: {}, input: {} },
  idempotencyKey: null,
  result: { ok: true, data: null },
  replayed: false,
});
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
  expect(evidence).toMatchObject({
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

test("saved example sentences use the title for each sentence language", () => {
  const evidence = codeVersionEvidence(
    result({ cases: [{ name: "Morning", file: "test/morning.json", ok: true, runs: [run(["example.create"])] }] }),
    (id, locale) => (locale === "de" ? "Aufgabe erstellen" : "Create task"),
  );
  expect(evidence.examples?.[0]?.sentences.de).toBe("Aufgabe erstellen · 1 im Beispiel erfolgreich");
  expect(evidence.examples?.[0]?.sentences.en).toBe("Create task · 1 successful in the example");
});
