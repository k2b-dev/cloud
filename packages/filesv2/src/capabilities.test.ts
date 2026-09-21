import { afterEach, expect, mock, test } from "bun:test";
import {
  CAPABILITY_MAX_RESULT_BYTES,
  type CapabilityExecutionContext,
  capabilityResultSchema,
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
let items: FileEntry[] = [];
let calls = 0;
const uploadKeys: string[] = [];
const ids = new Map<string, { baseId: string; path: string }>();
mock.module("./data/references", () => ({
  persistedEntryRefId: async (baseId: string, path: string) => {
    const id = entryRefId(baseId, path) ?? `p:${"a".repeat(64)}`;
    ids.set(id, { baseId, path });
    return id;
  },
  resolveEntryRefId: async (id: string) => ids.get(id) ?? null,
}));
const page = async (): Promise<DirectoryResult> => {
  calls++;
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
    bases: async () => ({ items: Array.from({ length: baseCount }, (_, index) => ({ ...base, id: `base${index}` })) }),
    upload: async (_actor: unknown, input: { idempotencyKey: string }) => {
      uploadKeys.push(input.idempotencyKey);
      return { id: input.idempotencyKey };
    },
    download: async (actor: unknown, input: { baseId: string; path: string }) => {
      downloads.push({ actor, input });
      if (downloadFailure) throw downloadFailure;
      return lease;
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
  items = [];
  calls = 0;
  ids.clear();
  downloads.length = 0;
  downloadFailure = null;
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
  const result = await query.run({ id: "missing" }, context);
  expect(result).toMatchObject({ ok: false, error: { status: 404 } });
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
