import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import { createServer as createTcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");
const directories: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
const transferServers: Server[] = [];
const identityId = "11111111-1111-4111-8111-111111111111";
const cloudToken = "cld_filesv2_test";
const leaseSecret = "filegate-lease-secret";

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(
    transferServers.splice(0).map(
      (server) =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    ),
  );
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "cld-filesv2-test-"));
  directories.push(path);
  return path;
}

function serve(fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
  servers.push(server);
  return server;
}

async function start(args: string[], options: { server?: string; stdin?: string; locale?: string } = {}) {
  const config = join(await directory(), "config.json");
  await writeFile(config, "{}", { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { ...process.env, CLD_CONFIG: config, CLD_LOCALE: options.locale ?? "en" };
  delete env.CLD_TOKEN;
  delete env.CLD_SERVER;
  return Bun.spawn({
    cmd: [
      process.execPath,
      "run",
      "packages/cloud-cli/src/index.ts",
      ...(options.server ? ["--server", options.server, "--token", cloudToken] : []),
      ...args,
    ],
    cwd: repoRoot,
    env,
    stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function finish(proc: Awaited<ReturnType<typeof start>>) {
  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode, stdout, stderr };
}

async function run(args: string[], options: { server?: string; stdin?: string; locale?: string } = {}) {
  return finish(await start(args, options));
}

async function serveTransfer(listener: RequestListener) {
  const server = createServer(listener);
  transferServers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
  return `http://127.0.0.1:${address.port}/?lease=${leaseSecret}`;
}

const area = { enabled: true, root: "cloud", prefix: "", homes: "users", groups: "groups", archive: "archive" };
const configuration = {
  url: "https://files.example.test",
  cloud: { ...area, autoCreate: false, autoArchive: true },
  freeipa: { ...area, enabled: false, root: "freeipa" },
  collabora: { url: "", internalUrl: "", wopiOrigin: "", documentFormat: "odf" },
  tokenConfigured: true,
};
const base = {
  id: "base-1",
  area: "cloud",
  kind: "users",
  name: "alice",
  status: "existing",
  reason: null,
  indexEnabled: false,
  versioningEnabled: true,
};
const entry = { name: "résumé.txt", path: "Documents/résumé.txt", directory: false, size: 12, modified: "2026-09-18T12:00:00Z" };
const inventoryItem = {
  identityId,
  name: "alice",
  path: "users/alice",
  kind: "users",
  area: "cloud",
  status: "unknown",
  reason: "identity_unavailable",
  baseId: null,
  uid: null,
  gid: null,
  actions: { create: false, adopt: false, archive: false, browse: false, delete: false, retire: false },
};
const inventory = {
  configuration,
  availability: { localLinuxEnabled: true, freeipaEnabled: false },
  root: {
    name: "cloud",
    indexEnabled: false,
    versioningEnabled: true,
    files: null,
    directories: null,
    bytes: null,
    versions: 2,
    versionBytes: 40,
    activeUploads: 1,
    available: 100,
    capacity: 200,
  },
  items: [inventoryItem],
  next: "opaque+/=?& cursor",
  issue: "identity_unavailable",
};

describe("Filesv2 CLI integration", () => {
  test("registers English and German help without authentication", async () => {
    for (const locale of ["en", "de"]) {
      const result = await run(["filesv2", "--help"], { locale });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain(locale === "en" ? "Browse files" : "Dateien durchsuchen");
      expect(result.stdout).toContain("download");
      expect(result.stdout).toContain("admin");
      const nested = await run(["filesv2", "admin", "configuration", "set", "--help"], { locale });
      expect(nested.exitCode, nested.stderr).toBe(0);
      expect(nested.stdout).toContain("--input-file");
      expect(nested.stdout).toContain("--stdin");
    }
  }, 20_000);

  test("preserves JSON snapshots, JSONL items, opaque cursors and Cloud locale/auth headers", async () => {
    const requests: Array<{ url: URL; authorization: string | null; locale: string | null }> = [];
    const server = serve((request) => {
      const url = new URL(request.url);
      requests.push({ url, authorization: request.headers.get("authorization"), locale: request.headers.get("accept-language") });
      if (url.pathname === "/api/filesv2/bases")
        return Response.json({ items: [base], issues: [{ area: "freeipa", code: "unavailable" }] });
      if (url.pathname.endsWith("/entries")) return Response.json({ base, path: "Documents/ä & +", items: [entry], next: inventory.next });
      if (url.pathname === "/api/filesv2/admin") return Response.json(inventory);
      return Response.json({ message: "unexpected route" }, { status: 404 });
    });
    const options = { server: server.url.href, locale: "de" };
    const bases = await run(["--json", "filesv2", "bases", "list"], options);
    expect(bases.exitCode, bases.stderr).toBe(0);
    expect(JSON.parse(bases.stdout)).toEqual({ items: [base], issues: [{ area: "freeipa", code: "unavailable" }] });
    expect(bases.stderr).toContain("unavailable");
    const page = await run(["--json", "filesv2", "list", base.id, "--path", "Documents/ä & +", "--after", inventory.next], options);
    expect(page.exitCode, page.stderr).toBe(0);
    expect(JSON.parse(page.stdout)).toEqual({ base, path: "Documents/ä & +", items: [entry], next: inventory.next });
    expect(requests.at(-1)?.url.searchParams.get("path")).toBe("Documents/ä & +");
    expect(requests.at(-1)?.url.searchParams.get("after")).toBe(inventory.next);
    const admin = await run(
      ["--json", "filesv2", "admin", "inventory", "--area", "freeipa", "--kind", "groups", "--after", inventory.next],
      options,
    );
    expect(admin.exitCode, admin.stderr).toBe(0);
    expect(JSON.parse(admin.stdout)).toEqual(inventory);
    expect(requests.at(-1)?.url.searchParams.get("area")).toBe("freeipa");
    expect(requests.at(-1)?.url.searchParams.get("kind")).toBe("groups");
    expect(requests.at(-1)?.url.searchParams.get("after")).toBe(inventory.next);
    for (const [args, expected] of [
      [["bases", "list"], base],
      [["list", base.id], entry],
      [["admin", "inventory"], inventoryItem],
    ] as const) {
      const lines = await run(["--jsonl", "filesv2", ...args], options);
      expect(lines.exitCode, lines.stderr).toBe(0);
      expect(
        lines.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual([expected]);
    }
    const config = await run(["--json", "filesv2", "admin", "configuration", "get"], options);
    expect(config.exitCode, config.stderr).toBe(0);
    expect(JSON.parse(config.stdout)).toEqual(configuration);
    expect(requests.at(-1)?.url.searchParams.get("includeEntries")).toBe("false");
    const text = await run(["filesv2", "admin", "inventory"], options);
    expect(text.stdout).toContain("unbekannt");
    expect(text.stderr).toContain(inventory.next);
    expect(requests.every((request) => request.authorization === `Bearer ${cloudToken}` && request.locale === "de")).toBe(true);
  }, 30_000);

  test("sends private configuration through file/stdin and never echoes malformed secrets", async () => {
    const payloads: unknown[] = [];
    const server = serve(async (request) => {
      expect(request.method).toBe("PUT");
      expect(new URL(request.url).pathname).toBe("/api/filesv2/admin/configuration");
      payloads.push(await request.json());
      return Response.json({ saved: true });
    });
    const dir = await directory();
    const file = join(dir, "configuration.json");
    const { tokenConfigured: _, ...input } = configuration;
    const secret = "private-filegate-backend-token";
    await writeFile(file, JSON.stringify({ ...input, token: secret }), { mode: 0o600 });
    const saved = await run(["--json", "filesv2", "admin", "configuration", "set", "--input-file", file], { server: server.url.href });
    expect(saved.exitCode, saved.stderr).toBe(0);
    expect(JSON.parse(saved.stdout)).toEqual({ saved: true });
    expect(saved.stdout + saved.stderr).not.toContain(secret);
    expect(payloads[0]).toEqual({ ...input, collabora: { url: "", internalUrl: "", wopiOrigin: "", documentFormat: "odf" }, token: secret });
    for (const value of [input, { ...input, token: "" }, { ...input, cloud: { ...input.cloud, autoCreate: true, autoArchive: false } }]) {
      const result = await run(["--jsonl", "filesv2", "admin", "configuration", "set", "--stdin"], {
        server: server.url.href,
        stdin: JSON.stringify(value),
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('{"saved":true}');
      expect(payloads.at(-1)).toEqual(value);
    }
    const count = payloads.length;
    const malformed = await run(["filesv2", "admin", "configuration", "set", "--stdin"], {
      server: server.url.href,
      stdin: `{"token":"${secret}`,
    });
    expect(malformed.exitCode).not.toBe(0);
    expect(malformed.stdout + malformed.stderr).not.toContain(secret);
    const invalid = await run(["filesv2", "admin", "configuration", "set", "--stdin"], {
      server: server.url.href,
      stdin: JSON.stringify({ ...input, cloud: { ...area, enabled: secret } }),
    });
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stdout + invalid.stderr).not.toContain(secret);
    const inline = await run(["filesv2", "admin", "configuration", "set", "--input", JSON.stringify({ ...input, token: secret })], {
      server: server.url.href,
    });
    expect(inline.exitCode).not.toBe(0);
    expect(inline.stdout + inline.stderr).not.toContain(secret);
    expect(payloads).toHaveLength(count);
  }, 25_000);

  test("requires confirmed valid adoption and propagates server authorization failures", async () => {
    const writes: unknown[] = [];
    const server = serve(async (request) => {
      if (request.method === "POST") {
        writes.push(await request.json());
        return Response.json({ id: "assigned" });
      }
      return Response.json({ code: "admin_required", message: "Administrator access required" }, { status: 403 });
    });
    const options = { server: server.url.href };
    for (const args of [[identityId], ["not-a-uuid", "--yes"]]) {
      const result = await run(["filesv2", "admin", "adopt", ...args], options);
      expect(result.exitCode).not.toBe(0);
      expect(writes).toHaveLength(0);
    }
    const adopted = await run(
      ["--json", "filesv2", "admin", "adopt", identityId, "--area", "freeipa", "--kind", "groups", "--yes"],
      options,
    );
    expect(adopted.exitCode, adopted.stderr).toBe(0);
    expect(JSON.parse(adopted.stdout)).toEqual({ id: "assigned" });
    expect(writes).toEqual([{ identityId, area: "freeipa", kind: "groups" }]);
    const denied = await run(["--json", "filesv2", "admin", "inventory"], options);
    expect(denied.exitCode).not.toBe(0);
    expect(denied.stdout).toBe("");
    expect(denied.stderr).toContain("Administrator access required");
  }, 15_000);

  test("streams binary and empty files directly without sending Cloud credentials to Filegate", async () => {
    const bytes = new Uint8Array([0, 255, 1, 128, 65, 0, 10]);
    const transferHeaders: Headers[] = [];
    const filegate = serve((request) => {
      transferHeaders.push(request.headers);
      const empty = new URL(request.url).pathname === "/empty";
      let offset = 0;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (empty || offset >= bytes.length) {
              controller.close();
              return;
            }
            controller.enqueue(bytes.slice(offset, offset + 2));
            offset += 2;
          },
        }),
        { headers: { "Content-Length": String(empty ? 0 : bytes.length) } },
      );
    });
    const leases: Array<{ authorization: string | null; path: string }> = [];
    const cloud = serve(async (request) => {
      const body = await request.json();
      leases.push({ authorization: request.headers.get("authorization"), path: body.path });
      return Response.json({
        url: `${filegate.url}${body.path === "empty.txt" ? "empty" : "file"}?lease=${leaseSecret}`,
        method: "GET",
        expires: "2030-01-01T00:00:00Z",
      });
    });
    const dir = await directory();
    for (const [remote, expected] of [
      ["nested/résumé.txt", bytes],
      ["empty.txt", new Uint8Array()],
    ] as const) {
      const out = join(dir, remote === "empty.txt" ? "empty" : "binary");
      const result = await run(["--json", "filesv2", "download", base.id, remote, "--out", out], { server: cloud.url.href });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ path: out, bytes: expected.length });
      expect(new Uint8Array(await readFile(out))).toEqual(expected);
      expect((await lstat(out)).mode & 0o777).toBe(0o600);
      expect(result.stdout + result.stderr).not.toContain(leaseSecret);
    }
    expect(leases).toEqual([
      { authorization: `Bearer ${cloudToken}`, path: "nested/résumé.txt" },
      { authorization: `Bearer ${cloudToken}`, path: "empty.txt" },
    ]);
    expect(transferHeaders).toHaveLength(2);
    for (const headers of transferHeaders) {
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("cookie")).toBeNull();
    }
    expect((await readdir(dir)).sort()).toEqual(["binary", "empty"]);
  }, 15_000);

  test("preserves existing files, symlinks and destinations created during a transfer", async () => {
    const dir = await directory();
    const existing = join(dir, "existing");
    const symbolic = join(dir, "symbolic");
    const race = join(dir, "race");
    await writeFile(existing, "keep");
    await symlink(existing, symbolic);
    let calls = 0;
    const filegate = serve(async () => {
      await writeFile(race, "concurrent writer");
      return new Response("download");
    });
    const cloud = serve(() => {
      calls += 1;
      return Response.json({ url: `${filegate.url}?lease=${leaseSecret}`, method: "GET", expires: "2030-01-01T00:00:00Z" });
    });
    for (const out of [existing, symbolic]) {
      const result = await run(["filesv2", "download", base.id, "file", "--out", out], { server: cloud.url.href });
      expect(result.exitCode).not.toBe(0);
      expect(calls).toBe(0);
    }
    const missingOut = await run(["filesv2", "download", base.id, "file"], { server: cloud.url.href });
    expect(missingOut.exitCode).not.toBe(0);
    expect(calls).toBe(0);
    const result = await run(["filesv2", "download", base.id, "file", "--out", race], { server: cloud.url.href });
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(existing, "utf8")).toBe("keep");
    expect((await lstat(symbolic)).isSymbolicLink()).toBe(true);
    expect(await readFile(race, "utf8")).toBe("concurrent writer");
    expect((await readdir(dir)).sort()).toEqual(["existing", "race", "symbolic"]);
  }, 20_000);

  test("redacts failed and redirected transfers and removes partial output", async () => {
    const dir = await directory();
    let targetCalls = 0;
    const target = serve(() => {
      targetCalls += 1;
      return new Response("must not be read");
    });
    const filegate = serve((request) =>
      new URL(request.url).pathname === "/redirect"
        ? Response.redirect(`${target.url}?token=${leaseSecret}`, 307)
        : new Response(`Sensitive response ${leaseSecret}`, { status: 403 }),
    );
    const cloud = serve(async (request) => {
      const body = await request.json();
      return Response.json({ url: `${filegate.url}${body.path}?lease=${leaseSecret}`, method: "GET", expires: "2030-01-01T00:00:00Z" });
    });
    for (const remote of ["redirect", "failure"]) {
      const result = await run(["--json", "filesv2", "download", base.id, remote, "--out", join(dir, remote)], { server: cloud.url.href });
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Filegate download failed");
      expect(result.stderr).not.toContain(leaseSecret);
      expect(result.stderr).not.toContain(filegate.url.href);
      expect(result.stderr).not.toContain("Sensitive response");
      expect(await readdir(dir)).toEqual([]);
    }
    expect(targetCalls).toBe(0);
  }, 15_000);

  test("cleans a started download after SIGINT without exposing its lease", async () => {
    const dir = await directory();
    let requested = false;
    const url = await serveTransfer((_request, response) => {
      requested = true;
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.write(Buffer.alloc(64 * 1024, 42));
      // Leave the stream open until the CLI cancels it.
    });
    const cloud = serve(() => Response.json({ url, method: "GET", expires: "2030-01-01T00:00:00Z" }));
    const proc = await start(["--json", "filesv2", "download", base.id, "file", "--out", join(dir, "output")], { server: cloud.url.href });
    const completed = finish(proc);
    const deadline = setTimeout(() => proc.kill("SIGKILL"), 10_000);
    try {
      let bytesWritten = false;
      const until = Date.now() + 5_000;
      while (Date.now() < until && !bytesWritten) {
        const temporary = (await readdir(dir)).find((name) => name.startsWith(".filesv2-download-"));
        if (temporary) bytesWritten = (await lstat(join(dir, temporary, "content")).catch(() => null))?.size === 64 * 1024;
        if (!bytesWritten) await Bun.sleep(10);
      }
      expect(requested).toBe(true);
      expect(bytesWritten).toBe(true);
      proc.kill("SIGINT");
      const result = await completed;
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Filegate download failed");
      expect(result.stderr).not.toContain(leaseSecret);
      expect(result.stderr).not.toContain(url);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      clearTimeout(deadline);
      if (proc.exitCode === null) proc.kill("SIGKILL");
      await completed;
    }
  }, 15_000);

  test("rejects a truncated Content-Length response and removes downloaded fragments", async () => {
    const dir = await directory();
    const sockets: Socket[] = [];
    const filegate = createTcpServer((socket) => {
      sockets.push(socket);
      socket.once("data", () => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 65536\r\nConnection: close\r\n\r\ntruncated bytes"));
    });
    await new Promise<void>((done) => filegate.listen(0, "127.0.0.1", done));
    const address = filegate.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
    const url = `http://127.0.0.1:${address.port}/?lease=${leaseSecret}`;
    const cloud = serve(() => Response.json({ url, method: "GET", expires: "2030-01-01T00:00:00Z" }));
    const proc = await start(["--json", "filesv2", "download", base.id, "file", "--out", join(dir, "output")], { server: cloud.url.href });
    const deadline = setTimeout(() => proc.kill("SIGKILL"), 10_000);
    try {
      const result = await finish(proc);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Filegate download failed");
      expect(result.stderr).not.toContain(leaseSecret);
      expect(result.stderr).not.toContain(url);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      clearTimeout(deadline);
      if (proc.exitCode === null) proc.kill("SIGKILL");
      await proc.exited;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done) => filegate.close(() => done()));
    }
  }, 15_000);

  test("filters authoritative inventory and preserves archive metadata and pagination", async () => {
    const archive = {
      id: identityId,
      area: "freeipa",
      kind: "groups",
      name: "old group",
      originalPath: "prefix/groups/old group",
      path: "prefix/archive/old-group-1",
      state: "archived",
      createdAt: "2026-09-18T12:00:00Z",
      canRestore: true,
      canDelete: true,
    };
    const archivePage = { items: [archive], next: identityId };
    const orphan = {
      ...inventoryItem,
      status: "orphaned",
      reason: "identity_missing",
      actions: { ...inventoryItem.actions, archive: true, browse: true, delete: true },
    };
    const requests: URL[] = [];
    const server = serve((request) => {
      const url = new URL(request.url);
      requests.push(url);
      expect(request.headers.get("authorization")).toBe(`Bearer ${cloudToken}`);
      expect(request.headers.get("accept-language")).toBe("de");
      return Response.json(url.pathname.endsWith("/archives") ? archivePage : { ...inventory, items: [orphan], issue: null });
    });
    const options = { server: server.url.href, locale: "de" };
    const filtered = await run(
      [
        "--json",
        "filesv2",
        "admin",
        "inventory",
        "--area",
        "freeipa",
        "--kind",
        "groups",
        "--status",
        "orphaned",
        "--search",
        "old & +",
        "--after",
        inventory.next,
      ],
      options,
    );
    expect(filtered.exitCode, filtered.stderr).toBe(0);
    expect(JSON.parse(filtered.stdout)).toEqual({ ...inventory, items: [orphan], issue: null });
    expect(requests[0]?.searchParams.get("q")).toBe("old & +");
    expect(requests[0]?.searchParams.get("status")).toBe("orphaned");
    expect(requests[0]?.searchParams.get("after")).toBe(inventory.next);
    const archives = await run(
      ["--json", "filesv2", "admin", "archives", "list", "--area", "freeipa", "--search", "old & +", "--after", identityId],
      options,
    );
    expect(archives.exitCode, archives.stderr).toBe(0);
    expect(JSON.parse(archives.stdout)).toEqual(archivePage);
    expect(requests.at(-1)?.searchParams.get("area")).toBe("freeipa");
    expect(requests.at(-1)?.searchParams.get("q")).toBe("old & +");
    expect(requests.at(-1)?.searchParams.get("after")).toBe(identityId);
    const lines = await run(["--jsonl", "filesv2", "admin", "archives", "list", "--area", "freeipa"], options);
    expect(lines.exitCode, lines.stderr).toBe(0);
    expect(
      lines.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([archive]);
  }, 15_000);

  test("sends lifecycle operations only with confirmation and retains pending states", async () => {
    const writes: Array<{ path: string; method: string; body: unknown }> = [];
    const operation = { id: "operation-1", state: "pending", path: "prefix/groups/alumni" };
    const server = serve(async (request) => {
      writes.push({ path: new URL(request.url).pathname, method: request.method, body: await request.json() });
      expect(request.headers.get("authorization")).toBe(`Bearer ${cloudToken}`);
      return Response.json(new URL(request.url).pathname.includes("/root/") ? inventory.root : operation);
    });
    const options = { server: server.url.href };
    for (const args of [
      ["directories", "create", identityId],
      ["directories", "create", "not-a-uuid", "--yes"],
      ["directories", "archive", "alumni"],
      ["directories", "retire", "alumni"],
      ["directories", "delete", "alumni", "--yes"],
      ["archives", "restore", identityId, "--yes"],
      ["archives", "delete", identityId, "--confirm-path", "prefix/archive/alumni"],
      ["root", "rebuild"],
    ]) {
      const rejected = await run(["filesv2", "admin", ...args], options);
      expect(rejected.exitCode).not.toBe(0);
      expect(writes).toHaveLength(0);
    }
    const operations = [
      {
        args: ["directories", "create", identityId, "--area", "freeipa", "--kind", "groups", "--yes"],
        path: "/directories/create",
        method: "POST",
        body: { area: "freeipa", kind: "groups", identityId },
      },
      {
        args: ["directories", "archive", "alumni", "--kind", "groups", "--archive-path", "archiv/2026", "--yes"],
        path: "/directories/archive",
        method: "POST",
        body: { area: "cloud", kind: "groups", name: "alumni", archivePath: "archiv/2026" },
      },
      {
        args: ["directories", "retire", "alumni", "--kind", "groups", "--yes"],
        path: "/directories/retire",
        method: "POST",
        body: { area: "cloud", kind: "groups", name: "alumni" },
      },
      {
        args: ["directories", "delete", "alumni", "--kind", "groups", "--confirm-path", "prefix/groups/alumni", "--yes"],
        path: "/directories/delete",
        method: "POST",
        body: { area: "cloud", kind: "groups", name: "alumni", confirmPath: "prefix/groups/alumni" },
      },
      {
        args: ["archives", "restore", identityId, "--confirm-path", "prefix/groups/alumni", "--yes"],
        path: `/archives/${identityId}/restore`,
        method: "POST",
        body: { confirmPath: "prefix/groups/alumni" },
      },
      {
        args: ["archives", "delete", identityId, "--confirm-path", "prefix/archive/alumni", "--yes"],
        path: `/archives/${identityId}`,
        method: "DELETE",
        body: { confirmPath: "prefix/archive/alumni" },
      },
      { args: ["root", "refresh", "--area", "freeipa"], path: "/root/refresh", method: "POST", body: { area: "freeipa" } },
      { args: ["root", "rebuild", "--area", "freeipa", "--yes"], path: "/root/rebuild", method: "POST", body: { area: "freeipa" } },
    ];
    for (const expected of operations) {
      const result = await run(["--json", "filesv2", "admin", ...expected.args], options);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(expected.path.startsWith("/root/") ? inventory.root : operation);
      expect(writes.at(-1)).toEqual({ path: `/api/filesv2/admin${expected.path}`, method: expected.method, body: expected.body });
    }
  }, 35_000);

  test("browses active and archived admin files and downloads directly with safe metadata", async () => {
    const dir = await directory();
    const requests: Array<{ method: string; url: URL; body: unknown }> = [];
    const transferHeaders: Headers[] = [];
    const filegate = serve((request) => {
      transferHeaders.push(request.headers);
      return new Response("archived bytes");
    });
    const page = {
      area: "freeipa",
      kind: "groups",
      name: "alumni",
      archiveId: identityId,
      basePath: "prefix/archive/alumni",
      path: "trash",
      items: [{ ...entry, path: "trash/résumé.txt" }],
      next: inventory.next,
    };
    const cloud = serve(async (request) => {
      const url = new URL(request.url);
      const body = request.method === "GET" ? null : await request.json();
      requests.push({ method: request.method, url, body });
      expect(request.headers.get("authorization")).toBe(`Bearer ${cloudToken}`);
      return Response.json(
        url.pathname.endsWith("/download")
          ? { url: `${filegate.url}?lease=${leaseSecret}`, method: "GET", expires: "2030-01-01T00:00:00Z" }
          : page,
      );
    });
    const options = { server: cloud.url.href };
    for (const source of [
      ["--name", "alumni", "--kind", "groups"],
      ["--archive-id", identityId],
    ]) {
      const result = await run(
        ["--json", "filesv2", "admin", "files", "list", "--area", "freeipa", ...source, "--path", "trash", "--after", inventory.next],
        options,
      );
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(page);
      expect(requests.at(-1)?.url.searchParams.get("path")).toBe("trash");
      expect(requests.at(-1)?.url.searchParams.get("after")).toBe(inventory.next);
    }
    expect(requests[0]?.url.searchParams.get("name")).toBe("alumni");
    expect(requests[0]?.url.searchParams.get("archiveId")).toBeNull();
    expect(requests[1]?.url.searchParams.get("archiveId")).toBe(identityId);
    expect(requests[1]?.url.searchParams.get("name")).toBeNull();
    const lines = await run(["--jsonl", "filesv2", "admin", "files", "list", "--area", "freeipa", "--archive-id", identityId], options);
    expect(
      lines.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual(page.items);
    const out = join(dir, "archive-file");
    const downloaded = await run(
      [
        "--json",
        "filesv2",
        "admin",
        "files",
        "download",
        "trash/résumé.txt",
        "--area",
        "freeipa",
        "--archive-id",
        identityId,
        "--out",
        out,
      ],
      options,
    );
    expect(downloaded.exitCode, downloaded.stderr).toBe(0);
    expect(JSON.parse(downloaded.stdout)).toEqual({ path: out, bytes: 14 });
    expect(await readFile(out, "utf8")).toBe("archived bytes");
    expect(requests.at(-1)?.body).toEqual({ area: "freeipa", archiveId: identityId, path: "trash/résumé.txt" });
    expect(downloaded.stdout + downloaded.stderr).not.toContain(leaseSecret);
    expect(transferHeaders).toHaveLength(1);
    expect(transferHeaders[0]?.get("authorization")).toBeNull();
    expect(transferHeaders[0]?.get("cookie")).toBeNull();
  }, 20_000);

  test("requires one admin file locator and exact-path confirmation before permanent deletion", async () => {
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const server = serve(async (request) => {
      const body = await request.json();
      requests.push({ method: request.method, path: new URL(request.url).pathname, body });
      return Response.json({ code: "admin_required", message: "Administrator access required" }, { status: 403 });
    });
    const options = { server: server.url.href };
    for (const args of [
      ["list"],
      ["list", "--name", "alumni", "--archive-id", identityId],
      ["delete", "trash/file.txt", "--name", "alumni", "--yes"],
      ["delete", "trash/file.txt", "--name", "alumni", "--confirm-path", "prefix/groups/alumni/trash/file.txt"],
    ]) {
      const result = await run(["filesv2", "admin", "files", ...args], options);
      expect(result.exitCode).not.toBe(0);
      expect(requests).toHaveLength(0);
    }
    const result = await run(
      [
        "--json",
        "filesv2",
        "admin",
        "files",
        "delete",
        "trash/file.txt",
        "--area",
        "freeipa",
        "--kind",
        "groups",
        "--name",
        "alumni",
        "--confirm-path",
        "prefix/groups/alumni/trash/file.txt",
        "--yes",
      ],
      options,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Administrator access required");
    expect(requests).toEqual([
      {
        method: "DELETE",
        path: "/api/filesv2/admin/entries",
        body: {
          area: "freeipa",
          kind: "groups",
          name: "alumni",
          path: "trash/file.txt",
          confirmPath: "prefix/groups/alumni/trash/file.txt",
        },
      },
    ]);
  }, 20_000);

  test("retries pending operations only with a valid confirmed UUID and preserves server preconditions", async () => {
    const requests: Array<{ path: string; method: string; body: string }> = [];
    let status = 200;
    const operation = { id: identityId, state: "pending", path: "prefix/groups/alumni" };
    const server = serve(async (request) => {
      requests.push({ path: new URL(request.url).pathname, method: request.method, body: await request.text() });
      expect(request.headers.get("authorization")).toBe(`Bearer ${cloudToken}`);
      expect(request.headers.get("accept-language")).toBe("de");
      return status === 200
        ? Response.json(operation)
        : Response.json({ code: "identity_changed", message: "Identity changed; operation remains pending" }, { status });
    });
    const options = { server: server.url.href, locale: "de" };
    for (const args of [[identityId], ["not-a-uuid", "--yes"]]) {
      const rejected = await run(["filesv2", "admin", "operations", "retry", ...args], options);
      expect(rejected.exitCode).not.toBe(0);
      expect(requests).toHaveLength(0);
    }
    const retry = await run(["--json", "filesv2", "admin", "operations", "retry", identityId, "--yes"], options);
    expect(retry.exitCode, retry.stderr).toBe(0);
    expect(JSON.parse(retry.stdout)).toEqual(operation);
    expect(requests).toEqual([{ path: `/api/filesv2/admin/operations/${identityId}/retry`, method: "POST", body: "" }]);
    status = 409;
    const refused = await run(["--json", "filesv2", "admin", "operations", "retry", identityId, "--yes"], options);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("Identity changed; operation remains pending");
    expect(requests).toHaveLength(2);
    const help = await run(["filesv2", "admin", "operations", "retry", "--help"], { locale: "de" });
    expect(help.exitCode, help.stderr).toBe(0);
    expect(help.stdout).toContain("erneuter Prüfung");
    expect(help.stdout).toContain("--yes");
  }, 20_000);
});

test("stat and thumbnail use the same authenticated base and keep transfer credentials private", async () => {
  const transfer = serve((request) => {
    expect(request.headers.get("authorization")).toBeNull();
    expect(request.headers.get("cookie")).toBeNull();
    return new Response("thumbnail-bytes");
  });
  const seen: string[] = [];
  const cloud = serve(async (request) => {
    expect(request.headers.get("authorization")).toBe(`Bearer ${cloudToken}`);
    const url = new URL(request.url);
    seen.push(url.pathname);
    if (url.pathname.endsWith("/entry")) {
      expect(url.searchParams.get("path")).toBe(entry.path);
      return Response.json({ base, entry });
    }
    expect(await request.json()).toEqual({ path: entry.path, size: "large" });
    return Response.json({ method: "GET", url: `${transfer.url}?lease=${leaseSecret}`, expires: "2030-01-01T00:00:00Z" });
  });
  const metadata = await run(["--json", "filesv2", "stat", base.id, entry.path], { server: cloud.url.href });
  expect(metadata.exitCode, metadata.stderr).toBe(0);
  expect(JSON.parse(metadata.stdout)).toEqual({ base, entry });
  const out = join(await directory(), "thumbnail.png");
  const result = await run(["--json", "filesv2", "thumbnail", base.id, entry.path, "--out", out, "--size", "large"], {
    server: cloud.url.href,
  });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ path: out, bytes: 15 });
  expect(await readFile(out, "utf8")).toBe("thumbnail-bytes");
  expect(result.stdout + result.stderr).not.toContain(leaseSecret);
  expect(seen).toEqual([`/api/filesv2/bases/${base.id}/entry`, `/api/filesv2/bases/${base.id}/thumbnail`]);
});

test("search and mkdir pass folder scope and names through the authenticated API", async () => {
  const seen: string[] = [];
  const cloud = serve(async (request) => {
    expect(request.headers.get("authorization")).toBe(`Bearer ${cloudToken}`);
    const url = new URL(request.url);
    seen.push(`${request.method} ${url.pathname}`);
    if (url.pathname.endsWith("/search")) {
      expect(url.searchParams.get("q")).toBe("report");
      expect(url.searchParams.get("path")).toBe("Documents");
      return Response.json({ base, path: "Documents", query: "report", items: [entry], next: null });
    }
    expect(await request.json()).toEqual({ path: "Documents/2026" });
    return Response.json({ base, entry: { name: "2026", path: "Documents/2026", directory: true, size: 0, modified: entry.modified } });
  });
  const search = await run(["--json", "filesv2", "search", base.id, "report", "--path", "Documents"], { server: cloud.url.href });
  expect(search.exitCode, search.stderr).toBe(0);
  expect(JSON.parse(search.stdout).items).toEqual([entry]);
  const made = await run(["--json", "filesv2", "mkdir", base.id, "Documents/2026"], { server: cloud.url.href });
  expect(made.exitCode, made.stderr).toBe(0);
  expect(JSON.parse(made.stdout).entry.path).toBe("Documents/2026");
  expect(seen).toEqual([`GET /api/filesv2/bases/${base.id}/search`, `POST /api/filesv2/bases/${base.id}/directories`]);
});

test("upload opens a session through Cloud, streams segments to Filegate without Cloud credentials, and commits", async () => {
  const dir = await directory();
  const local = join(dir, "notes.txt");
  await writeFile(local, "hello filegate");
  let received = 0;
  const transfer = serve(async (request) => {
    expect(request.headers.get("authorization")).toBeNull();
    expect(request.headers.get("cookie")).toBeNull();
    const url = new URL(request.url);
    expect(url.searchParams.get("lease")).toBe(leaseSecret);
    const status = () => ({ id: "s1", root: "cloud", size: 14, chunkSize: 4, expires: "2030-01-01T00:00:00Z", state: "open", segments: {}, received });
    if (request.method === "GET") return Response.json(status());
    expect(request.method).toBe("PUT");
    received += (await request.arrayBuffer()).byteLength;
    return Response.json(status());
  });
  const seen: string[] = [];
  const cloud = serve(async (request) => {
    expect(request.headers.get("authorization")).toBe(`Bearer ${cloudToken}`);
    const url = new URL(request.url);
    seen.push(`${request.method} ${url.pathname}`);
    if (url.pathname.endsWith("/uploads")) {
      expect(await request.json()).toEqual({ path: "Documents/notes.txt", size: 14, onConflict: "overwrite" });
      return Response.json({ id: "s1", path: "Documents/notes.txt", size: 14, chunkSize: 4, url: `${transfer.url}?lease=${leaseSecret}`, expires: "2030-01-01T00:00:00Z" });
    }
    expect(received).toBe(14);
    return Response.json({ base, entry: { ...entry, name: "notes.txt", path: "Documents/notes.txt", size: 14 } });
  });
  const result = await run(["--json", "filesv2", "upload", base.id, local, "--to", "Documents/notes.txt", "--replace"], { server: cloud.url.href });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).entry).toMatchObject({ path: "Documents/notes.txt", size: 14 });
  expect(result.stdout + result.stderr).not.toContain(leaseSecret);
  expect(seen).toEqual([`POST /api/filesv2/bases/${base.id}/uploads`, `POST /api/filesv2/bases/${base.id}/uploads/s1/commit`]);
});

test("delete, trash restore, versions and shares are thin wrappers over the authenticated API", async () => {
  const seen: string[] = [];
  const cloud = serve(async (request) => {
    expect(request.headers.get("authorization")).toBe(`Bearer ${cloudToken}`);
    const url = new URL(request.url);
    seen.push(`${request.method} ${url.pathname}`);
    if (url.pathname.endsWith("/delete")) {
      expect(await request.json()).toEqual({ paths: [entry.path, "Documents/old.txt"] });
      const trashEntry = { id: "11111111-1111-4111-8111-111111111111", original: entry.path, name: entry.name, directory: false, deletedAt: entry.modified };
      return Response.json({ entries: [trashEntry], results: [{ path: entry.path, ok: true, entry: trashEntry }] });
    }
    if (url.pathname.endsWith("/restore") && url.pathname.includes("/trash/")) return Response.json({ base, entry });
    if (url.pathname.endsWith("/versions")) return Response.json([{ id: "v1", created: entry.modified, size: 4, pinned: false, comment: "draft", author: "alice" }]);
    if (url.pathname.endsWith("/versions/restore-as")) {
      expect(await request.json()).toEqual({ path: entry.path, id: "v1", name: "copy.txt" });
      return Response.json({ base, entry: { ...entry, path: "Documents/copy.txt", name: "copy.txt" } });
    }
    if (url.pathname.endsWith("/shares") && request.method === "POST") {
      expect(await request.json()).toEqual({ kind: "download", paths: [entry.path], folder: "", title: "Report", expiresIn: "7d", maxFileSize: 104857600, maxTotalSize: 1073741824, showUploadNames: false });
      return Response.json({ id: "s1", kind: "download", url: "https://cloud.test/share/filesv2/s/tok", title: "Report", note: null, base, scope: "Documents", items: [entry.path], createdBy: "alice", createdAt: entry.modified, expiresAt: entry.modified, state: "active", accessCount: 0, lastAccessedAt: null });
    }
    if (url.pathname.endsWith("/revoke")) return Response.json({ id: "s1", state: "revoked", title: "Report" });
    return Response.json({ message: "unexpected" }, { status: 500 });
  });
  const server = { server: cloud.url.href };
  const removed = await run(["--json", "filesv2", "delete", base.id, entry.path, "Documents/old.txt"], server);
  expect(removed.exitCode, removed.stderr).toBe(0);
  expect(JSON.parse(removed.stdout).entries[0].original).toBe(entry.path);
  const restored = await run(["--json", "filesv2", "trash", "restore", base.id, "11111111-1111-4111-8111-111111111111"], server);
  expect(restored.exitCode, restored.stderr).toBe(0);
  const versions = await run(["--json", "filesv2", "versions", "list", base.id, entry.path], server);
  expect(JSON.parse(versions.stdout)[0].comment).toBe("draft");
  const asCopy = await run(["--json", "filesv2", "versions", "restore", base.id, entry.path, "v1", "--as", "copy.txt"], server);
  expect(JSON.parse(asCopy.stdout).entry.path).toBe("Documents/copy.txt");
  const share = await run(["filesv2", "shares", "create", base.id, entry.path, "--title", "Report", "--expires-in", "7d"], server);
  expect(share.exitCode, share.stderr).toBe(0);
  expect(share.stdout.trim()).toBe("https://cloud.test/share/filesv2/s/tok");
  const revoked = await run(["--json", "filesv2", "shares", "revoke", "s1"], server);
  expect(JSON.parse(revoked.stdout).state).toBe("revoked");
  expect(seen).toEqual([
    `POST /api/filesv2/bases/${base.id}/delete`,
    `POST /api/filesv2/bases/${base.id}/trash/11111111-1111-4111-8111-111111111111/restore`,
    `GET /api/filesv2/bases/${base.id}/versions`,
    `POST /api/filesv2/bases/${base.id}/versions/restore-as`,
    `POST /api/filesv2/bases/${base.id}/shares`,
    "POST /api/filesv2/shares/s1/revoke",
  ]);
});

test("documents create calls the API and edit-url prints the Cloud address locally", async () => {
  const seen: string[] = [];
  const cloud = serve(async (request) => {
    expect(request.headers.get("authorization")).toBe(`Bearer ${cloudToken}`);
    const url = new URL(request.url);
    seen.push(`${request.method} ${url.pathname}`);
    if (url.pathname.endsWith("/documents")) {
      expect(await request.json()).toEqual({ path: "Documents/Minutes", kind: "spreadsheet" });
      return Response.json({ base, entry: { ...entry, path: "Documents/Minutes.ods", name: "Minutes.ods" } });
    }
    return Response.json({ message: "unexpected" }, { status: 500 });
  });
  const server = { server: cloud.url.href };
  const created = await run(["--json", "filesv2", "documents", "create", base.id, "Documents/Minutes", "--kind", "spreadsheet"], server);
  expect(created.exitCode, created.stderr).toBe(0);
  expect(JSON.parse(created.stdout).entry.path).toBe("Documents/Minutes.ods");
  const address = await run(["filesv2", "edit-url", base.id, "Documents/Minutes.ods"], server);
  expect(address.exitCode, address.stderr).toBe(0);
  const query = new URLSearchParams({ base: base.id, path: "Documents", file: "Documents/Minutes.ods" });
  expect(address.stdout.trim()).toBe(`${cloud.url.origin}/app/filesv2?${query}&view=edit`);
  expect(seen).toEqual([`POST /api/filesv2/bases/${base.id}/documents`]);
});


test("batch partial results preserve successes and return a failure exit status", async () => {
  const cloud = serve(() => Response.json({ base, entries: [entry], results: [{ path: entry.path, ok: true, entry }, { path: "missing.txt", ok: false, error: "not_found" }] }));
  const result = await run(["--json", "filesv2", "move", base.id, entry.path, "missing.txt", "--to", "Target"], { server: cloud.url.href });
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout).results).toHaveLength(2);
  expect(JSON.parse(result.stdout).entries[0].path).toBe(entry.path);
});

test("new administration and inbox settings use the authenticated API without stored bearer URLs", async () => {
  const seen: string[] = [];
  const cloud = serve(async (request) => {
    expect(request.headers.get("authorization")).toBe(`Bearer ${cloudToken}`);
    const url = new URL(request.url);
    seen.push(`${request.method} ${url.pathname}`);
    if (url.pathname === "/api/filesv2/admin/shares" || url.pathname === "/api/filesv2/admin/uploads") return Response.json({ items: [], next: null });
    if (url.pathname === "/api/filesv2/admin/versions") {
      expect(request.method).toBe("DELETE");
      expect(await request.json()).toMatchObject({ path: "a.txt", id: "v1", confirmPath: "home/alice/a.txt", area: "cloud", kind: "users", name: "alice" });
      return Response.json({ deleted: true });
    }
    if (url.pathname.endsWith("/shares")) {
      expect(await request.json()).toMatchObject({ kind: "inbox", folder: "Inbox", expiresIn: "unlimited", maxFileSize: 123, maxTotalSize: 456, showUploadNames: true, note: "private", publicNote: "hello" });
      return Response.json({ url: "https://cloud.test/share/filesv2/inbox/once" });
    }
    return Response.json({ state: "revoked", title: "Inbox" });
  });
  const options = { server: cloud.url.href };
  for (const args of [["admin", "shares", "list"], ["admin", "uploads", "list"], ["admin", "shares", "revoke", "abc"], ["admin", "versions", "delete", "a.txt", "v1", "--name", "alice", "--confirm-path", "home/alice/a.txt", "--yes"], ["shares", "create", base.id, "Inbox", "--kind", "inbox", "--title", "Drop", "--expires-in", "unlimited", "--max-file-size", "123", "--max-total-size", "456", "--show-upload-names", "--note", "private", "--public-note", "hello"]]) {
    const result = await run(["--json", "filesv2", ...args], options);
    expect(result.exitCode, result.stderr).toBe(0);
  }
  expect(seen).toHaveLength(5);
});
