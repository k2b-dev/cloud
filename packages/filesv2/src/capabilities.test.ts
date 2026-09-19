import { afterEach, expect, mock, test } from "bun:test";
import {
  CAPABILITY_MAX_RESULT_BYTES,
  type CapabilityExecutionContext,
  capabilityResultSchema,
  UniversalSearchDataSchema,
} from "@k2b/cloud/contracts";
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
class MockFilesError extends Error {}
mock.module("./service", () => ({
  FilesError: MockFilesError,
  filesService: {
    bases: async () => ({ items: Array.from({ length: baseCount }, (_, index) => ({ ...base, id: `base${index}` })) }),
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
