import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { bindProcessSync, sql, unbindProcessSync } from "@k2b/cloud";
import { createSync } from "@k2b/sync";
import { SQL } from "bun";
import { Hono } from "hono";
import { createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { APP_KEY_FIXTURES } from "../../../../scripts/fixtures/app-key-fixtures";
import { connectTestNats, suiteFor, testSyncNamespace, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { migrateAppMigration } from "../../../core/src/migrate/core/app-migration";
import { migrate as migrateAudit } from "../../../core/src/migrate/core/audit";
import { migrate as migrateAuth } from "../../../core/src/migrate/core/auth";
import { appInstancePrefix, appInstanceRegistry, appRegistry } from "../../src/_internal/registry";
import { createAdminAppKeyRoutes } from "../../src/api/admin-app-keys";
import { APP_MIGRATION_RECEIPT_PATH, createAppMigrationProbeRoutes } from "../../src/api/app-migration-probe";
import { APP_MIGRATION_TRIGGER_PATH, createAppMigrationTriggerRoutes } from "../../src/api/app-migration-trigger";
import { authenticateSignedAppRequest } from "../../src/api/authenticate-app-request";
import { type AppKey, formatAppKey } from "../../src/app-key";
import { env } from "../../src/config/env";
import { AppMigrationStatusSchema } from "../../src/contracts/app-migration";
import { appKeys } from "../../src/services/app-keys";
import { readAppMigrationStatus } from "../../src/services/app-migration";
import { beginAppMigrationObservation, readAppMigrationObservation, recordLegacyAppUse } from "../../src/services/app-migration-evidence";
import * as invocation from "../../src/services/identity/invocation-token";

const NOW = Date.UTC(2030, 0, 2);
const actor = { id: "11111111-1111-4111-8111-111111111111", uid: "migration-admin", provider: "local" as const, roles: ["admin" as const] };
suiteFor(
  "database",
  "valkey",
  "nats",
)("checked app key migration over HTTP", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  let replica: SQL;
  let connection: Awaited<ReturnType<typeof connectTestNats>> | undefined;
  let sync: ReturnType<typeof createSync> | undefined;
  let key: AppKey;
  const stops: (() => void | Promise<void>)[] = [];
  let restoreSigning: (() => void) | undefined;
  let restoreEnv: (() => void) | undefined;
  beforeAll(async () => {
    database = await useFreshDatabase("cloud_app_key_migration_r3");
    await migrateAuth();
    await Promise.all([migrateAppMigration(), migrateAppMigration()]);
    await migrateAudit();
    replica = new SQL(database.url);
    await sql`INSERT INTO auth.users(id,uid,provider,profile,admin) VALUES (${actor.id}::uuid,${actor.uid},'local','user',true)`;
    const enrolled = await appKeys.register({ actor, appId: "acme", publicKey: APP_KEY_FIXTURES[0].publicKey, grants: ["oauth:issue"] });
    if (!enrolled.ok) throw new Error(enrolled.error.message);
    key = { appId: "acme", keyId: enrolled.data.keyId, installationId: enrolled.data.installationId, seed: APP_KEY_FIXTURES[0].seed };
    const descriptor = Object.getOwnPropertyDescriptor(env, "CLOUD_APP_KEY")!;
    Object.defineProperty(env, "CLOUD_APP_KEY", { configurable: true, value: formatAppKey(key) });
    restoreEnv = () => Object.defineProperty(env, "CLOUD_APP_KEY", descriptor);
    connection = await connectTestNats({ timeout: 3_000, maxReconnectAttempts: 0 });
    sync = createSync({ connection, namespace: testSyncNamespace("app-migration"), application: "core", defaults: { replicas: 1 } });
    bindProcessSync(sync);
    await sync.ready();
    setSystemTime(NOW);
    const pair = await generateKeyPair("RS256");
    const issuer = "https://core.test";
    const signer = { key: pair.privateKey, kid: "44444444-4444-4444-8444-444444444444", signUntil: new Date(NOW + 60_000) };
    const verifyKey = createLocalJWKSet({
      keys: [{ ...(await exportJWK(pair.publicKey)), kid: "44444444-4444-4444-8444-444444444444", alg: "RS256" }],
    });
    const sign = invocation.signMigrationProbe;
    const signing = spyOn(invocation, "signMigrationProbe").mockImplementation((input) => sign({ ...input, issuer, signer }));
    restoreSigning = () => signing.mockRestore();
    const admitted = async () => ({ limited: false, remaining: 1, resetIn: 1000 });
    const core = new Hono().route(
      APP_MIGRATION_RECEIPT_PATH,
      createAppMigrationProbeRoutes((c, scope) =>
        authenticateSignedAppRequest(c, scope, { db: replica, ingress: admitted, admit: admitted }),
      ),
    );
    const coreServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: core.fetch });
    stops.push(() => coreServer.stop(true));
    const app = new Hono().route(
      APP_MIGRATION_TRIGGER_PATH,
      createAppMigrationTriggerRoutes("acme", {
        verify: (token, appId) => invocation.verifyMigrationProbe(token, appId, { issuer, key: verifyKey }),
        origin: async () => coreServer.url.origin,
      }),
    );
    const appServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    stops.push(() => appServer.stop(true));
    await appRegistry().upsert({
      key: "apps/acme",
      value: {
        id: "acme",
        name: "Acme",
        description: "Migration fixture",
        icon: "ti ti-app",
        baseUrl: appServer.url.origin,
        routes: ["/acme"],
      },
    });
    await appInstanceRegistry().upsert({
      key: `${appInstancePrefix("core")}new`,
      value: { appId: "core", instanceId: "new", hostname: "test", startedAt: NOW, entries: {}, legacyEvidence: 1 },
    });
    await appInstanceRegistry().upsert({
      key: `${appInstancePrefix("acme")}one`,
      value: {
        appId: "acme",
        instanceId: "one",
        hostname: "test",
        startedAt: NOW,
        entries: {},
        bootstrap: {
          keyId: key.keyId,
          mode: "core",
          keyFormat: "cloud-app-key-v1",
          protocol: 1,
          sources: {
            database: { url: "core" },
            valkey: { url: "core" },
            nats: { servers: "core", namespace: "core", replicas: "core", ignoreClusterUpdates: "core" },
            appSecret: { current: "core" },
          },
        },
      },
    });
  });
  afterAll(async () => {
    for (const stop of stops.reverse()) await stop();
    await sync?.drain();
    unbindProcessSync();
    await connection?.close();
    restoreSigning?.();
    restoreEnv?.();
    setSystemTime();
    await replica?.close();
    await sql.close();
    await database?.drop();
  });
  const status = () => readAppMigrationStatus({ actor, expect: ["acme"], allowEnv: [], windowSeconds: 86400 });
  test("fresh signed broker/OAuth receipts cross Core replicas, but no observation is never green", async () => {
    const result = await status();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.apps[0]?.probes).toEqual([{ keyId: key.keyId, broker: true, oauth: true }]);
    expect(result.data.needsAttention).toBe(true);
    const begun = await beginAppMigrationObservation({ actor }, replica);
    expect(begun.ok).toBe(true);
    const [audit] = await replica<{ action: string; actor_user_id: string }[]>`SELECT action, actor_user_id FROM audit.events
      WHERE action = 'app_migration.observation_begin' ORDER BY id DESC LIMIT 1`;
    expect(audit).toMatchObject({ action: "app_migration.observation_begin", actor_user_id: actor.id });
    expect((await readAppMigrationObservation(86400)).complete).toBe(false);
    await replica`UPDATE auth.app_migration_observation SET started_at = clock_timestamp() - interval '2 days'`;
    const complete = await status();
    expect(complete.ok && complete.data.needsAttention).toBe(false);
  });
  test("an explicit OAuth grant is required for the OAuth probe on the actual signed path", async () => {
    await sql`UPDATE auth.service_account_credentials SET oauth_issue_allowed = false WHERE id = ${key.keyId}::uuid`;
    const body = JSON.stringify({ nonce: "33333333-3333-4333-8333-333333333333" });
    const path = `${APP_MIGRATION_RECEIPT_PATH}/oauth:issue`;
    const { signAppProof } = await import("../../src/runtime/bootstrap-protocol");
    const proof = await signAppProof(key, { method: "POST", path, body: new TextEncoder().encode(body) });
    const routes = createAppMigrationProbeRoutes((c, scope) =>
      authenticateSignedAppRequest(c, scope, { db: replica, ingress: async () => ({ limited: false, remaining: 1, resetIn: 1000 }) }),
    );
    expect(
      (
        await new Hono().route(APP_MIGRATION_RECEIPT_PATH, routes).request(`http://core.test${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${proof}` },
          body,
        })
      ).status,
    ).toBe(403);
    await sql`UPDATE auth.service_account_credentials SET oauth_issue_allowed = true WHERE id = ${key.keyId}::uuid`;
  });
  test("either legacy path on another Core replica restarts the observation and rejected starts remain visible", async () => {
    for (const path of ["bearer", "broker-secret"] as const) {
      await recordLegacyAppUse(path, replica);
      expect((await readAppMigrationObservation(86400)).complete).toBe(false);
    }
    await replica`INSERT INTO auth.app_start_rejections(app_id,rejected_at,reason,key_id) VALUES ('acme',clock_timestamp(),'revoked',${key.keyId}::uuid)`;
    const result = await status();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.needsAttention).toBe(true);
      expect(result.data.apps[0]?.lastRejectedStart?.reason).toBe("revoked");
      expect(result.data.apps[0]?.attentionReasons).toContain("last_rejected_start");
    }
  });
  test("an older live Core refuses observation and keeps status in attention", async () => {
    const oldKey = `${appInstancePrefix("core")}old`;
    await appInstanceRegistry().upsert({
      key: oldKey,
      value: { appId: "core", instanceId: "old", hostname: "old", startedAt: NOW, entries: {} },
    });
    try {
      const result = await beginAppMigrationObservation({ actor }, replica);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.status).toBe(409);
      const checked = await status();
      expect(checked.ok && checked.data.registryIssues.some((issue) => issue.reason === "core_legacy_evidence_missing")).toBe(true);
    } finally {
      await appInstanceRegistry().delete({ key: oldKey });
    }
  });
  test("legacy evidence coalesces concurrent calls, skips locked rows and retains conservative coverage", async () => {
    const writer = new SQL(database.url);
    const contender = new SQL(database.url);
    let unlock!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const released = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    try {
      await replica`UPDATE auth.app_migration_legacy SET last_used_at = NULL WHERE path = 'bearer'`;
      const holding = replica.begin(async (tx) => {
        await tx`SELECT path FROM auth.app_migration_legacy WHERE path = 'bearer' FOR UPDATE`;
        locked();
        await released;
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([ready, holding]);
        const results = await Promise.race([
          Promise.allSettled(Array.from({ length: 20 }, () => recordLegacyAppUse("bearer", writer))),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Evidence queued behind row lock")), 1_000);
          }),
        ]);
        expect(results.every((result) => result.status === "rejected")).toBe(true);
      } finally {
        clearTimeout(timer);
        unlock();
        await holding;
      }
      await Promise.all(Array.from({ length: 20 }, () => recordLegacyAppUse("bearer", writer)));
      const [before] = await replica<{ at: Date }[]>`SELECT last_used_at AS at FROM auth.app_migration_legacy WHERE path = 'bearer'`;
      expect((await readAppMigrationObservation(1)).complete).toBe(false);
      await writer.close();
      // Requests within committed coverage do not depend on another evidence write succeeding.
      await recordLegacyAppUse("bearer", writer);
      await replica.begin(async (tx) => {
        await tx`SELECT path FROM auth.app_migration_legacy WHERE path = 'bearer' FOR UPDATE`;
        await recordLegacyAppUse("bearer", contender);
      });
      const [after] = await replica<{ at: Date }[]>`SELECT last_used_at AS at FROM auth.app_migration_legacy WHERE path = 'bearer'`;
      expect(after?.at).toEqual(before?.at);
    } finally {
      await writer.close();
      await contender.close();
    }
  });
  test("a hanging app cannot starve a healthy probe or prevent a JSON status response", async () => {
    const hanging = await appKeys.register({ actor, appId: "hang", publicKey: APP_KEY_FIXTURES[0].publicKey });
    if (!hanging.ok) throw new Error(hanging.error.message);
    const instanceKey = `${appInstancePrefix("hang")}one`;
    const snapshot = await appInstanceRegistry().snapshot({ prefix: appInstancePrefix("acme") });
    const metadata = snapshot.entries[0]?.value.bootstrap;
    if (!metadata) throw new Error("Missing fixture metadata");
    const hangingServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        new Promise<Response>((resolve) => {
          const aborted = () => resolve(new Response(null, { status: 499 }));
          if (request.signal.aborted) aborted();
          else request.signal.addEventListener("abort", aborted, { once: true });
        }),
    });
    try {
      await appRegistry().upsert({
        key: "apps/hang",
        value: {
          id: "hang",
          name: "Hang",
          description: "Hanging fixture",
          icon: "ti ti-app",
          baseUrl: hangingServer.url.origin,
          routes: ["/hang"],
        },
      });
      await appInstanceRegistry().upsert({
        key: instanceKey,
        value: {
          appId: "hang",
          instanceId: "one",
          hostname: "test",
          startedAt: NOW,
          entries: {},
          bootstrap: { ...metadata, keyId: hanging.data.keyId },
        },
      });
      const routes = createAdminAppKeyRoutes(async (c, next) => {
        c.set("user", {
          ...actor,
          profile: "user",
          givenname: "",
          sn: "",
          displayName: "",
          mail: null,
          avatarHash: null,
          memberofGroup: [],
          memberofGroupIds: [],
          manages: [],
          managesGroupIds: [],
          accountExpires: null,
          lastLoginLocal: null,
          ipa: null,
        });
        await next();
      });
      const response = await routes.request("/status?windowSeconds=86400", { method: "POST" });
      expect(response.status).toBe(200);
      const result = AppMigrationStatusSchema.parse(await response.json());
      expect(result.apps.find((app) => app.appId === "hang")?.attentionReasons).toContain(`probe_timeout:${hanging.data.keyId}`);
      expect(result.apps.find((app) => app.appId === "acme")?.probes[0]?.broker).toBe(true);
    } finally {
      await hangingServer.stop(true);
      await appRegistry().delete({ key: "apps/hang" });
      await appInstanceRegistry().delete({ key: instanceKey });
    }
  }, 5_000);
});
