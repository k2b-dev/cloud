import { afterEach, beforeEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";

let openCode = "";
let commitFailure = false;
let commitCode = "permission_changed";
let abortStatus = 200;
let leaseCode = "";
const startKeys: string[] = [];
let received = 0;
let renews = 0;
let aborts = 0;
let controller = new AbortController();
let cancelCommit = false;
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
const originalFetch = globalThis.fetch;
mock.module("../api/client", () => ({
  apiClient: {
    bases: {
      ":baseId": {
        uploads: {
          $post: async (input: { json: { idempotencyKey: string } }) => {
            startKeys.push(input.json.idempotencyKey);
            return openCode
              ? Response.json({ code: openCode, message: "conflict" }, { status: 409 })
              : Response.json({ id: "s1", url: "https://filegate.test/lease", size: 3, chunkSize: 3, state: "open" });
          },
          ":id": {
            lease: {
              $post: async (_input: unknown, options: { init: { signal: AbortSignal } }) => {
                expect(options.init.signal.aborted).toBe(false);
                renews++;
                if (leaseCode) return Response.json({ code: leaseCode, message: "lease closed" }, { status: 409 });
                return Response.json({ url: "https://filegate.test/renewed" });
              },
            },
            abort: {
              $post: async () => {
                aborts++;
                return Response.json({}, { status: abortStatus });
              },
            },
            commit: {
              $post: async (_input: unknown, options: { init: { signal: AbortSignal } }) => {
                if (cancelCommit) {
                  controller.abort();
                  options.init.signal.throwIfAborted();
                }
                return commitFailure
                  ? Response.json({ code: commitCode, message: "permission changed" }, { status: 409 })
                  : Response.json({ entry: { path: "file" } });
              },
            },
          },
        },
      },
    },
  },
}));
const { uploadFile, UploadConflict } = await import("./uploads");
const options = () => ({ onConflict: "error" as const, signal: controller.signal, fallback: "Upload failed" });
const normalTransfer = async (_input: RequestInfo | URL, init?: RequestInit) => {
  if (new URL(String(_input)).searchParams.has("segments")) return Response.json({ items: [] });
  if (init?.method === "PUT") received = 3;
  return Response.json({ id: "s1", root: "cloud", size: 3, chunkSize: 3, state: "open", received, uploadedSegments: 0 });
};
beforeEach(() => setSystemTime(new Date("2026-10-15T00:00:00Z")));
afterEach(() => {
  setSystemTime();
  startKeys.length = 0;
  commitCode = "permission_changed";
  abortStatus = 200;
  leaseCode = "";
  storage.clear();
  globalThis.fetch = originalFetch;
  openCode = "";
  commitFailure = false;
  cancelCommit = false;
  received = 0;
  renews = 0;
  aborts = 0;
  controller = new AbortController();
});

test("only path-conflict 409 offers overwrite, other domain conflicts remain errors", async () => {
  openCode = "operation_busy";
  try {
    await uploadFile("base", "file", new Blob(["abc"]), options());
    throw new Error("expected error");
  } catch (error) {
    expect(error).not.toBeInstanceOf(UploadConflict);
  }
  openCode = "path_conflict";
  await expect(uploadFile("base", "file", new Blob(["abc"]), options())).rejects.toBeInstanceOf(UploadConflict);
});

test("browser renewal has a bounded retry budget and a final transfer failure aborts", async () => {
  globalThis.fetch = Object.assign(async () => Response.json({ error: "expired_capability", message: "secret-lease" }, { status: 401 }), {
    preconnect: originalFetch.preconnect,
  });
  await expect(uploadFile("base", "file", new Blob(["abc"]), options())).rejects.toThrow("Upload failed");
  expect(renews).toBe(3);
  expect(aborts).toBe(1);
});

test("browser commit receives cancellation and an ambiguous result is never aborted", async () => {
  globalThis.fetch = Object.assign(normalTransfer, { preconnect: originalFetch.preconnect });
  cancelCommit = true;
  await expect(uploadFile("base", "file", new Blob(["abc"]), options())).rejects.toBeDefined();
  expect(controller.signal.aborted).toBe(true);
  expect(aborts).toBe(0);
});

test("non-path commit conflicts never request overwrite", async () => {
  globalThis.fetch = Object.assign(normalTransfer, { preconnect: originalFetch.preconnect });
  commitFailure = true;
  try {
    await uploadFile("base", "file", new Blob(["abc"]), options());
    throw new Error("expected error");
  } catch (error) {
    expect(error).not.toBeInstanceOf(UploadConflict);
    expect(error).toHaveProperty("message", "permission changed");
  }
  expect(aborts).toBe(0);
});

test("a transient transfer keeps its key and never aborts", async () => {
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: "upload_capacity" }, { status: 503, headers: { "Retry-After": "5" } }),
    { preconnect: originalFetch.preconnect },
  );
  await expect(uploadFile("base", "file", new Blob(["abc"]), options())).rejects.toHaveProperty("kind", "busy");
  expect(aborts).toBe(0);
  expect(storage.size).toBe(1);
  await expect(uploadFile("base", "file", new Blob(["abc"]), options())).rejects.toHaveProperty("kind", "busy");
  expect(startKeys[1]).toBe(startKeys[0]!);
});

test("path_conflict at start drops the key even when the caller skips", async () => {
  openCode = "path_conflict";
  await expect(uploadFile("base", "file", new Blob(["abc"]), options())).rejects.toBeInstanceOf(UploadConflict);
  expect(storage.size).toBe(0);
  expect(aborts).toBe(0);
});

test.each(["write_conflict", "path_conflict"])(
  "commit %s aborts before offering replacement and overwrite remains a final error",
  async (code) => {
    globalThis.fetch = Object.assign(normalTransfer, { preconnect: originalFetch.preconnect });
    commitFailure = true;
    commitCode = code;
    await expect(uploadFile("base", "file", new Blob(["abc"]), options())).rejects.toBeInstanceOf(UploadConflict);
    expect(aborts).toBe(1);
    expect(storage.size).toBe(0);
    await expect(
      uploadFile("base", "file", new Blob(["abc"]), { ...options(), onConflict: "overwrite", expectedRevision: "old" }),
    ).rejects.toMatchObject({ kind: "final", message: "permission changed", code });
    expect(aborts).toBe(2);
    expect(startKeys[1]).not.toBe(startKeys[0]!);
  },
);

test("receipt_unknown at commit drops the key without aborting and retry uses a fresh key", async () => {
  globalThis.fetch = Object.assign(normalTransfer, { preconnect: originalFetch.preconnect });
  commitFailure = true;
  commitCode = "receipt_unknown";
  await expect(uploadFile("base", "file", new Blob(["abc"]), options())).rejects.toHaveProperty("code", "receipt_unknown");
  expect(storage.size).toBe(0);
  expect(aborts).toBe(0);
  commitFailure = false;
  await uploadFile("base", "file", new Blob(["abc"]), options());
  expect(startKeys[1]).not.toBe(startKeys[0]!);
});

test("a rejected abort retains the key after a final transfer error", async () => {
  abortStatus = 500;
  globalThis.fetch = Object.assign(async () => Response.json({ error: "mismatch" }, { status: 409 }), {
    preconnect: originalFetch.preconnect,
  });
  await expect(uploadFile("base", "file", new Blob(["abc"]), options())).rejects.toHaveProperty("kind", "final");
  expect(aborts).toBe(1);
  expect(storage.size).toBe(1);
});

test.each(["upload_closed", "receipt_unknown", "upload_changed"])("lease %s drops its dead key without an abort", async (code) => {
  leaseCode = code;
  globalThis.fetch = Object.assign(async () => Response.json({ error: "expired_capability" }, { status: 401 }), {
    preconnect: originalFetch.preconnect,
  });
  await expect(uploadFile("base", "file", new Blob(["abc"]), options())).rejects.toHaveProperty("code", code);
  expect(aborts).toBe(0);
  expect(storage.size).toBe(0);
});

test("a durable-key write failure happens before any start request", async () => {
  const failure = new DOMException("Storage full", "QuotaExceededError");
  const write = spyOn(localStorage, "setItem").mockImplementation(() => {
    throw failure;
  });
  try {
    await expect(uploadFile("base", "file", new Blob(["abc"]), options())).rejects.toBe(failure);
    expect(startKeys).toEqual([]);
    expect(aborts).toBe(0);
  } finally {
    write.mockRestore();
  }
});
