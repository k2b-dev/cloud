import { expect, test } from "bun:test";
import { fileImportManifest } from "./file-ref.test-fixture";
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
  expect(invalid.calls()[0]?.result).toMatchObject({
    ok: false,
    error: "code_test_invalid_fixture",
    detail: {
      operation: mock.operation,
      mockIndex: 0,
      replyIndex: 0,
      path: ["mocks", 0, "replies", 0, "data", "id"],
      reason: expect.stringContaining("string"),
    },
  });
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

test("exhausted mocks locate the next reply and count non-replayed calls across runs", async () => {
  const bridge = createCodeTestBridge(manifest, [mock]);
  await bridge.call(mock.operation, invocation());
  // A successful keyed replay does not consume a reply or count toward exhaustion.
  await bridge.call(mock.operation, invocation());
  bridge.begin();
  await expect(bridge.call(mock.operation, invocation("Two", target.id, "invoice:two"))).rejects.toThrow("code_test_mock_exhausted");
  expect(bridge.calls()[0]?.result).toEqual({
    ok: false,
    error: "code_test_mock_exhausted",
    detail: {
      operation: mock.operation,
      mockIndex: 0,
      replyIndex: 1,
      path: ["mocks", 0, "replies", 1],
      reason: "Mock exhausted: calls=2 (excluding replays), replies=1. Each reply serves exactly one call; add a reply for each call.",
    },
  });
  // Even a caught refusal must retain its count on the next attempt.
  await expect(bridge.call(mock.operation, invocation("Three", target.id, "invoice:three"))).rejects.toThrow("code_test_mock_exhausted");
  expect(bridge.calls()[1]?.result).toMatchObject({
    detail: { replyIndex: 2, reason: expect.stringContaining("calls=3 (excluding replays), replies=1") },
  });
  expect(bridge.failure()).toBe("code_test_mock_exhausted");
  expect(CodeTestResultSchema.shape.cases.element.shape.runs.element.shape.calls.parse(bridge.calls())).toEqual(bridge.calls());
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

test("query mocks preserve envelope pagination while validating domain data separately", async () => {
  const operation = "work-shop.stock.list";
  const bridge = createCodeTestBridge(manifest, [
    {
      operation,
      target,
      replies: [
        { ok: true, data: { rows: [{ id: "one", state: "ready" }], next: null }, page: { hasMore: true, nextCursor: "opaque:two" } },
        { ok: true, data: { rows: [], next: null }, page: { hasMore: false } },
      ],
    },
  ]);
  const call = (input: { cursor?: string }) =>
    bridge.call(operation, { call: { capability: operation, target, refs: {}, input }, metadata: {} });
  expect(await call({})).toEqual({
    data: { rows: [{ id: "one", state: "ready" }], next: null },
    page: { hasMore: true, nextCursor: "opaque:two" },
  });
  expect(await call({ cursor: "opaque:two" })).toEqual({ data: { rows: [], next: null }, page: { hasMore: false } });
  expect(bridge.calls()[1]?.call.input).toEqual({ cursor: "opaque:two" });
});

test("Action mocks reject query pagination rather than silently dropping it", async () => {
  const bridge = createCodeTestBridge(manifest, [{ ...mock, replies: [{ ...mock.replies[0]!, page: { hasMore: false } }] }]);
  await expect(bridge.call(mock.operation, invocation())).rejects.toThrow("code_test_invalid_fixture");
  expect(bridge.calls()[0]?.result).toMatchObject({
    detail: { operation: mock.operation, replyIndex: 0, path: ["mocks", 0, "replies", 0, "page"], reason: expect.any(String) },
  });
});

test("nested reply failures retain fixture indexes across attempts and survive the public result schema", async () => {
  const operation = "work-shop.stock.list";
  const bridge = createCodeTestBridge(manifest, [
    mock,
    {
      operation,
      target,
      replies: [
        { ok: true, data: { rows: [], next: null } },
        { ok: true, data: { rows: [{ id: "one", state: "invalid" }], next: null } },
      ],
    },
  ]);
  const raw = { call: { capability: operation, target, refs: {}, input: {} }, metadata: {} };
  await bridge.call(operation, raw);
  bridge.begin();
  await expect(bridge.call(operation, raw)).rejects.toThrow("code_test_invalid_fixture");
  const result = CodeTestResultSchema.parse({
    version: 1,
    mode: "test",
    ok: false,
    error: null,
    diagnostics: [],
    cases: [
      {
        name: "nested",
        file: "test/nested.json",
        ok: false,
        runs: [
          {
            entrypoint: "weekly",
            ok: false,
            error: bridge.failure(),
            value: null,
            calls: bridge.calls(),
            failures: [],
          },
        ],
      },
    ],
  });
  expect(result.cases[0]?.runs[0]?.calls[0]?.result).toMatchObject({
    error: "code_test_invalid_fixture",
    detail: {
      operation,
      mockIndex: 1,
      replyIndex: 1,
      path: ["mocks", 1, "replies", 1, "data", "rows", 0, "state"],
      reason: expect.any(String),
    },
  });
});

test("file mocks pass only checked references and keep the business receipt stable across fresh references", async () => {
  const manifest = generateCodeSdk([sdkFixture(), fileImportManifest()], { mode: "personal" }).manifest;
  const file = { id: "fake-file-1", name: "invoice.pdf", mediaType: "application/pdf", size: 5 };
  const read = "work-shop.stock.export";
  const write = "imports.import";
  const bridge = createCodeTestBridge(manifest, [
    { operation: read, target, replies: [{ ok: true, data: file }] },
    { operation: write, target: null, replies: [{ ok: true, data: { imported: true } }] },
  ]);
  const received = await bridge.call(read, { call: { capability: read, target, refs: {}, input: {} }, metadata: {} });
  expect(received).toEqual(file);
  const invoke = (file: typeof received) => ({
    call: { capability: write, target: null, refs: {}, input: { file } },
    metadata: { idempotencyKey: "invoice:fixed" },
  });
  expect(await bridge.call(write, invoke(received))).toEqual({ imported: true });
  bridge.begin();
  expect(await bridge.call(write, invoke({ ...file, id: "fake-file-2" }))).toEqual({ imported: true });
  expect(bridge.calls()[0]?.replayed).toBe(true);
  await expect(bridge.call(write, invoke({ ...file, bytes: "body" }))).rejects.toThrow("code_test_invalid_input");
  const invalid = createCodeTestBridge(manifest, [{ operation: read, target, replies: [{ ok: true, data: { ...file, size: 101 } }] }]);
  await expect(invalid.call(read, { call: { capability: read, target, refs: {}, input: {} }, metadata: {} })).rejects.toThrow(
    "code_test_invalid_fixture",
  );
  expect(invalid.calls()[0]?.result).toMatchObject({
    detail: { operation: read, replyIndex: 0, path: ["mocks", 0, "replies", 0, "data", "size"], reason: expect.stringContaining("100") },
  });
});
