import { expect, test } from "bun:test";
import { generateCodeSdk } from "./generator";
import { sdkFixture } from "./sdk.test-fixture";
import { createCodeTestBridge } from "./test-bridge";
import { CODE_TEST_RESULT_JSON_SCHEMA, CodeTestCaseSchema, type CodeTestResult, CodeTestResultSchema } from "./test-contract";

const manifest = generateCodeSdk([sdkFixture()], { mode: "personal" }).manifest;
const target = { type: "work-shop.workshop", id: "destination" };
const invocation = (title = "One", id = target.id, key = "invoice:fixed") => ({
  call: { capability: "work-shop.item.create", target: { ...target, id }, refs: {}, input: { title } },
  metadata: { idempotencyKey: key },
});
const mock = { operation: "work-shop.item.create", target, replies: [{ ok: true as const, data: { id: "new-item" } }] };

test("successful keys replay old data across attempts without consuming another fixture", async () => {
  const bridge = createCodeTestBridge(manifest, [mock]);
  bridge.begin();
  const first = await bridge.call(mock.operation, invocation());
  bridge.begin();
  expect(await bridge.call(mock.operation, invocation())).toEqual(first);
  expect(bridge.calls()).toMatchObject([{ sequence: 1, replayed: true, result: { ok: true, data: { id: "new-item" } } }]);
  await expect(bridge.call(mock.operation, invocation("Changed"))).rejects.toThrow("idempotency_conflict");
  await expect(bridge.call(mock.operation, invocation("One", "another-target"))).rejects.toThrow("idempotency_conflict");
});

test("matching uses exact operation, target, input and refs; invalid schemas and missing mocks fail visibly", async () => {
  const bridge = createCodeTestBridge(manifest, [mock]);
  await expect(bridge.call(mock.operation, invocation("One", "unmocked", "new-key"))).rejects.toThrow("code_test_missing_mock");
  expect(bridge.failure()).toBe("code_test_missing_mock");
  expect(bridge.calls()[0]?.result).toEqual({ ok: false, error: "code_test_missing_mock" });
  bridge.begin();
  await expect(bridge.call(mock.operation, { ...invocation(), call: { ...invocation().call, input: { title: 4 } } })).rejects.toThrow(
    "code_test_invalid_input",
  );
  const invalid = createCodeTestBridge(manifest, [{ ...mock, replies: [{ ok: true, data: { id: 3 } }] }]);
  await expect(invalid.call(mock.operation, invocation())).rejects.toThrow("code_test_invalid_fixture");
  const specific = createCodeTestBridge(manifest, [
    mock,
    { ...mock, input: { title: "One" }, replies: [{ ok: true, data: { id: "specific" } }] },
  ]);
  expect(await specific.call(mock.operation, invocation())).toEqual({ id: "specific" });
});

test("none Actions execute each time; required Actions reject missing keys; domain errors do not create receipts", async () => {
  const move = {
    operation: "work-shop.item.move",
    target,
    replies: [
      { ok: true as const, data: { moved: true } },
      { ok: true as const, data: { moved: false } },
    ],
  };
  const bridge = createCodeTestBridge(manifest, [move]);
  const raw = { call: { capability: move.operation, target, refs: { destination: target }, input: { itemId: "item" } }, metadata: {} };
  expect(await bridge.call(move.operation, raw)).toEqual({ moved: true });
  expect(await bridge.call(move.operation, raw)).toEqual({ moved: false });
  await expect(bridge.call(mock.operation, { ...invocation(), metadata: {} })).rejects.toThrow("code_test_invalid_idempotency");
  const error = createCodeTestBridge(manifest, [{ ...mock, replies: [{ ok: false, error: "not_ready" }, ...mock.replies] }]);
  await expect(error.call(mock.operation, invocation())).rejects.toThrow("not_ready");
  expect(await error.call(mock.operation, invocation())).toEqual({ id: "new-item" });
  expect(error.calls().every((row) => !row.replayed)).toBe(true);
});

test("test cases and stable machine output have versioned JSON schemas", () => {
  expect(
    CodeTestCaseSchema.safeParse({
      version: 1,
      name: "weekly",
      now: Date.UTC(2030, 0, 2),
      seed: 42,
      mocks: [],
      runs: [{ entrypoint: "weekly" }],
    }).success,
  ).toBe(true);
  expect(CodeTestCaseSchema.safeParse({ version: 1, name: "weekly", now: "today", seed: 42, mocks: [], runs: [] }).success).toBe(false);
  const value: CodeTestResult = { version: 1, mode: "test", ok: true, error: null, diagnostics: [], cases: [] };
  expect(CodeTestResultSchema.parse(value)).toEqual(value);
  expect(CODE_TEST_RESULT_JSON_SCHEMA).toMatchObject({ type: "object", properties: { version: { const: 1 } } });
});
