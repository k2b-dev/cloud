import { expect, test } from "bun:test";
import { FilegateError, type Node, type RootInfo } from "@k2b/filegate";
import { ancestors, type KnownActivity } from "../data/activity-observations";
import { compareActivity, inspectActivity, observationBindingMatches, observationKey } from "./activity-observations";
import type { readConfiguration } from "./configuration";

const known: KnownActivity = {
  id: "10000000-0000-4000-8000-000000000001",
  server_url: "https://filegate.test",
  root: "cloud",
  base_id: "10000000-0000-4000-8000-000000000002",
  path: "users/alice/folder/file.txt",
  item_id: "file-id",
  directory: false,
  size: "4",
  revision: "r1",
  observation_next_at: null,
};
const node: Node = {
  root: known.root,
  path: known.path,
  id: known.item_id!,
  directory: false,
  size: 4,
  revision: "r1",
  modified: "2030-05-15T12:00:00Z",
  mode: "0600",
  uid: 1,
  gid: 1,
};
const info: RootInfo = {
  name: "cloud",
  stableIds: true,
  managed: true,
  execution: false,
  index: { enabled: true, rebuilding: false, scanned: 0, lastBuilt: null, durationMs: 0 },
  stats: null,
  versioning: { enabled: true, keep: { last: 10, hourly: 0, daily: 0, weekly: 0, monthly: 0 } },
  cooldown: "1m",
  versions: 0,
  versionBytes: 0,
  filesystem: "ext4",
  capacity: 1000,
  available: 1000,
  activeUploads: 0,
  stagingBytes: 0,
};
const missing = () => new FilegateError(404, "not_found", "Missing");
function fixture(options: { node?: Node | null; resolved?: Node; statError?: Error; resolveError?: Error; info?: RootInfo } = {}) {
  const calls: string[] = [];
  return {
    calls,
    root: {
      info: async () => {
        calls.push("info");
        return options.info ?? info;
      },
      stat: async () => {
        calls.push("stat");
        if (options.statError) throw options.statError;
        if (options.node === null) throw missing();
        return options.node ?? node;
      },
      resolve: async () => {
        calls.push("resolve");
        if (options.resolveError) throw options.resolveError;
        if (!options.resolved) throw missing();
        return options.resolved;
      },
    },
  };
}
test("equal successful Cloud evidence does not make a per-person read log", async () => {
  const f = fixture();
  expect(await inspectActivity(known, f.root)).toBeNull();
  expect(f.calls).toEqual(["info", "stat"]);
});
test("same-size revision change records only observed metadata", async () => {
  const finding = await inspectActivity(known, fixture({ node: { ...node, revision: "r2" } }).root);
  expect(finding).toEqual({
    action: "item.differs",
    path: known.path,
    state: { exists: true, directory: false, id: "file-id", size: 4, revision: "r2" },
  });
  expect(finding?.state).not.toHaveProperty("modified");
});
test("revisionless equal-size change remains undetectable, different size is observed", () => {
  const baseline = { ...known, item_id: null, revision: null };
  const current = { ...node, id: undefined, revision: undefined, modified: "2031-01-01T00:00:00Z" };
  expect(compareActivity(baseline, current, { ...info, stableIds: false, managed: false })).toBeNull();
  expect(compareActivity(baseline, { ...current, size: 5 }, { ...info, stableIds: false, managed: false })?.action).toBe("item.differs");
});
test("missing path resolves stable ID to its live endpoint without mutating it", async () => {
  const f = fixture({ node: null, resolved: { ...node, path: "users/bob/private.txt" } });
  expect(await inspectActivity(known, f.root)).toMatchObject({ action: "item.elsewhere", path: "users/bob/private.txt" });
  expect(f.calls).toEqual(["info", "stat", "resolve"]);
});
test("confirmed missing path and identity produce missing; no date or person inferred", async () => {
  const f = fixture({ node: null });
  expect(await inspectActivity(known, f.root)).toEqual({ action: "item.missing", path: null, state: { exists: false } });
  expect(f.calls).toEqual(["info", "stat", "resolve", "info"]);
});
test("replacement ID does not inherit the prior object's revision or baseline", async () => {
  expect(await inspectActivity(known, fixture({ node: { ...node, id: "replacement", revision: "r2" } }).root)).toEqual({
    action: "item.missing",
    path: null,
    state: { exists: false },
  });
});
test("replacement at old path still resolves the old object's moved endpoint", async () => {
  expect(
    await inspectActivity(known, fixture({ node: { ...node, id: "replacement" }, resolved: { ...node, path: "elsewhere.txt" } }).root),
  ).toMatchObject({ action: "item.elsewhere", path: "elsewhere.txt" });
});
test.each([403, 500, 503])("stat failure %s is not missing", async (status) => {
  const error = new FilegateError(status, "unavailable", "Failure");
  const f = fixture({ statError: error });
  await expect(inspectActivity(known, f.root)).rejects.toBe(error);
  expect(f.calls).toEqual(["info", "stat"]);
});
test("resolve permission failure is not missing", async () => {
  const error = new FilegateError(403, "forbidden", "Denied");
  await expect(inspectActivity(known, fixture({ node: null, resolveError: error }).root)).rejects.toBe(error);
});
test("unknown 404 and root disappearance are not element absence", async () => {
  const error = new FilegateError(404, "root_not_found", "Unknown root");
  await expect(inspectActivity(known, fixture({ statError: error }).root)).rejects.toBe(error);
  const f = fixture({ node: null });
  let reads = 0;
  f.root.info = async () => {
    if (reads++) throw error;
    return info;
  };
  await expect(inspectActivity(known, f.root)).rejects.toBe(error);
});
test("lost identity/revision capabilities and rebuilding never establish a replacement baseline", async () => {
  for (const rootInfo of [
    { ...info, stableIds: false },
    { ...info, index: { ...info.index, rebuilding: true } },
  ])
    expect(await inspectActivity(known, fixture({ info: rootInfo }).root)).toBeNull();
  expect(await inspectActivity(known, fixture({ node: { ...node, revision: undefined } }).root)).toBeNull();
  expect(await inspectActivity({ ...known, item_id: null }, fixture().root)).toBeNull();
});
test("directory metadata and replacement types are not invented content changes", () => {
  expect(compareActivity({ ...known, directory: true }, { ...node, directory: true, size: 99 }, info)).toBeNull();
  expect(compareActivity(known, { ...node, directory: true }, info)).toBeNull();
});
test("cancellation stops before the next storage read", async () => {
  const controller = new AbortController();
  const f = fixture();
  f.root.info = async () => {
    controller.abort();
    return info;
  };
  await expect(inspectActivity(known, f.root, controller.signal)).rejects.toBeDefined();
  expect(f.calls).toEqual([]);
});
test("dedup binds the known event and full observed state, independent of observer/time", () => {
  const first = { action: "item.differs" as const, path: known.path, state: { exists: true as const, directory: false, size: 5 } };
  expect(observationKey(known, first)).toBe(observationKey({ ...known }, { ...first }));
  expect(observationKey(known, first)).not.toBe(observationKey({ ...known, id: "another-event" }, first));
  expect(observationKey(known, first)).not.toBe(observationKey(known, { ...first, state: { ...first.state, size: 6 } }));
});
test("ancestor suppression is segment safe, including SQL wildcard characters", () => {
  expect(ancestors("users/a_b%/folder/file")).toEqual(["", ".", "users", "users/a_b%", "users/a_b%/folder", "users/a_b%/folder/file"]);
  expect(ancestors("users/alice2/file")).not.toContain("users/alice");
});
test("configuration drift and closed bindings cannot become missing observations", () => {
  const area = {
    enabled: true,
    root: "cloud",
    prefix: "",
    homes: "users",
    groups: "groups",
    archive: "archive",
    autoCreate: false,
    autoArchive: false,
  };
  const config: Awaited<ReturnType<typeof readConfiguration>> = {
    url: known.server_url,
    token: "test",
    unreadable: false,
    tokenConfigured: true,
    activityRetentionDays: 365,
    cloud: area,
    freeipa: area,
    collabora: { url: "", internalUrl: "", wopiOrigin: "", documentFormat: "odf" },
  };
  const binding = {
    id: known.base_id,
    root: "cloud",
    path: "users/alice",
    lifecycle: "active" as const,
    area: "cloud" as const,
    kind: "users" as const,
    identity_id: "alice-id",
    identity_name: "alice",
    uid_number: null,
    gid_number: null,
  };
  const target = { serverUrl: known.server_url, root: known.root, baseId: known.base_id, path: known.path };
  expect(observationBindingMatches(config, binding, target)).toBe(true);
  expect(observationBindingMatches(config, { ...binding, area: "freeipa" }, target)).toBe(false);
  for (const changed of [
    { ...config, url: "https://another.test" },
    { ...config, unreadable: true },
    { ...config, cloud: { ...area, prefix: "changed" } },
  ])
    expect(observationBindingMatches(changed, binding, target)).toBe(false);
  for (const lifecycle of ["retired", "archived", "deleted", "provisioning"] as const)
    expect(observationBindingMatches(config, { ...binding, lifecycle }, target)).toBe(false);
});
