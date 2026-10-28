import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { sql } from "bun";
import { suiteFor, useFreshDatabase } from "../../../../../scripts/fixtures/test-infra";
import { runCoreSetup } from "../../../../core/src/runtime-helpers";
import { freeipa } from "../../server/services";
import { createAccess, getEffectivePermission, updateAccess } from "../../server/services/access";
import { accountLifecycle } from "../account-lifecycle";
import { syncFromIpa, syncUser } from "../ipa/sync";
import { providers } from "../providers";
import { loadCurrentUser } from "../session/user";
import { invalidateSettingsCache, set } from "../settings";
import { accountsAppService } from "./app";
import * as localGroups from "./local-groups";
import { createPosixService } from "./posix";

const config = { enabled: true, rangeStart: 200000, rangeEnd: 299999, homeTemplate: "/home/{username}", loginShell: "/bin/bash" };
const ipaConfig = {
  "freeipa.enable": true,
  "freeipa.url": "ipa.example.test",
  "freeipa.service_user": "example",
  "freeipa.service_password": "fictional",
  "freeipa.groups.base_sync": ["cloud"],
  "freeipa.groups.base_ipa_realm": ["people"],
  "freeipa.account_transition_policy": "delete",
  "freeipa.sync_guard.max_user_change_percent": 100,
};

suiteFor("database", "valkey")("personal group retirement", () => {
  let disposable: Awaited<ReturnType<typeof useFreshDatabase>>;
  let admin: string;
  let other: string;
  let sequence = 0;
  const person = async (admin = false) => {
    const [row] = await sql<{ id: string; uid: string }[]>`INSERT INTO auth.users(uid,provider,profile,display_name,admin)
      VALUES(${`retirement_${++sequence}`},'local','user','Example person',${admin}) RETURNING id, uid`;
    return row!;
  };
  const provision = async () => {
    const owner = await person();
    await createPosixService(sql, async () => []).provision({ id: admin, roles: ["admin"] }, owner.id);
    const [row] = await sql<{ primary_group_id: string }[]>`SELECT primary_group_id FROM auth.user_posix WHERE user_id=${owner.id}::uuid`;
    return { ...owner, groupId: row!.primary_group_id };
  };
  const actor = () => ({ userId: admin, uid: "retirement_admin", roles: ["user", "admin"], provider: "local" as const });
  const assertRetired = async (owner: { id: string; groupId: string }) => {
    expect(await sql`SELECT id FROM auth.users WHERE id=${owner.id}::uuid`).toHaveLength(0);
    expect(await sql`SELECT id FROM auth.groups WHERE id=${owner.groupId}::uuid`).toHaveLength(0);
    expect(
      await sql`SELECT * FROM auth.personal_groups WHERE group_id=${owner.groupId}::uuid AND owner_id=${owner.id}::uuid AND retired_at IS NOT NULL`,
    ).toHaveLength(1);
    expect(await sql`SELECT number FROM auth.posix_allocations WHERE kind='gid' AND owner_id=${owner.groupId}::uuid`).toHaveLength(1);
  };
  beforeAll(async () => {
    setSystemTime(new Date("2026-10-26T00:00:00Z"));
    disposable = await useFreshDatabase("personal_retirement");
    await runCoreSetup();
    await set("linux.identity_config", JSON.stringify(config));
    admin = (await person(true)).id;
    other = (await person()).id;
  });
  afterAll(async () => {
    setSystemTime();
    try {
      // The disposable database must not leave its settings in the shared test cache.
      await invalidateSettingsCache(["linux.identity_config", ...Object.keys(ipaConfig)]);
    } finally {
      await sql.close();
      await disposable?.drop();
    }
  });

  test("the authorized deletion reproduction retires memberships, nested/manager relations and old grants", async () => {
    const owner = await provision();
    const grant = await createAccess({ principal: { type: "group", groupId: owner.groupId }, permission: "write" });
    if (!grant.ok) throw new Error(grant.error.message);
    expect((await accountsAppService.group.member.add({ actor: actor(), id: owner.groupId, userId: other })).ok).toBe(true);
    const team = await localGroups.create({ name: "retirement_team" });
    if (!team.ok) throw new Error(team.error);
    expect((await localGroups.addMember({ id: team.data.id, group: owner.groupId })).ok).toBe(true);
    expect((await localGroups.addManager({ id: team.data.id, group: owner.groupId })).ok).toBe(true);
    expect(await getEffectivePermission({ accessIds: [grant.data.id], subject: { type: "user", userId: other } })).toBe("write");
    expect((await accountsAppService.user.remove({ actor: actor(), id: owner.id })).ok).toBe(true);
    await assertRetired(owner);
    expect(
      (await accountsAppService.group.list({ filter: { search: owner.uid, includePersonal: true }, scope: { mode: "all" } })).items,
    ).toEqual([]);
    expect(await localGroups.get({ id: owner.groupId })).toBeNull();
    expect(await getEffectivePermission({ accessIds: [grant.data.id], subject: { type: "user", userId: other } })).toBe("none");
    expect((await createAccess({ principal: { type: "group", groupId: owner.groupId }, permission: "read" })).ok).toBe(false);
    expect((await updateAccess({ id: grant.data.id, permission: "admin" })).ok).toBe(false);
    expect((await localGroups.addMember({ id: owner.groupId, user: other })).ok).toBe(false);
    expect((await localGroups.addMember({ id: team.data.id, group: owner.groupId })).ok).toBe(false);
    expect((await localGroups.addManager({ id: team.data.id, group: owner.groupId })).ok).toBe(false);
    expect(await sql`SELECT * FROM auth.group_groups_v2 WHERE child_group_id=${owner.groupId}::uuid`).toHaveLength(0);
    expect(await sql`SELECT * FROM auth.group_manager_groups_v2 WHERE manager_group_id=${owner.groupId}::uuid`).toHaveLength(0);
    // A new account with the same login receives a fresh reserved GID.
    const [replacement] = await sql<
      { id: string }[]
    >`INSERT INTO auth.users(uid,provider,profile) VALUES(${owner.uid},'local','user') RETURNING id`;
    await createPosixService(sql, async () => []).provision({ id: admin, roles: ["admin"] }, replacement!.id);
    const [oldGroup] = await sql`SELECT gid_number FROM auth.personal_groups WHERE group_id=${owner.groupId}::uuid`;
    const [newGroup] = await sql`SELECT primary_gid_number FROM auth.user_posix WHERE user_id=${replacement!.id}::uuid`;
    expect(newGroup!.primary_gid_number).toBeGreaterThan(oldGroup!.gid_number);
    await sql`DELETE FROM auth.users WHERE id=${replacement!.id}::uuid`;
  });

  test.each(["self", "expired_guest", "expired_user", "ipa_manual", "ipa_expired", "ipa_full_sync", "ipa_login_sync"])(
    "%s deletion retires a personal group even after profile/provider conversion",
    async (path) => {
      const owner = await provision();
      const ipa = path.startsWith("ipa_");
      await sql`UPDATE auth.users SET provider=${ipa ? "ipa" : "local"}, profile=${path === "self" || path === "expired_guest" ? "guest" : "user"},
        account_expires=${path.startsWith("expired") || path === "ipa_expired" ? "2000-01-01T00:00:00Z" : null}::timestamptz WHERE id=${owner.id}::uuid`;
      // The durable link must survive removal of the mutable identity projection.
      await sql`DELETE FROM auth.user_posix WHERE user_id=${owner.id}::uuid`;
      expect((await localGroups.get({ id: owner.groupId }))?.personalOwner?.id).toBe(owner.id);
      expect((await localGroups.remove({ id: owner.groupId })).ok).toBe(false);
      const sessionSpy = spyOn(freeipa.session, "getServiceSession").mockResolvedValue("fictional-session");
      const rpcSpy = spyOn(freeipa.client, "call").mockImplementation(async ({ method }) => ({
        id: 0,
        error: null,
        result: {
          truncated: false,
          result: method === "user_show" ? { uid: [owner.uid], krbprincipalexpiration: ["20000101000000Z"] } : [],
        },
      }));
      try {
        if (ipa) {
          for (const [key, value] of Object.entries(ipaConfig)) await set(key, value);
        }
        if (path === "self") {
          const user = await loadCurrentUser({ userId: owner.id, groupsAdmin: [] });
          if (!user) throw new Error("Missing fixture");
          expect((await accountsAppService.user.removeSelf({ user })).ok).toBe(true);
        } else if (path === "expired_guest") expect((await accountLifecycle.cleanupExpiredGuests()).failed).toBe(0);
        else if (path === "expired_user") expect((await accountLifecycle.cleanupExpiredLocalUsers()).failed).toBe(0);
        else if (path === "ipa_manual")
          expect((await providers.ipa.users.remove({ id: owner.id, actor: actor(), ipaSession: "fictional-session" })).ok).toBe(true);
        else if (path === "ipa_expired") expect((await accountLifecycle.demoteExpiredIpaUsers()).failed).toBe(0);
        else if (path === "ipa_full_sync") await syncFromIpa();
        else expect((await syncUser(owner.uid)).status).toBe("expired");
        await assertRetired(owner);
      } finally {
        sessionSpy.mockRestore();
        rpcSpy.mockRestore();
        await set("freeipa.enable", false);
        await sql`DELETE FROM auth.users WHERE id=${owner.id}::uuid`;
      }
    },
  );

  test("concurrent member and grant inserts wait for retirement and then fail", async () => {
    const owner = await provision();
    const deleted = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const deletion = sql.begin(async (tx) => {
      const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
      await tx`DELETE FROM auth.users WHERE id=${owner.id}::uuid`;
      deleted.resolve(backend!.pid);
      await release.promise;
    });
    const deletingPid = await deleted.promise;
    const attempts = ["member", "grant"].map((kind) => {
      const started = Promise.withResolvers<number>();
      const result = sql
        .begin(async (tx) => {
          const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
          started.resolve(backend!.pid);
          if (kind === "member") await tx`INSERT INTO auth.user_groups_v2 VALUES(${other}::uuid,${owner.groupId}::uuid)`;
          else await tx`INSERT INTO auth.access(group_id,permission) VALUES(${owner.groupId}::uuid,'write')`;
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      return { started: started.promise, result };
    });
    try {
      for (const attempt of attempts) {
        const pid = await attempt.started;
        const deadline = performance.now() + 5000;
        let blocked = false;
        while (performance.now() < deadline) {
          const [row] = await sql`SELECT ${deletingPid}::int = ANY(pg_blocking_pids(${pid}::int)) AS blocked`;
          if (row!.blocked) {
            blocked = true;
            break;
          }
          await Bun.sleep(10);
        }
        expect(blocked).toBe(true);
      }
    } finally {
      release.resolve();
      await deletion;
      const results = await Promise.all(attempts.map((attempt) => attempt.result));
      for (const result of results) expect(result).toMatchObject({ errno: "23503" });
    }
    await assertRetired(owner);
  });

  test("a failed deletion rolls back the account, group, grants and tombstone together", async () => {
    const owner = await provision();
    expect((await localGroups.addMember({ id: owner.groupId, user: other })).ok).toBe(true);
    const grant = await createAccess({ principal: { type: "group", groupId: owner.groupId }, permission: "write" });
    if (!grant.ok) throw new Error(grant.error.message);
    await sql`CREATE TABLE auth.retirement_restrict(group_id UUID REFERENCES auth.groups(id))`.simple();
    try {
      await sql`INSERT INTO auth.retirement_restrict VALUES (${owner.groupId}::uuid)`;
      await expect(providers.local.users.remove({ id: owner.id, actor: actor() })).rejects.toMatchObject({ errno: "23503" });
      expect(await sql`SELECT id FROM auth.users WHERE id=${owner.id}::uuid`).toHaveLength(1);
      expect(await sql`SELECT * FROM auth.user_posix WHERE user_id=${owner.id}::uuid`).toHaveLength(1);
      expect(await getEffectivePermission({ accessIds: [grant.data.id], subject: { type: "user", userId: other } })).toBe("write");
      expect(await sql`SELECT * FROM auth.deleted_accounts WHERE deleted_user_id=${owner.id}::uuid`).toHaveLength(0);
      expect(await sql`SELECT * FROM auth.personal_groups WHERE group_id=${owner.groupId}::uuid AND retired_at IS NULL`).toHaveLength(1);
    } finally {
      await sql`DROP TABLE auth.retirement_restrict`.simple();
      await sql`DELETE FROM auth.users WHERE id=${owner.id}::uuid`;
    }
  });
});
