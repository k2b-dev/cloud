import { expect, test } from "bun:test";
import { checkStorageBudget } from "./storage-budget";
import { StorageJsonRequest } from "./storage-contracts";

const base = {
  area: "files" as const,
  bytes: 10,
  metadataBytes: 32,
  total: 58,
  previous: 0,
  previousBytes: 0,
  items: 10000,
  exists: false,
  limits: { total: 100, file: 50 },
};
test("files charge payload and metadata against total bytes, not count", () => {
  expect(checkStorageBudget(base)).toBe(true);
  expect(checkStorageBudget({ ...base, bytes: 11 })).toBe(false);
  expect(checkStorageBudget({ ...base, total: 0, bytes: 51 })).toBe(false);
  expect(checkStorageBudget({ ...base, metadataBytes: 33 })).toBe(false);
});
test("repeated empty files exhaust a small byte budget", () => {
  let total = 0;
  for (let items = 0; items < 3; items++) {
    expect(checkStorageBudget({ ...base, bytes: 0, items, total })).toBe(true);
    total += base.metadataBytes;
  }
  expect(checkStorageBudget({ ...base, bytes: 0, items: 3, total })).toBe(false);
  for (const metadataBytes of [0, -1, NaN, Infinity, 1.5]) {
    expect(checkStorageBudget({ ...base, bytes: 0, total: 0, metadataBytes })).toBe(false);
  }
});
test("KV retains its independent count and payload limits", () => {
  expect(checkStorageBudget({ ...base, area: "kv" })).toBe(false);
  expect(checkStorageBudget({ ...base, area: "kv", items: 999 })).toBe(true);
  expect(checkStorageBudget({ ...base, area: "kv", items: 0, bytes: 51, total: 0 })).toBe(false);
});
test("lower limits permit non-growing replacements including empty files", () => {
  expect(checkStorageBudget({ ...base, exists: true, total: 200, previous: 122, previousBytes: 90, bytes: 80 })).toBe(true);
  expect(checkStorageBudget({ ...base, exists: true, total: 200, previous: 122, previousBytes: 90, bytes: 91 })).toBe(false);
  expect(checkStorageBudget({ ...base, exists: true, total: 200, previous: 32, bytes: 0 })).toBe(true);
  expect(checkStorageBudget({ ...base, exists: true, total: 200, previous: 32, bytes: 0, metadataBytes: 33 })).toBe(false);
});
test("a smaller metadata charge cannot grow payload past a lowered file limit", () => {
  expect(checkStorageBudget({ ...base, exists: true, total: 200, previous: 100, previousBytes: 0, bytes: 51 })).toBe(false);
});
test("file JSON transport cannot bypass the binary path", () => {
  expect(StorageJsonRequest.safeParse({ area: "files", operation: "write", key: "x", content: "eA==" }).success).toBe(false);
  expect(StorageJsonRequest.safeParse({ area: "files", operation: "list" }).success).toBe(true);
});
