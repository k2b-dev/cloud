import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import { SQL, sql } from "bun";
import { createLocalJWKSet } from "jose";
import { z } from "zod";
import { bindProcessApplicationId, clearProcessApplicationId } from "../packages/cloud/src/_internal/process-identity";
import * as registry from "../packages/cloud/src/_internal/registry";
import { dispatchCapability } from "../packages/cloud/src/api/capabilities";
import { createWidgetRoutes } from "../packages/cloud/src/api/widgets";
import { migrateCloudCapabilities } from "../packages/cloud/src/capabilities/migrate";
import { compileCapabilityManifest } from "../packages/cloud/src/capabilities/testing";
import { appAccess } from "../packages/cloud/src/contracts/app-access";
import { defineCapabilities } from "../packages/cloud/src/contracts/capabilities";
import type { AppRegistryEntry } from "../packages/cloud/src/contracts/registry";
import type { RequestAuthority } from "../packages/cloud/src/server/middleware/auth";
import { canUseApp, usableAppIds } from "../packages/cloud/src/services/app-access";
import * as identity from "../packages/cloud/src/services/identity";
import { issueInvocationToken, resolveIssuanceAuthority } from "../packages/cloud/src/services/identity/issue-invocation";
import { getIdentityRuntimeConfig, invalidateIdentityRuntimeConfig } from "../packages/cloud/src/services/identity/runtime-config";
import { resumeMandate } from "../packages/cloud/src/services/mandates";
import { buildProjectedUser } from "../packages/cloud/src/services/session/user";
import * as settings from "../packages/cloud/src/services/settings";
import { decryptValue, encryptValue } from "../packages/cloud/src/services/settings/crypto";
import { testInfra, useFreshDatabase } from "../scripts/fixtures/test-infra";

if (!testInfra.database) {
  test.skip("app-access checked issuance on pool max1 (CLOUD_TEST_DATABASE_URL)", () => {});
} else {
  // The runner isolates integration files. Both handles reach a private *_test
  // database. Uncommitted changes below distinguish the reserved connection
  // from the separate global handle, even when that handle has spare capacity.
  const fresh = await useFreshDatabase("app_access_issuance_pool");
  const pool = new SQL(fresh.url, { max: 1, connectionTimeout: 5, idleTimeout: 0 });
  const issuer = "https://app-access-pool.example.test";
  const ownerAppId = "pool-owner";
  const targetAppId = "pool-target";
  const apps: AppRegistryEntry[] = [ownerAppId, targetAppId].map((id) => ({
    id,
    name: id,
    description: "Pool regression fixture",
    icon: "ti ti-test-pipe",
    baseUrl: `http://${id}.test:3000`,
    routes: [`/api/${id}`],
    access: appAccess.grants(),
  }));
  const target = apps[1]!;
  const operation = "capability.query:read";
  const definitions = defineCapabilities({
    protocolVersion: 2,
    types: {},
    queries: {
      read: {
        title: "Read",
        description: "Read one item.",
        input: z.object({ id: z.string().describe("Item identifier.") }).strict(),
        data: z.object({ id: z.string().describe("Item identifier.") }).strict(),
        openWorld: false,
        run: async () => ok({ data: { id: "one" } }),
      },
    },
  });
  const manifest = compileCapabilityManifest(targetAppId, definitions);
  const previousEnvironment = {
    CLOUD_IDENTITY_KEY_ENCRYPTION_KEY: process.env.CLOUD_IDENTITY_KEY_ENCRYPTION_KEY,
    CLOUD_IDENTITY_PREVIOUS_KEY: process.env.CLOUD_IDENTITY_PREVIOUS_KEY,
    CLOUD_IDENTITY_NEXT_KEY: process.env.CLOUD_IDENTITY_NEXT_KEY,
  };
  let key: ReturnType<typeof createLocalJWKSet>;
  const getApp = spyOn(registry, "getApp").mockImplementation(async (id) => apps.find((app) => app.id === id) ?? null);
  const listApps = spyOn(registry, "listApps").mockImplementation(async () => apps);
  // Only settings transport is replaced. The guarded signer preloads this
  // configuration before reserving pool1; identity, category and grant SQL stay real.
  const settingRead = spyOn(settings, "get").mockImplementation(async <T>(name: string): Promise<T> => {
    const [row] = await pool<{ value: string }[]>`SELECT value FROM settings.entries WHERE key = ${name}`;
    if (!row) throw new Error(`Unexpected identity setting: ${name}`);
    return (await decryptValue(row.value)) as T;
  });
  const person = async (db: SQL = pool, expired = false): Promise<RequestAuthority> => {
    const [row] = await db<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, admin, account_expires)
      VALUES (${`issuance-${crypto.randomUUID()}`}, 'local', 'user', true, ${expired ? new Date(Date.now() - 60_000) : null})
      RETURNING id`;
    return {
      actor: { kind: "user", user: buildProjectedUser({ id: row!.id, provider: "local", profile: "user", effective_admin: true }) },
      accessSubject: { type: "user", userId: row!.id },
      credentialKind: "session",
      scopes: [],
    };
  };
  const userId = (authority: RequestAuthority): string => {
    if (authority.accessSubject.type !== "user") throw new Error("Expected user fixture");
    return authority.accessSubject.userId;
  };
  const grant = async (db: SQL, authority: RequestAuthority, appId = targetAppId) => {
    const [row] = await db<{ id: string }[]>`
      INSERT INTO auth.access (user_id, permission) VALUES (${userId(authority)}::uuid, 'read') RETURNING id`;
    await db`INSERT INTO auth.app_access (app_id, access_id) VALUES (${appId}, ${row!.id}::uuid)`;
    return row!.id;
  };
  const verify = (token: string, expectedOperation = operation, schemaHash: string | null = null) =>
    identity.verifyInvocationToken(token, { targetAppId, operation: expectedOperation, schemaHash }, { issuer, key });

  describe("app-access issuance keeps SQL on the reserved connection", () => {
    beforeAll(async () => {
      expect(pool.options.max).toBe(1);
      bindProcessApplicationId("core");
      process.env.CLOUD_IDENTITY_KEY_ENCRYPTION_KEY = "42".repeat(32);
      delete process.env.CLOUD_IDENTITY_PREVIOUS_KEY;
      delete process.env.CLOUD_IDENTITY_NEXT_KEY;
      for (const name of ["auth", "rail-preferences", "rail-shortcuts", "audit", "settings"])
        await (await import(`../packages/core/src/migrate/core/${name}.ts`)).migrate();
      await migrateCloudCapabilities();
      await pool`INSERT INTO settings.entries (key, value)
        VALUES ('app.url', ${await encryptValue(issuer)}), ('freeipa.groups.admin', ${await encryptValue([])})`;
      for (const app of apps) await pool`INSERT INTO auth.app_access_state (app_id, configured_at) VALUES (${app.id}, now())`;
      identity.clearIdentityKeyCachesForTest();
      invalidateIdentityRuntimeConfig();
      await identity.prepareIdentitySigner("invocation");
      key = createLocalJWKSet(await identity.listIdentityJwks("invocation"));
    }, 120_000);
    beforeEach(async () => {
      const [clock] = await pool<{ now: Date }[]>`SELECT now() AS now`;
      setSystemTime(clock!.now);
    });
    afterEach(async () => {
      setSystemTime();
      getApp.mockImplementation(async (id) => apps.find((app) => app.id === id) ?? null);
      await pool`UPDATE settings.entries SET value = ${await encryptValue([])} WHERE key = 'freeipa.groups.admin'`;
      invalidateIdentityRuntimeConfig();
    });
    afterAll(async () => {
      getApp.mockRestore();
      listApps.mockRestore();
      settingRead.mockRestore();
      clearProcessApplicationId();
      identity.clearIdentityKeyCachesForTest();
      invalidateIdentityRuntimeConfig();
      for (const [name, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      try {
        await pool.close({ timeout: 5 });
      } finally {
        try {
          await sql.close({ timeout: 5 });
        } finally {
          await fresh.drop();
        }
      }
    });

    test("single and batched grant reads observe uncommitted grants and revocations", async () => {
      const authority = await person();
      await pool.begin(async (db) => {
        const accessId = await grant(db, authority);
        expect(await canUseApp(authority, target)).toBeFalse();
        expect(await canUseApp(authority, target, { db })).toBeTrue();
        expect(await usableAppIds(authority, apps, { db })).toEqual(new Set([targetAppId]));
        await db`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
        expect(await canUseApp(authority, target, { db })).toBeFalse();
      });
    });

    test("checked signing reloads an uncommitted principal and grants without widening mobile or OAuth authority", async () => {
      const signed = await identity.withActiveIdentitySigner(
        "invocation",
        async (signer, db) => {
          const authority = await person(db);
          await grant(db, authority);
          const principal = identity.invocationAuthorityFromRequest(authority);
          const params = { targetAppId, callingAppId: "core", operation, schemaHash: null, authority: principal, signer, issuer };
          // Both the principal and its grant are invisible to the global handle.
          expect(
            await identity.resolveInvocationAuthority({
              ...principal,
              act: { sub: "app:core" },
              jti: "probe",
              exp: Math.floor(Date.now() / 1000) + 60,
            }),
          ).toBeNull();
          const mobile = { ...principal, session_kind: "app" as const };
          const resolved = await resolveIssuanceAuthority(mobile, "core", db);
          expect(resolved?.actor).toMatchObject({ kind: "user", sessionKind: "app" });
          expect(resolved?.actor.kind === "user" && resolved.actor.user.roles.includes("admin")).toBeFalse();
          await expect(
            issueInvocationToken({ ...params, authority: { ...principal, credential_kind: "oauth", scopes: ["openid"] } }, { db }),
          ).rejects.toMatchObject({ code: "app_access_denied" });
          return issueInvocationToken({ ...params, authority: mobile }, { db });
        },
        { pool },
      );
      expect(await verify(signed.token)).toMatchObject({ sub: signed.claims.sub, session_kind: "app", scopes: [] });
    });

    test("prepared admin groups survive config expiry inside a held signer without widening credentials", async () => {
      const loadedAt = Date.now();
      await pool`UPDATE settings.entries SET value = ${await encryptValue(["pool-admins"])} WHERE key = 'freeipa.groups.admin'`;
      invalidateIdentityRuntimeConfig();
      const runtime = await getIdentityRuntimeConfig();
      setSystemTime(loadedAt + 59_999);
      const reads = settingRead.mock.calls.length;
      const signed = await identity.withActiveIdentitySigner(
        "invocation",
        async (signer, db) => {
          // Cross the config TTL after reservation, inside the original issuance deadline.
          setSystemTime(loadedAt + 60_001);
          expect(Object.isFrozen(signer.groupsAdmin)).toBeTrue();
          expect(signer.groupsAdmin).toEqual(["pool-admins"]);
          expect(signer.groupsAdmin).not.toBe(runtime.groupsAdmin);
          // A transaction-local config reload would lose admin. This issuance
          // must keep the prepared groups even when the process cache expires.
          await db`UPDATE settings.entries SET value = ${await encryptValue(["other-admins"])} WHERE key = 'freeipa.groups.admin'`;
          const authority = await person(db);
          await db`UPDATE auth.users SET provider = 'ipa', admin = false WHERE id = ${userId(authority)}::uuid`;
          await db`INSERT INTO auth.ipa_user_effective_groups (user_id, group_name) VALUES (${userId(authority)}::uuid, 'pool-admins')`;
          const principal = identity.invocationAuthorityFromRequest(authority);
          const options = {
            db,
            groupsAdmin: signer.groupsAdmin,
            getApp: async (id: string) => (id === targetAppId ? { id, access: appAccess.roles(["admin"]) } : null),
          };
          const params = {
            targetAppId,
            callingAppId: "core",
            operation,
            schemaHash: null,
            authority: principal,
            signer,
            issuer: signer.issuer,
          };
          const mobile = { ...principal, session_kind: "app" as const };
          const resolved = await resolveIssuanceAuthority(mobile, "core", db, signer.groupsAdmin);
          expect(resolved?.actor).toMatchObject({ kind: "user", sessionKind: "app" });
          expect(resolved?.actor.kind === "user" && resolved.actor.user.roles.includes("admin")).toBeFalse();
          await expect(issueInvocationToken({ ...params, authority: mobile }, options)).rejects.toMatchObject({
            code: "app_access_denied",
          });
          await expect(
            issueInvocationToken({ ...params, authority: { ...principal, credential_kind: "oauth", scopes: ["openid"] } }, options),
          ).rejects.toMatchObject({ code: "app_access_denied" });
          return issueInvocationToken(
            {
              ...params,
              authority: {
                ...principal,
                credential_kind: "oauth",
                credential_id: "pool-credential",
                scopes: ["openid", `${targetAppId}:read`],
              },
            },
            options,
          );
        },
        { pool },
      );
      expect(settingRead.mock.calls.length).toBe(reads);
      expect(await verify(signed.token)).toMatchObject({
        credential_kind: "oauth",
        credential_id: "pool-credential",
        scopes: ["openid", `${targetAppId}:read`],
      });
    });

    for (const allowed of [true, false]) {
      test(`cold mandate resume ${allowed ? "allows granted apps" : "denies missing grants"} on its held connection and commits audit`, async () => {
        const authority = await person();
        await pool`UPDATE auth.users SET provider = 'ipa', admin = false WHERE id = ${userId(authority)}::uuid`;
        await pool`INSERT INTO auth.ipa_user_effective_groups (user_id, group_name) VALUES (${userId(authority)}::uuid, 'resume-admins')`;
        const [row] = await pool<{ id: string }[]>`
          INSERT INTO auth.mandates (subject_kind, subject_user_id, owner_app_id, workload_type, workload_id, policy, state, created_by_user_id)
          VALUES ('user', ${userId(authority)}::uuid, ${ownerAppId}, 'pool.resume', ${`resume-${allowed}`},
            ${JSON.stringify({ version: 1, apps: [targetAppId], operations: [operation], actions: "deny" })}::jsonb,
            'paused', ${userId(authority)}::uuid) RETURNING id`;
        const mandateId = row!.id;
        // The owner requires the configured IPA admin group; the target still
        // requires its real configurable app grant.
        getApp.mockImplementation(async (id) => {
          const app = apps.find((entry) => entry.id === id);
          return app?.id === ownerAppId ? { ...app, access: appAccess.roles(["admin"]) } : (app ?? null);
        });
        invalidateIdentityRuntimeConfig();
        const reads = settingRead.mock.calls.length;
        const result = await pool.begin(async (db) => {
          // Only this connection sees the non-default admin-group setting.
          await db`UPDATE settings.entries SET value = ${await encryptValue(["resume-admins"])} WHERE key = 'freeipa.groups.admin'`;
          if (allowed) await grant(db, authority);
          return resumeMandate({ mandateId, expectedRevision: 1, authority: { kind: "interactive", userId: userId(authority) } }, { db });
        });
        expect(settingRead.mock.calls.length).toBe(reads);
        if (allowed) expect(result).toMatchObject({ ok: true, data: { state: "active", revision: 2 } });
        else expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
        const [stored] = await pool<{ state: string; revision: number | bigint }[]>`
          SELECT state, revision FROM auth.mandates WHERE id = ${mandateId}::uuid`;
        expect(stored?.state).toBe(allowed ? "active" : "paused");
        expect(Number(stored?.revision)).toBe(allowed ? 2 : 1);
        const audits = await pool<{ outcome: string; actor_user_id: string }[]>`
          SELECT outcome, actor_user_id FROM audit.events WHERE action = 'mandate.resume' AND target_id = ${mandateId}`;
        expect(audits).toEqual([{ outcome: allowed ? "allowed" : "denied", actor_user_id: userId(authority) }]);
      });
    }

    for (const mode of ["interactive", "mandate"] as const) {
      test(`real ${mode} capability dispatch uses transaction-local grants and real signing`, async () => {
        const authority = await person();
        const requestId = `pool-${mode}`;
        let mandateId: string | undefined;
        if (mode === "mandate") {
          const [row] = await pool<{ id: string }[]>`
            INSERT INTO auth.mandates (subject_kind, subject_user_id, owner_app_id, workload_type, workload_id, policy, created_by_user_id)
            VALUES ('user', ${userId(authority)}::uuid, ${ownerAppId}, 'pool.test', ${requestId},
              ${JSON.stringify({ version: 1, apps: [targetAppId], operations: [operation], actions: "deny" })}::jsonb,
              ${userId(authority)}::uuid) RETURNING id`;
          mandateId = row!.id;
        }
        const loadedAt = Date.now();
        invalidateIdentityRuntimeConfig();
        await getIdentityRuntimeConfig();
        setSystemTime(loadedAt + 59_999);
        const reads = settingRead.mock.calls.length;
        let fetches = 0;
        const response = await dispatchCapability({
          request: new Request("http://core.test/invoke", { headers: { "x-request-id": requestId } }),
          kind: "queries",
          origin: "app",
          appId: targetAppId,
          capabilityId: "read",
          input: { id: "one" },
          ...(mandateId ? { mandate: { mandateId, mandateRevision: 1, ownerAppId } } : { authority }),
          dependencies: {
            getCapability: async () => ({
              appId: targetAppId,
              appName: "Target",
              appIcon: target.icon,
              appDescription: "",
              endpoint: `${target.baseUrl}/invoke`,
              manifest,
            }),
            withActiveSigner: (purpose, callback, options) =>
              identity.withActiveIdentitySigner(
                purpose,
                async (signer, db) => {
                  setSystemTime(loadedAt + 60_001);
                  await grant(db, authority);
                  await grant(db, authority, ownerAppId);
                  return callback(signer, db);
                },
                { ...options, pool },
              ),
            fetch: async (_input, init) => {
              fetches++;
              const token = new Headers(init?.headers).get("authorization")!.slice(7);
              expect(await verify(token, operation, manifest.queries[0]!.schemaHash)).toMatchObject({
                sub: userId(authority),
                credential_kind: mode === "mandate" ? "mandate" : "session",
                ...(mandateId ? { mandate_id: mandateId, mandate_revision: 1 } : {}),
              });
              return Response.json({ data: { id: "one" } });
            },
          },
        });
        expect(response.status).toBe(200);
        expect(fetches).toBe(1);
        expect(settingRead.mock.calls.length).toBe(reads);
        if (mandateId) {
          const audits = await pool<
            { outcome: string }[]
          >`SELECT outcome FROM audit.events WHERE action = 'mandate.issue' AND request_id = ${requestId}`;
          expect(audits).toEqual([{ outcome: "allowed" }]);
        }
      });
    }

    for (const path of ["/widgets/v1", `/widgets/v1/${targetAppId}/summary`]) {
      for (const revoked of [false, true]) {
        test(`${path} ${revoked ? "denies a transaction-local grant revocation" : "reloads the current principal on pool1"}`, async () => {
          // Discovery sees a real committed grant. Checked issuance must recheck
          // the identity/grant state changed only inside the signing transaction.
          const authority = await person(pool, !revoked);
          const accessId = await grant(pool, authority);
          let fetches = 0;
          let guards = 0;
          const routes = createWidgetRoutes({
            authenticate: async (c, next) => {
              c.set("actor", authority.actor);
              c.set("accessSubject", authority.accessSubject);
              if (authority.actor.kind === "user") c.set("user", authority.actor.user);
              c.set("credentialKind", "session");
              c.set("credentialScopes", []);
              await next();
            },
            listWidgets: async () => [
              { appId: targetAppId, appName: "Target", appIcon: target.icon, widgetId: "summary", url: `${target.baseUrl}/widget` },
            ],
            withActiveSigner: (purpose, callback, options) =>
              identity.withActiveIdentitySigner(
                purpose,
                async (signer, db) => {
                  guards++;
                  if (revoked) await db`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
                  else await db`UPDATE auth.users SET account_expires = NULL WHERE id = ${userId(authority)}::uuid`;
                  return callback(signer, db);
                },
                { ...options, pool },
              ),
            fetch: async (_input, init) => {
              fetches++;
              const token = new Headers(init?.headers).get("authorization")!.slice(7);
              expect(await verify(token, identity.widgetInvocationOperation("summary"))).toMatchObject({ sub: userId(authority) });
              return Response.json({ title: "Target", blocks: [] });
            },
          });
          const response = await routes.request(path);
          expect(guards).toBe(1);
          if (path === "/widgets/v1") {
            expect(response.status).toBe(200);
            const lines: unknown[] = (await response.text())
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line));
            expect(lines).toEqual(expect.arrayContaining([expect.objectContaining({ type: "widget", status: revoked ? "error" : "ok" })]));
            expect(lines.at(-1)).toEqual({ type: "done", status: revoked ? "partial" : "complete" });
          } else {
            expect(response.status).toBe(revoked ? 403 : 200);
            if (revoked) expect(await response.json()).toMatchObject({ code: "app_access_denied" });
          }
          expect(fetches).toBe(revoked ? 0 : 1);
        });
      }
    }
  });
}
