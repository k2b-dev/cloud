import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudCliContext, CloudCliFlags, CloudCliOutputMode } from "@k2b/cloud/cli";
import { sha256 } from "@k2b/filegate/utils";
import { hc } from "hono/client";
import filesCli from "./cli";
import type { BaseSummary, FileEntry } from "./contracts";
import { entryRefId, parseEntryRefId } from "./resource-ref";

/**
 * Every user-level command against an in-memory Files API and Filegate. Cloud
 * routes require the bearer token; transfer routes must never receive it.
 */

const TOKEN = "cloud-secret";
const LEASE = "lease-secret";
const uuid = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const summary = (id: string, name: string): BaseSummary => {
  const [area, kind] = id.split(":") as ["cloud" | "freeipa", "users" | "groups"];
  return { id, area, kind, name, status: "existing", reason: null, indexEnabled: false, versioningEnabled: true };
};
const home = summary(`cloud:users:${uuid("1")}`, "alice");
const team = summary(`cloud:groups:${uuid("2")}`, "team");
const opsCloud = summary(`cloud:groups:${uuid("3")}`, "ops");
const opsIpa = summary(`freeipa:groups:${uuid("4")}`, "ops");
const bases = [home, team, opsCloud, opsIpa];
const MODIFIED = "2026-09-26T12:00:00.000Z";

type Node = { directory: boolean; bytes: Uint8Array<ArrayBuffer> };
type Version = {
  id: string;
  created: string;
  size: number;
  pinned: boolean;
  comment: string | null;
  author: string | null;
  bytes: Uint8Array<ArrayBuffer>;
};

let server: ReturnType<typeof Bun.serve>;
let files: Map<string, Map<string, Node>>;
let trash: Map<string, { id: string; base: string; original: string; node: Node; directory: boolean }>;
let versions: Map<string, Version[]>;
let shares: { id: string; kind: string; title: string; state: string; password?: string; paths: string[]; folder: string }[];
let favorites: Set<string>;
let sessions: Map<string, { base: string; path: string; size: number; segments: Map<number, Uint8Array<ArrayBuffer>> }>;
let requests: string[];
let transferHeaders: Headers[];
const directories: string[] = [];

const text = (value: string) => new TextEncoder().encode(value);
const fail = (status: number, message: string) => Response.json({ code: message, message }, { status });
const entryOf = (path: string, node: Node): FileEntry => ({
  name: path.split("/").at(-1)!,
  path,
  directory: node.directory,
  size: node.directory ? 0 : node.bytes.byteLength,
  modified: MODIFIED,
  revision: `r${node.bytes.byteLength}`,
});
const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");
const tree = (base: string) => files.get(base)!;
const exists = (base: string, path: string) => path === "" || tree(base).has(path);
const isFolder = (base: string, path: string) => path === "" || tree(base).get(path)?.directory === true;
const children = (base: string, folder: string) =>
  [...tree(base)]
    .filter(([path]) => parentOf(path) === folder)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, node]) => entryOf(path, node));
const baseOf = (id: string) => bases.find((base) => base.id === id)!;
const result = (base: string, path: string) => ({ base: baseOf(base), entry: entryOf(path, tree(base).get(path)!) });

function copyTree(fromBase: string, from: string, toBase: string, to: string) {
  for (const [path, node] of [...tree(fromBase)])
    if (path === from || path.startsWith(`${from}/`)) tree(toBase).set(to + path.slice(from.length), { ...node });
}
function moveTree(base: string, from: string, to: string) {
  for (const [path, node] of [...tree(base)])
    if (path === from || path.startsWith(`${from}/`)) {
      tree(base).delete(path);
      tree(base).set(to + path.slice(from.length), node);
    }
}

async function cloud(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/api\/filesv2/, "");
  requests.push(`${request.method} ${route}`);
  if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) return fail(401, "unauthorized");
  const body = request.method === "GET" ? null : await request.json().catch(() => null);
  if (route === "/bases") return Response.json({ items: bases, issues: [], editor: null });
  if (route === "/shares") return Response.json({ items: shares, next: null });
  if (route === "/favorites")
    return Response.json(
      [...favorites].map((key) => {
        const [base, path] = key.split("\n") as [string, string];
        return { base: baseOf(base), entry: entryOf(path, tree(base).get(path)!), markedAt: MODIFIED };
      }),
    );
  const revoke = /^\/shares\/([^/]+)\/revoke$/.exec(route);
  if (revoke) {
    const share = shares.find((item) => item.id === revoke[1]);
    if (!share) return fail(404, "not_found");
    share.state = "revoked";
    return Response.json(share);
  }
  const byId = /^\/entries\/([^/]+)$/.exec(route);
  if (byId) {
    const ref = parseEntryRefId(decodeURIComponent(byId[1]!));
    if (!ref || !tree(ref.baseId)?.has(ref.path)) return fail(404, "not_found");
    return Response.json(result(ref.baseId, ref.path));
  }
  const match = /^\/bases\/([^/]+)(\/.*)$/.exec(route);
  if (!match) return fail(404, "unexpected route");
  const base = decodeURIComponent(match[1]!);
  const action = match[2]!;
  if (!files.has(base)) return fail(404, "not_found");
  const query = url.searchParams;
  const path = (body?.path as string | undefined) ?? query.get("path") ?? "";
  switch (`${request.method} ${action}`) {
    case "GET /entry":
      if (!exists(base, path)) return fail(404, "not_found");
      return Response.json({ ...result(base, path), favorite: favorites.has(`${base}\n${path}`), resourceId: entryRefId(base, path) });
    case "GET /entries": {
      if (!isFolder(base, path)) return fail(exists(base, path) ? 409 : 404, exists(base, path) ? "not_directory" : "not_found");
      const items = children(base, path);
      const start = Number(query.get("after") ?? 0);
      const next = start + 2 < items.length ? String(start + 2) : null;
      return Response.json({ base: baseOf(base), path, items: items.slice(start, start + 2), next });
    }
    case "GET /search": {
      const q = query.get("q")!;
      const items = [...tree(base)]
        .filter(([item]) => (path === "" || item.startsWith(`${path}/`)) && item.split("/").at(-1)!.includes(q))
        .map(([item, node]) => entryOf(item, node));
      return Response.json({ base: baseOf(base), path, query: q, scope: query.get("scope"), items, next: null });
    }
    case "POST /directories":
      if (!isFolder(base, parentOf(path))) return fail(404, "not_found");
      if (exists(base, path)) return fail(409, "path_conflict");
      tree(base).set(path, { directory: true, bytes: new Uint8Array() });
      return Response.json(result(base, path));
    case "POST /uploads": {
      if (!isFolder(base, parentOf(path))) return fail(404, "not_found");
      if (exists(base, path) && body.onConflict !== "overwrite") return fail(409, "path_conflict");
      const id = crypto.randomUUID();
      sessions.set(id, { base, path, size: body.size, segments: new Map() });
      return Response.json({
        id,
        path,
        size: body.size,
        chunkSize: 4,
        state: "open",
        url: `${server.url}transfer/${id}?lease=${LEASE}`,
        expires: "2099-01-01T00:00:00Z",
      });
    }
    case "POST /download":
    case "POST /versions/download": {
      const node = tree(base).get(path);
      if (!node) return fail(404, "not_found");
      if (node.directory) return fail(400, "not_file");
      const version = body.id ? `&version=${body.id}` : "";
      return Response.json({
        url: `${server.url}blob?base=${encodeURIComponent(base)}&path=${encodeURIComponent(path)}${version}&lease=${LEASE}`,
        method: "GET",
        expires: "2099-01-01T00:00:00Z",
      });
    }
    case "POST /archive":
      return Response.json({
        url: `${server.url}zip?lease=${LEASE}`,
        method: "POST",
        expires: "2099-01-01T00:00:00Z",
        manifest: JSON.stringify(body.paths),
      });
    case "POST /rename": {
      const target = [parentOf(path), body.name].filter(Boolean).join("/");
      if (exists(base, target)) return fail(409, "path_conflict");
      moveTree(base, path, target);
      return Response.json(result(base, target));
    }
    case "POST /move":
    case "POST /copy": {
      const targetBase = action === "/copy" ? body.targetBaseId : base;
      if (!isFolder(targetBase, body.folder)) return fail(404, "not_found");
      const results = (body.paths as string[]).map((source) => {
        const target = [body.folder, source.split("/").at(-1)].filter(Boolean).join("/");
        if (!exists(base, source)) return { path: source, ok: false, error: "not_found" };
        if (exists(targetBase, target)) return { path: source, ok: false, error: "path_conflict" };
        if (action === "/copy") copyTree(base, source, targetBase, target);
        else moveTree(base, source, target);
        return { path: source, ok: true, entry: entryOf(target, tree(targetBase).get(target)!) };
      });
      return Response.json({ base: baseOf(targetBase), entries: results.flatMap((item) => (item.ok ? [item.entry] : [])), results });
    }
    case "POST /delete": {
      const results = (body.paths as string[]).map((source) => {
        const node = tree(base).get(source);
        if (!node) return { path: source, ok: false, error: "not_found" };
        const id = crypto.randomUUID();
        const entry = { id, original: source, name: source.split("/").at(-1)!, directory: node.directory, deletedAt: MODIFIED };
        trash.set(id, { id, base, original: source, node, directory: node.directory });
        tree(base).delete(source);
        return { path: source, ok: true, entry };
      });
      return Response.json({ entries: results.flatMap((item) => (item.ok ? [item.entry] : [])), results });
    }
    case "GET /trash":
      return Response.json({
        entries: [...trash.values()]
          .filter((item) => item.base === base)
          .map((item) => ({
            id: item.id,
            original: item.original,
            name: item.original.split("/").at(-1),
            directory: item.directory,
            deletedAt: MODIFIED,
          })),
        next: null,
      });
    case "GET /versions":
      return Response.json((versions.get(`${base}\n${path}`) ?? []).map(({ bytes: _, ...version }) => version));
    case "POST /versions/comment": {
      const version = versions.get(`${base}\n${path}`)?.find((item) => item.id === body.id);
      if (!version) return fail(404, "not_found");
      version.comment = body.comment || null;
      const { bytes: _, ...view } = version;
      return Response.json(view);
    }
    case "POST /versions/restore":
    case "POST /versions/restore-as": {
      const version = versions.get(`${base}\n${path}`)?.find((item) => item.id === body.id);
      if (!version) return fail(404, "not_found");
      const target = body.name ? [parentOf(path), body.name].filter(Boolean).join("/") : path;
      if (body.name && exists(base, target)) return fail(409, "path_conflict");
      if (!body.name) keepVersion(base, path);
      tree(base).set(target, { directory: false, bytes: version.bytes });
      return Response.json(result(base, target));
    }
    case "POST /shares": {
      const share = {
        id: crypto.randomUUID(),
        kind: body.kind,
        title: body.title,
        state: "active",
        password: body.password,
        paths: body.paths,
        folder: body.folder,
      };
      shares.push(share);
      return Response.json({ ...share, url: `https://cloud.test/share/filesv2/${share.id}` });
    }
    case "POST /favorite":
      if (body.favorite) favorites.add(`${base}\n${path}`);
      else favorites.delete(`${base}\n${path}`);
      return Response.json({ favorite: body.favorite });
  }
  const restore = /^\/trash\/([^/]+)\/restore$/.exec(action);
  if (restore && request.method === "POST") {
    const item = trash.get(restore[1]!);
    if (!item || item.base !== base) return fail(404, "not_found");
    const target = query.get("path") ?? item.original;
    if (exists(base, target)) return fail(409, "path_conflict");
    tree(base).set(target, item.node);
    trash.delete(item.id);
    return Response.json(result(base, target));
  }
  const commit = /^\/uploads\/([^/]+)\/commit$/.exec(action);
  if (commit) {
    const session = sessions.get(commit[1]!)!;
    const bytes = new Uint8Array(Buffer.concat([...session.segments].sort(([a], [b]) => a - b).map(([, chunk]) => chunk)));
    if (bytes.byteLength !== session.size) return fail(409, "upload_incomplete");
    if (tree(base).has(session.path)) keepVersion(base, session.path);
    tree(base).set(session.path, { directory: false, bytes });
    return Response.json(result(base, session.path));
  }
  return fail(404, "unexpected route");
}

let versionCounter = 0;
function keepVersion(base: string, path: string) {
  const bytes = tree(base).get(path)!.bytes;
  const list = versions.get(`${base}\n${path}`) ?? [];
  list.push({
    id: `v${++versionCounter}`,
    created: MODIFIED,
    size: bytes.byteLength,
    pinned: false,
    comment: null,
    author: "alice",
    bytes,
  });
  versions.set(`${base}\n${path}`, list);
}

async function transfer(request: Request): Promise<Response> {
  transferHeaders.push(request.headers);
  const url = new URL(request.url);
  if (url.searchParams.get("lease") !== LEASE) return fail(403, "forbidden");
  if (url.pathname === "/blob") {
    const base = url.searchParams.get("base")!;
    const path = url.searchParams.get("path")!;
    const version = url.searchParams.get("version");
    const bytes = version ? versions.get(`${base}\n${path}`)!.find((item) => item.id === version)!.bytes : tree(base).get(path)!.bytes;
    return new Response(bytes, { headers: { "Content-Length": String(bytes.byteLength) } });
  }
  if (url.pathname === "/zip") {
    const form = new URLSearchParams(await request.text());
    return new Response(`ZIP ${form.get("manifest")}`);
  }
  const session = sessions.get(url.pathname.split("/").at(-1)!)!;
  if (url.searchParams.has("segments"))
    return Response.json({
      items: await Promise.all([...session.segments].map(async ([index, chunk]) => ({ index, hash: await sha256(chunk) }))),
    });
  if (request.method === "PUT") session.segments.set(Number(url.searchParams.get("segment")), new Uint8Array(await request.arrayBuffer()));
  const received = [...session.segments.values()].reduce((sum, chunk) => sum + chunk.byteLength, 0);
  return Response.json({
    id: "session",
    root: "cloud",
    size: session.size,
    chunkSize: 4,
    state: "open",
    uploadedSegments: session.segments.size,
    received,
  });
}

beforeEach(() => {
  files = new Map(bases.map((base) => [base.id, new Map()]));
  tree(home.id).set("Documents", { directory: true, bytes: new Uint8Array() });
  tree(home.id).set("Documents/notes.txt", { directory: false, bytes: text("hello notes\n") });
  tree(home.id).set("Documents/binary.bin", { directory: false, bytes: new Uint8Array([0, 255, 1]) });
  tree(team.id).set("Shared", { directory: true, bytes: new Uint8Array() });
  trash = new Map();
  versions = new Map();
  shares = [];
  favorites = new Set();
  sessions = new Map();
  requests = [];
  transferHeaders = [];
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => (new URL(request.url).pathname.startsWith("/api/") ? cloud(request) : transfer(request)),
  });
});

afterEach(async () => {
  server.stop(true);
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "filesv2-cli-"));
  directories.push(path);
  return path;
}

/** Runs one command in process, as `cld` would after parsing global options. */
async function cli(args: string[], flags: CloudCliFlags = {}, output: CloudCliOutputMode = "json") {
  const out: string[] = [];
  const err: string[] = [];
  const values: unknown[] = [];
  const ctx: CloudCliContext = {
    args,
    flags,
    options: { profile: "test", server: server.url.href, token: TOKEN, output, locale: "en" },
    getDefault: async () => undefined,
    setDefault: async () => undefined,
    createApiClient: ((basePath: string) =>
      hc(new URL(basePath, server.url).href, { headers: { authorization: `Bearer ${TOKEN}` } })) as CloudCliContext["createApiClient"],
    fetch: async () => {
      throw new Error("Unexpected fetch");
    },
    readJson: async (response) => {
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`${response.status} ${(payload as { message?: string } | null)?.message ?? response.statusText}`);
      return payload as never;
    },
    print: (value = "") => void out.push(value),
    write: async (value) => void out.push(value),
    error: (value) => void err.push(value),
    json: (value) => void values.push(value),
    jsonLine: (value) => void values.push(value),
    table: (rows, columns) => {
      for (const row of rows)
        out.push(columns.map((column) => String(column.value ? column.value(row) : row[String(column.key)])).join("\t"));
    },
  };
  const code = await filesCli.run(ctx);
  // The printed JSON, as a consumer parses it.
  const json = JSON.parse(JSON.stringify(values.at(-1) ?? null));
  return { code: code ?? 0, out: out.join("\n"), err: err.join("\n"), json, values };
}

const failure = async (args: string[], flags: CloudCliFlags = {}) => {
  try {
    await cli(args, flags);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`expected ${args.join(" ")} to fail`);
};

test("ls lists areas, then folder pages; tree follows every page and stat exposes the file ID", async () => {
  const areas = await cli(["ls"], {}, "text");
  expect(areas.out.split("\n").map((line) => line.split("\t")[0])).toEqual(["me", "team", "ops", "ops"]);
  expect((await cli(["ls"])).json.items).toEqual(bases);

  const page = await cli(["ls", "me:/Documents"]);
  expect(page.json).toMatchObject({ base: home, path: "Documents", next: null });
  expect(page.json.items.map((item: FileEntry) => item.path)).toEqual(["Documents/binary.bin", "Documents/notes.txt"]);
  expect((await cli(["ls", "me:"])).json.items.map((item: FileEntry) => item.path)).toEqual(["Documents"]);
  expect(requests.filter((request) => request === "GET /bases")).toHaveLength(4);

  tree(home.id).set("Documents/2026", { directory: true, bytes: new Uint8Array() });
  tree(home.id).set("Documents/2026/a.txt", { directory: false, bytes: text("a") });
  const walked = await cli(["tree", "me:"]);
  expect(walked.json.items.map((item: FileEntry & { depth: number }) => `${item.depth} ${item.path}`)).toEqual([
    "1 Documents",
    "2 Documents/2026",
    "3 Documents/2026/a.txt",
    "2 Documents/binary.bin",
    "2 Documents/notes.txt",
  ]);
  expect((await cli(["tree", "me:"], { depth: "1" })).json.items).toHaveLength(1);
  expect((await cli(["tree", "me:/Documents"], {}, "text")).out).toBe("me:/Documents\n  2026/\n    a.txt\n  binary.bin\n  notes.txt");

  const info = await cli(["stat", "me:/Documents/notes.txt"]);
  expect(info.json).toMatchObject({
    base: home,
    entry: { path: "Documents/notes.txt", size: 12 },
    resourceId: entryRefId(home.id, "Documents/notes.txt"),
  });
  const byId = await cli(["stat", info.json.resourceId]);
  expect(byId.json.entry.path).toBe("Documents/notes.txt");
  expect(requests.at(-1)).toBe(`GET /entries/${info.json.resourceId}`);
  expect((await cli(["stat", `${home.id}:/Documents`])).json.entry.directory).toBe(true);
});

test("addresses resolve group names and IDs and fail on ambiguity before any file request", async () => {
  expect((await cli(["ls", "team:/Shared"])).json.path).toBe("Shared");
  expect((await cli(["ls", `${uuid("2")}:/`])).json.base).toEqual(team);
  requests = [];
  const ambiguous = await failure(["ls", "ops:/"]);
  expect(ambiguous).toBe(
    `409 "ops" matches several areas: cloud/groups/ops (${opsCloud.id}), freeipa/groups/ops (${opsIpa.id}). Use one of these paths or IDs.`,
  );
  expect(requests).toEqual(["GET /bases"]);
  expect((await cli(["ls", `${opsIpa.id}:/`])).json.base).toEqual(opsIpa);
  expect(await failure(["ls", "nobody:/"])).toStartWith("404 ");
  expect(await failure(["stat", "notes.txt"])).toContain('"notes.txt:"');
  expect(await failure(["stat", "./notes.txt"])).toContain("local path");
});

test("put and get round-trip text and binary files, never overwrite, and keep Cloud credentials away from Filegate", async () => {
  const dir = await directory();
  const local = join(dir, "report.txt");
  await writeFile(local, "quarterly numbers\n");

  const uploaded = await cli(["put", local, "me:/Documents/"]);
  expect(uploaded.json).toMatchObject({ base: home, entry: { path: "Documents/report.txt", size: 18 } });
  expect(await failure(["put", local, "me:/Documents/report.txt"])).toStartWith("409 path_conflict");
  await writeFile(local, "revised numbers\n");
  expect((await cli(["put", local, "me:/Documents/report.txt"], { replace: true })).json.entry.size).toBe(16);

  const missing = await failure(["put", local, "team:/2026/Q3/report.txt"]);
  expect(missing).toStartWith("404 ");
  const nested = await cli(["put", local, "team:/2026/Q3/report.txt"], { parents: true });
  expect(nested.json.entry.path).toBe("2026/Q3/report.txt");
  expect(tree(team.id).get("2026")?.directory).toBe(true);

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await rm(local);
    expect((await cli(["get", "me:/Documents/report.txt"])).json).toEqual({
      path: join(await realpath(dir), "report.txt"),
      bytes: 16,
    });
  } finally {
    process.chdir(cwd);
  }
  expect(await readFile(local, "utf8")).toBe("revised numbers\n");
  expect(await failure(["get", "me:/Documents/report.txt", local])).toBe("The output path already exists.");

  const sub = join(dir, "downloads");
  await mkdir(sub);
  const binary = await cli(["get", "me:/Documents/binary.bin", sub]);
  expect(binary.json).toEqual({ path: join(sub, "binary.bin"), bytes: 3 });
  expect(new Uint8Array(await readFile(join(sub, "binary.bin")))).toEqual(new Uint8Array([0, 255, 1]));

  const zipped = await cli(["get", "me:/Documents", join(dir, "docs.zip")]);
  expect(zipped.json.path).toBe(join(dir, "docs.zip"));
  expect(await readFile(join(dir, "docs.zip"), "utf8")).toBe('ZIP ["Documents"]');
  await cli(["zip", "me:/Documents/notes.txt", "me:/Documents/report.txt"], { out: join(dir, "two.zip") });
  expect(await readFile(join(dir, "two.zip"), "utf8")).toBe('ZIP ["Documents/notes.txt","Documents/report.txt"]');
  expect(await failure(["zip", "me:/Documents/notes.txt", "team:/Shared"], { out: join(dir, "mixed.zip") })).toContain("same area");

  expect(transferHeaders.length).toBeGreaterThan(0);
  for (const headers of transferHeaders) {
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
  }
});

test("cat prints text, refuses binary content, and saves with --out", async () => {
  const printed = await cli(["cat", "me:/Documents/notes.txt"], {}, "text");
  expect(printed.out).toBe("hello notes\n");
  expect((await cli(["cat", "me:/Documents/notes.txt"])).json).toEqual({
    baseId: home.id,
    path: "Documents/notes.txt",
    bytes: 12,
    content: "hello notes\n",
  });
  expect(await failure(["cat", "me:/Documents/binary.bin"])).toBe("This file is not text. Save it with --out or get.");
  const out = join(await directory(), "binary.bin");
  expect((await cli(["cat", "me:/Documents/binary.bin"], { out })).json).toEqual({ path: out, bytes: 3 });
  expect(await failure(["cat", "me:/Documents"])).toStartWith("400 not_file");
});

test("mkdir, mv, cp and rm follow shell semantics inside the area contract", async () => {
  expect(await failure(["mkdir", "me:/Projects/2026"])).toStartWith("404 ");
  expect((await cli(["mkdir", "me:/Projects/2026"], { parents: true })).json.entry.path).toBe("Projects/2026");
  expect((await cli(["mkdir", "me:/Projects/2026"], { p: true })).json.entry.path).toBe("Projects/2026");
  expect(await failure(["mkdir", "me:/Documents/notes.txt"], { parents: true })).toStartWith("409 ");
  expect(await failure(["mkdir", "me:/Projects"])).toStartWith("409 path_conflict");

  const renamed = await cli(["mv", "me:/Documents/notes.txt", "me:/Documents/todo.txt"]);
  expect(renamed.json).toMatchObject({
    base: home,
    entries: [{ path: "Documents/todo.txt" }],
    results: [{ path: "Documents/notes.txt", ok: true }],
  });
  expect(requests).toContain(`POST /bases/${home.id}/rename`);
  const moved = await cli(["mv", "me:/Documents/todo.txt", "me:/Projects"]);
  expect(moved.json.entries[0].path).toBe("Projects/todo.txt");
  expect(await failure(["mv", "me:/Projects/todo.txt", "me:/Documents/other.txt"])).toContain("Move first, then rename");
  expect((await cli(["mv", "me:/Projects/todo.txt", "me:/Projects/2026"])).json.entries[0].path).toBe("Projects/2026/todo.txt");
  tree(home.id).set("Projects/other.txt", { directory: false, bytes: text("x") });
  expect(await failure(["mv", "me:/Projects/other.txt", "me:/Documents/binary.bin"])).toStartWith("409 ");
  expect(await failure(["mv", "me:/Projects/other.txt", "team:/Shared/"])).toContain("mv stays inside one area");

  const copied = await cli(["cp", "me:/Projects/other.txt", "team:/Shared"]);
  expect(copied.json.entries[0].path).toBe("Shared/other.txt");
  expect(tree(team.id).has("Shared/other.txt")).toBe(true);
  const partial = await cli(["cp", "me:/Projects/other.txt", "me:/Documents/missing.txt", "team:/Shared/"]);
  expect(partial.code).toBe(1);
  expect(partial.json.results.map((item: { ok: boolean }) => item.ok)).toEqual([false, false]);

  requests = [];
  expect(await failure(["rm", "me:/Projects/other.txt"])).toBe("This operation requires --yes.");
  expect(requests).toEqual([]);
  const removed = await cli(["rm", "me:/Projects/other.txt"], { yes: true });
  expect(removed.json.results[0]).toMatchObject({ path: "Projects/other.txt", ok: true });
  expect(tree(home.id).has("Projects/other.txt")).toBe(false);
});

test("trash restore, versions and search round-trip", async () => {
  const removed = await cli(["rm", "me:/Documents/notes.txt"], { yes: true });
  const trashId = removed.json.entries[0].id as string;
  expect((await cli(["trash", "list", "me"])).json.entries.map((item: { id: string }) => item.id)).toEqual([trashId]);
  expect((await cli(["trash", "restore", "me:", trashId], { to: "/Documents/recovered.txt" })).json.entry.path).toBe(
    "Documents/recovered.txt",
  );
  expect(new TextDecoder().decode(tree(home.id).get("Documents/recovered.txt")!.bytes)).toBe("hello notes\n");
  expect(await failure(["trash", "list", "me:/Documents"])).toContain("not an area");

  const dir = await directory();
  const local = join(dir, "recovered.txt");
  await writeFile(local, "second draft\n");
  await cli(["put", local, "me:/Documents/recovered.txt"], { replace: true });
  const listed = await cli(["versions", "list", "me:/Documents/recovered.txt"]);
  expect(listed.json).toEqual(
    [{ id: "v1", created: MODIFIED, size: 12, pinned: false, comment: null, author: "alice" }].map((item) => ({
      ...item,
      id: listed.json[0].id,
    })),
  );
  const version = listed.json[0].id as string;
  expect((await cli(["versions", "update", "me:/Documents/recovered.txt", version], { comment: "first" })).json.comment).toBe("first");
  const saved = await cli(["versions", "get", "me:/Documents/recovered.txt", version, join(dir, "v1.txt")]);
  expect(saved.json.bytes).toBe(12);
  expect(await readFile(join(dir, "v1.txt"), "utf8")).toBe("hello notes\n");
  expect((await cli(["versions", "restore", "me:/Documents/recovered.txt", version], { as: "old.txt" })).json.entry.path).toBe(
    "Documents/old.txt",
  );
  await cli(["versions", "restore", "me:/Documents/recovered.txt", version]);
  expect(new TextDecoder().decode(tree(home.id).get("Documents/recovered.txt")!.bytes)).toBe("hello notes\n");

  const found = await cli(["search", "me:/Documents", "old"], { scope: "folder" });
  expect(found.json.items.map((item: FileEntry) => item.path)).toEqual(["Documents/old.txt"]);
  expect(requests.at(-1)).toBe(`GET /bases/${home.id}/search`);
});

test("shares add, list and revoke keep passwords in a private file and require --yes to revoke", async () => {
  const dir = await directory();
  const passwordFile = join(dir, "password.txt");
  await writeFile(passwordFile, "correct horse battery\n", { mode: 0o600 });
  const created = await cli(
    ["shares", "add", "me:/Documents/notes.txt"],
    { title: "Notes", "password-file": passwordFile, "expires-in": "7d" },
    "text",
  );
  expect(created.out).toStartWith("https://cloud.test/share/filesv2/");
  expect(created.out + created.err).not.toContain("correct horse");
  expect(shares[0]).toMatchObject({ kind: "download", paths: ["Documents/notes.txt"], folder: "", password: "correct horse battery" });
  const inbox = await cli(["shares", "add", "team:/Shared"], { title: "Drop", kind: "inbox" });
  expect(shares[1]).toMatchObject({ kind: "inbox", paths: [], folder: "Shared" });
  expect(await failure(["shares", "add", "team:/Shared", "me:/Documents"], { title: "Drop", kind: "inbox" })).toContain(
    "exactly one folder",
  );
  expect((await cli(["shares", "list"])).json.items).toHaveLength(2);
  expect(await failure(["shares", "revoke", inbox.json.id])).toBe("This operation requires --yes.");
  expect((await cli(["shares", "revoke", inbox.json.id], { yes: true })).json.state).toBe("revoked");
});

test("favorites and edit-url use addresses; recent-style rows print addresses", async () => {
  expect((await cli(["favorites", "add", "team:/Shared"])).json).toEqual({ favorite: true });
  expect((await cli(["favorites", "list"], {}, "text")).out).toBe(`team:/Shared\t${MODIFIED}`);
  expect((await cli(["favorites", "remove", "team:/Shared"])).json).toEqual({ favorite: false });
  const url = await cli(["edit-url", "me:/Documents/notes.txt"]);
  expect(url.json.url).toBe(
    `${server.url.origin}/app/filesv2?base=${encodeURIComponent(home.id)}&path=Documents&file=Documents%2Fnotes.txt&view=edit`,
  );
});
