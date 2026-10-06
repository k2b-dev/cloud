import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  CAPABILITY_MAX_RESULT_BYTES,
  type CapabilityExecutionContext,
  capabilityResultSchema,
  FileProviderListDataSchema,
  FileProviderListInputSchema,
  fileProviderIssues,
  UniversalSearchDataSchema,
} from "@k2b/cloud/contracts";
import { FilegateError } from "@k2b/filegate";
import type { DirectoryResult, FileEntry } from "./contracts";
import { entryRefId } from "./resource-ref";

const base = {
  id: "base",
  area: "cloud",
  kind: "users",
  name: "Home",
  status: "existing",
  reason: null,
  indexEnabled: false,
  versioningEnabled: false,
} as const;
let baseCount = 1;
let next: string | null = null;
let failure = false;
let serviceFailure: Error | null = null;
let items: FileEntry[] = [];
let calls = 0;
const uploadKeys: string[] = [];
const uploadInputs: unknown[] = [];
const folderCalls: unknown[] = [];
let folderWritable = true;
let baseItems: Array<Record<string, unknown>> | null = null;
let readName: string | null = null;
const ids = new Map<string, { baseId: string; path: string }>();
const persistedEntryRefId = async (baseId: string, path: string) => {
  const id = entryRefId(baseId, path) ?? `p:${"a".repeat(64)}`;
  ids.set(id, { baseId, path });
  return id;
};
mock.module("./data/references", () => ({
  persistedEntryRefId,
  entryRef: async (baseId: string, entry: { path: string; resourceId?: string }) => {
    if (!entry.resourceId) return persistedEntryRefId(baseId, entry.path);
    ids.set(entry.resourceId, { baseId, path: entry.path });
    return entry.resourceId;
  },
  resolveEntryRefId: async (id: string) => ids.get(id) ?? null,
}));
const page = async (): Promise<DirectoryResult> => {
  calls++;
  if (serviceFailure) throw serviceFailure;
  if (failure) throw new Error("storage unavailable");
  return { base, path: "", items, next };
};
class MockFilesError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
  }
}
const downloads: Array<{ actor: unknown; input: { baseId: string; path: string } }> = [];
let downloadFailure: Error | null = null;
const lease = { url: "https://storage.example.test/direct/opaque-token", method: "GET" as const, expires: "2026-09-21T12:01:00Z" };
mock.module("./service", () => ({
  FilesError: MockFilesError,
  filesService: {
    bases: async () => ({ items: baseItems ?? Array.from({ length: baseCount }, (_, index) => ({ ...base, id: `base${index}` })) }),
    upload: async (_actor: unknown, input: { idempotencyKey: string }) => {
      if (serviceFailure) throw serviceFailure;
      uploadKeys.push(input.idempotencyKey);
      uploadInputs.push(input);
      return { id: input.idempotencyKey };
    },
    folder: async (_actor: unknown, input: { id: string }) => {
      folderCalls.push(input);
      if (serviceFailure) throw serviceFailure;
      const ref = ids.get(input.id);
      if (!ref) throw new MockFilesError("not_found", 404);
      return { base: { ...base, id: ref.baseId }, writable: folderWritable, items, next };
    },
    folderLocation: async (_actor: unknown, id: string) => {
      const ref = ids.get(id);
      if (!ref) throw new MockFilesError("not_found", 404);
      return ref;
    },
    // The service resolves every file ID form; unknown IDs are not found before storage is asked.
    downloadById: async (actor: unknown, id: string) => {
      const input = ids.get(id);
      if (!input) throw new MockFilesError("not_found", 404);
      downloads.push({ actor, input });
      if (downloadFailure) throw downloadFailure;
      return lease;
    },
    entryById: async (_actor: unknown, id: string) => {
      if (serviceFailure) throw serviceFailure;
      const ref = ids.get(id);
      if (!ref) throw new MockFilesError("not_found", 404);
      return { base: { ...base, id: ref.baseId }, entry: { ...entry(ref.path), ...(readName ? { name: readName } : {}) } };
    },
    list: page,
    search: page,
  },
}));
const { filesCapabilities } = await import("./capabilities");
const user = {
  id: "user",
  uid: "alice",
  roles: ["user" as const],
  provider: "local" as const,
  profile: "user" as const,
  givenname: "Alice",
  sn: "Example",
  displayName: "Alice",
  mail: "alice@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
};
const context: CapabilityExecutionContext = {
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId: user.id },
  user,
  locale: "en",
  requestId: "test",
  origin: "app",
  signal: new AbortController().signal,
};
afterEach(() => {
  baseCount = 1;
  next = null;
  failure = false;
  serviceFailure = null;
  items = [];
  calls = 0;
  ids.clear();
  downloads.length = 0;
  downloadFailure = null;
  uploadInputs.length = 0;
  folderCalls.length = 0;
  folderWritable = true;
  baseItems = null;
  readName = null;
});
const entry = (path: string): FileEntry => ({ name: "report", path, directory: false, size: 4, modified: "2026-09-19" });

test("capability explicitly describes truncated base and source-page coverage", async () => {
  baseCount = 12;
  next = "more";
  const result = await filesCapabilities.queries["entry.search"].run({ query: "", tags: [], limit: 10 }, context);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected success");
  expect(result.data.summary).toContain("Partial results");
  expect(result.data.summary).toContain("2 further");
  expect(calls).toBe(10);
});

test("the reference's search across areas passes the query input as written and returns file IDs", async () => {
  const reference = await Bun.file(new URL("./cli-references/index.md", import.meta.url)).text();
  const [, queryId, input] = reference.match(/cld capabilities query filesv2 (\S+) --input '([^']+)' --json/) ?? [];
  expect(queryId).toBe("entry.search");
  const query = filesCapabilities.queries["entry.search"];
  items = [entry("Documents/report.pdf")];
  const result = await query.run(query.input.parse(JSON.parse(input!)), context);
  if (!result.ok) throw new Error("expected success");
  const ref = result.data.data[0]!.ref;
  expect(ref.type).toBe("filesv2.entry");
  expect(ids.get(ref.id)).toEqual({ baseId: base.id, path: "Documents/report.pdf" });
});

test("failed capability reads are never presented as empty search results", async () => {
  failure = true;
  await expect(filesCapabilities.queries["entry.search"].run({ query: "file", tags: [], limit: 10 }, context)).rejects.toThrow(
    "storage unavailable",
  );
});

test("long file paths retain resolvable refs and valid compact links", async () => {
  const path = "Ordner ä/".repeat(150) + "report.pdf";
  items = [entry(path)];
  const result = await filesCapabilities.queries["entry.search"].run({ query: "file", tags: [], limit: 10 }, context);
  if (!result.ok) throw new Error("expected success");
  const row = result.data.data[0]!;
  expect(row.ref.id.length).toBeLessThanOrEqual(512);
  expect(ids.get(row.ref.id)).toEqual({ baseId: base.id, path });
  expect(row.links[0]?.href).toBe(`/app/filesv2/ref/${encodeURIComponent(row.ref.id)}`);
  expect(capabilityResultSchema(UniversalSearchDataSchema).safeParse(result.data).success).toBe(true);
});

test("multibyte result envelopes stay within the platform byte limit with explicit partial summary", async () => {
  items = Array.from({ length: 100 }, (_, i) => entry("🍎/".repeat(900) + i));
  const result = await filesCapabilities.queries["entry.search"].run({ query: "file", tags: [], limit: 100 }, context);
  if (!result.ok) throw new Error("expected success");
  expect(result.data.data.length).toBeLessThan(100);
  expect(result.data.summary).toContain("Partial results");
  expect(new TextEncoder().encode(JSON.stringify(result.data)).byteLength).toBeLessThan(CAPABILITY_MAX_RESULT_BYTES);
  expect(capabilityResultSchema(UniversalSearchDataSchema).safeParse(result.data).success).toBe(true);
});

test("Filesv2 registers all binary and organization capabilities with documented input contracts", async () => {
  const { compileCapabilityManifest } = await import("@k2b/cloud/capabilities/testing");
  const manifest = compileCapabilityManifest("filesv2", filesCapabilities);
  expect(manifest.queries.find((item) => item.localId === "content.read")?.stream).toEqual({
    direction: "read",
    maxBytes: 50 * 1024 * 1024,
  });
  expect(manifest.actions.find((item) => item.localId === "content.create")?.stream).toEqual({
    direction: "write",
    maxBytes: 50 * 1024 * 1024,
  });
  expect(manifest.actions.map((item) => item.localId)).toEqual(
    expect.arrayContaining(["entry.rename", "entry.move", "entry.copy", "entry.trash", "trash.restore", "folder.create"]),
  );
});

test("upload idempotency is stable per user and isolated between users", async () => {
  uploadKeys.length = 0;
  const action = filesCapabilities.actions["content.create"];
  const input = { baseId: "base", path: "test.csv", size: 4, mediaType: "text/csv", onConflict: "error" as const };
  const caller = { ...context, idempotencyKey: "same-key" };
  await action.run(input, caller);
  await action.run(input, caller);
  await action.run(input, { ...caller, actor: { kind: "user", user: { ...user, id: "another-user" } } });
  expect(uploadKeys[0]).toBe(uploadKeys[1]);
  expect(uploadKeys[2]).not.toBe(uploadKeys[0]);
});

test("canonical entry reader exposes an authorized stable open link", async () => {
  ids.set("entry-id", { baseId: "base", path: "report.pdf" });
  const result = await filesCapabilities.queries["entry.read"].run({ id: "entry-id" }, context);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected entry");
  expect(result.data.refs).toEqual([{ type: "filesv2.entry", id: "entry-id", title: "report" }]);
  expect(result.data.links).toEqual([{ rel: "open", href: "/app/filesv2/ref/entry-id" }]);
});

test("stable refs pass through listing, universal search and the reader unchanged", async () => {
  const stable = `n:cloud:users:${"1".repeat(8)}-1111-4111-8111-${"1".repeat(12)}:019b72cf-5200-7000-8000-000000000001`;
  items = [{ ...entry("Docs/report.pdf"), resourceId: stable }];
  const list = filesCapabilities.queries["entry.list"];
  const listed = await list.run(list.input.parse({ baseId: base.id }), context);
  if (!listed.ok) throw new Error("expected list success");
  expect(listed.data.data.items[0]!.ref).toEqual({ type: "filesv2.entry", id: stable });
  expect(listed.data.data.items[0]).not.toHaveProperty("resourceId");
  const found = await filesCapabilities.queries["entry.search"].run({ query: "report", tags: [], limit: 10 }, context);
  if (!found.ok) throw new Error("expected search success");
  expect(found.data.data[0]!.ref).toEqual({ type: "filesv2.entry", id: stable });
  const read = await filesCapabilities.queries["entry.read"].run({ id: stable }, context);
  if (!read.ok) throw new Error("expected reader success");
  expect(read.data.refs).toEqual([{ type: "filesv2.entry", id: stable, title: "report" }]);
  expect(read.data.links).toEqual([{ rel: "open", href: `/app/filesv2/ref/${encodeURIComponent(stable)}` }]);
});

for (const query of ["entry.list", "entry.search-in-base"] as const) {
  test(`${query} supplies stable refs without minting leases, including long paths and continuation`, async () => {
    items = [entry("report.pdf"), entry("Ordner ä/".repeat(100) + "report.pdf")];
    next = "next-page";
    const capability = filesCapabilities.queries[query];
    const run = () => {
      if (query === "entry.list") {
        const list = filesCapabilities.queries[query];
        return list.run(list.input.parse({ baseId: base.id }), context);
      }
      const search = filesCapabilities.queries[query];
      return search.run(search.input.parse({ baseId: base.id, q: "report" }), context);
    };
    const first = await run();
    const again = await run();
    if (!first.ok || !again.ok) throw new Error("expected success");
    expect(first.data).toEqual(again.data);
    expect(first.data.data.next).toBe(next);
    expect(downloads).toEqual([]);
    expect(capabilityResultSchema(capability.data).safeParse(first.data).success).toBe(true);
    for (const row of first.data.data.items) {
      expect(row.ref.type).toBe("filesv2.entry");
      expect(row.ref.id.length).toBeLessThanOrEqual(512);
      expect(row).not.toHaveProperty("url");
      const download = await filesCapabilities.queries["content.download"].run({ id: row.ref.id }, context);
      expect(download).toEqual({ ok: true, data: { data: lease } });
      expect(downloads.at(-1)).toEqual({ actor: context.actor, input: { baseId: base.id, path: row.path } });
    }
  });
}

test("download contract is discoverable, ref-only and returns storage expiry unchanged", async () => {
  const { compileCapabilityManifest } = await import("@k2b/cloud/capabilities/testing");
  const query = filesCapabilities.queries["content.download"];
  const manifest = compileCapabilityManifest("filesv2", filesCapabilities);
  expect(manifest.queries.find((q) => q.localId === "content.download")?.stream).toBeUndefined();
  expect(manifest.queries.some((q) => q.localId === "content.download")).toBe(true);
  expect(query.input.safeParse({ baseId: "base", path: "file" }).success).toBe(false);
  expect(query.input.safeParse({ id: "" }).success).toBe(false);
  expect(query.input.safeParse({ id: "a".repeat(513) }).success).toBe(false);
  expect(query.data.parse(lease)).toEqual(lease);
});

test("unknown references never reach storage and non-user actors cannot request a lease", async () => {
  const query = filesCapabilities.queries["content.download"];
  await expect(query.run({ id: "missing" }, context)).rejects.toMatchObject({ code: "not_found", status: 404 });
  await expect(
    query.run(
      { id: "missing" },
      {
        ...context,
        actor: {
          kind: "service_account",
          serviceAccount: {
            id: "service",
            name: "Studio",
            kind: "resource_bound",
            status: "active",
            delegatedUserId: null,
            appId: "assistant",
            resourceType: "app",
            resourceId: "app",
            createdBy: null,
            createdAt: "2026-09-21T12:00:00Z",
          },
          delegatedUser: null,
          scopes: ["read"],
        },
      },
    ),
  ).rejects.toMatchObject({ status: 403 });
  expect(downloads).toEqual([]);
});

for (const [code, status] of [
  ["forbidden", 403],
  ["not_found", 404],
  ["not_file", 400],
  ["unavailable", 503],
] as const) {
  test(`download preserves ${code} and checks access again after listing`, async () => {
    items = [entry("report.pdf")];
    const query = filesCapabilities.queries["entry.list"];
    const listed = await query.run(query.input.parse({ baseId: base.id }), context);
    if (!listed.ok) throw new Error("expected list success");
    downloadFailure = new MockFilesError(code, status);
    await expect(
      filesCapabilities.queries["content.download"].run({ id: listed.data.data.items[0]!.ref.id }, context),
    ).rejects.toMatchObject({ code, status });
    expect(downloads).toHaveLength(1);
  });
}

for (const [status, upstreamCode, code, expectedStatus] of [
  [403, "permission_denied", "forbidden", 403],
  [404, "missing", "not_found", 404],
  [409, "execution_mismatch", "identity_changed", 409],
  [502, "upstream_failure", "unavailable", 503],
] as const) {
  test(`download sanitizes Filegate ${upstreamCode} without exposing upstream details`, async () => {
    ids.set("ref", { baseId: base.id, path: "report.pdf" });
    downloadFailure = new FilegateError(status, upstreamCode, "private upstream message");
    await expect(filesCapabilities.queries["content.download"].run({ id: "ref" }, context)).rejects.toEqual({
      code,
      message: code,
      status: expectedStatus,
    });
  });
}

for (const [status, upstreamCode, code, expectedStatus] of [
  [403, "permission_denied", "forbidden", 403],
  [404, "missing", "not_found", 404],
  [409, "execution_mismatch", "identity_changed", 409],
  [502, "upstream_failure", "unavailable", 503],
] as const) {
  test(`shared file capability boundary sanitizes ${upstreamCode} for reads and actions`, async () => {
    ids.set("ref", { baseId: base.id, path: "report.pdf" });
    serviceFailure = new FilegateError(status, upstreamCode, "private upstream message");
    const expected = { code, message: code, status: expectedStatus };
    const list = filesCapabilities.queries["entry.list"];
    const search = filesCapabilities.queries["entry.search-in-base"];
    await expect(list.run(list.input.parse({ baseId: base.id }), context)).rejects.toEqual(expected);
    await expect(search.run(search.input.parse({ baseId: base.id, q: "report" }), context)).rejects.toEqual(expected);
    await expect(filesCapabilities.queries["content.read"].run({ id: "ref" }, context)).rejects.toEqual(expected);
    const create = filesCapabilities.actions["content.create"];
    await expect(
      create.run(create.input.parse({ baseId: base.id, path: "report.pdf", size: 4 }), { ...context, idempotencyKey: "create" }),
    ).rejects.toEqual(expected);
  });
}

for (const [failure, expected] of [
  [new FilegateError(403, "permission_denied", "private"), { code: "FORBIDDEN", message: "forbidden", status: 403 }],
  [new FilegateError(404, "missing", "private"), { code: "NOT_FOUND", message: "File entry not found", status: 404 }],
  [new FilegateError(409, "execution_mismatch", "private"), { code: "identity_changed", message: "identity_changed", status: 409 }],
  [new FilegateError(502, "upstream_failure", "private"), { code: "unavailable", message: "unavailable", status: 503 }],
  [new MockFilesError("unavailable", 503), { code: "unavailable", message: "unavailable", status: 503 }],
] as const) {
  test(`entry reader answers ${failure.name} ${failure.code} without upstream details`, async () => {
    ids.set("ref", { baseId: base.id, path: "report.pdf" });
    serviceFailure = failure;
    const read = filesCapabilities.queries["entry.read"].run({ id: "ref" }, context);
    // Access answers stay reader results; other failures are thrown as sanitized service errors.
    if (expected.status === 403 || expected.status === 404) expect(await read).toMatchObject({ ok: false, error: expected });
    else await expect(read).rejects.toEqual(expected);
  });
}

describe("Files as a file provider", () => {
  const listProvider = (input: Record<string, unknown>, caller = context) =>
    filesCapabilities.queries["provider.list"].run(FileProviderListInputSchema.parse(input), caller);
  const modified = "2026-09-19T08:30:00.123456789Z";

  test("Files declares a provider that matches the shared contract", async () => {
    const { compileCapabilityManifest } = await import("@k2b/cloud/capabilities/testing");
    const manifest = compileCapabilityManifest("filesv2", filesCapabilities);
    expect(manifest.fileProvider).toEqual({ list: "provider.list", read: "content.read", save: "provider.save" });
    expect(fileProviderIssues(manifest)).toEqual([]);
  });

  test("the root lists usable bases as virtual folders under their Files names, filtered and paged", async () => {
    const home = { ...base, id: "cloud:users:me", name: "alice" };
    const group = (id: string, name: string) => ({ ...base, id, name, kind: "groups" as const });
    baseItems = [
      group("cloud:groups:b", "zeta"),
      home,
      group("cloud:groups:a", "alpha"),
      { ...group("cloud:groups:c", "gone"), status: "missing" },
    ];
    const first = await listProvider({ limit: 2 });
    if (!first.ok) throw new Error("expected root page");
    expect(first.data.data).toEqual({
      writable: false,
      items: [
        { kind: "folder", id: entryRefId("cloud:users:me", "")!, name: "My files", icon: "ti ti-home" },
        { kind: "folder", id: entryRefId("cloud:groups:a", "")!, name: "alpha", icon: "ti ti-users" },
      ],
      next: "2",
    });
    expect(capabilityResultSchema(FileProviderListDataSchema).safeParse(first.data).success).toBe(true);
    const second = await listProvider({ limit: 2, cursor: "2" });
    if (!second.ok) throw new Error("expected second page");
    expect(second.data.data.items.map((item) => item.name)).toEqual(["zeta"]);
    expect(second.data.data.next).toBeNull();

    const german = await listProvider({ query: "dateien" }, { ...context, locale: "de" });
    if (!german.ok) throw new Error("expected filtered root");
    expect(german.data.data.items.map((item) => item.name)).toEqual(["Meine Dateien"]);
    await expect(listProvider({ cursor: "base0" })).rejects.toMatchObject({ code: "cursor_invalid", status: 409 });
  });

  test("a folder page maps entries, keeps writability, and reads half the limit from storage", async () => {
    ids.set("folder-id", { baseId: "base", path: "Docs" });
    folderWritable = false;
    next = "cursor-2";
    items = [
      { name: "Plans", path: "Docs/Plans", directory: true, size: 0, modified },
      { name: "photo.PNG", path: "Docs/photo.PNG", directory: false, size: 12, modified },
      { name: "notes", path: "Docs/notes", directory: false, size: 3, modified },
    ];
    const result = await listProvider({ parent: "folder-id", query: "o", cursor: "cursor-1", limit: 25 });
    if (!result.ok) throw new Error("expected folder page");
    expect(folderCalls).toEqual([{ id: "folder-id", q: "o", after: "cursor-1", pageSize: 13 }]);
    expect(result.data.data).toEqual({
      writable: false,
      items: [
        {
          kind: "folder",
          id: entryRefId("base", "Docs/Plans")!,
          name: "Plans",
          updatedAt: modified,
          icon: expect.stringMatching(/^ti ti-/),
        },
        {
          kind: "file",
          id: entryRefId("base", "Docs/photo.PNG")!,
          name: "photo.PNG",
          size: 12,
          mediaType: "image/png",
          updatedAt: modified,
          icon: expect.stringMatching(/^ti ti-/),
        },
        {
          kind: "file",
          id: entryRefId("base", "Docs/notes")!,
          name: "notes",
          size: 3,
          mediaType: "application/octet-stream",
          updatedAt: modified,
          icon: expect.stringMatching(/^ti ti-/),
        },
      ],
      next: "cursor-2",
    });
    expect(capabilityResultSchema(FileProviderListDataSchema).safeParse(result.data).success).toBe(true);
    await expect(listProvider({ parent: "unknown" })).rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  test("content.read reports the media type of the file name", async () => {
    ids.set("pdf-id", { baseId: "base", path: "Q3 report.PDF" });
    readName = "Q3 report.PDF";
    const read = await filesCapabilities.queries["content.read"].run({ id: "pdf-id" }, context);
    if (!read.ok) throw new Error("expected read");
    expect(read.data.stream).toMatchObject({ name: "Q3 report.PDF", mediaType: "application/pdf" });
    readName = "README";
    const plain = await filesCapabilities.queries["content.read"].run({ id: "pdf-id" }, context);
    if (!plain.ok) throw new Error("expected read");
    expect(plain.data.stream?.mediaType).toBe("application/octet-stream");
  });

  test("save creates only, inside the chosen folder, with a key bound to user and call", async () => {
    ids.set("root-id", { baseId: "base", path: "" });
    ids.set("docs-id", { baseId: "base", path: "Docs" });
    const save = filesCapabilities.actions["provider.save"];
    const caller = { ...context, idempotencyKey: "save-key" };
    const input = { parent: "docs-id", name: "Report (2).pdf", mediaType: "application/pdf", size: 4 };
    const first = await save.run(input, caller);
    await save.run(input, caller);
    await save.run({ ...input, parent: "root-id" }, { ...caller, idempotencyKey: "other-key" });
    if (!first.ok) throw new Error("expected save");
    expect(first.data.data).toEqual({});
    expect(first.data.stream).toMatchObject({ direction: "write", name: "Report (2).pdf", mediaType: "application/pdf", size: 4 });
    expect(uploadInputs).toEqual([
      expect.objectContaining({ baseId: "base", path: "Docs/Report (2).pdf", size: 4, onConflict: "error" }),
      expect.objectContaining({ baseId: "base", path: "Docs/Report (2).pdf", size: 4, onConflict: "error" }),
      expect.objectContaining({ baseId: "base", path: "Report (2).pdf", onConflict: "error" }),
    ]);
    expect(uploadKeys[0]).toBe(uploadKeys[1]);
    expect(uploadKeys[2]).not.toBe(uploadKeys[0]);
    // The same caller key never collides with an upload through content.create.
    await filesCapabilities.actions["content.create"].run(
      { baseId: "base", path: "Docs/Report (2).pdf", size: 4, mediaType: "application/pdf", onConflict: "error" },
      caller,
    );
    expect(uploadKeys[3]).not.toBe(uploadKeys[0]);

    expect(await save.run({ ...input, size: 50 * 1024 * 1024 + 1 }, caller)).toMatchObject({ ok: false, error: { status: 400 } });
    serviceFailure = new MockFilesError("path_conflict", 409);
    await expect(save.run(input, caller)).rejects.toMatchObject({ code: "path_conflict", status: 409 });
  });
});
