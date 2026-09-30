import { expect, test } from "bun:test";
import { syncDefaultMaxBytes } from "./sync-budget";

test("a job or queue without retention holds 256 messages at its payload limit", () => {
  expect(syncDefaultMaxBytes()).toBe(256 * (128 * 1024 + 4096));
  expect(syncDefaultMaxBytes(8_000)).toBe(256 * (8_000 + 4096));
});

test("the default never exceeds 1 GiB, even for large payload limits", () => {
  expect(syncDefaultMaxBytes(4 * 1024 * 1024 - 4096)).toBe(1024 ** 3);
  expect(syncDefaultMaxBytes(16 * 1024 * 1024)).toBe(1024 ** 3);
});
