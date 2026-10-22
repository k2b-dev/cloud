import { beforeEach, expect, mock, spyOn, test } from "bun:test";
import { accountIdentities } from "@k2b/cloud/services";
import { testActor, testCall } from "../../test/files-call";
import * as observationData from "../data/activity-observations";
import { type Binding, bindings } from "../data/bases";
import * as operationModule from "../data/operations";
import * as referencesModule from "../data/references";
import { shares } from "../data/shares";
import { parseEntryRefId } from "../resource-ref";
import { withActivityReadBudget } from "./activity-read-budget";
import type { ActivityReaderDependencies } from "./activity-reader";
import * as activityReaderModule from "./activity-reader";
import { FilesError } from "./errors";
import { connectFilegate } from "./filegate-facade";

const readerActivity = mock(async (..._args: unknown[]) => ({ items: [] }));
let readerDeps: ActivityReaderDependencies | undefined;
mock.module("./activity-reader", () => ({
  ...activityReaderModule,
  createActivityReader: (deps: ActivityReaderDependencies) => {
    readerDeps = deps;
    return { activity: readerActivity, movementChain: mock(), shareAccess: mock() };
  },
}));
// This authorization-only fixture has no retained Cloud baseline. Real comparisons use the Filegate integration fixture.
mock.module("../data/activity-observations", () => ({
  ...observationData,
  knownIdentityActivity: async () => null,
}));
mock.module("../data/operations", () => ({
  ...operationModule,
  operations: { ...operationModule.operations, pending: async () => null, retiredPath: async () => false },
}));
const storedRefs = new Map<string, { baseId: string; path: string }>();
mock.module("../data/references", () => ({
  ...referencesModule,
  resolveEntryRefId: async (id: string) => storedRefs.get(id) ?? parseEntryRefId(id),
}));
let provisions = 0;
mock.module("./lifecycle", () => ({
  createDirectoryLifecycle: () => ({
    provisionCandidate: async () => {
      provisions++;
      throw new Error("normal provisioning reached");
    },
  }),
}));
const { createFilesService } = await import("./index");
const actor = testActor;
const id = actor.kind === "user" ? actor.user.id : "";
const fileId = "30000000-0000-4000-8000-000000000001";
const pathRef = `p:${"a".repeat(64)}`;
const area = { enabled: true, root: "cloud", prefix: "", homes: "users", groups: "groups", archive: "archive" };
const config = {
  url: "http://filegate.test",
  token: "test-token",
  tokenConfigured: true,
  unreadable: false,
  activityRetentionDays: 365,
  cloud: { ...area, autoCreate: true, autoArchive: true },
  freeipa: { ...area, root: "freeipa" },
  collabora: { url: "", internalUrl: "", wopiOrigin: "", documentFormat: "odf" as const },
};
function fixture(ipa = false) {
  let present = true;
  let bound = true;
  let member = true;
  let leafMode = "0600";
  let denyAncestor = false;
  let liveId = fileId;
  let stableIds = true;
  let resolvedPath = "users/alice/file.txt";
  let resolveStatus = 200;
  const statFailures = new Map<string, number>();
  let seenActor: unknown;
  const counts = { self: 0, groups: 0, config: 0, bindings: 0 };
  const requests: { path: string; target: string; execution: string | null }[] = [];
  const baseId = `${ipa ? "freeipa" : "cloud"}:users:${id}`;
  storedRefs.set(pathRef, { baseId, path: "file.txt" });
  const binding: Binding = {
    id: "20000000-0000-4000-8000-000000000001",
    lifecycle: "active",
    area: ipa ? "freeipa" : "cloud",
    kind: "users",
    identity_id: id,
    identity_name: "alice",
    root: ipa ? "freeipa" : "cloud",
    path: "users/alice",
    uid_number: ipa ? 1000 : null,
    gid_number: ipa ? 1000 : null,
  };
  const claim = mock(async () => [binding]);
  const transport: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      const url = new URL(String(input));
      const path = url.searchParams.get("path") ?? "";
      const execution = new Headers(init?.headers).get("X-Filegate-Execution");
      requests.push({ path: url.pathname, target: path, execution });
      if (/\/roots\/[^/]+$/.test(url.pathname))
        return Response.json({ execution: true, stableIds, managed: true, index: { enabled: true }, versioning: { enabled: true } });
      if (url.pathname.includes("/resolve")) {
        if (resolveStatus !== 200) return Response.json({ error: "resolve_failed" }, { status: resolveStatus });
        return Response.json({
          root: binding.root,
          path: resolvedPath,
          id: fileId,
          directory: false,
          size: 0,
          modified: "2026-10-20T12:00:00Z",
        });
      }
      if (url.pathname.endsWith("/stat")) {
        const failure = statFailures.get(path);
        if (failure) return Response.json({ error: "stat_failed" }, { status: failure });
        if (!present) return Response.json({ error: "not_found" }, { status: 404 });
        if (execution && denyAncestor && path !== binding.path) return Response.json({ error: "permission_denied" }, { status: 403 });
        return Response.json({
          root: binding.root,
          path,
          id: liveId,
          directory: path === binding.path,
          uid: 1000,
          gid: 1000,
          mode: path === binding.path ? "0700" : leafMode,
          size: 0,
          modified: "2026-10-20T12:00:00Z",
        });
      }
      if (url.pathname.includes("acl"))
        return Response.json({ entries: [{ tag: "owner", permissions: path !== binding.path && leafMode === "0000" ? "---" : "rwx" }] });
      throw new Error(`Unexpected request ${url.pathname}`);
    },
    { preconnect: fetch.preconnect },
  );
  const service = createFilesService({
    identities: {
      ...accountIdentities,
      self: async (requestActor) => {
        counts.self++;
        seenActor = requestActor;
        return {
          user: {
            id: member ? id : "other-user",
            username: member ? "alice" : "other",
            provider: ipa ? ("ipa" as const) : ("local" as const),
            profile: "user" as const,
            posix: ipa ? { uidNumber: 1000, primaryGidNumber: 1000 } : null,
          },
          availability: { localLinuxEnabled: true, freeipaEnabled: true },
        };
      },
      groups: async () => {
        counts.groups++;
        return { items: [], nextCursor: null };
      },
      inventory: async () => {
        throw new FilesError("forbidden", 403);
      },
    },
    bindings: {
      ...bindings,
      find: async () => {
        counts.bindings++;
        return bound ? [binding] : [];
      },
      claim,
    },
    readConfiguration: async () => {
      counts.config++;
      return config;
    },
    displayNames: async () => [],
    writeConfiguration: async () => {},
    resetConfiguration: async () => {},
    publicOrigin: async () => "https://cloud.test",
    userById: async () => null,
    transfer: fetch,
    connect: (configuration, signal) => connectFilegate(configuration, transport, signal),
  });
  const requestContext = readerDeps!.requestContext;
  return {
    service,
    requestContext,
    counts,
    read: (path = "file.txt") =>
      withActivityReadBudget(undefined, async (budget) => (await requestContext(actor, budget)).readOnlyAuthorized(baseId, path)),
    claim,
    requests,
    statFailures,
    set liveId(value: string) {
      liveId = value;
    },
    set stableIds(value: boolean) {
      stableIds = value;
    },
    set resolvedPath(value: string) {
      resolvedPath = value;
    },
    set resolveStatus(value: number) {
      resolveStatus = value;
    },
    get seenActor() {
      return seenActor;
    },
    set present(value: boolean) {
      present = value;
    },
    set bound(value: boolean) {
      bound = value;
    },
    set member(value: boolean) {
      member = value;
    },
    set leafMode(value: string) {
      leafMode = value;
    },
    set denyAncestor(value: boolean) {
      denyAncestor = value;
    },
    baseId,
  };
}
beforeEach(() => {
  provisions = 0;
  readerActivity.mockClear();
  storedRefs.clear();
});
test("history on a missing auto-created home never provisions; the normal path still does", async () => {
  const f = fixture();
  f.present = false;
  await expect(f.read()).rejects.toMatchObject({ status: 403, code: "not_found" });
  expect(provisions).toBe(0);
  expect(f.claim).not.toHaveBeenCalled();
  await expect(f.service.entry(testCall(actor), { baseId: f.baseId, path: "file.txt" })).rejects.toThrow("normal provisioning reached");
  expect(provisions).toBe(1);
});
test("history never adopts an unbound FreeIPA home; the normal path still claims", async () => {
  const f = fixture(true);
  f.bound = false;
  await expect(f.read()).rejects.toMatchObject({ status: 403, code: "unassigned" });
  expect(f.claim).not.toHaveBeenCalled();
  expect(provisions).toBe(0);
  // An unreadable leaf stops the normal path after its existing claim behavior, before reference writes.
  f.leafMode = "0000";
  await expect(f.service.entry(testCall(actor), { baseId: f.baseId, path: "file.txt" })).rejects.toMatchObject({ status: 403 });
  expect(f.claim).toHaveBeenCalledTimes(1);
});
test("read-only inspection preserves RequestActor, current membership, execution and Unix leaf rights", async () => {
  const f = fixture(true);
  const result = await f.read();
  expect(result.target).toBe("users/alice/file.txt");
  expect(f.seenActor).toBe(actor);
  expect(f.requests.some((request) => request.execution && JSON.parse(request.execution).uid === 1000)).toBe(true);
  f.leafMode = "0000";
  await expect(f.read()).rejects.toMatchObject({ status: 403 });
  f.leafMode = "0600";
  f.denyAncestor = true;
  await expect(f.read()).rejects.toMatchObject({ status: 403 });
  f.denyAncestor = false;
  f.member = false;
  await expect(f.read()).rejects.toMatchObject({ status: 404 });
  expect(f.claim).not.toHaveBeenCalled();
  expect(provisions).toBe(0);
});

test("entry-reference history authorizes stable identity and path before delegating without writes", async () => {
  const f = fixture();
  const call = testCall(actor);
  const stable = `n:${f.baseId}:${fileId}`;
  await f.service.activityForEntry(call, stable, { limit: 2 });
  expect(readerActivity.mock.calls[0]).toEqual([
    { ...call, requestAbort: expect.any(AbortSignal) },
    { baseId: f.baseId, itemId: "30000000-0000-4000-8000-000000000001", limit: 2 },
  ]);
  await f.service.activityForEntry(call, pathRef, { q: "old" });
  expect(readerActivity.mock.calls[1]).toEqual([
    { ...call, requestAbort: expect.any(AbortSignal) },
    { baseId: f.baseId, path: "file.txt", q: "old" },
  ]);
  expect(f.requests.some((request) => request.path.includes("/resolve"))).toBe(true);
  expect(f.requests.some((request) => request.target === "users/alice/file.txt")).toBe(true);
  expect(f.claim).not.toHaveBeenCalled();
  expect(provisions).toBe(0);
});

test("unknown and registered unreadable refs return identical empty pages without invoking the candidate reader", async () => {
  const f = fixture(true);
  const call = testCall(actor);
  const empty = await f.service.activityForEntry(call, `p:${"b".repeat(64)}`);
  expect(empty).toEqual({
    items: [],
    next: null,
    visibleCount: 0,
    batches: [],
    exhausted: true,
    scanLimitReached: false,
    searchLimitReached: false,
  });
  expect(f.requests).toEqual([]);
  f.leafMode = "0000";
  expect(await f.service.activityForEntry(call, pathRef)).toEqual(empty);
  expect(await f.service.activityForEntry(call, `n:${f.baseId}:${fileId}`)).toEqual(empty);
  // Inspection stats the base; no execution-scoped parent authorization may rescue the existing leaf.
  expect(f.requests.filter((request) => request.execution && request.target === "users/alice")).toEqual([]);
  expect(readerActivity).not.toHaveBeenCalled();
  expect(f.claim).not.toHaveBeenCalled();
  expect(provisions).toBe(0);
});

test("only a proven missing path may authorize its readable parent before history candidates", async () => {
  const f = fixture(true);
  const call = testCall(actor);
  f.leafMode = "0000";
  f.statFailures.set("users/alice/file.txt", 404);
  await f.service.activityForEntry(call, pathRef);
  expect(readerActivity).toHaveBeenCalledTimes(1);
  expect(f.requests.some((request) => request.execution && request.target === "users/alice")).toBe(true);
  readerActivity.mockClear();
  f.statFailures.set("users/alice/file.txt", 403);
  expect((await f.service.activityForEntry(call, pathRef)).next).toBeNull();
  expect(readerActivity).not.toHaveBeenCalled();
  f.statFailures.set("users/alice/file.txt", 503);
  await expect(f.service.activityForEntry(call, pathRef)).rejects.toMatchObject({ status: 503 });
  expect(readerActivity).not.toHaveBeenCalled();
  f.statFailures.set("users/alice/file.txt", 404);
  f.statFailures.set("users/alice", 403);
  expect((await f.service.activityForEntry(call, pathRef)).items).toEqual([]);
  expect(readerActivity).not.toHaveBeenCalled();
});

test("stable refs never scan history for unresolved, replaced, disabled or out-of-base identities", async () => {
  const f = fixture();
  const read = () => f.service.activityForEntry(testCall(actor), `n:${f.baseId}:${fileId}`);
  for (const status of [400, 404, 409]) {
    f.resolveStatus = status;
    expect((await read()).next).toBeNull();
  }
  f.resolveStatus = 200;
  f.liveId = "replacement";
  expect((await read()).items).toEqual([]);
  f.liveId = fileId;
  f.resolvedPath = "users/another/file.txt";
  expect((await read()).items).toEqual([]);
  f.resolvedPath = "users/alice/trash/file.txt";
  expect((await read()).items).toEqual([]);
  f.stableIds = false;
  expect((await read()).items).toEqual([]);
  expect(readerActivity).not.toHaveBeenCalled();
  f.stableIds = true;
  f.resolveStatus = 503;
  await expect(read()).rejects.toMatchObject({ status: 503 });
  expect(readerActivity).not.toHaveBeenCalled();
});

test("entry refs cannot bypass membership checks or provision a missing home", async () => {
  const f = fixture();
  f.member = false;
  expect((await f.service.activityForEntry(testCall(actor), pathRef)).items).toEqual([]);
  expect(f.requests).toEqual([]);
  f.member = true;
  f.present = false;
  expect((await f.service.activityForEntry(testCall(actor), pathRef)).items).toEqual([]);
  expect(readerActivity).not.toHaveBeenCalled();
  expect(f.claim).not.toHaveBeenCalled();
  expect(provisions).toBe(0);
});

test("one request resolves identity/config/groups once and read-only base once, with fresh leaf checks", async () => {
  const f = fixture(true);
  await withActivityReadBudget(undefined, async (budget) => {
    const current = await f.requestContext(actor, budget);
    for (const path of ["one.txt", "two.txt", "two.txt"]) await current.readOnlyAuthorized(f.baseId, path);
  });
  expect(f.counts).toEqual({ self: 1, groups: 1, config: 1, bindings: 2 });
  expect(f.requests.filter((request) => /\/roots\/[^/]+$/.test(request.path))).toHaveLength(1);
  expect(f.requests.filter((request) => request.path.endsWith("/stat") && request.execution)).toHaveLength(6);
  expect(f.claim).not.toHaveBeenCalled();
  expect(provisions).toBe(0);
});

test("item-share listing uses read-only authorization and the actual current stable identity before bounded SQL", async () => {
  const list = spyOn(shares, "list").mockResolvedValue({ items: [], next: null });
  try {
    const f = fixture(true);
    await f.service.listShares(testCall(actor), { baseId: f.baseId, path: "file.txt" });
    expect(list).toHaveBeenCalledWith({
      ownerId: id,
      after: undefined,
      item: {
        bindingId: "20000000-0000-4000-8000-000000000001",
        serverUrl: config.url,
        root: "freeipa",
        basePath: "users/alice",
        path: "file.txt",
        target: "users/alice/file.txt",
        directory: false,
        itemId: fileId,
      },
    });
    expect(f.seenActor).toBe(actor);
    expect(f.requests.some((request) => request.execution && JSON.parse(request.execution).uid === 1000)).toBe(true);
    expect(f.claim).not.toHaveBeenCalled();
    expect(provisions).toBe(0);
    list.mockClear();
    f.leafMode = "0000";
    await expect(f.service.listShares(testCall(actor), { baseId: f.baseId, path: "file.txt" })).rejects.toMatchObject({ status: 403 });
    expect(list).not.toHaveBeenCalled();
    f.leafMode = "0600";
    f.bound = false;
    await expect(f.service.listShares(testCall(actor), { baseId: f.baseId, path: "file.txt" })).rejects.toMatchObject({ status: 403 });
    expect(list).not.toHaveBeenCalled();
    expect(f.claim).not.toHaveBeenCalled();
    expect(provisions).toBe(0);
    const missing = fixture();
    missing.present = false;
    await expect(missing.service.listShares(testCall(actor), { baseId: missing.baseId, path: "file.txt" })).rejects.toMatchObject({
      status: 403,
    });
    expect(missing.claim).not.toHaveBeenCalled();
    expect(provisions).toBe(0);
  } finally {
    list.mockRestore();
  }
});
