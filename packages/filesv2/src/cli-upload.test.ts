import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "@k2b/filegate/utils";
import { uploadFile } from "./cli-upload";
import type { EntryResult, UploadSession } from "./contracts";

const defaults = new Map<string, string>();
const ctx = {
  getDefault: async (key: string) => defaults.get(key),
  setDefault: async (key: string, value: string | undefined) => {
    if (value === undefined) defaults.delete(key);
    else defaults.set(key, value);
  },
  options: { profile: "test", server: "https://cloud.test", token: "cloud-secret", output: "json" as const },
};
const directories: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  defaults.clear();
  for (const server of servers.splice(0)) server.stop(true);
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function file(contents: string) {
  const dir = await mkdtemp(join(tmpdir(), "filesv2-upload-"));
  directories.push(dir);
  const path = join(dir, "file");
  await writeFile(path, contents);
  return path;
}
const result: EntryResult = {
  base: {
    id: "base",
    area: "cloud",
    kind: "users",
    name: "Home",
    status: "existing",
    reason: null,
    indexEnabled: false,
    versioningEnabled: false,
  },
  entry: { name: "file", path: "file", size: 12, directory: false, modified: "2026-09-19" },
};
const session = (url: string, size = 12): UploadSession => ({
  id: "session",
  path: "file",
  size,
  chunkSize: 4,
  state: "open",
  url,
  expires: "2099-01-01",
});

test("CLI reads bounded disk-backed segments and reauthorizes an expired lease", async () => {
  const local = await file("abcdefghijkl");
  const chunks: string[] = [];
  let renews = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(request.headers.get("authorization")).toBeNull();
      expect(request.headers.get("cookie")).toBeNull();
      if (new URL(request.url).pathname === "/expired") return Response.json({ error: "expired_capability" }, { status: 401 });
      if (new URL(request.url).searchParams.has("segments"))
        return Response.json({
          items: await Promise.all(chunks.map(async (chunk, index) => ({ index, hash: await sha256(new TextEncoder().encode(chunk)) }))),
        });
      if (request.method === "PUT") chunks.push(await request.text());
      return Response.json({
        id: "session",
        root: "cloud",
        size: 12,
        chunkSize: 4,
        state: "open",
        uploadedSegments: 0,
        received: chunks.join("").length,
      });
    },
  });
  servers.push(server);
  const actual = await uploadFile(ctx, local, {
    scope: "base/path/error",
    open: async () => session(`${server.url}expired`),
    renew: async (_id, signal) => {
      expect(signal.aborted).toBe(false);
      renews++;
      return { url: `${server.url}valid` };
    },
    commit: async (_id, signal) => {
      expect(signal.aborted).toBe(false);
      return result;
    },
    abort: async () => {
      throw new Error("Unexpected abort");
    },
  });
  expect(actual).toEqual(result);
  expect(chunks).toEqual(["abcd", "efgh", "ijkl"]);
  expect(renews).toBe(1);
});

test("CLI caps repeated lease rejection, masks lease details, and aborts with a fresh signal", async () => {
  const local = await file("");
  let renews = 0,
    aborts = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ message: "secret-lease", error: "expired_capability" }, { status: 401 }),
  });
  servers.push(server);
  await expect(
    uploadFile(ctx, local, {
      scope: "base/path/error",
      open: async () => session(server.url.href, 0),
      renew: async () => {
        renews++;
        return { url: server.url.href };
      },
      commit: async () => result,
      abort: async (_id, signal) => {
        expect(signal.aborted).toBe(false);
        aborts++;
      },
    }),
  ).rejects.toThrow("Filegate upload failed.");
  expect(renews).toBe(3);
  expect(aborts).toBe(1);
});

test("CLI cancellation during open removes process listeners", async () => {
  const local = await file("");
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  await expect(
    uploadFile(ctx, local, {
      scope: "base/path/error",
      open: async (_size, signal) => {
        process.emit("SIGINT");
        signal.throwIfAborted();
        throw new Error("unreachable");
      },
      renew: async () => ({ url: "https://filegate.test" }),
      commit: async () => result,
      abort: async () => {},
    }),
  ).rejects.toThrow("Upload cancelled.");
  expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
});

test("CLI never aborts an ambiguous commit after cancellation", async () => {
  const local = await file("");
  let aborts = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ id: "session", root: "cloud", size: 0, chunkSize: 4, state: "open", uploadedSegments: 0, received: 0 }),
  });
  servers.push(server);
  await expect(
    uploadFile(ctx, local, {
      scope: "base/path/error",
      open: async () => session(server.url.href, 0),
      renew: async () => ({ url: server.url.href }),
      commit: async (_id, signal) => {
        process.emit("SIGINT");
        signal.throwIfAborted();
        return result;
      },
      abort: async () => {
        aborts++;
      },
    }),
  ).rejects.toThrow("Upload cancelled.");
  expect(aborts).toBe(0);
});

test("healthy long uploads may renew repeatedly while each failing segment remains bounded", async () => {
  const local = await file("abcdefghijklmnopqrst");
  const attempted = new Set<string>();
  const accepted = new Map<number, string>();
  let renews = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).searchParams.has("segments"))
        return Response.json({ items: [...accepted].map(([index, hash]) => ({ index, hash })) });
      const segment = new URL(request.url).searchParams.get("segment")!;
      if (request.method === "PUT" && !attempted.has(segment)) {
        attempted.add(segment);
        return Response.json({ error: "expired_capability" }, { status: 401 });
      }
      if (request.method === "PUT") accepted.set(Number(segment), await sha256(await request.arrayBuffer()));
      return Response.json({
        id: "session",
        root: "cloud",
        size: 20,
        chunkSize: 4,
        state: "open",
        uploadedSegments: accepted.size,
        received: accepted.size * 4,
      });
    },
  });
  servers.push(server);
  await uploadFile(ctx, local, {
    scope: "base/path/error",
    open: async () => session(server.url.href, 20),
    renew: async () => {
      renews++;
      return { url: server.url.href };
    },
    commit: async () => result,
    abort: async () => {
      throw new Error("Unexpected abort");
    },
  });
  expect(renews).toBe(5);
});

test("lost start responses retain the durable key and committed replay transfers no bytes", async () => {
  const local = await file("abc");
  let issued: string | undefined;
  const api = {
    scope: "base/file/error",
    open: async (_size: number, _signal: AbortSignal, key: string): Promise<UploadSession> => {
      issued = key;
      throw new Error("response lost");
    },
    renew: async () => {
      throw new Error("must not renew terminal replay");
    },
    commit: async () => result,
    abort: async () => {
      throw new Error("must not abort terminal replay");
    },
  };
  await expect(uploadFile(ctx, local, api)).rejects.toThrow("response lost");
  expect(defaults.size).toBe(1);
  expect([...defaults.values()][0]).toBe(issued!);
  const replayed = await uploadFile(ctx, local, {
    ...api,
    open: async (_size, _signal, key) => {
      expect(key).toBe(issued!);
      return { id: "session", path: "file", size: 3, chunkSize: 8 * 1024 * 1024, state: "committed", expires: "2099-01-01" };
    },
  });
  expect(replayed).toEqual(result);
  expect(defaults.size).toBe(0);
});
