import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import * as bun from "bun";
import { createLocalJWKSet } from "jose";
import { z } from "zod";

// Run this file alone: replacing Bun's default SQL handle ensures preparation,
// guarded transactions, mandates and audits all compete for the SAME real pool.
if (process.env.CLOUD_IDENTITY_POOL_INTEGRATION !== "1") {
  test.skip("single-connection identity issuance integration (opt-in)", () => {});
} else {
  const databaseUrl = new URL(process.env.DATABASE_URL!);
  if (!/^\/cloud_identity_pool_[a-z0-9_]+$/.test(databaseUrl.pathname)) {
    throw new Error("Identity pool integration requires a disposable cloud_identity_pool_ database");
  }
  const pool = new bun.SQL(databaseUrl, { max: 1, connectionTimeout: 5, idleTimeout: 0 });
  mock.module("bun", () => ({ ...bun, sql: pool }));
  const identity = await import("@valentinkolb/cloud/services/identity");
  const runtimeConfig = await import("@valentinkolb/cloud/services/identity/runtime-config");
  const settings = await import("@valentinkolb/cloud/services/settings");
  const { withMandateIssueAuthority } = await import("@valentinkolb/cloud/services/mandates");
  const { dispatchCapability } = await import("@valentinkolb/cloud/api");
  const { compileCapabilityManifest } = await import("@valentinkolb/cloud/capabilities/testing");
  const { defineCapabilities } = await import("@valentinkolb/cloud/contracts");
  const { ok } = await import("@k2b/stdlib");
  const issuer = "https://pool.cloud.example";
  const previousEnvironment = {
    APP_ID: process.env.APP_ID,
    CLOUD_IDENTITY_KEY_ENCRYPTION_KEY: process.env.CLOUD_IDENTITY_KEY_ENCRYPTION_KEY,
    CLOUD_IDENTITY_PREVIOUS_KEY: process.env.CLOUD_IDENTITY_PREVIOUS_KEY,
    CLOUD_IDENTITY_NEXT_KEY: process.env.CLOUD_IDENTITY_NEXT_KEY,
  };
  let settingsReads = 0;
  const settingRead = spyOn(settings, "get").mockImplementation(async <T>(key: string): Promise<T> => {
    settingsReads += 1;
    // Avoid shared Redis settings. A real read on pool1 still reproduces the
    // cold-config deadlock if loading ever moves back inside the transaction.
    const [row] = await pool<{ value: string }[]>`SELECT value FROM settings.entries WHERE key = ${key}`;
    if (!row) throw new Error(`Unexpected identity setting: ${key}`);
    return JSON.parse(row.value) as T;
  });
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  let userId = "";
  let mandateId = "";
  const operation = "capability.query:read";
  const schemaHash = "a".repeat(64);
  const issueInput = (requestId: string) => ({
    mandateId,
    expectedRevision: 1,
    ownerAppId: "mail",
    targetAppId: "spaces",
    operation,
    requestId,
  });
  const sign = (signer: Parameters<Parameters<typeof identity.withActiveIdentitySigner>[1]>[0]) =>
    identity.signInvocationToken({
      targetAppId: "spaces",
      callingAppId: "mail",
      operation,
      schemaHash,
      authority: {
        sub: userId,
        principal_type: "user",
        access_subject_type: "user",
        access_subject_id: userId,
        credential_kind: "mandate",
        scopes: [],
        mandate_id: mandateId,
        mandate_revision: 1,
        workload_type: "pool.test",
        workload_id: "pool-workload",
      },
      signer,
      issuer: signer.issuer,
    });
  const issue = (requestId: string) =>
    identity.withActiveIdentitySigner(
      "invocation",
      (signer, db) => withMandateIssueAuthority(issueInput(requestId), () => sign(signer), { db }),
      { pool },
    );

  describe("identity issuance with one real Postgres connection", () => {
    beforeAll(async () => {
      process.env.APP_ID = "core";
      process.env.CLOUD_IDENTITY_KEY_ENCRYPTION_KEY = "31".repeat(32);
      delete process.env.CLOUD_IDENTITY_PREVIOUS_KEY;
      delete process.env.CLOUD_IDENTITY_NEXT_KEY;
      await (await import("./migrate/core/auth")).migrate();
      await (await import("./migrate/core/audit")).migrate();
      await (await import("./migrate/core/settings")).migrate();
      await (await import("./migrate/core/logging")).migrate();
      await pool`INSERT INTO settings.entries (key, value) VALUES ('app.url', ${JSON.stringify(issuer)}), ('freeipa.groups.admin', '[]')`;
      const [user] = await pool<
        { id: string }[]
      >`INSERT INTO auth.users (uid, provider, profile) VALUES ('pool-owner', 'local', 'user') RETURNING id`;
      userId = user!.id;
      const policy = { version: 1, apps: ["spaces"], operations: [operation], actions: "deny" };
      const [mandate] = await pool<{ id: string }[]>`
        INSERT INTO auth.mandates (subject_kind, subject_user_id, owner_app_id, workload_type, workload_id, policy, created_by_user_id)
        VALUES ('user', ${userId}::uuid, 'mail', 'pool.test', 'pool-workload', ${JSON.stringify(policy)}::jsonb, ${userId}::uuid) RETURNING id
      `;
      mandateId = mandate!.id;
      identity.clearIdentityKeyCachesForTest();
      runtimeConfig.invalidateIdentityRuntimeConfig();
    }, 60_000);

    afterAll(async () => {
      settingRead.mockRestore();
      identity.clearIdentityKeyCachesForTest();
      runtimeConfig.invalidateIdentityRuntimeConfig();
      for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await pool.close({ timeout: 5 });
    });

    test("cold key/config and six concurrent mandates complete on pool max1", async () => {
      expect(pool.options.max).toBe(1);
      const results = await Promise.all(Array.from({ length: 6 }, (_, index) => issue(`cold-${index}`)));
      expect(settingsReads).toBe(2);
      const key = createLocalJWKSet(await identity.listIdentityJwks("invocation"));
      for (const result of results) {
        expect(result.ok).toBeTrue();
        if (!result.ok) throw new Error(result.error.message);
        expect(
          await identity.verifyInvocationToken(result.data.token, { targetAppId: "spaces", operation, schemaHash }, { issuer, key }),
        ).not.toBeNull();
      }
      const [audit] = await pool<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM audit.events WHERE request_id LIKE 'cold-%' AND outcome = 'allowed'`;
      expect(audit?.count).toBe(6);
    }, 15_000);

    test("stale cached key retries outside the single-connection transaction", async () => {
      const stale = await identity.prepareIdentitySigner("invocation");
      await pool`UPDATE auth.signing_keys SET state = 'revoked', revoked_at = now(), revoke_reason = 'remote-replica-test' WHERE kid = ${stale.kid}`;
      const result = await issue("stale-key");
      expect(result.ok).toBeTrue();
      if (!result.ok) throw new Error(result.error.message);
      expect(result.data.kid).not.toBe(stale.kid);
    }, 15_000);

    test("signing failure returns a Result and commits its failure audit", async () => {
      const result = await identity.withActiveIdentitySigner(
        "invocation",
        (signer, db) =>
          withMandateIssueAuthority(
            issueInput("failed-sign"),
            () =>
              identity.signInvocationToken({
                targetAppId: "spaces",
                callingAppId: "mail",
                operation,
                schemaHash: "invalid",
                authority: {
                  sub: userId,
                  principal_type: "user",
                  access_subject_type: "user",
                  access_subject_id: userId,
                  credential_kind: "session",
                  scopes: [],
                },
                signer,
                issuer: signer.issuer,
              }),
            { db },
          ),
        { pool },
      );
      expect(result.ok).toBeFalse();
      if (result.ok) throw new Error("Signing unexpectedly succeeded");
      expect(result.error.code).toBe("INTERNAL");
      const [audit] = await pool<
        { outcome: string; error_code: string }[]
      >`SELECT outcome, error_code FROM audit.events WHERE request_id = 'failed-sign'`;
      expect(audit).toMatchObject({ outcome: "failed", error_code: "INTERNAL" });
    });

    test("real capability dispatch shares pool1 through signing, mandate validation and audit", async () => {
      const definitions = defineCapabilities({
        protocolVersion: 1,
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
      const manifest = compileCapabilityManifest("spaces", definitions);
      let fetches = 0;
      const response = await dispatchCapability({
        request: new Request("http://core.test/invoke", {
          headers: { "x-request-id": "dispatch", authorization: "Bearer source-never-forwarded" },
        }),
        kind: "queries",
        appId: "spaces",
        capabilityId: "read",
        input: { id: "one" },
        mandate: { mandateId, mandateRevision: 1, ownerAppId: "mail" },
        dependencies: {
          queryTimeoutMs: 5_000,
          getCapability: async () => ({
            appId: "spaces",
            appName: "Spaces",
            appIcon: "ti ti-box",
            appDescription: "",
            endpoint: "http://spaces:3000/api/_internal/capabilities/v1",
            manifest,
          }),
          withActiveSigner: (purpose, callback, options) => identity.withActiveIdentitySigner(purpose, callback, { ...options, pool }),
          fetch: async (_url, init) => {
            fetches += 1;
            const bearer = new Headers(init?.headers).get("authorization")!;
            expect(bearer).not.toContain("source-never-forwarded");
            const verified = await identity.verifyInvocationToken(
              bearer.slice(7),
              { targetAppId: "spaces", operation, schemaHash: manifest.queries[0]!.schemaHash },
              { issuer, key: createLocalJWKSet(await identity.listIdentityJwks("invocation")) },
            );
            expect(verified?.mandate_id).toBe(mandateId);
            return Response.json({ data: { id: "one" } });
          },
        },
      });
      expect(response.status).toBe(200);
      expect(fetches).toBe(1);
      expect(await response.json()).toMatchObject({ data: { id: "one" } });

      const failed = await dispatchCapability({
        request: new Request("http://core.test/invoke", { headers: { "x-request-id": "dispatch-failed" } }),
        kind: "queries",
        appId: "spaces",
        capabilityId: "read",
        input: { id: "one" },
        mandate: { mandateId, mandateRevision: 1, ownerAppId: "mail" },
        dependencies: {
          queryTimeoutMs: 5_000,
          getCapability: async () => ({
            appId: "spaces",
            appName: "Spaces",
            appIcon: "ti ti-box",
            appDescription: "",
            endpoint: "http://spaces:3000/api/_internal/capabilities/v1",
            manifest,
          }),
          withActiveSigner: (purpose, callback, options) => identity.withActiveIdentitySigner(purpose, callback, { ...options, pool }),
          signInvocation: (params) => identity.signInvocationToken({ ...params, schemaHash: "invalid" }),
          fetch: async () => {
            fetches += 1;
            return Response.json({ data: { id: "unexpected" } });
          },
        },
      });
      expect(failed.status).toBe(500);
      expect(await failed.json()).toMatchObject({ code: "INTERNAL" });
      expect(fetches).toBe(1);
      const [audit] = await pool<
        { outcome: string; error_code: string }[]
      >`SELECT outcome, error_code FROM audit.events WHERE request_id = 'dispatch-failed'`;
      expect(audit).toMatchObject({ outcome: "failed", error_code: "INTERNAL" });

      const entered = deferred();
      const release = deferred();
      const holder = pool.begin(async (db) => {
        await db`SELECT 1`;
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const abort = new AbortController();
      let signingCalls = 0;
      const cancelled = dispatchCapability({
        request: new Request("http://core.test/invoke", { signal: abort.signal }),
        kind: "queries",
        appId: "spaces",
        capabilityId: "read",
        input: { id: "one" },
        mandate: { mandateId, mandateRevision: 1, ownerAppId: "mail" },
        dependencies: {
          getCapability: async () => ({
            appId: "spaces",
            appName: "Spaces",
            appIcon: "ti ti-box",
            appDescription: "",
            endpoint: "http://spaces:3000/api/_internal/capabilities/v1",
            manifest,
          }),
          withActiveSigner: (purpose, callback, options) => identity.withActiveIdentitySigner(purpose, callback, { ...options, pool }),
          signInvocation: (params) => {
            signingCalls += 1;
            return identity.signInvocationToken(params);
          },
          fetch: async () => {
            fetches += 1;
            return Response.json({ data: { id: "unexpected" } });
          },
        },
      });
      try {
        await Bun.sleep(25);
        abort.abort();
        const cancelledResponse = await Promise.race([cancelled, Bun.sleep(250).then(() => null)]);
        expect(cancelledResponse?.status).toBe(499);
      } finally {
        release.resolve();
        await holder;
      }
      await pool`SELECT 1`;
      expect(signingCalls).toBe(0);
      expect(fetches).toBe(1);
    }, 15_000);

    test("SQL timeout rolls back blocked statements and resets the pooled connection", async () => {
      let signed = false;
      await expect(
        identity.withActiveIdentitySigner(
          "invocation",
          async (signer, db) => {
            await db`SELECT pg_sleep(1)`;
            signed = true;
            return sign(signer);
          },
          { pool, timeoutMs: 50 },
        ),
      ).rejects.toThrow();
      expect(signed).toBeFalse();
      const [settings] = await pool<{ statement_timeout: string }[]>`SHOW statement_timeout`;
      expect(settings?.statement_timeout).toBe("0");
      expect((await issue("after-sql-timeout")).ok).toBeTrue();
    });

    test("SQL key-lock timeout never enters signing and releases the pool", async () => {
      const signer = await identity.prepareIdentitySigner("invocation");
      const lockPool = new bun.SQL(databaseUrl, { max: 1 });
      const entered = deferred();
      const release = deferred();
      const holder = lockPool.begin(async (db) => {
        await db`SELECT kid FROM auth.signing_keys WHERE kid = ${signer.kid} FOR UPDATE`;
        entered.resolve();
        await release.promise;
      });
      let callbacks = 0;
      try {
        await entered.promise;
        await expect(
          identity.withActiveIdentitySigner(
            "invocation",
            async (active) => {
              callbacks += 1;
              return sign(active);
            },
            { pool, timeoutMs: 50 },
          ),
        ).rejects.toThrow();
        expect(callbacks).toBe(0);
        const [settings] = await pool<{ statement_timeout: string }[]>`SHOW statement_timeout`;
        expect(settings?.statement_timeout).toBe("0");
      } finally {
        release.resolve();
        await holder;
        await lockPool.close();
      }
      expect((await issue("after-key-lock-timeout")).ok).toBeTrue();
    });

    test("abort while waiting never invokes the callback and leaves the pool usable", async () => {
      await identity.prepareIdentitySigner("invocation");
      const entered = deferred();
      const release = deferred();
      const holder = pool.begin(async (db) => {
        await db`SELECT 1`;
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const controller = new AbortController();
      let callbacks = 0;
      const pending = identity.withActiveIdentitySigner(
        "invocation",
        async (signer) => {
          callbacks += 1;
          return sign(signer);
        },
        { pool, signal: controller.signal },
      );
      const rejected = pending.then(
        () => false,
        () => true,
      );
      try {
        await Bun.sleep(25);
        controller.abort();
        expect(callbacks).toBe(0);
      } finally {
        release.resolve();
        await holder;
      }
      expect(await rejected).toBeTrue();
      await pool`SELECT 1`;
      expect(callbacks).toBe(0);
      expect((await issue("after-abort")).ok).toBeTrue();
    }, 10_000);
  });
}
