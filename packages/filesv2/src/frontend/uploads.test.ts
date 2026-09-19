import { afterEach, expect, mock, test } from "bun:test";

let openCode = "";
let commitFailure = false;
let received = 0;
let renews = 0;
let aborts = 0;
let controller = new AbortController();
let cancelCommit = false;
const originalFetch = globalThis.fetch;
mock.module("../api/client", () => ({
  apiClient: {
    bases: {
      ":baseId": {
        uploads: {
          $post: async () =>
            openCode
              ? Response.json({ code: openCode, message: "conflict" }, { status: 409 })
              : Response.json({ id: "s1", url: "https://filegate.test/lease", size: 3, chunkSize: 3 }),
          ":id": {
            lease: {
              $post: async (_input: unknown, options: { init: { signal: AbortSignal } }) => {
                expect(options.init.signal.aborted).toBe(false);
                renews++;
                return Response.json({ url: "https://filegate.test/renewed" });
              },
            },
            abort: {
              $post: async () => {
                aborts++;
                return Response.json({});
              },
            },
            commit: {
              $post: async (_input: unknown, options: { init: { signal: AbortSignal } }) => {
                if (cancelCommit) {
                  controller.abort();
                  options.init.signal.throwIfAborted();
                }
                return commitFailure
                  ? Response.json({ code: "permission_changed", message: "permission changed" }, { status: 409 })
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
  if (init?.method === "PUT") received = 3;
  return Response.json({ id: "s1", root: "cloud", size: 3, chunkSize: 3, state: "open", received, segments: {} });
};
afterEach(() => {
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

test("browser renewal has a bounded retry budget and failed transfer aborts", async () => {
  globalThis.fetch = Object.assign(async () => Response.json({ error: "expired", message: "secret-lease" }, { status: 401 }), {
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
