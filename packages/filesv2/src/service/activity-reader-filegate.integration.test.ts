import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { accountIdentities } from "@k2b/cloud/services";
import { Filegate, type RootClient } from "@k2b/filegate";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { activityFilegate } from "../../test/activity-filegate";
import { actorId, candidate, otherId } from "../../test/activity-reader-fixture";
import { testActor, testCall } from "../../test/files-call";
import { assertPrivateDatabase } from "../../test/private-database";
import type { ActivityCandidate } from "../data/activity-reader";
import { type Binding, bindings } from "../data/bases";
import { migrate } from "../migrate";
import { FilesError } from "./errors";
import { connectFilegate } from "./filegate-facade";
import { createFilesService } from "./index";

const at = new Date("2030-05-15T12:00:00Z");
const groupId = "60000000-0000-4000-8000-000000000001";
const cloudGroupId = "60000000-0000-4000-8000-000000000002";
const prefix = `reader-${randomUUID()}`;
const unix = { uidNumber: 12345, primaryGidNumber: 12346 };
const path = `${prefix}/groups/team`;
const cloudPath = `${prefix}/groups/local`;
const binding: Binding = {
  id: "20000000-0000-4000-8000-000000000001",
  lifecycle: "active",
  area: "freeipa",
  kind: "groups",
  identity_id: groupId,
  identity_name: "team",
  root: "freeipa",
  path,
  uid_number: null,
  gid_number: unix.primaryGidNumber,
};
const cloudBinding: Binding = {
  ...binding,
  id: "20000000-0000-4000-8000-000000000002",
  area: "cloud",
  root: "cloud",
  path: cloudPath,
  identity_id: cloudGroupId,
  identity_name: "local",
};
let target: Awaited<ReturnType<typeof activityFilegate>>;
let ipa: RootClient;
let cloud: RootClient;
let member = true;
const requests: string[] = [];
let service: ReturnType<typeof createFilesService>;
const actor =
  testActor.kind === "user"
    ? {
        ...testActor,
        user: {
          ...testActor.user,
          provider: "ipa" as const,
          ipa: {
            uidNumber: unix.uidNumber,
            phone: null,
            employeeType: null,
            mobile: null,
            address: { street: null, postalCode: null, city: null, state: null },
            passwordExpires: null,
            lastLoginIpa: null,
            syncedAt: null,
            sshPublicKeys: [],
            sshFingerprints: [],
          },
        },
      }
    : testActor;
const call = testCall(actor);

suiteFor("database", "nats")("history through real Filegate and the owning authorization factory", () => {
  beforeAll(async () => {
    await assertPrivateDatabase();
    await sql`CREATE SCHEMA auth`.simple();
    await sql`CREATE TABLE auth.users(id uuid PRIMARY KEY)`.simple();
    await sql`CREATE TABLE auth.access(id uuid PRIMARY KEY)`.simple();
    await migrate();
    target = await activityFilegate();
    const client = new Filegate({ baseUrl: target.url, token: target.token });
    ipa = client.root("freeipa");
    cloud = client.root("cloud");
    await ipa.mkdir(prefix, { ownership: { dirMode: "0755" } });
    await ipa.mkdir(`${prefix}/groups`, { ownership: { dirMode: "0755" } });
    await cloud.mkdir(prefix);
    await cloud.mkdir(`${prefix}/groups`);
    await ipa.mkdir(path, { ownership: { uid: unix.uidNumber, gid: unix.primaryGidNumber, dirMode: "0770" } });
    await cloud.mkdir(cloudPath);
    const area = { enabled: true, prefix, homes: "users", groups: "groups", archive: "archive" };
    const config = {
      url: target.url,
      token: target.token,
      tokenConfigured: true,
      unreadable: false,
      activityRetentionDays: 365,
      cloud: { ...area, root: "cloud", autoCreate: true, autoArchive: false },
      freeipa: { ...area, root: "freeipa" },
      collabora: { url: "", internalUrl: "", wopiOrigin: "", documentFormat: "odf" as const },
    };
    const transport: typeof fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        requests.push(String(input));
        return fetch(input, init);
      },
      { preconnect: fetch.preconnect },
    );
    service = createFilesService({
      identities: {
        ...accountIdentities,
        self: async () => ({
          user: { id: actorId, username: "alice", provider: "ipa", profile: "user", posix: unix },
          availability: { localLinuxEnabled: true, freeipaEnabled: true },
        }),
        groups: async () => ({
          items: member
            ? [
                { id: groupId, provider: "ipa", name: "team", gidNumber: unix.primaryGidNumber, personal: false },
                { id: cloudGroupId, provider: "local", name: "local", gidNumber: unix.primaryGidNumber, personal: false },
              ]
            : [],
          nextCursor: null,
        }),
        inventory: async () => {
          throw new FilesError("forbidden", 403);
        },
      },
      bindings,
      readConfiguration: async () => config,
      writeConfiguration: async () => {},
      resetConfiguration: async () => {},
      displayNames: async (items) => items.map((item) => ({ ...item, displayName: "Current actor" })),
      publicOrigin: async () => "https://cloud.test",
      userById: async () => null,
      transfer: fetch,
      connect: (config, signal) => connectFilegate(config, transport, signal),
    });
  }, 60_000);
  afterAll(async () => {
    try {
      if (ipa) await ipa.remove(prefix, true);
    } finally {
      try {
        if (cloud) await cloud.remove(prefix, true);
      } finally {
        await target?.stop();
      }
    }
  }, 30_000);
  beforeEach(async () => {
    member = true;
    requests.length = 0;
    await sql`TRUNCATE auth.users,filesv2.bases CASCADE`.simple();
    await sql`INSERT INTO auth.users VALUES (${actorId}::uuid),(${otherId}::uuid)`;
    await sql`INSERT INTO filesv2.bases ${sql([binding, cloudBinding])}`;
  });
  async function seed(row: ActivityCandidate) {
    const { share_expires_at: _expiry, effective_time: _time, observed_before, observed_after, metadataUnknown: _unknown, ...stored } = row;
    await sql`INSERT INTO filesv2.activity ${sql({ ...stored, name: "recorded", detail: JSON.stringify({ observed_before, observed_after }) })}`;
  }
  test("real Unix leaf denial, membership revocation and later observations never grant snapshot access", async () => {
    const file = `${path}/private.txt`;
    const node = await ipa.put(file, new Blob(["private"]), {
      ownership: { uid: unix.uidNumber, gid: unix.primaryGidNumber, mode: "0600" },
    });
    const row = candidate(1, {
      server_url: target.url,
      root: "freeipa",
      base_id: binding.id,
      directory: false,
      path_before: null,
      path_after: file,
      item_after_id: node.id ?? null,
      started_at: at,
      finished_at: at,
      observed_after: { exists: true, id: "later-hidden-id", revision: "later-hidden-revision" },
    });
    await seed(row);
    expect((await service.activity(call)).items).toHaveLength(1);
    await ipa.setOwnership(file, { uid: 23456, gid: 23456, mode: "0600" });
    expect((await service.activity(call, { q: "private.txt" })).items).toEqual([]);
    await expect(service.activityEntry(call, { activityId: row.id })).rejects.toMatchObject({ status: 404 });
    member = false;
    requests.length = 0;
    const managerCall = testCall(
      actor.kind === "user"
        ? {
            ...actor,
            user: { ...actor.user, managesGroupIds: [groupId] },
          }
        : actor,
    );
    expect((await service.activity(managerCall)).items).toEqual([]);
    expect(requests).toEqual([]);
    await sql`UPDATE filesv2.activity SET actor_user_id=${actorId}::uuid WHERE id=${row.id}::uuid`;
    const own = await service.activityEntry(call, { activityId: row.id });
    expect(own.after).toMatchObject({ visibility: "full", source: "snapshot" });
    expect(own.after).not.toHaveProperty("observation");
    expect(JSON.stringify(own)).not.toContain("later-hidden");
    expect(requests).toEqual([]);
  });
  test("real stable-ID chain resolves its endpoint and checks current access again", async () => {
    const old = `${cloudPath}/old.txt`;
    const moved = `${cloudPath}/moved.txt`;
    const node = await cloud.put(old, new Blob(["chain"]));
    expect((await cloud.info()).stableIds).toBe(true);
    const transfer = await cloud.transfer(old, "cloud", moved, { move: true });
    expect(transfer.state).toBe("completed");
    const current = await cloud.stat(moved);
    expect(current.id).toBe(node.id);
    const row = candidate(1, {
      server_url: target.url,
      root: "cloud",
      base_id: cloudBinding.id,
      directory: false,
      path_before: old,
      path_after: moved,
      item_id: node.id ?? null,
      item_after_id: current.id ?? null,
      started_at: at,
      finished_at: at,
    });
    await seed(row);
    requests.length = 0;
    const chain = await service.movementChain(call, { activityId: row.id });
    expect(chain.endpoint).toEqual({ baseId: `cloud:groups:${cloudGroupId}`, path: "moved.txt", itemId: node.id! });
    expect(chain.certainty).toBe("verified");
    expect(chain.hops[0]).toMatchObject({ actor: { userId: otherId, name: "Current actor" }, via: "web" });
    expect(requests.some((url) => url.includes("/resolve"))).toBe(true);
    expect(
      requests.filter((url) => url.includes("/stat") && new URL(url).searchParams.get("path") === moved).length,
    ).toBeGreaterThanOrEqual(3);
    member = false;
    requests.length = 0;
    await expect(service.movementChain(call, { activityId: row.id })).rejects.toMatchObject({ status: 404 });
    expect(requests).toEqual([]);
  });
});
