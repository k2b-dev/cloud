import { afterEach, expect, test } from "bun:test";
import { browserUploadKey } from "./upload-key";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});
afterEach(() => storage.clear());

test("logical upload start survives retries without persisting names or public tokens", async () => {
  const file = new File(["bytes"], "private-name.txt", { lastModified: 123 });
  const first = await browserUploadKey(["public", "secret-share-token"], file);
  const retry = await browserUploadKey(["public", "secret-share-token"], file);
  expect(retry.idempotencyKey).toBe(first.idempotencyKey);
  expect(JSON.stringify([...storage])).not.toContain("private-name");
  expect(JSON.stringify([...storage])).not.toContain("secret-share-token");
  first.finish();
  expect((await browserUploadKey(["public", "secret-share-token"], file)).idempotencyKey).not.toBe(first.idempotencyKey);
});

test("changed files and scopes receive distinct durable logical identities", async () => {
  const first = await browserUploadKey(["private", "base", "file"], new File(["a"], "file", { lastModified: 1 }));
  const changed = await browserUploadKey(["private", "base", "file"], new File(["a"], "file", { lastModified: 2 }));
  const elsewhere = await browserUploadKey(["private", "other", "file"], new File(["a"], "file", { lastModified: 1 }));
  expect(new Set([first.idempotencyKey, changed.idempotencyKey, elsewhere.idempotencyKey]).size).toBe(3);
});
