import { expect, test } from "bun:test";
import { syncBudgetRetention } from "./sync-budget";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

test("a job or queue without retention holds 256 messages at its payload limit", () => {
  expect(syncBudgetRetention()).toEqual({ maxAgeMs: WEEK_MS, maxBytes: 256 * (128 * 1024 + 4096) });
  expect(syncBudgetRetention(8_000).maxBytes).toBe(256 * (8_000 + 4096));
});

test("the budget never exceeds Sync's own 1 GiB, even for large payload limits", () => {
  expect(syncBudgetRetention(4 * 1024 * 1024 - 4096).maxBytes).toBe(1024 ** 3);
  expect(syncBudgetRetention(8 * 1024 * 1024).maxBytes).toBe(1024 ** 3);
  expect(syncBudgetRetention(16 * 1024 * 1024).maxBytes).toBe(1024 ** 3);
});
