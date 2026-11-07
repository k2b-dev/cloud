import { expect, test } from "bun:test";
import type { accountIdentities } from "@k2b/cloud/services";
import type { HomeProvisioningResult, HomeProvisioningStatus } from "../contracts";
import type { NewBinding } from "../data/bases";
import type { homeProvisioning } from "../data/home-provisioning";
import type { readConfiguration } from "./configuration";
import { createHomeProvisioning } from "./home-provisioning";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const updatedAt = "2026-01-01T00:00:00.000Z";
type Identity = Awaited<ReturnType<typeof accountIdentities.provisioningUsers>>["items"][number];
function fixture(count = 1, now?: () => number) {
  const area = { enabled: true, root: "cloud", prefix: "", homes: "users", groups: "groups", archive: "archive" };
  const config: Awaited<ReturnType<typeof readConfiguration>> = {
    activityRetentionDays: 365,
    url: "http://filegate.test",
    token: "test",
    tokenConfigured: true,
    unreadable: false,
    cloud: { ...area, autoCreate: true, autoArchive: true },
    freeipa: { ...area, autoCreate: false, enabled: true, root: "freeipa" },
    collabora: { url: "", internalUrl: "", wopiOrigin: "", documentFormat: "odf" },
  };
  const users: Identity[] = Array.from({ length: count }, (_, n) => ({
    id: id(n + 1),
    provider: "local",
    username: `user${n + 1}`,
    posix: { uidNumber: 200001 + n, primaryGidNumber: 200500 + n },
  }));
  const records = new Map<string, HomeProvisioningStatus>();
  const receipts = new Map<string, string>();
  const calls: NewBinding[] = [];
  let creates = 0;
  let after: string | null = null;
  let revision = 0;
  let failDone = false;
  let failUser: string | null = null;
  let linuxEnabled = true;
  let beforeProvision: (() => void) | undefined;
  const reconcile: HomeProvisioningResult["reconcile"] = { running: false, lastRunAt: null, lastResult: null };
  const store: typeof homeProvisioning = {
    get: async (userId) => records.get(userId) ?? null,
    async set(input) {
      if (failDone && input.state === "done") {
        failDone = false;
        throw new Error("crash before status commit");
      }
      const old = records.get(input.userId);
      if (old?.state === "done" && old.area === input.area) return old;
      const value = { ...input, eventId: input.eventId ?? old?.eventId ?? null, updatedAt };
      records.set(input.userId, value);
      return value;
    },
    page: async () => ({ items: [...records.values()], nextCursor: null, counts: { cloud: {}, freeipa: {} }, reconcile }),
    cursor: async () => ({ after_id: after, revision }),
    advance: async (value, expected) => {
      if (expected === revision) after = value;
    },
    request: async () => {
      after = null;
      revision++;
    },
    start: async () => {
      reconcile.running = true;
    },
    renew: async () => {
      reconcile.running = true;
    },
    finish: async (result) => {
      reconcile.running = false;
      reconcile.lastRunAt = updatedAt;
      reconcile.lastResult = result;
    },
  };
  let liveMismatch = false;
  let liveAbsent = false;
  const identities = {
    async provisioningIdentity(input: { name: string; identityId: string }) {
      if (liveAbsent) return { state: "absent" as const };
      const user = users.find((user) => user.id === input.identityId)!;
      return {
        state: "present" as const,
        eligible: true,
        identity: {
          id: user.id,
          name: user.username,
          uidNumber: liveMismatch ? 999999 : user.posix!.uidNumber,
          gidNumber: user.posix!.primaryGidNumber,
        },
      };
    },
    async provisioningUsers(input: { provider?: "local" | "ipa"; id?: string; after?: string }) {
      const remaining = users.filter(
        (user) =>
          (!input.provider || user.provider === input.provider) &&
          (!input.id || user.id === input.id) &&
          (!input.after || user.id > input.after),
      );
      return {
        items: remaining.slice(0, 50),
        nextCursor: remaining.length > 50 ? remaining[49]!.id : null,
        availability: { localLinuxEnabled: linuxEnabled, freeipaEnabled: true },
      };
    },
  };
  const service = createHomeProvisioning({
    identities,
    store,
    readConfiguration: async () => config,
    lock: async (run) => run(),
    now,
    provision: async (_config, base, actorId, actorName) => {
      expect(actorId).toBeNull();
      expect(actorName).toBe("automatic-policy");
      calls.push(base);
      beforeProvision?.();
      if (base.identity_id === failUser) throw new Error("Filegate unavailable");
      let receipt = receipts.get(base.identity_id);
      if (!receipt) {
        creates++;
        receipt = id(999);
        receipts.set(base.identity_id, receipt);
      }
      return { id: receipt, state: "complete", path: base.path };
    },
  });
  return {
    service,
    mismatch: () => {
      liveMismatch = true;
    },
    absent: () => {
      liveAbsent = true;
    },
    identities,
    users,
    records,
    config,
    calls,
    store,
    reconcile,
    get creates() {
      return creates;
    },
    get after() {
      return after;
    },
    crash: () => {
      failDone = true;
    },
    fail: (userId: string) => {
      failUser = userId;
    },
    disableLinux: () => {
      linuxEnabled = false;
    },
    beforeProvision: (run: () => void) => {
      beforeProvision = run;
    },
  };
}

test("new local user gets one home with application authority; delivery replay is done", async () => {
  const f = fixture();
  expect(await f.service.ensure(id(1), { eventId: id(200) })).toMatchObject({ state: "done", eventId: id(200), operationId: id(999) });
  await f.service.ensure(id(1), { eventId: id(201) });
  expect(f.creates).toBe(1);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]).toMatchObject({ path: "users/user1", area: "cloud", kind: "users", uid_number: null, gid_number: null });
});
test("a crash after provisioning resumes the same lifecycle receipt", async () => {
  const f = fixture();
  f.crash();
  await expect(f.service.ensure(id(1), { eventId: id(200) })).rejects.toThrow("crash before status commit");
  expect(f.records.get(id(1))?.state).toBe("failed");
  expect(await f.service.ensure(id(1), { eventId: id(200) })).toMatchObject({ state: "done", operationId: id(999) });
  expect(f.calls).toHaveLength(2);
  expect(f.calls[0]).toEqual(f.calls[1]);
  expect(f.creates).toBe(1);
});
test("auto-create off is visible, delivery completes, and enabling resumes it", async () => {
  const f = fixture();
  f.config.cloud.autoCreate = false;
  expect((await f.service.ensure(id(1))).state).toBe("auto_create_off");
  expect(f.creates).toBe(0);
  f.config.cloud.autoCreate = true;
  await f.service.reconcile();
  expect(f.records.get(id(1))?.state).toBe("done");
});
test("incomplete POSIX stays pending until active identity projection is complete", async () => {
  const f = fixture();
  f.users[0]!.posix = null;
  expect((await f.service.ensure(id(1))).state).toBe("posix_incomplete");
  expect(f.creates).toBe(0);
  f.users[0]!.posix = { uidNumber: 200001, primaryGidNumber: 200009 };
  await f.service.reconcile();
  expect(f.records.get(id(1))?.state).toBe("done");
});
test("disabled or unreadable configuration and disabled Linux do not touch Filegate", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.config.cloud.enabled = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.config.unreadable = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.config.token = "";
    },
    (f: ReturnType<typeof fixture>) => {
      f.disableLinux();
    },
  ]) {
    const f = fixture();
    change(f);
    expect((await f.service.ensure(id(1))).state).toBe("not_configured");
    expect(f.creates).toBe(0);
  }
});
test("deleted, expired, or otherwise inactive identities cannot provision", async () => {
  const f = fixture(0);
  expect((await f.service.ensure(id(1))).state).toBe("inactive");
  expect(f.creates).toBe(0);
});
test("FreeIPA incomplete POSIX precedes its independent off switch and never uses cloud.autoCreate", async () => {
  const f = fixture(3);
  f.users[0]!.provider = "ipa";
  f.users[0]!.posix = null;
  f.users[1]!.provider = "ipa";
  expect(await f.service.reconcile()).toMatchObject({ processed: 3, done: 1, pending: 2 });
  expect(f.records.get(id(1))).toMatchObject({ area: "freeipa", state: "posix_incomplete" });
  expect(f.records.get(id(2))).toMatchObject({ area: "freeipa", state: "auto_create_off" });
  expect(f.calls.map((base) => base.identity_id)).toEqual([id(3)]);
  f.users[0]!.posix = { uidNumber: 100001, primaryGidNumber: 100009 };
  expect((await f.service.ensure(id(1))).state).toBe("auto_create_off");
  expect(f.creates).toBe(1);
});
test("enabling FreeIPA creation reconciles pending homes using their POSIX ownership and configured area", async () => {
  const f = fixture();
  f.users[0]!.provider = "ipa";
  f.config.cloud.autoCreate = false;
  f.config.freeipa.prefix = "company";
  f.config.freeipa.homes = "homes";
  expect(await f.service.ensure(id(1))).toMatchObject({ area: "freeipa", state: "auto_create_off" });
  f.config.freeipa.autoCreate = true;
  await f.service.reconcile();
  expect(f.records.get(id(1))).toMatchObject({ area: "freeipa", state: "done" });
  expect(f.calls).toEqual([
    expect.objectContaining({
      area: "freeipa",
      root: "freeipa",
      path: "company/homes/user1",
      uid_number: 200001,
      gid_number: 200500,
    }),
  ]);
  await f.service.ensure(id(1), { eventId: id(200) });
  expect(f.creates).toBe(1);
  expect(f.calls).toHaveLength(1);
});
test("FreeIPA creation recovers its receipt after a crash before the status commit", async () => {
  const f = fixture();
  f.users[0]!.provider = "ipa";
  f.config.freeipa.autoCreate = true;
  f.crash();
  await expect(f.service.ensure(id(1))).rejects.toThrow("crash before status commit");
  await f.service.reconcile();
  expect(f.records.get(id(1))).toMatchObject({ area: "freeipa", state: "done", operationId: id(999) });
  expect(f.calls).toHaveLength(2);
  expect(f.calls[0]).toEqual(f.calls[1]);
  expect(f.creates).toBe(1);
});
test("FreeIPA creation requires its area and backend even when its switch is enabled", async () => {
  const f = fixture();
  f.users[0]!.provider = "ipa";
  f.config.freeipa.autoCreate = true;
  f.config.freeipa.enabled = false;
  expect(await f.service.ensure(id(1))).toMatchObject({ area: "freeipa", state: "not_configured" });
  expect(f.calls).toHaveLength(0);
});
test("reconciliation processes at most one identity page and resumes from its cursor", async () => {
  const f = fixture(105);
  expect(await f.service.reconcile()).toMatchObject({ processed: 50, done: 50, nextCursor: id(50) });
  expect(f.after).toBe(id(50));
  expect(await f.service.reconcile()).toMatchObject({ processed: 50, done: 50, nextCursor: id(100) });
  expect(await f.service.reconcile()).toMatchObject({ processed: 5, done: 5, nextCursor: null });
  expect(f.creates).toBe(105);
  await f.service.reconcile();
  expect(f.creates).toBe(105);
});
test("the 30-second soft deadline finishes the current operation, persists partial totals, and resumes", async () => {
  let elapsed = 0;
  const f = fixture(3, () => elapsed);
  let heartbeats = 0;
  let renewals = 0;
  f.store.renew = async () => {
    renewals++;
  };
  f.beforeProvision(() => {
    elapsed = 35_000;
  });
  const heartbeat = async () => {
    heartbeats++;
  };
  expect(await f.service.reconcile({ heartbeat })).toEqual({ processed: 1, done: 1, pending: 0, failed: 0, nextCursor: id(1) });
  expect(f.after).toBe(id(1));
  expect(f.reconcile).toEqual({ running: false, lastRunAt: updatedAt, lastResult: { processed: 1, done: 1, pending: 0, failed: 0 } });
  expect(heartbeats).toBe(1);
  expect(renewals).toBe(1);
  f.beforeProvision(() => {});
  expect(await f.service.reconcile({ heartbeat })).toEqual({ processed: 2, done: 2, pending: 0, failed: 0, nextCursor: null });
  expect(f.after).toBeNull();
  expect(f.creates).toBe(3);
  expect(heartbeats).toBe(3);
  expect(renewals).toBe(3);
});
test("a heartbeat reaching the deadline starts no operation and preserves the resume cursor", async () => {
  let elapsed = 0;
  const f = fixture(3, () => elapsed);
  expect(
    await f.service.reconcile({
      heartbeat: async () => {
        elapsed = 30_000;
      },
    }),
  ).toEqual({
    processed: 0,
    done: 0,
    pending: 0,
    failed: 0,
    nextCursor: null,
  });
  expect(f.creates).toBe(0);
  expect(f.after).toBeNull();
  expect(f.reconcile.lastResult).toEqual({ processed: 0, done: 0, pending: 0, failed: 0 });
  expect((await f.service.reconcile()).processed).toBe(3);
});
test("one failed user stays visible without blocking later users", async () => {
  const f = fixture(3);
  f.fail(id(1));
  expect(await f.service.reconcile()).toMatchObject({ processed: 3, done: 2, failed: 1 });
  expect(f.records.get(id(1))).toMatchObject({ state: "failed", errorCode: "provisioning_failed" });
  expect(f.reconcile).toEqual({ running: false, lastRunAt: updatedAt, lastResult: { processed: 3, done: 2, pending: 0, failed: 1 } });
});
test("reconciliation exposes running and records completion, including after cancellation", async () => {
  const f = fixture(3);
  f.beforeProvision(() => {
    expect(f.reconcile.running).toBe(true);
  });
  await f.service.reconcile();
  expect(f.reconcile).toEqual({ running: false, lastRunAt: updatedAt, lastResult: { processed: 3, done: 3, pending: 0, failed: 0 } });
  const controller = new AbortController();
  const g = fixture(3);
  g.beforeProvision(() => controller.abort());
  await expect(g.service.reconcile({ signal: controller.signal })).rejects.toThrow();
  expect(g.reconcile).toEqual({ running: false, lastRunAt: updatedAt, lastResult: { processed: 1, done: 1, pending: 0, failed: 0 } });
});
test("a source page filtered by provider availability still advances to later active users", async () => {
  const f = fixture(55);
  const read = f.identities.provisioningUsers;
  f.identities.provisioningUsers = async (input) =>
    input.id || input.after
      ? read(input)
      : { items: [], nextCursor: id(50), availability: { localLinuxEnabled: true, freeipaEnabled: true } };
  expect(await f.service.reconcile()).toMatchObject({ processed: 0, nextCursor: id(50) });
  expect(f.after).toBe(id(50));
  expect(await f.service.reconcile()).toMatchObject({ processed: 5, done: 5, nextCursor: null });
});
test("cancellation preserves progress and a configuration reset cannot be overwritten by an older page", async () => {
  const f = fixture(3);
  const controller = new AbortController();
  f.beforeProvision(() => controller.abort());
  await expect(f.service.reconcile({ signal: controller.signal })).rejects.toThrow();
  expect(f.after).toBe(id(1));
  const g = fixture(55);
  g.beforeProvision(() => {
    void g.store.request();
  });
  await g.service.reconcile();
  expect(g.after).toBeNull();
});

test("a completed local home does not prevent the same user migrating to a FreeIPA home", async () => {
  const fixtureState = fixture();
  expect(await fixtureState.service.ensure(id(1))).toMatchObject({ area: "cloud", state: "done" });
  fixtureState.users[0]!.provider = "ipa";
  fixtureState.config.freeipa.autoCreate = true;
  expect(await fixtureState.service.ensure(id(1))).toMatchObject({ area: "freeipa", state: "done" });
  expect(fixtureState.calls.map(({ area }) => area)).toEqual(["cloud", "freeipa"]);
});
test("live FreeIPA mismatch or absence is visible and never provisions", async () => {
  for (const change of ["mismatch", "absent"] as const) {
    const fixtureState = fixture();
    fixtureState.users[0]!.provider = "ipa";
    fixtureState.config.freeipa.autoCreate = true;
    fixtureState[change]();
    expect(await fixtureState.service.ensure(id(1))).toMatchObject({ area: "freeipa", state: "posix_incomplete" });
    expect(fixtureState.calls).toHaveLength(0);
  }
});
test("shutdown during a failing provisioning step does not persist a failure", async () => {
  const fixtureState = fixture();
  const controller = new AbortController();
  fixtureState.beforeProvision(() => controller.abort());
  fixtureState.fail(id(1));
  await expect(fixtureState.service.ensure(id(1), { signal: controller.signal })).rejects.toThrow();
  expect(fixtureState.records.has(id(1))).toBe(false);
});
