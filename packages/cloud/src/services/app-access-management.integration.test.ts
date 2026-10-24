import { expect, spyOn, test } from "bun:test";
import { type SQL, sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { type AppAccessDeclaration, appAccess } from "../contracts/app-access";
import * as accessEvents from "../events/app-access";
import type { RequestAuthority } from "../server/middleware/auth";
import { canUseApp } from "./app-access";
import { appAccessGrantCounts, appAccessManagers, canManageAppAccess, changeAppAccess, readAppAccess } from "./app-access-management";
import { audit } from "./audit";
import * as identityRuntimeConfig from "./identity/runtime-config";
import { createApiToken } from "./service-account-credentials";
import { buildProjectedUser } from "./session/user";

const fixture = async () => {
  const id = `access-management-${crypto.randomUUID()}`;
  const users: string[] = [];
  const groups: string[] = [];
  const accounts: string[] = [];
  const kid = crypto.randomUUID();
  await sql`INSERT INTO auth.signing_keys (purpose, state, kid, public_jwk, encrypted_private_jwk, encryption_key_id,
      activate_at, activated_at, sign_until, retired_at, verify_until)
    VALUES ('session', 'retired', ${kid}, '{}'::jsonb, 'test', 'test', now()-INTERVAL '2 days', now()-INTERVAL '2 days',
      now()-INTERVAL '1 day', now()-INTERVAL '1 day', now()+INTERVAL '1 day')`;
  const session = async (userId: string, mobile = false) => {
    let deviceId: string | null = null;
    if (mobile) {
      deviceId = crypto.randomUUID();
      await sql`INSERT INTO auth.pwa_devices (id, user_id, name, platform, auth_epoch, secret_hash, rotated_at)
        VALUES (${deviceId}::uuid, ${userId}::uuid, 'Fictional phone', 'other', 0, 'test', now())`;
    }
    const [row] = await sql<{ sid: string }[]>`
      INSERT INTO auth.session_families (user_id, auth_epoch, signing_kid, expires_at, pwa_device_id)
      VALUES (${userId}::uuid, 0, ${kid}, now()+INTERVAL '1 hour', ${deviceId}::uuid) RETURNING sid`;
    return row!.sid;
  };
  const group = async () => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO auth.groups (cn, provider, name)
      VALUES (${`${id}-${groups.length}`}, 'local', ${`Fictional group ${id}-${groups.length}`}) RETURNING id`;
    groups.push(row!.id);
    return row!.id;
  };
  const service = async (kind: "standalone" | "agent") => {
    const [row] = await sql<
      { id: string }[]
    >`INSERT INTO auth.service_accounts (name, kind) VALUES (${`${id}-${accounts.length}`}, ${kind}) RETURNING id`;
    accounts.push(row!.id);
    return { type: "service_account" as const, serviceAccountId: row!.id };
  };
  const person = async (admin = false): Promise<RequestAuthority> => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${`${id}-${users.length}`}, 'local', 'user', 'Fictional Manager', ${admin}) RETURNING id`;
    users.push(row!.id);
    await session(row!.id);
    return {
      actor: { kind: "user", user: buildProjectedUser({ id: row!.id, provider: "local", profile: "user", effective_admin: admin }) },
      accessSubject: { type: "user", userId: row!.id },
      credentialKind: "session",
      scopes: [],
    };
  };
  const app = { id, name: "Fictional App", access: appAccess.grants() };
  return {
    app,
    person,
    group,
    service,
    session,
    key: async (serviceAccountId: string, scopes: string[]) => {
      const result = await createApiToken({ serviceAccountId, name: "Fictional management key", scopes });
      if (!result.ok) throw new Error(result.error.message);
      return result.data.credential;
    },
    cleanup: async () => {
      const entries = await sql<{ access_id: string }[]>`SELECT access_id FROM auth.app_access WHERE app_id = ${id}`;
      for (const entry of entries) await sql`DELETE FROM auth.access WHERE id = ${entry.access_id}::uuid`;
      await sql`DELETE FROM auth.app_access_state WHERE app_id = ${id}`;
      await sql`DELETE FROM audit.events WHERE target_type = 'app' AND target_id = ${id}`;
      await sql`DELETE FROM events.outbox WHERE app_id = 'core' AND ordering_key = ${`app.access:${id}`}`;
      for (const groupId of groups) await sql`DELETE FROM auth.groups WHERE id = ${groupId}::uuid`;
      for (const accountId of accounts) await sql`DELETE FROM auth.service_accounts WHERE id = ${accountId}::uuid`;
      for (const userId of users) await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
      await sql`DELETE FROM auth.signing_keys WHERE kid = ${kid}`;
    },
  };
};
const principal = (authority: RequestAuthority) => {
  if (authority.accessSubject.type !== "user") throw new Error("Expected person fixture");
  return { type: "user" as const, userId: authority.accessSubject.userId };
};
const onlyAdministrators = (authority: RequestAuthority) => authority.actor.kind === "user" && authority.actor.user.roles.includes("admin");
const persistedCounts = async (appId: string) => {
  const [row] = await sql<{ grants: number; audits: number; outbox: number }[]>`
    SELECT (SELECT count(*)::int FROM auth.app_access WHERE app_id = ${appId}) AS grants,
      (SELECT count(*)::int FROM audit.events WHERE target_type = 'app' AND target_id = ${appId}) AS audits,
      (SELECT count(*)::int FROM events.outbox WHERE app_id = 'core' AND ordering_key = ${`app.access:${appId}`}) AS outbox`;
  return row;
};

databaseSuite()("audited app access management", () => {
  test("SQL-backed restrictions finish more concurrent edits than pool connections, including remaining session proof", async () => {
    const poolSize = sql.options.max ?? 10;
    const count = poolSize + 2;
    const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
    const changes: (() => ReturnType<typeof changeAppAccess>)[] = [];
    const poolFull = Promise.withResolvers<void>();
    const calls: string[][] = [];
    let authorizations = 0;
    const configRead = spyOn(identityRuntimeConfig, "getIdentityRuntimeConfig");
    try {
      for (let index = 0; index < count; index++) {
        const f = await fixture();
        fixtures.push(f);
        const alice = await f.person(true),
          bob = await f.person();
        const first = await changeAppAccess({
          app: f.app,
          authority: alice,
          repair: true,
          change: { action: "grant", principal: principal(alice), permission: "admin" },
        });
        await changeAppAccess({
          app: f.app,
          authority: alice,
          change: { action: "grant", principal: principal(bob), permission: "admin" },
        });
        let transaction: SQL | undefined;
        const seen: string[] = [];
        calls.push(seen);
        const canManage: NonNullable<AppAccessDeclaration["canManage"]> = async (candidate, { db }) => {
          // Fail immediately if the callback is given the pool instead of the reserved connection.
          expect(db).not.toBe(sql);
          if (!transaction) {
            transaction = db;
            authorizations++;
            if (authorizations === poolSize) poolFull.resolve();
            // Hold every pooled connection at its first callback before allowing any SQL-backed restriction.
            await poolFull.promise;
            expect(candidate).toBe(alice); // Preserve the exact resolved request authority.
            expect(configRead.mock.calls).toHaveLength(count);
            // Candidate proof must not consult global settings again, even when the cache is cold.
            identityRuntimeConfig.invalidateIdentityRuntimeConfig();
          } else expect(db).toBe(transaction);
          const candidateId = principal(candidate).userId;
          seen.push(candidateId);
          const [row] = await db<{ allowed: boolean }[]>`
            SELECT EXISTS (
              SELECT 1 FROM auth.app_access j JOIN auth.access a ON a.id = j.access_id
              WHERE j.app_id = ${f.app.id} AND a.user_id = ${candidateId}::uuid AND a.permission = 'admin'
            ) AS allowed`;
          return row?.allowed === true;
        };
        changes.push(() =>
          changeAppAccess({ app: f.app, authority: alice, canManage, change: { action: "revoke", accessId: first.entry!.id } }),
        );
      }
      identityRuntimeConfig.invalidateIdentityRuntimeConfig();
      // Drain failed mutations as well; an early failure must release callers waiting at the barrier.
      const results = await Promise.allSettled(changes.map((change) => change().finally(() => poolFull.resolve())));
      expect(results.map((result) => result.status)).toEqual(fixtures.map(() => "fulfilled"));
      expect(results.map((result) => result.status === "fulfilled" && result.value.canUse)).toEqual(fixtures.map(() => false));
      expect(calls.map((seen) => seen.length)).toEqual(fixtures.map(() => 2));
      expect(configRead.mock.calls).toHaveLength(count);
      for (const f of fixtures) expect(await persistedCounts(f.app.id)).toMatchObject({ grants: 1, audits: 3, outbox: 6 });
    } finally {
      poolFull.resolve();
      configRead.mockRestore();
      identityRuntimeConfig.invalidateIdentityRuntimeConfig();
      for (const f of fixtures) await f.cleanup();
    }
  }, 30_000);

  test("read and visibility callbacks receive the global query context and the original authority", async () => {
    const f = await fixture();
    try {
      const alice = await f.person(true);
      await changeAppAccess({
        app: f.app,
        authority: alice,
        repair: true,
        change: { action: "grant", principal: principal(alice), permission: "admin" },
      });
      let checks = 0;
      const canManage: NonNullable<AppAccessDeclaration["canManage"]> = async (candidate, { db }) => {
        expect(candidate).toBe(alice);
        expect(db).toBe(sql);
        const [row] = await db<{ exists: boolean }[]>`SELECT EXISTS (
          SELECT 1 FROM auth.users WHERE id = ${principal(candidate).userId}::uuid
        ) AS exists`;
        checks++;
        return row?.exists === true;
      };
      expect(await canManageAppAccess(alice, f.app, canManage)).toBe(true);
      expect((await readAppAccess({ app: f.app, authority: alice, canManage })).hasEffectiveManager).toBe(true);
      expect(checks).toBe(3); // Visibility, list authorization and proof of the current request's remaining grant.
      const bob = await f.person();
      let transaction: SQL | undefined;
      const grantCounts: number[] = [];
      await changeAppAccess({
        app: f.app,
        authority: alice,
        change: { action: "grant", principal: principal(bob), permission: "read" },
        canManage: async (candidate, { db }) => {
          expect(candidate).toBe(alice);
          expect(db).not.toBe(sql);
          if (!transaction) transaction = db;
          else expect(db).toBe(transaction);
          const [row] = await db<{ count: number }[]>`SELECT count(*)::int AS count FROM auth.app_access WHERE app_id = ${f.app.id}`;
          grantCounts.push(row!.count);
          return true;
        },
      });
      expect(grantCounts).toEqual([1, 2]); // The current-request proof sees the same transaction's uncommitted grant.
    } finally {
      await f.cleanup();
    }
  });

  test("Alice cannot remove or downgrade the last manager eligible under the app restriction", async () => {
    const f = await fixture();
    try {
      const alice = await f.person(true),
        bob = await f.person();
      const first = await changeAppAccess({
        app: f.app,
        authority: alice,
        repair: true,
        canManage: () => {
          throw new Error("Core cannot evaluate the app callback");
        },
        change: { action: "grant", principal: principal(alice), permission: "admin" },
      });
      await changeAppAccess({
        app: f.app,
        authority: alice,
        canManage: onlyAdministrators,
        change: { action: "grant", principal: principal(bob), permission: "admin" },
      });
      expect(await canManageAppAccess(alice, f.app, onlyAdministrators)).toBe(true);
      expect(await canManageAppAccess(bob, f.app, onlyAdministrators)).toBe(false);
      const before = await persistedCounts(f.app.id);
      for (const change of [
        { action: "revoke", accessId: first.entry!.id },
        { action: "update", accessId: first.entry!.id, permission: "read" },
      ] as const) {
        await expect(changeAppAccess({ app: f.app, authority: alice, canManage: onlyAdministrators, change })).rejects.toMatchObject({
          code: "LAST_MANAGER",
          status: 409,
        });
        expect(await persistedCounts(f.app.id)).toEqual(before);
        expect((await readAppAccess({ app: f.app, authority: alice, canManage: onlyAdministrators })).hasEffectiveManager).toBe(true);
      }
      // Repair can restore eligible grants even while the application's restriction is unavailable.
      const restored = await f.person(true);
      await changeAppAccess({
        app: f.app,
        authority: alice,
        repair: true,
        canManage: () => {
          throw new Error("External app unavailable");
        },
        change: { action: "grant", principal: principal(restored), permission: "admin" },
      });
      await changeAppAccess({
        app: f.app,
        authority: alice,
        canManage: onlyAdministrators,
        change: { action: "revoke", accessId: first.entry!.id },
      });
      expect(await canManageAppAccess(restored, f.app, onlyAdministrators)).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  test("nested group candidates use current canonical roles and retain mobile-session caps", async () => {
    const f = await fixture();
    try {
      const alice = await f.person(true),
        bob = await f.person();
      const child = await f.group(),
        parent = await f.group();
      await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${principal(bob).userId}::uuid, ${child}::uuid)`;
      await sql`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id) VALUES (${parent}::uuid, ${child}::uuid)`;
      const first = await changeAppAccess({
        app: f.app,
        authority: alice,
        repair: true,
        change: { action: "grant", principal: principal(alice), permission: "admin" },
      });
      await changeAppAccess({
        app: f.app,
        authority: alice,
        canManage: onlyAdministrators,
        change: { action: "grant", principal: { type: "group", groupId: parent }, permission: "admin" },
      });
      const removeAlice = () =>
        changeAppAccess({
          app: f.app,
          authority: alice,
          canManage: onlyAdministrators,
          change: { action: "revoke", accessId: first.entry!.id },
        });
      await expect(removeAlice()).rejects.toMatchObject({ code: "LAST_MANAGER" });
      await sql`UPDATE auth.users SET admin = true WHERE id = ${principal(bob).userId}::uuid`;
      await sql`UPDATE auth.session_families SET revoked_at = now() WHERE user_id = ${principal(bob).userId}::uuid`;
      await f.session(principal(bob).userId, true);
      // A mobile session must not recover Bob's administrator role from his DB identity.
      await expect(removeAlice()).rejects.toMatchObject({ code: "LAST_MANAGER" });
      await f.session(principal(bob).userId);
      await removeAlice();
      expect(await persistedCounts(f.app.id)).toMatchObject({ grants: 1, audits: 3, outbox: 6 });
    } finally {
      await f.cleanup();
    }
  });

  for (const kind of ["standalone", "agent"] as const) {
    test(`${kind} candidates require a callback-approved active credential with real write scopes`, async () => {
      const f = await fixture();
      try {
        const alice = await f.person(true);
        const candidate = await f.service(kind);
        const first = await changeAppAccess({
          app: f.app,
          authority: alice,
          repair: true,
          change: { action: "grant", principal: principal(alice), permission: "admin" },
        });
        await changeAppAccess({
          app: f.app,
          authority: alice,
          canManage: onlyAdministrators,
          change: { action: "grant", principal: candidate, permission: "admin" },
        });
        const seen: RequestAuthority[] = [];
        const restriction: NonNullable<AppAccessDeclaration["canManage"]> = async (authority, { db }) => {
          expect(db).not.toBe(sql);
          await db`SELECT 1`;
          if (authority.actor.kind === "user") return onlyAdministrators(authority);
          seen.push(authority);
          return (
            authority.actor.serviceAccount.name.startsWith("access-management-") &&
            authority.actor.serviceAccount.kind === kind &&
            authority.actor.credentialId !== null
          );
        };
        const removeAlice = () =>
          changeAppAccess({
            app: f.app,
            authority: alice,
            canManage: restriction,
            change: { action: "revoke", accessId: first.entry!.id },
          });
        await expect(removeAlice()).rejects.toMatchObject({ code: "LAST_MANAGER" });
        for (const scopes of [[], ["read"], ["other:write"]]) await f.key(candidate.serviceAccountId, scopes);
        const models = await f.key(candidate.serviceAccountId, ["write"]);
        await sql`UPDATE auth.service_account_credentials SET scopes = ARRAY['write','ai:inference'] WHERE id = ${models.id}::uuid`;
        const allowed = await f.key(candidate.serviceAccountId, [`${f.app.id}:write`]);
        await sql`UPDATE auth.service_account_credentials SET status = 'revoked', revoked_at = now() WHERE id = ${allowed.id}::uuid`;
        await expect(removeAlice()).rejects.toMatchObject({ code: "LAST_MANAGER" });
        await sql`UPDATE auth.service_account_credentials SET status = 'active', revoked_at = NULL, expires_at = now()-INTERVAL '1 second'
          WHERE id = ${allowed.id}::uuid`;
        await expect(removeAlice()).rejects.toMatchObject({ code: "LAST_MANAGER" });
        await sql`UPDATE auth.service_account_credentials SET expires_at = now()+INTERVAL '1 hour' WHERE id = ${allowed.id}::uuid`;
        await sql`UPDATE auth.service_accounts SET status = 'disabled' WHERE id = ${candidate.serviceAccountId}::uuid`;
        await expect(removeAlice()).rejects.toMatchObject({ code: "LAST_MANAGER" });
        expect(seen).toEqual([]); // Cap-ineligible credentials never reach the callback.
        await sql`UPDATE auth.service_accounts SET status = 'active' WHERE id = ${candidate.serviceAccountId}::uuid`;
        await expect(
          changeAppAccess({
            app: f.app,
            authority: alice,
            canManage: onlyAdministrators,
            change: { action: "revoke", accessId: first.entry!.id },
          }),
        ).rejects.toMatchObject({ code: "LAST_MANAGER" });
        await removeAlice();
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({
          credentialKind: "api_key",
          scopes: allowed.scopes,
          actor: {
            delegatedUser: null,
            scopes: allowed.scopes,
            credentialId: allowed.id,
            serviceAccount: { id: candidate.serviceAccountId, kind, status: "active" },
          },
          accessSubject: candidate,
        });
        expect(seen[0]?.actor.kind === "service_account" && seen[0].actor.credentialExpiresAt).toBeTruthy();
      } finally {
        await f.cleanup();
      }
    });
  }

  test("callback failures roll back mutations and candidate evaluation has a one-page budget", async () => {
    const f = await fixture();
    try {
      const alice = await f.person(true),
        bob = await f.person();
      const first = await changeAppAccess({
        app: f.app,
        authority: alice,
        repair: true,
        change: { action: "grant", principal: principal(alice), permission: "admin" },
      });
      await changeAppAccess({ app: f.app, authority: alice, change: { action: "grant", principal: principal(bob), permission: "admin" } });
      const change = { action: "revoke" as const, accessId: first.entry!.id };
      const before = await persistedCounts(f.app.id);
      await expect(
        changeAppAccess({
          app: f.app,
          authority: alice,
          change,
          canManage: (authority) => {
            if (onlyAdministrators(authority)) return true;
            throw new Error("Fictional callback unavailable");
          },
        }),
      ).rejects.toThrow("Fictional callback unavailable");
      expect(await persistedCounts(f.app.id)).toEqual(before);
      // More sessions than the existing maximum public identity page may not create an unbounded loop.
      await sql`INSERT INTO auth.session_families (user_id, auth_epoch, signing_kid, expires_at)
        SELECT sf.user_id, sf.auth_epoch, sf.signing_kid, sf.expires_at FROM auth.session_families sf,
          generate_series(1, 100) WHERE sf.user_id = ${principal(bob).userId}::uuid`;
      let checks = 0;
      await expect(
        changeAppAccess({
          app: f.app,
          authority: alice,
          change,
          canManage: (authority) => {
            checks++;
            return onlyAdministrators(authority);
          },
        }),
      ).rejects.toMatchObject({ code: "LAST_MANAGER" });
      expect(checks).toBe(101); // The real request, then at most 100 remaining credential candidates.
      expect(await persistedCounts(f.app.id)).toEqual(before);
    } finally {
      await f.cleanup();
    }
  });

  test("request-only eligibility uses the real capped caller but never invents other OAuth authority", async () => {
    const f = await fixture();
    try {
      const alice = await f.person(true),
        bob = await f.person();
      const first = await changeAppAccess({
        app: f.app,
        authority: alice,
        repair: true,
        change: { action: "grant", principal: principal(alice), permission: "admin" },
      });
      const authority: RequestAuthority = { ...alice, credentialKind: "oauth", scopes: [`${f.app.id}:write`] };
      const canManage = (candidate: RequestAuthority) => candidate.credentialKind === "oauth";
      expect((await readAppAccess({ app: f.app, authority, canManage })).hasEffectiveManager).toBe(true);
      await changeAppAccess({
        app: f.app,
        authority,
        canManage,
        change: { action: "grant", principal: principal(bob), permission: "admin" },
      });
      const before = await persistedCounts(f.app.id);
      await expect(
        changeAppAccess({ app: f.app, authority, canManage, change: { action: "revoke", accessId: first.entry!.id } }),
      ).rejects.toMatchObject({ code: "LAST_MANAGER" });
      expect(await persistedCounts(f.app.id)).toEqual(before);
      expect(
        (
          await readAppAccess({
            app: f.app,
            authority: alice,
            repair: true,
            canManage: () => {
              throw new Error("Core does not own this callback");
            },
          })
        ).hasEffectiveManager,
      ).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  test("repair bootstraps a manager without granting the administrator use; changes and audit commit together", async () => {
    const f = await fixture();
    try {
      const administrator = await f.person(true),
        manager = await f.person();
      expect(await canUseApp(administrator, f.app)).toBe(false);
      const first = await changeAppAccess({
        app: f.app,
        authority: administrator,
        repair: true,
        change: { action: "grant", principal: principal(manager), permission: "admin" },
      });
      expect(first.canUse).toBe(false);
      expect((await appAccessGrantCounts(administrator, [f.app])).get(f.app.id)).toBe(1);
      expect(await canUseApp(manager, f.app)).toBe(true);
      expect(await readAppAccess({ app: f.app, authority: manager })).toMatchObject({ configured: true, canUse: true });
      const [audit] = await sql<
        { action: string; metadata: { via: string } }[]
      >`SELECT action, metadata FROM audit.events WHERE target_type = 'app' AND target_id = ${f.app.id}`;
      expect(audit).toMatchObject({ action: "app.access.granted", metadata: { via: "platform-admin" } });
      await expect(
        changeAppAccess({ app: f.app, authority: manager, change: { action: "revoke", accessId: first.entry!.id } }),
      ).rejects.toMatchObject({ code: "LAST_MANAGER" });
      const [count] = await sql<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM audit.events WHERE target_type = 'app' AND target_id = ${f.app.id}`;
      expect(count?.count).toBe(1);
      const [outbox] = await sql<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM events.outbox WHERE app_id = 'core' AND ordering_key = ${`app.access:${f.app.id}`}`;
      expect(outbox?.count).toBe(2);
      expect(await canUseApp(manager, f.app)).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  test("serialized concurrent self-removals leave an effective manager", async () => {
    const f = await fixture();
    try {
      const administrator = await f.person(true),
        one = await f.person(),
        two = await f.person();
      const a = await changeAppAccess({
        app: f.app,
        authority: administrator,
        repair: true,
        change: { action: "grant", principal: principal(one), permission: "admin" },
      });
      const b = await changeAppAccess({
        app: f.app,
        authority: one,
        change: { action: "grant", principal: principal(two), permission: "admin" },
      });
      const results = await Promise.allSettled([
        changeAppAccess({ app: f.app, authority: one, change: { action: "revoke", accessId: a.entry!.id } }),
        changeAppAccess({ app: f.app, authority: two, change: { action: "revoke", accessId: b.entry!.id } }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected?.status === "rejected" && rejected.reason.code).toBe("LAST_MANAGER");
      expect(Number(await canUseApp(one, f.app)) + Number(await canUseApp(two, f.app))).toBe(1);
    } finally {
      await f.cleanup();
    }
  });

  test("first save preserves the signed-in predecessor and restrictions run in the owning app", async () => {
    const f = await fixture();
    try {
      const administrator = await f.person(true),
        manager = await f.person(),
        visitor = await f.person();
      const app = { ...f.app, access: appAccess.grants({ until: appAccess.signedIn() }) };
      expect(await canUseApp(visitor, app)).toBe(true);
      const initial = await readAppAccess({ app, authority: administrator, repair: true });
      expect(initial).toMatchObject({ configured: false, inheritedSignedIn: true });
      expect((await appAccessGrantCounts(administrator, [app])).get(app.id)).toBe(initial.entries.length);
      expect(initial.entries[0]).toMatchObject({ id: "inherited-authenticated", principal: { type: "authenticated" }, permission: "read" });
      await changeAppAccess({
        app,
        authority: administrator,
        repair: true,
        change: { action: "grant", principal: principal(manager), permission: "admin" },
      });
      expect(await canUseApp(visitor, app)).toBe(true);
      await expect(readAppAccess({ app, authority: manager, canManage: () => false })).rejects.toMatchObject({ code: "FORBIDDEN" });
      const list = await readAppAccess({ app, authority: manager, canManage: () => true });
      expect((await appAccessGrantCounts(administrator, [app])).get(app.id)).toBe(list.entries.length);
      const audience = list.entries.find((entry) => entry.principal.type === "authenticated")!;
      await changeAppAccess({ app, authority: manager, change: { action: "revoke", accessId: audience.id } });
      expect(await canUseApp(visitor, app)).toBe(false);
      await expect(readAppAccess({ app, authority: { ...manager, credentialKind: "oauth", scopes: ["read"] } })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    } finally {
      await f.cleanup();
    }
  });

  test("a configured app with no remaining grants does not regain the inherited audience in its count", async () => {
    const f = await fixture();
    try {
      const administrator = await f.person(true);
      const app = { ...f.app, access: appAccess.grants({ until: appAccess.signedIn() }) };
      expect((await appAccessGrantCounts(administrator, [app])).get(app.id)).toBe(1);
      // Account deletion can leave a configured app without grants; repair must show the actual empty list.
      await sql`INSERT INTO auth.app_access_state (app_id, configured_at) VALUES (${app.id}, now())`;
      expect((await appAccessGrantCounts(administrator, [app])).get(app.id)).toBe(0);
      expect((await readAppAccess({ app, authority: administrator, repair: true })).entries).toHaveLength(0);
    } finally {
      await f.cleanup();
    }
  });

  test("an empty group cannot be the final manager and failed first saves do not end the transition", async () => {
    const f = await fixture();
    let groupId: string | undefined;
    try {
      const administrator = await f.person(true);
      const [group] = await sql<
        { id: string }[]
      >`INSERT INTO auth.groups (cn, provider, name) VALUES (${f.app.id}, 'local', 'Empty group') RETURNING id`;
      groupId = group!.id;
      const app = { ...f.app, access: appAccess.grants({ until: appAccess.signedIn() }) };
      await expect(
        changeAppAccess({
          app,
          authority: administrator,
          repair: true,
          change: { action: "grant", principal: { type: "group", groupId }, permission: "admin" },
        }),
      ).rejects.toMatchObject({ code: "LAST_MANAGER" });
      expect(await readAppAccess({ app, authority: administrator, repair: true })).toMatchObject({
        configured: false,
        inheritedSignedIn: true,
      });
      const [count] = await sql<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM audit.events WHERE target_type = 'app' AND target_id = ${app.id}`;
      expect(count?.count).toBe(0);
    } finally {
      await f.cleanup();
      if (groupId) await sql`DELETE FROM auth.groups WHERE id = ${groupId}::uuid`;
    }
  });

  test("a management grant and the app restriction are both required, without automatic administrator repair", async () => {
    const f = await fixture();
    try {
      const administrator = await f.person(true),
        manager = await f.person(),
        visitor = await f.person();
      await changeAppAccess({
        app: f.app,
        authority: administrator,
        repair: true,
        change: { action: "grant", principal: principal(manager), permission: "admin" },
      });
      for (const authority of [administrator, visitor]) {
        await expect(readAppAccess({ app: f.app, authority, canManage: () => true })).rejects.toMatchObject({ code: "FORBIDDEN" });
      }
      await expect(
        changeAppAccess({
          app: f.app,
          authority: manager,
          canManage: () => false,
          change: { action: "grant", principal: principal(visitor), permission: "read" },
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      for (const scopes of [["read"], ["other:write"], ["write", "ai:inference"]]) {
        await expect(
          changeAppAccess({
            app: f.app,
            authority: { ...manager, credentialKind: "oauth", scopes },
            change: { action: "grant", principal: principal(visitor), permission: "read" },
          }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
      }
      await changeAppAccess({
        app: f.app,
        authority: { ...manager, credentialKind: "oauth", scopes: [`${f.app.id}:write`] },
        canManage: () => true,
        change: { action: "grant", principal: principal(visitor), permission: "read" },
      });
      await expect(readAppAccess({ app: f.app, authority: visitor, canManage: () => true })).rejects.toMatchObject({ code: "FORBIDDEN" });
      for (const change of [
        { action: "grant" as const, principal: { type: "public" as const }, permission: "read" as const },
        { action: "grant" as const, principal: { type: "authenticated" as const }, permission: "admin" as const },
      ])
        await expect(changeAppAccess({ app: f.app, authority: manager, change })).rejects.toMatchObject({ code: "BAD_INPUT" });
    } finally {
      await f.cleanup();
    }
  });

  test("the last manager counts recursive group membership and excludes expired people", async () => {
    const f = await fixture();
    try {
      const administrator = await f.person(true),
        manager = await f.person(),
        member = await f.person();
      const owner = await changeAppAccess({
        app: f.app,
        authority: administrator,
        repair: true,
        change: { action: "grant", principal: principal(manager), permission: "admin" },
      });
      const parent = await f.group(),
        child = await f.group();
      await sql`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id) VALUES (${parent}::uuid, ${child}::uuid)`;
      await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${principal(member).userId}::uuid, ${child}::uuid)`;
      const group = await changeAppAccess({
        app: f.app,
        authority: manager,
        change: { action: "grant", principal: { type: "group", groupId: parent }, permission: "admin" },
      });
      expect(
        (await readAppAccess({ app: f.app, authority: manager })).entries.find((entry) => entry.id === group.entry!.id)?.groupMemberCount,
      ).toBe(1);
      // The same person reached directly and recursively counts once in the displayed group size.
      await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${principal(member).userId}::uuid, ${parent}::uuid)`;
      const beforeExpiry = await readAppAccess({ app: f.app, authority: manager });
      expect(beforeExpiry.entries.find((entry) => entry.id === group.entry!.id)?.groupMemberCount).toBe(1);
      expect(beforeExpiry.entries.find((entry) => entry.id === group.entry!.id)?.effectiveManager).toBe(true);
      expect((await appAccessManagers(f.app.id)).map((entry) => entry.id)).toContain(group.entry!.id);
      await sql`UPDATE auth.users SET account_expires = now() - interval '1 day' WHERE id = ${principal(member).userId}::uuid`;
      const afterExpiry = await readAppAccess({ app: f.app, authority: manager });
      expect(afterExpiry.entries.find((entry) => entry.id === group.entry!.id)?.groupMemberCount).toBe(1);
      expect(afterExpiry.entries.find((entry) => entry.id === group.entry!.id)?.effectiveManager).toBe(false);
      expect((await appAccessManagers(f.app.id)).map((entry) => entry.id)).not.toContain(group.entry!.id);
      await expect(
        changeAppAccess({ app: f.app, authority: manager, change: { action: "revoke", accessId: owner.entry!.id } }),
      ).rejects.toMatchObject({ code: "LAST_MANAGER" });
      await sql`UPDATE auth.users SET account_expires = NULL WHERE id = ${principal(member).userId}::uuid`;
      await changeAppAccess({ app: f.app, authority: manager, change: { action: "revoke", accessId: owner.entry!.id } });
      expect((await readAppAccess({ app: f.app, authority: member })).entries).toHaveLength(1);
      await expect(
        changeAppAccess({ app: f.app, authority: member, change: { action: "update", accessId: group.entry!.id, permission: "read" } }),
      ).rejects.toMatchObject({ code: "LAST_MANAGER" });
    } finally {
      await f.cleanup();
    }
  });

  test("active standalone and agent accounts can remain managers; disabled ones cannot", async () => {
    for (const kind of ["standalone", "agent"] as const) {
      const f = await fixture();
      try {
        const administrator = await f.person(true),
          manager = await f.person();
        const owner = await changeAppAccess({
          app: f.app,
          authority: administrator,
          repair: true,
          change: { action: "grant", principal: principal(manager), permission: "admin" },
        });
        const service = await f.service(kind);
        await changeAppAccess({ app: f.app, authority: manager, change: { action: "grant", principal: service, permission: "admin" } });
        await sql`UPDATE auth.service_accounts SET status = 'disabled' WHERE id = ${service.serviceAccountId}::uuid`;
        expect((await appAccessManagers(f.app.id)).some((entry) => entry.principal.type === "service_account")).toBe(false);
        expect(
          (await readAppAccess({ app: f.app, authority: manager })).entries.find((entry) => entry.principal.type === "service_account")
            ?.effectiveManager,
        ).toBe(false);
        await expect(
          changeAppAccess({ app: f.app, authority: manager, change: { action: "revoke", accessId: owner.entry!.id } }),
        ).rejects.toMatchObject({ code: "LAST_MANAGER" });
        await sql`UPDATE auth.service_accounts SET status = 'active' WHERE id = ${service.serviceAccountId}::uuid`;
        await changeAppAccess({ app: f.app, authority: manager, change: { action: "revoke", accessId: owner.entry!.id } });
        expect(await canUseApp(manager, f.app)).toBe(false);
      } finally {
        await f.cleanup();
      }
    }
  });

  test("audit or outbox failures roll back grants, the transition marker and every side effect", async () => {
    for (const boundary of ["audit", "outbox"] as const) {
      const f = await fixture();
      try {
        const administrator = await f.person(true),
          manager = await f.person();
        const app = { ...f.app, access: appAccess.grants({ until: appAccess.signedIn() }) };
        const fail = async (): Promise<never> => {
          throw new Error("Fictional storage failure");
        };
        const failure =
          boundary === "audit"
            ? spyOn(audit, "record").mockImplementation(fail)
            : spyOn(accessEvents, "publishAppAccessChanged").mockImplementation(fail);
        try {
          await expect(
            changeAppAccess({
              app,
              authority: administrator,
              repair: true,
              change: { action: "grant", principal: principal(manager), permission: "admin" },
            }),
          ).rejects.toThrow("Fictional storage failure");
        } finally {
          failure.mockRestore();
        }
        const snapshot = await readAppAccess({ app, authority: administrator, repair: true });
        expect(snapshot).toMatchObject({ configured: false, inheritedSignedIn: true });
        expect(snapshot.entries).toHaveLength(1);
        expect(snapshot.entries[0]?.id).toBe("inherited-authenticated");
        const [counts] = await sql<{ grants: number; audits: number; outbox: number }[]>`
          SELECT (SELECT count(*)::int FROM auth.app_access WHERE app_id = ${app.id}) AS grants,
            (SELECT count(*)::int FROM audit.events WHERE target_type = 'app' AND target_id = ${app.id}) AS audits,
            (SELECT count(*)::int FROM events.outbox WHERE app_id = 'core' AND ordering_key = ${`app.access:${app.id}`}) AS outbox`;
        expect(counts).toEqual({ grants: 0, audits: 0, outbox: 0 });
      } finally {
        await f.cleanup();
      }
    }
  });

  test("a role predecessor stays exact until save and never seeds the signed-in audience", async () => {
    const f = await fixture();
    try {
      const administrator = await f.person(true),
        manager = await f.person();
      const app = { ...f.app, access: appAccess.grants({ until: appAccess.roles(["admin"]) }) };
      expect(await canUseApp(administrator, app)).toBe(true);
      expect(await canUseApp(manager, app)).toBe(false);
      expect((await readAppAccess({ app, authority: administrator, repair: true })).entries).toHaveLength(0);
      await changeAppAccess({
        app,
        authority: administrator,
        repair: true,
        change: { action: "grant", principal: principal(manager), permission: "admin" },
      });
      expect(await canUseApp(administrator, app)).toBe(false);
      expect(await canUseApp(manager, app)).toBe(true);
      expect((await readAppAccess({ app, authority: manager })).entries).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  });

  test("duplicates, unknown entries and invalid audience managers cannot bypass the list boundary", async () => {
    const f = await fixture();
    try {
      const administrator = await f.person(true),
        manager = await f.person(),
        visitor = await f.person();
      await changeAppAccess({
        app: f.app,
        authority: administrator,
        repair: true,
        change: { action: "grant", principal: principal(manager), permission: "admin" },
      });
      // Object property order must not create a second grant for the same person.
      await expect(
        changeAppAccess({
          app: f.app,
          authority: manager,
          change: { action: "grant", principal: { userId: principal(manager).userId, type: "user" }, permission: "read" },
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(
        changeAppAccess({ app: f.app, authority: manager, change: { action: "revoke", accessId: "ffffffff-ffff-4fff-8fff-ffffffffffff" } }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      for (const authenticated of [false, true]) {
        const [row] = await sql<
          { id: string }[]
        >`INSERT INTO auth.access (authenticated_only, permission) VALUES (${authenticated}, 'admin') RETURNING id`;
        await sql`INSERT INTO auth.app_access (app_id, access_id) VALUES (${f.app.id}, ${row!.id}::uuid)`;
      }
      await expect(readAppAccess({ app: f.app, authority: visitor, canManage: () => true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      await f.cleanup();
    }
  });
});
