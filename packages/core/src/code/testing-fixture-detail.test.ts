import { expect, test } from "bun:test";
import { type CodeTestCase, generateCodeSdk } from "@k2b/cloud/code";
import { type CodeTestingHost, simulateCode, testCode } from "./testing";

const fixture: CodeTestCase = {
  version: 1,
  name: "weekly",
  now: Date.UTC(2030, 0, 2),
  seed: 42,
  mocks: [],
  runs: [{ entrypoint: "weekly", input: null }],
};
const limits = { requestBytes: 2 * 1024 * 1024, outputBytes: 64 * 1024, cases: 10, runs: 10, calls: 10, wallClockMs: 10_000 };
const code = () => ({ sdk: generateCodeSdk([], { mode: "personal" }), aiOperations: [], entry: "code.ts", files: { "code.ts": "" } });
const host: CodeTestingHost = {
  limits,
  check: async () => {
    throw new Error("must not check");
  },
  execute: async () => {
    throw new Error("must not execute");
  },
};

test("fixture parsing returns a located model-facing detail before calling either executor", async () => {
  const malformed = await testCode({ code: code(), tests: { "test/bad.json": "{" } }, host);
  expect(malformed).toMatchObject({
    error: "code_test_invalid_fixture",
    detail: {
      file: "test/bad.json",
      operation: null,
      mockIndex: null,
      replyIndex: null,
      path: [],
      reason: expect.stringContaining("JSON"),
    },
  });
  const invalid = { ...fixture, mocks: [{ operation: "work-shop.item.create", target: null, replies: [{ ok: "yes", data: {} }] }] };
  const result = await testCode({ code: code(), tests: { "test/bad.json": JSON.stringify(invalid) } }, host);
  expect(result).toMatchObject({
    error: "code_test_invalid_fixture",
    detail: {
      file: "test/bad.json",
      operation: "work-shop.item.create",
      mockIndex: 0,
      replyIndex: 0,
      path: ["mocks", 0, "replies", 0, "ok"],
      reason: expect.any(String),
    },
  });
  expect(await simulateCode({ code: code(), fixture: { ...fixture, runs: [...fixture.runs, ...fixture.runs] } }, host)).toMatchObject({
    error: "code_test_invalid_fixture",
    detail: { file: null, path: ["runs"], reason: expect.stringContaining("one run") },
  });
  expect(await simulateCode({ code: code(), fixture: { ...fixture, seed: -1 } }, host)).toMatchObject({
    error: "code_test_invalid_fixture",
    detail: { file: null, path: ["seed"], reason: expect.any(String) },
  });
});

test("oversized fixture details are omitted within the host output budget while preserving the stable refusal code", async () => {
  const invalid = { ...fixture, mocks: [{ operation: "x".repeat(1024), target: null, replies: [{ ok: "yes" }] }] };
  const result = await testCode(
    { code: code(), tests: { "test/bad.json": JSON.stringify(invalid) } },
    {
      ...host,
      limits: { ...limits, outputBytes: 256 },
    },
  );
  expect(result.error).toBe("code_test_invalid_fixture");
  expect(result).not.toHaveProperty("detail");
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(256);
});
