import { expect, test } from "bun:test";
import { testActor, testCall } from "../../test/files-call";
import { entry as historyEntry } from "../../test/history-fixtures";
import type { ActivityChain, ActivityEntry } from "../activity-contracts";
import type { EntryResult, TrashEntry } from "../contracts";
import type { RecoveryRecord } from "../data/activity-recovery";
import type { Binding } from "../data/bases";
import { type ActivityActionDeps, createActivityActions } from "./activity-actions";
import { FilesError } from "./errors";

const call = testCall(testActor);
const activityId = "10000000-0000-4000-8000-000000000001";
const binding: Binding = {
  id: "binding",
  lifecycle: "active",
  area: "cloud",
  kind: "users",
  identity_id: "alice",
  identity_name: "alice",
  root: "cloud",
  path: "users/alice",
  uid_number: null,
  gid_number: null,
};
const baseId = "cloud:users:alice";
const result: EntryResult = {
  base: {
    id: baseId,
    area: "cloud",
    kind: "users",
    name: "Personal",
    status: "existing",
    reason: null,
    indexEnabled: true,
    versioningEnabled: true,
  },
  entry: { name: "original", path: "folder/original", directory: true, size: 0, modified: "2030-05-15T12:00:00.000Z" },
};
function fixture(action = "item.trash") {
  const record: RecoveryRecord = {
    id: activityId,
    action,
    state: "done",
    server_url: "http://storage.test",
    root: "cloud",
    base_id: binding.id,
    path_before: "users/alice/folder/original",
    trash_id: "trash-id",
  };
  let visible: ActivityEntry = historyEntry({ id: activityId, action: "item.trash" });
  let trashState: TrashEntry["state"] = "trashed";
  let chain: ActivityChain = {
    sourceId: activityId,
    hops: [],
    endpoint: { baseId, path: "archive/original", itemId: "stable-original" },
    certainty: "verified",
    historyComplete: false,
    truncated: false,
  };
  const writes: unknown[] = [];
  const reads: string[] = [];
  const deps: ActivityActionDeps = {
    async entry() {
      reads.push("visible");
      return visible;
    },
    async record() {
      reads.push("record");
      return record;
    },
    async binding() {
      return binding;
    },
    async chain() {
      return chain;
    },
    async oldLocation() {
      reads.push("old-parent");
    },
    async writable() {
      reads.push("write-parent");
    },
    async trashEntry() {
      return { id: "trash-id", name: "original", original: "folder/original", directory: true, deletedAt: null, state: trashState };
    },
    async restoreTrash(_call, input) {
      writes.push(input);
      return result;
    },
    async moveBack(_call, _record, endpoint, path) {
      writes.push({ endpoint, path });
      return result;
    },
    async recheck(_call, id) {
      writes.push({ recheck: id });
      visible = { ...visible, state: "done" };
    },
  };
  return {
    record,
    deps,
    writes,
    reads,
    service: createActivityActions(deps),
    setState: (state: ActivityEntry["state"]) => {
      visible = { ...visible, state };
    },
    setChain: (value: ActivityChain) => {
      chain = value;
    },
    setTrashState: (state: TrashEntry["state"]) => {
      trashState = state;
    },
  };
}

test("a guessed hidden history ID is denied before journal lookup", async () => {
  const f = fixture();
  f.deps.entry = async () => {
    throw new FilesError("not_found", 404);
  };
  await expect(f.service.restore(call, { activityId })).rejects.toHaveProperty("status", 404);
  expect(f.reads).toEqual([]);
  expect(f.writes).toEqual([]);
});
test("own history cannot restore after losing the current old location", async () => {
  const f = fixture();
  f.deps.oldLocation = async () => {
    throw new FilesError("forbidden", 403);
  };
  expect(await f.service.recovery(call, { activityId })).toEqual({ oldLocation: null, trash: null, canMoveBack: false });
  await expect(f.service.restore(call, { activityId })).rejects.toHaveProperty("status", 404);
  expect(f.writes).toEqual([]);
});
test("recovery checks current trash and parent access, and suppresses the restore action without write rights", async () => {
  const f = fixture();
  expect(await f.service.recovery(call, { activityId })).toMatchObject({ trash: { id: "trash-id", canRestore: true } });
  f.deps.writable = async () => {
    throw new FilesError("forbidden", 403);
  };
  expect(await f.service.recovery(call, { activityId })).toMatchObject({ trash: { id: "trash-id", canRestore: false } });
  f.setTrashState("restoring");
  expect(await f.service.recovery(call, { activityId })).toMatchObject({ trash: { canRestore: false } });
});
test("restore delegates the original journal and safe conflict name to the existing permission-aware writer", async () => {
  const f = fixture();
  expect(await f.service.restore(call, { activityId, name: "original restored" })).toBe(result);
  expect(f.writes).toEqual([{ baseId, id: "trash-id", path: "folder/original restored" }]);
});
test.each(["../escape", "folder/name", "folder\\name", ".", "..", ""])(
  "a conflict name cannot select another location: %j",
  async (name) => {
    const f = fixture();
    await expect(f.service.restore(call, { activityId, name })).rejects.toHaveProperty("code", "invalid_path");
    expect(f.writes).toEqual([]);
  },
);
test("unknown or unfinished trash evidence cannot trigger a restore", async () => {
  const f = fixture();
  f.record.state = "unclear";
  await expect(f.service.restore(call, { activityId })).rejects.toHaveProperty("status", 404);
  expect(f.writes).toEqual([]);
});
test("move-back passes the verified current stable identity, preserving the original destination", async () => {
  const f = fixture("item.move");
  expect((await f.service.recovery(call, { activityId })).canMoveBack).toBe(true);
  expect(await f.service.moveBack(call, { activityId })).toBe(result);
  expect(f.writes).toEqual([{ endpoint: { baseId, path: "archive/original", itemId: "stable-original" }, path: "folder/original" }]);
});
test("a probable path or cross-base endpoint cannot move a replacement", async () => {
  for (const endpoint of [
    { baseId, path: "replacement", itemId: null },
    { baseId: "cloud:users:other", path: "original", itemId: "stable-original" },
  ]) {
    const f = fixture("item.move");
    f.setChain({
      sourceId: activityId,
      hops: [],
      endpoint,
      certainty: endpoint.itemId ? "verified" : "probable",
      historyComplete: false,
      truncated: false,
    });
    expect((await f.service.recovery(call, { activityId })).canMoveBack).toBe(false);
    await expect(f.service.moveBack(call, { activityId })).rejects.toHaveProperty("code", "source_changed");
    expect(f.writes).toEqual([]);
  }
});
test("recheck is scoped to one visible unfinished entry and returns its freshly authorized state", async () => {
  const f = fixture();
  f.setState("unclear");
  expect((await f.service.recheck(call, { activityId })).state).toBe("done");
  expect(f.writes).toEqual([{ recheck: activityId }]);
  expect(f.reads).toEqual(["visible", "visible"]);
  await f.service.recheck(call, { activityId });
  expect(f.writes).toHaveLength(1);
});
test("an operational failure stays an error instead of hiding recovery options", async () => {
  const f = fixture();
  f.deps.oldLocation = async () => {
    throw new FilesError("unavailable", 503);
  };
  await expect(f.service.recovery(call, { activityId })).rejects.toHaveProperty("status", 503);
});
