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

const keyOf = () => [...storage.keys()].find((key) => key.startsWith("filesv2:upload:"))!;
const atOf = (key: string) => Number(storage.get(key.replace("filesv2:upload:", "filesv2:upload-at:")));

test("retention keeps the exact boundary, prunes older entries and preserves other apps", async () => {
  const id = crypto.randomUUID();
  storage.set("filesv2:upload:boundary", id);
  storage.set("filesv2:upload-at:boundary", String(now - UPLOAD_KEY_RETENTION_MS));
  storage.set("filesv2:upload:old", id);
  storage.set("filesv2:upload-at:old", String(now - UPLOAD_KEY_RETENTION_MS - 1));
  storage.set("other:upload:old", "untouched");
  await browserUploadKey(["new"], new Blob([]));
  expect(storage.has("filesv2:upload:boundary")).toBe(true);
  expect(storage.has("filesv2:upload:old")).toBe(false);
  expect(storage.has("filesv2:upload-at:old")).toBe(false);
  expect(storage.get("other:upload:old")).toBe("untouched");
});

test("stored keys stay bare UUIDs, so a tab running the previous client keeps resuming", async () => {
  const first = await browserUploadKey(["private"], new Blob(["a"]));
  await browserUploadKey(["other"], new Blob(["b"]));
  // The previous client read the value verbatim as its idempotency key.
  expect(storage.get(keyOf())).toBe(first.idempotencyKey);
  for (const [key, value] of storage) if (key.startsWith("filesv2:upload:")) expect(value).toMatch(/^[0-9a-f-]{36}$/);
});

test("keys without a start time are adopted as started now and expire a full retention after the last start", async () => {
  const file = new Blob(["a"]);
  const first = await browserUploadKey(["private"], file);
  const key = keyOf();
  storage.delete(key.replace("filesv2:upload:", "filesv2:upload-at:"));
  expect((await browserUploadKey(["private"], file)).idempotencyKey).toBe(first.idempotencyKey);
  expect(atOf(key)).toBe(now);
  setSystemTime(now + UPLOAD_KEY_RETENTION_MS + 1);
  expect((await browserUploadKey(["private"], file)).idempotencyKey).not.toBe(first.idempotencyKey);
});

test("a full storage still reuses existing keys without throwing", async () => {
  const legacy = crypto.randomUUID();
  storage.set("filesv2:upload:legacy", legacy);
  const first = await browserUploadKey(["private"], new Blob(["a"]));
  const setItem = localStorage.setItem;
  storage.delete("filesv2:upload-at:legacy");
  localStorage.setItem = () => {
    throw new DOMException("full", "QuotaExceededError");
  };
  try {
    expect((await browserUploadKey(["private"], new Blob(["a"]))).idempotencyKey).toBe(first.idempotencyKey);
    expect(storage.get("filesv2:upload:legacy")).toBe(legacy);
    // Issuing a new key still fails before the start request.
    await expect(browserUploadKey(["other"], new Blob(["a"]))).rejects.toThrow("full");
  } finally {
    localStorage.setItem = setItem;
  }
});

test("corrupt and orphaned entries are removed without skipping keys during pruning", async () => {
  for (const [index, value] of ["not-a-uuid", "", JSON.stringify({ id: crypto.randomUUID(), at: now })].entries())
    storage.set(`filesv2:upload:bad-${index}`, value);
  storage.set("filesv2:upload-at:orphan", String(now));
  await browserUploadKey(["new"], new Blob([]));
  expect(storage.size).toBe(2);
  expect([...storage.keys()].some((key) => key.includes("bad-") || key.includes("orphan"))).toBe(false);
});

test("finish removes the key and its start time", async () => {
  const start = await browserUploadKey(["private"], new Blob(["a"]));
  expect(storage.size).toBe(2);
  start.finish();
  expect(storage.size).toBe(0);
});

test("each start refreshes the start time, so a session opened by a late retry is never pruned early", async () => {
  const day = 24 * 60 * 60 * 1000;
  const first = await browserUploadKey(["private"], new Blob(["a"]));
  setSystemTime(now + 3 * day);
  const retry = await browserUploadKey(["private"], new Blob(["a"]));
  expect(retry.idempotencyKey).toBe(first.idempotencyKey);
  expect(atOf(keyOf())).toBe(now + 3 * day);
  setSystemTime(now + 3 * day + UPLOAD_KEY_RETENTION_MS);
  expect((await browserUploadKey(["private"], new Blob(["a"]))).idempotencyKey).toBe(first.idempotencyKey);
});
