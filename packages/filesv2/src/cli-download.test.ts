import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadFile } from "./cli-download";

const ctx = { options: { profile: "test", server: "https://cloud.test", token: "cloud-secret", output: "json" as const } };
const directories: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "filesv2-download-"));
  directories.push(path);
  return path;
}

test("download reauthorizes expired leases with a bounded attempt count", async () => {
  const dir = await directory();
  let leases = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      expect(request.headers.get("authorization")).toBeNull();
      return new URL(request.url).pathname === "/1" ? new Response("expired", { status: 401 }) : new Response("content");
    },
  });
  servers.push(server);
  const result = await downloadFile(ctx, join(dir, "file"), async (signal) => {
    expect(signal.aborted).toBe(false);
    return { url: `${server.url}${++leases}`, method: "GET", expires: "2099-01-01" };
  });
  expect(leases).toBe(2);
  expect(result.bytes).toBe(7);
  expect(await readFile(result.path, "utf8")).toBe("content");
  expect(await readdir(dir)).toEqual(["file"]);
});

test("download cancellation while requesting a lease cleans temporary state and listeners", async () => {
  const dir = await directory();
  const before = process.listenerCount("SIGINT");
  await expect(
    downloadFile(ctx, join(dir, "file"), async (signal) => {
      process.emit("SIGINT");
      signal.throwIfAborted();
      throw new Error("unreachable");
    }),
  ).rejects.toThrow("Filegate download failed");
  expect(await readdir(dir)).toEqual([]);
  expect(process.listenerCount("SIGINT")).toBe(before);
});
