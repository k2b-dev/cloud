import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadFile } from "./cli-upload";
import type { EntryResult, UploadSession } from "./contracts";

const ctx = { options: { profile: "test", server: "https://cloud.test", token: "cloud-secret", output: "json" as const } };
const directories: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
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
      if (new URL(request.url).pathname === "/expired") return Response.json({ error: "expired" }, { status: 401 });
      if (request.method === "PUT") chunks.push(await request.text());
      return Response.json({
        id: "session",
        root: "cloud",
        size: 12,
        chunkSize: 4,
        state: "open",
        segments: {},
        received: chunks.join("").length,
      });
    },
  });
  servers.push(server);
  const actual = await uploadFile(ctx, local, {
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
    fetch: () => Response.json({ message: "secret-lease", error: "expired" }, { status: 401 }),
  });
  servers.push(server);
  await expect(
    uploadFile(ctx, local, {
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
    fetch: () => Response.json({ id: "session", root: "cloud", size: 0, chunkSize: 4, state: "open", segments: {}, received: 0 }),
  });
  servers.push(server);
  await expect(
    uploadFile(ctx, local, {
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
  let renews = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const segment = new URL(request.url).searchParams.get("segment")!;
      if (request.method === "PUT" && !attempted.has(segment)) {
        attempted.add(segment);
        return Response.json({ error: "expired" }, { status: 401 });
      }
      return Response.json({ id: "session", root: "cloud", size: 20, chunkSize: 4, state: "open", segments: {}, received: 20 });
    },
  });
  servers.push(server);
  await uploadFile(ctx, local, {
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
