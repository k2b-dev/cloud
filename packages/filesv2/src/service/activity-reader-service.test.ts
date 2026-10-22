import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { accountIdentities } from "@k2b/cloud/services";
import { actorId, candidate, historyBinding, otherId } from "../../test/activity-reader-fixture";
import { testActor, testCall } from "../../test/files-call";
import { activityReaderData } from "../data/activity-reader";
import { bindings } from "../data/bases";
import { shares, type ShareRow } from "../data/shares";
import { FilesError } from "./errors";
import { createFilesService } from "./index";

const call = testCall(testActor);
const row = candidate(1, { actor_user_id: actorId });
const input = { shareId: "50000000-0000-4000-8000-000000000001", from: "2030-05-01", to: "2030-05-15" };
const share: ShareRow = {
  id: input.shareId,
  token_hash: "test-only",
  password_hash: null,
  kind: "download",
  base_id: historyBinding.id,
  root: "cloud",
  base_path: historyBinding.path,
  scope: "",
  items: [],
  title: "Share",
  note: null,
  public_note: null,
  owner_uid: null,
  owner_gid: null,
  created_by: actorId,
  created_by_name: "Alice",
  created_at: new Date("2030-05-01T00:00:00Z"),
  expires_at: null,
  revoked_at: null,
  revoked_by: null,
  access_count: 0,
  last_accessed_at: null,
  max_file_size: 0,
  max_total_size: 0,
  show_upload_names: false,
};
afterEach(() => mock.restore());
function fixture() {
  let profile: "user" | "guest" = "user";
  let admin = false;
  let creator = actorId;
  const area = { enabled: true, root: "cloud", prefix: "", homes: "users", groups: "groups", archive: "archive" };
  const config = {
    url: "http://filegate.test",
    token: "test-only",
    tokenConfigured: true,
    unreadable: false,
    activityRetentionDays: 365,
    cloud: { ...area, autoCreate: false, autoArchive: false },
    freeipa: { ...area, root: "freeipa" },
    collabora: { url: "", internalUrl: "", wopiOrigin: "", documentFormat: "odf" as const },
  };
  const candidates = spyOn(activityReaderData, "candidates").mockResolvedValue([row]);
  const byId = spyOn(activityReaderData, "byId").mockResolvedValue(row);
  const counts = spyOn(activityReaderData, "shareAccess").mockResolvedValue({
    pageNetworks: 0,
    from: input.from,
    to: input.to,
    timeline: { items: [], next: null },
    pages: 1,
    downloads: 0,
    passwordFailed: 0,
    networks: { known: 0, incomplete: false, overflow: false, items: [], next: null, rolledUp: false },
  });
  spyOn(shares, "get").mockImplementation(async () => ({ ...share, created_by: creator }));
  const inventory = mock(async () => {
    if (!admin) throw new FilesError("forbidden", 403);
    return { items: [], nextCursor: null };
  });
  const connect = mock((): never => {
    throw new Error("History snapshots and share counts must not connect");
  });
  const service = createFilesService({
    identities: {
      ...accountIdentities,
      self: async () => ({
        user: { id: actorId, username: "alice", provider: "local", profile, posix: null },
        availability: { localLinuxEnabled: true, freeipaEnabled: true },
      }),
      groups: async () => ({ items: [], nextCursor: null }),
      inventory,
    },
    bindings: { ...bindings, find: async () => [historyBinding], byId: async () => historyBinding },
    readConfiguration: async () => config,
    writeConfiguration: async () => {},
    resetConfiguration: async () => {},
    displayNames: async () => [],
    publicOrigin: async () => "https://cloud.test",
    userById: async () => null,
    transfer: fetch,
    connect,
  });
  return {
    service,
    config,
    candidates,
    byId,
    counts,
    inventory,
    connect,
    demote: () => {
      profile = "guest";
    },
    setAdmin: () => {
      admin = true;
    },
    setForeignCreator: () => {
      creator = otherId;
    },
  };
}

test("canonical guest demotion denies own activity/list, activity.get and share.access before creator/admin shortcuts", async () => {
  const f = fixture();
  expect((await f.service.activity(call)).items[0]?.id).toBe(row.id);
  expect((await f.service.activityEntry(call, { activityId: row.id })).id).toBe(row.id);
  expect((await f.service.shareAccess(call, input)).pages).toBe(1);
  f.candidates.mockClear();
  f.byId.mockClear();
  f.counts.mockClear();
  f.inventory.mockClear();
  // The actor still carries the old user profile; only the canonical current profile decides.
  f.demote();
  await expect(f.service.activity(call)).rejects.toMatchObject({ code: "forbidden", status: 403 });
  await expect(f.service.activityEntry(call, { activityId: row.id })).rejects.toMatchObject({ code: "forbidden", status: 403 });
  await expect(f.service.activityForEntry(call, "unknown-reference")).rejects.toMatchObject({ code: "forbidden", status: 403 });
  await expect(f.service.shareAccess(call, input)).rejects.toMatchObject({ code: "forbidden", status: 403 });
  f.setAdmin();
  f.setForeignCreator();
  await expect(f.service.shareAccess(call, input)).rejects.toMatchObject({ code: "forbidden", status: 403 });
  expect(f.candidates).not.toHaveBeenCalled();
  expect(f.byId).not.toHaveBeenCalled();
  expect(f.counts).not.toHaveBeenCalled();
  expect(f.inventory).not.toHaveBeenCalled();
  expect(f.connect).not.toHaveBeenCalled();
});

test("unreadable configuration fails history list/detail/chain explicitly while independent share authorization survives", async () => {
  const f = fixture();
  f.config.unreadable = true;
  // This also covers the default/disabled configuration returned after failed decryption.
  f.config.cloud.enabled = false;
  f.config.url = "";
  for (const read of [
    () => f.service.activity(call),
    () => f.service.activityEntry(call, { activityId: row.id }),
    () => f.service.activityForEntry(call, "unknown-reference"),
    () => f.service.movementChain(call, { activityId: row.id }),
  ])
    await expect(read()).rejects.toMatchObject({ code: "configuration_unreadable", status: 409 });
  expect(f.candidates).not.toHaveBeenCalled();
  expect(f.byId).not.toHaveBeenCalled();
  expect(f.connect).not.toHaveBeenCalled();
  expect((await f.service.shareAccess(call, input)).pages).toBe(1);
  f.setForeignCreator();
  await expect(f.service.shareAccess(call, input)).rejects.toMatchObject({ code: "not_found", status: 404 });
  f.setAdmin();
  expect((await f.service.shareAccess(call, input)).pages).toBe(1);
});

test("share list and revoke reject a canonical guest before creator or admin management shortcuts", async () => {
  const f = fixture();
  f.setAdmin();
  f.demote();
  for (const read of [
    () => f.service.listShares(call),
    () => f.service.listShares(call, { baseId: `cloud:users:${actorId}`, path: "file.txt" }),
    () => f.service.listShares(call, { admin: true }),
    () => f.service.revokeShare(call, { id: input.shareId }),
    () => f.service.revokeShare(call, { id: input.shareId, admin: true }),
  ])
    await expect(read()).rejects.toMatchObject({ code: "forbidden", status: 403 });
  expect(f.inventory).not.toHaveBeenCalled();
  expect(f.connect).not.toHaveBeenCalled();
});

test("administrator history base labels require a current full profile and canonical admin before SQL", async () => {
  const f = fixture();
  const bases = spyOn(activityReaderData, "activityBases").mockResolvedValue({ items: [historyBinding], next: null });
  await expect(f.service.adminActivityBases(call)).rejects.toMatchObject({ status: 403 });
  expect(bases).not.toHaveBeenCalled();
  f.setAdmin();
  f.config.unreadable = true;
  expect(await f.service.adminActivityBases(call)).toMatchObject({ items: [{ id: `cloud:users:${actorId}`, name: "Deleted account" }] });
  bases.mockClear();
  f.inventory.mockClear();
  f.demote();
  await expect(f.service.adminActivityBases(call)).rejects.toMatchObject({ code: "forbidden", status: 403 });
  expect(bases).not.toHaveBeenCalled();
  expect(f.inventory).not.toHaveBeenCalled();
  expect(f.connect).not.toHaveBeenCalled();
});
