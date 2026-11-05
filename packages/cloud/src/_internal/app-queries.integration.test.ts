import { afterAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { z } from "zod";
import { APP_KEY_FIXTURES } from "../../../../scripts/fixtures/app-key-fixtures";
import { suiteFor, testInfra, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { APP_QUERY_REQUESTS_PER_MINUTE, type CapabilityDispatchDependencies, dispatchCapability } from "../api/capabilities";
import { formatAppKey } from "../app-key";
import * as executions from "../capabilities/executions";
import { migrateCloudCapabilities } from "../capabilities/migrate";
import { readResourcePrincipals } from "../capabilities/resource-readers";
import { env } from "../config/env";
import { CloudResourceReaderViewSchema, defineCapabilities } from "../contracts/capabilities";
import { redis, sql } from "../runtime/clients";
import { registerAppKey } from "../services/app-keys";
import { signAppQueryInvocation } from "../services/identity/invocation-token";
import { withActiveIdentitySigner } from "../services/identity/key-ring";
import { authenticateWorkloadCredential } from "../services/identity/workload-auth";
import { toPgTextArray } from "../services/postgres";
import { createApiToken } from "../services/service-account-credentials";
import { encryptValue } from "../services/settings/crypto";
import { createAppQueryRoutes } from "./app-queries";
import { compileCapabilities, invokeCompiledCapability } from "./capabilities";
import { bindProcessApplicationId, clearProcessApplicationId } from "./process-identity";
import * as registry from "./registry";

const database = testInfra.database && testInfra.nats && testInfra.valkey ? await useFreshDatabase("resource_readers") : null;
const reader = {
  title: "Read item",
  description: "Read the authorized item.",
  input: z.object({ id: z.string().min(1).max(512).describe("Resource ID.") }).strict(),
  data: z.object({ view: CloudResourceReaderViewSchema }),
  openWorld: false,
  run: async () => ({ ok: true as const, data: { data: { view: { title: "Item", permission: "read" as const } } } }),
};
if (database) await import("../../../../scripts/fixtures/authorization-preload");
afterAll(async () => {
  await database?.drop();
});

suiteFor(
  "database",
  "nats",
  "valkey",
)("app query live admission", () => {
  test("current workload credential is required at authentication and provider execution", async () => {
    const appId = `query-fixture-${crypto.randomUUID()}`;
    const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
      VALUES ('App query fixture', 'resource_bound', ${appId}, 'cloud.app', ${appId}) RETURNING id`;
    try {
      let invoked = 0;
      const compiled = compileCapabilities(
        "query-provider",
        defineCapabilities({
          protocolVersion: 2,
          queries: { "item.read": reader },
          types: {
            item: {
              title: "Item",
              description: "An item.",
              reader: "item.read",
              access: {
                readable: async (_input, context) => {
                  expect(context).toMatchObject({ actor: { kind: "app", appId }, accessSubject: { type: "none" }, user: null });
                  invoked++;
                  return [];
                },
              },
            },
          },
        }),
      );
      const credential = await createApiToken({ serviceAccountId: account!.id, name: "Query fixture", scopes: ["identity:invoke"] });
      if (!credential.ok) throw new Error(credential.error.message);
      const auth = () => authenticateWorkloadCredential({ appId, scope: "identity:invoke", token: credential.data.token });
      expect(await authenticateWorkloadCredential({ appId, scope: "identity:invoke", token: null })).toBeNull();
      const workload = await auth();
      if (!workload) throw new Error("Missing workload fixture");
      const payload = { id: "Abc123", principals: [] };
      const signed = await withActiveIdentitySigner("invocation", (signer) =>
        signAppQueryInvocation({
          workload,
          targetAppId: "query-provider",
          capabilityId: "item.readable",
          schemaHash: compiled.queries.get("item.readable")!.manifest.schemaHash,
          input: payload,
          requestId: "live-query",
          signer,
        }),
      );
      const routes = createAppQueryRoutes(compiled);
      const call = (token: string | null = signed.token, value: unknown = payload) =>
        routes.request("http://provider.test/item.readable", {
          method: "POST",
          headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ input: value }),
        });
      expect((await call()).status).toBe(200);
      expect((await call(null)).status).toBe(403);
      expect((await call("invalid")).status).toBe(403);
      expect((await call(signed.token, { ...payload, principals: [{ type: "user", userId: account!.id }] })).status).toBe(403);
      await sql`UPDATE auth.service_account_credentials SET status = 'revoked', revoked_at = clock_timestamp() WHERE id = ${workload.credentialId}::uuid`;
      expect(await auth()).toBeNull();
      expect((await call()).status).toBe(403);
      await sql`UPDATE auth.service_account_credentials SET status = 'active', revoked_at = NULL, expires_at = now() - interval '1 second' WHERE id = ${workload.credentialId}::uuid`;
      expect(await auth()).toBeNull();
      expect((await call()).status).toBe(403);
      await sql`UPDATE auth.service_account_credentials SET expires_at = NULL, scopes = '{}' WHERE id = ${workload.credentialId}::uuid`;
      expect(await auth()).toBeNull();
      expect((await call()).status).toBe(403);
      await sql`UPDATE auth.service_account_credentials SET scopes = ARRAY['identity:invoke'] WHERE id = ${workload.credentialId}::uuid`;
      await sql`UPDATE auth.service_accounts SET status = 'disabled' WHERE id = ${account!.id}::uuid`;
      expect(await auth()).toBeNull();
      expect((await call()).status).toBe(403);
      await sql`UPDATE auth.service_accounts SET status = 'active', resource_id = 'wrong' WHERE id = ${account!.id}::uuid`;
      expect(await auth()).toBeNull();
      expect((await call()).status).toBe(403);
      expect(invoked).toBe(1);
    } finally {
      await sql`DELETE FROM auth.service_accounts WHERE id = ${account!.id}::uuid`;
    }
  });
  test("enrolled app keys and legacy workloads have the same reader authority and live revocation", async () => {
    const appId = "reader-consumer";
    const userId = "33333333-3333-4333-8333-333333333333";
    const keyDescriptor = Object.getOwnPropertyDescriptor(env, "CLOUD_APP_KEY")!;
    const originalCredential = process.env.CLOUD_APP_CREDENTIAL;
    const originalOrigin = process.env.CLOUD_CORE_INTERNAL_ORIGIN;
    await sql`INSERT INTO auth.users (id, uid, provider, profile, admin)
      VALUES (${userId}::uuid, 'reader-admin', 'local', 'user', true)`;
    const enrolled = await registerAppKey({
      actor: { id: userId, uid: "reader-admin", provider: "local", roles: ["admin"] },
      appId,
      publicKey: APP_KEY_FIXTURES[0].publicKey,
    });
    if (!enrolled.ok) throw new Error(enrolled.error.message);
    const [account] = await sql<{ id: string }[]>`SELECT service_account_id AS id FROM auth.service_account_credentials
      WHERE id = ${enrolled.data.keyId}::uuid`;
    if (!account) throw new Error("Missing app account");
    const legacy = await createApiToken({ serviceAccountId: account.id, name: "Legacy reader", scopes: ["identity:invoke"] });
    if (!legacy.ok) throw new Error(legacy.error.message);
    let invoked = 0;
    const compiled = compileCapabilities("reader-provider", {
      protocolVersion: 2,
      // A type with access names its reader query.
      queries: { "item.read": reader, "folder.read": reader },
      types: Object.fromEntries(
        ["item", "folder"].map((type) => [
          type,
          {
            title: type,
            description: "Reader fixture.",
            reader: `${type}.read`,
            access: {
              readable: async (input, context) => {
                expect(context).toMatchObject({ actor: { kind: "app", appId }, accessSubject: { type: "none" }, user: null });
                invoked++;
                return input.principals;
              },
            },
          },
        ]),
      ),
    });
    const entry = {
      appId: "reader-provider",
      appName: "Reader provider",
      appIcon: "",
      appDescription: "",
      endpoint: "http://provider.test",
      manifest: compiled.manifest,
    };
    const lookup = spyOn(registry, "getCapability").mockResolvedValue(entry);
    const routes = new Hono().route("/app-queries", createAppQueryRoutes(compiled));
    let providerRequest: Request | undefined;
    let admitted = true;
    const dependencies: CapabilityDispatchDependencies = {
      getApp: async (id) => ({
        id,
        name: id,
        description: "",
        icon: "",
        routes: [],
        baseUrl: "http://caller.test",
        platformPermissions: admitted ? ["resources:readers"] : [],
      }),
      getCapability: async () => entry,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        providerRequest = request.clone();
        return routes.fetch(request);
      },
    };
    // Use Core's actual signed/legacy broker without importing its program into Cloud's typecheck.
    const brokerPath = "../../../core/src/api/identity-invocation";
    const { createIdentityInvocationRoutes } = (await import(brokerPath)) as {
      createIdentityInvocationRoutes: (dependencies: {
        authenticateWorkload: typeof authenticateWorkloadCredential;
        dispatchDependencies: CapabilityDispatchDependencies;
      }) => Hono;
    };
    const broker = createIdentityInvocationRoutes({
      authenticateWorkload: authenticateWorkloadCredential,
      dispatchDependencies: dependencies,
    });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: new Hono().route("/api/_internal/identity/v1", broker).fetch });
    process.env.CLOUD_CORE_INTERNAL_ORIGIN = server.url.origin;
    clearProcessApplicationId();
    bindProcessApplicationId(appId, ["resources:readers"]);
    const read = (type = "item") =>
      readResourcePrincipals({ ref: { type: `reader-provider.${type}`, id: "item-1" }, principals: [{ type: "user", userId }] });
    try {
      for (const kind of ["legacy", "app_key"] as const) {
        Object.defineProperty(env, "CLOUD_APP_KEY", {
          configurable: true,
          value: kind === "app_key" ? formatAppKey({ ...enrolled.data, appId, seed: APP_KEY_FIXTURES[0].seed }) : undefined,
        });
        if (kind === "legacy") process.env.CLOUD_APP_CREDENTIAL = legacy.data.token;
        else delete process.env.CLOUD_APP_CREDENTIAL;
        const credentialId = kind === "legacy" ? legacy.data.credential.id : enrolled.data.keyId;
        for (const type of ["item", "folder"]) {
          expect(await read(type)).toEqual({ state: "checked", readable: [{ type: "user", userId }] });
        }
        const issued = providerRequest!;
        admitted = false;
        expect(await read()).toEqual({ state: "not_configured", reason: "not_admitted" });
        admitted = true;
        for (const state of ["revoked", "expired", "disabled", "wrong_resource"] as const) {
          if (state === "revoked")
            await sql`UPDATE auth.service_account_credentials SET status = 'revoked', revoked_at = now() WHERE id = ${credentialId}::uuid`;
          if (state === "expired")
            await sql`UPDATE auth.service_account_credentials SET expires_at = '-infinity' WHERE id = ${credentialId}::uuid`;
          if (state === "disabled") await sql`UPDATE auth.service_accounts SET status = 'disabled' WHERE id = ${account.id}::uuid`;
          if (state === "wrong_resource") {
            // An account with app credentials cannot be rebound at all; the database refuses the state the reader would have to catch.
            await expect(sql`UPDATE auth.service_accounts SET resource_id = 'wrong' WHERE id = ${account.id}::uuid`).rejects.toThrow(
              "Account credentials do not match its kind or binding",
            );
            continue;
          }
          expect((await routes.fetch(issued.clone())).status).toBe(403);
          await expect(read()).rejects.toThrow();
          await sql`UPDATE auth.service_account_credentials SET status = 'active', revoked_at = NULL, expires_at = NULL WHERE id = ${credentialId}::uuid`;
          await sql`UPDATE auth.service_accounts SET status = 'active', resource_id = ${appId}, delegated_user_id = NULL WHERE id = ${account.id}::uuid`;
        }
        expect(await read()).toMatchObject({ state: "checked" });
      }
      expect(invoked).toBe(6);
    } finally {
      await server.stop(true);
      lookup.mockRestore();
      Object.defineProperty(env, "CLOUD_APP_KEY", keyDescriptor);
      if (originalCredential === undefined) delete process.env.CLOUD_APP_CREDENTIAL;
      else process.env.CLOUD_APP_CREDENTIAL = originalCredential;
      if (originalOrigin === undefined) delete process.env.CLOUD_CORE_INTERNAL_ORIGIN;
      else process.env.CLOUD_CORE_INTERNAL_ORIGIN = originalOrigin;
      clearProcessApplicationId();
      bindProcessApplicationId("core");
      await sql`DELETE FROM capabilities.executions WHERE via_app_id = ${appId}`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ${account.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });
  test("platform filters inactive principals before provider code in one bounded batch", async () => {
    const userId = crypto.randomUUID();
    const expiredId = crypto.randomUUID();
    const disabledCategoryId = crypto.randomUUID();
    const activeAccountId = crypto.randomUUID();
    const disabledAccountId = crypto.randomUUID();
    const delegatedActiveId = crypto.randomUUID();
    const delegatedExpiredId = crypto.randomUUID();
    const delegatedDisabledCategoryId = crypto.randomUUID();
    const deletedId = crypto.randomUUID();
    const user = (userId: string) => ({ type: "user" as const, userId });
    const account = (serviceAccountId: string) => ({ type: "service_account" as const, serviceAccountId });
    const active = [user(userId.toUpperCase()), account(activeAccountId), account(delegatedActiveId)];
    const principals = [
      ...active,
      user(expiredId),
      user(disabledCategoryId),
      account(disabledAccountId),
      user(deletedId),
      account(deletedId),
      account(delegatedExpiredId),
      account(delegatedDisabledCategoryId),
    ];
    const [setting] = await sql<{ value: string }[]>`SELECT value FROM settings.entries WHERE key = 'user.category.guest.enabled'`;
    try {
      await sql`INSERT INTO auth.users (id, uid, provider, profile, account_expires) VALUES
        (${userId}::uuid, ${userId}, 'local', 'user', NULL),
        (${expiredId}::uuid, ${expiredId}, 'local', 'user', '-infinity'),
        (${disabledCategoryId}::uuid, ${disabledCategoryId}, 'local', 'guest', NULL)`;
      await sql`INSERT INTO auth.service_accounts (id, name, kind, status) VALUES
        (${activeAccountId}::uuid, 'Active reader', 'standalone', 'active'),
        (${disabledAccountId}::uuid, 'Disabled reader', 'standalone', 'disabled')`;
      await sql`INSERT INTO auth.service_accounts (id, name, kind, status, delegated_user_id) VALUES
        (${delegatedActiveId}::uuid, 'Active delegated reader', 'user_delegated', 'active', ${userId}::uuid),
        (${delegatedExpiredId}::uuid, 'Expired delegated reader', 'user_delegated', 'active', ${expiredId}::uuid),
        (${delegatedDisabledCategoryId}::uuid, 'Disabled category delegated reader', 'user_delegated', 'active', ${disabledCategoryId}::uuid)`;
      await sql`INSERT INTO settings.entries (key, value) VALUES ('user.category.guest.enabled', ${await encryptValue(false)})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
      let called = 0;
      const compiled = compileCapabilities("provider", {
        protocolVersion: 2,
        queries: { "item.read": reader },
        types: {
          item: {
            title: "Item",
            description: "Item.",
            reader: "item.read",
            access: {
              readable: (input) => {
                called++;
                expect(input.principals).toEqual(active);
                return input.principals;
              },
            },
          },
        },
      });
      const result = await invokeCompiledCapability({
        compiled,
        kind: "query",
        localId: "item.readable",
        input: { id: "item-1", principals },
        expectedSchemaHash: compiled.queries.get("item.readable")!.manifest.schemaHash,
        context: {
          actor: { kind: "app", appId: "consumer" },
          accessSubject: { type: "none" },
          user: null,
          locale: "en",
          requestId: "active-reader-fixture",
          origin: "app",
          signal: new AbortController().signal,
        },
      });
      expect(result).toEqual({ ok: true, data: { data: { readable: active } } });
      expect(called).toBe(1);
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ANY(${toPgTextArray([userId, expiredId, disabledCategoryId])}::uuid[])`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ANY(${toPgTextArray([activeAccountId, disabledAccountId])}::uuid[])`;
      if (setting) await sql`UPDATE settings.entries SET value = ${setting.value} WHERE key = 'user.category.guest.enabled'`;
      else await sql`DELETE FROM settings.entries WHERE key = 'user.category.guest.enabled'`;
    }
  });
  test("execution actor constraint upgrades once and keeps its OID on subsequent boots", async () => {
    await sql`ALTER TABLE capabilities.executions DROP CONSTRAINT capabilities_executions_actor_kind_check`.simple();
    await sql`ALTER TABLE capabilities.executions ADD CONSTRAINT capabilities_executions_actor_kind_check
      CHECK (actor_kind IS NULL OR actor_kind IN ('user', 'service_account'))`.simple();
    const constraint = () => sql<
      { oid: number; definition: string }[]
    >`SELECT oid, pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid = 'capabilities.executions'::regclass AND conname = 'capabilities_executions_actor_kind_check'`;
    const before = await constraint();
    await migrateCloudCapabilities();
    const upgraded = await constraint();
    expect(upgraded[0]!.oid).not.toBe(before[0]!.oid);
    expect(upgraded[0]!.definition).toContain("'app'::text");
    await migrateCloudCapabilities();
    expect(await constraint()).toEqual(upgraded);
  });
  test("execution history persists the app without a person or grant subject", async () => {
    const id = await executions.recordCapabilityExecution({
      requestId: "app-query-history-fixture",
      origin: "app",
      appId: "spaces",
      capability: "spaces.item.readable",
      kind: "query",
      destructive: false,
      actorKind: "app",
      viaAppId: "chat",
      status: "succeeded",
      inputMeta: { type: "object", keys: ["id", "principals"], omittedKeys: 0 },
      startedAt: new Date("2026-10-29T00:00:00Z"),
      completedAt: new Date("2026-10-29T00:00:00.001Z"),
    });
    try {
      const [row] =
        await sql`SELECT actor_kind, actor_id, user_id, access_subject_type, access_subject_id, via_app_id FROM capabilities.executions WHERE id = ${id}::uuid`;
      expect(row).toEqual({
        actor_kind: "app",
        actor_id: null,
        user_id: null,
        access_subject_type: null,
        access_subject_id: null,
        via_app_id: "chat",
      });
    } finally {
      await sql`DELETE FROM capabilities.executions WHERE id = ${id}::uuid`;
    }
  });
  test("real Valkey budget is shared by target queries for the calling app", async () => {
    setSystemTime(new Date("2026-10-29T00:00:00Z"));
    const appId = `rate-fixture-${crypto.randomUUID()}`;
    const window = Math.floor(Date.now() / 60_000);
    const keys = [window - 1, window].map((part) => `cloud:ratelimit:app-queries:${appId}:${part}`);
    const record = spyOn(executions, "recordCapabilityExecution").mockResolvedValue(crypto.randomUUID());
    try {
      const compiled = compileCapabilities(
        "provider",
        defineCapabilities({
          protocolVersion: 2,
          queries: { "item.read": reader },
          types: { item: { title: "Item", description: "Item.", reader: "item.read", access: { readable: () => [] } } },
        }),
      );
      await redis.set(keys[1]!, String(APP_QUERY_REQUESTS_PER_MINUTE - 1));
      const call = (target: string) =>
        dispatchCapability({
          request: new Request("http://core.test/invoke"),
          workload: { appId, credentialId: crypto.randomUUID(), serviceAccountId: crypto.randomUUID(), scope: "identity:invoke" },
          kind: "queries",
          appId: target,
          capabilityId: "item.readable",
          input: {},
          origin: "app",
          dependencies: {
            getApp: async (id) => ({
              id,
              platformPermissions: ["resources:readers"],
              name: id,
              description: "",
              icon: "",
              routes: [],
              baseUrl: "http://caller.test",
            }),
            getCapability: async () => ({
              appId: target,
              appName: "Provider",
              appDescription: "Fixture",
              appIcon: "ti ti-box",
              endpoint: "http://provider.test",
              manifest: { ...compiled.manifest, appId: target },
            }),
            // Deliberately stop at input validation: admission already consumed the actual shared rate budget.
          },
        });
      // A validation failure still consumes its admitted slot; no signer or network is needed.
      expect((await call("provider")).status).toBe(400);
      expect((await call("other-provider")).status).toBe(429);
    } finally {
      await redis.del(...keys);
      record.mockRestore();
      setSystemTime();
    }
  });
});
