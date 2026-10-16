import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { browserUploadKey, UPLOAD_KEY_RETENTION_MS } from "./upload-key";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    get length() {
      return storage.size;
    },
    key: (index: number) => [...storage.keys()][index] ?? null,
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});
const now = Date.UTC(2026, 9, 15);
beforeEach(() => setSystemTime(now));
afterEach(() => {
  storage.clear();
  setSystemTime();
});

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

test("retention keeps the exact boundary, prunes older entries and preserves other apps", async () => {
  const id = crypto.randomUUID();
  storage.set("filesv2:upload:boundary", JSON.stringify({ id, at: now - UPLOAD_KEY_RETENTION_MS }));
  storage.set("filesv2:upload:old", JSON.stringify({ id, at: now - UPLOAD_KEY_RETENTION_MS - 1 }));
  storage.set("other:upload:old", "untouched");
  await browserUploadKey(["new"], new Blob([]));
  expect(storage.has("filesv2:upload:boundary")).toBe(true);
  expect(storage.has("filesv2:upload:old")).toBe(false);
  expect(storage.get("other:upload:old")).toBe("untouched");
});

test("legacy UUIDs are adopted once and expire a full retention after adoption", async () => {
  const file = new Blob(["a"]);
  const first = await browserUploadKey(["private"], file);
  const key = [...storage.keys()][0]!;
  storage.set(key, first.idempotencyKey);
  expect((await browserUploadKey(["private"], file)).idempotencyKey).toBe(first.idempotencyKey);
  expect(JSON.parse(storage.get(key)!)).toEqual({ id: first.idempotencyKey, at: now });
  setSystemTime(now + UPLOAD_KEY_RETENTION_MS);
  expect((await browserUploadKey(["private"], file)).idempotencyKey).toBe(first.idempotencyKey);
  expect(JSON.parse(storage.get(key)!).at).toBe(now);
  setSystemTime(now + UPLOAD_KEY_RETENTION_MS + 1);
  expect((await browserUploadKey(["private"], file)).idempotencyKey).not.toBe(first.idempotencyKey);
});

test("corrupt entries are removed without skipping keys during pruning", async () => {
  for (const [index, value] of [
    "not-json",
    "{}",
    "null",
    JSON.stringify({ id: "invalid", at: now }),
    JSON.stringify({ id: crypto.randomUUID(), at: "yesterday" }),
  ].entries())
    storage.set(`filesv2:upload:bad-${index}`, value);
  await browserUploadKey(["new"], new Blob([]));
  expect(storage.size).toBe(1);
  expect([...storage.keys()].some((key) => key.includes("bad-"))).toBe(false);
});

test("reuse preserves the original issuance timestamp", async () => {
  const first = await browserUploadKey(["private"], new Blob(["a"]));
  setSystemTime(now + 1000);
  const retry = await browserUploadKey(["private"], new Blob(["a"]));
  expect(retry.idempotencyKey).toBe(first.idempotencyKey);
  expect(JSON.parse([...storage.values()][0]!).at).toBe(now);
});
