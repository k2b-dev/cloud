import { afterAll, beforeAll, expect, jest, test } from "bun:test";
import { createAdminAppKeyRoutes, createAppBootstrapRoutes } from "@k2b/cloud/api";
import { type AppKey, formatAppKey, importAppKeySeed } from "@k2b/cloud/app-key";
import { authenticateAppProof, cleanupBootstrapProofs } from "@k2b/cloud/services/app-bootstrap";
import { appKeys, getActiveAppKey, getInstallationId } from "@k2b/cloud/services/app-keys";
import { get as getSetting, set as setSetting } from "@k2b/cloud/services/settings";
import { SQL } from "bun";
import { decodeJwt, SignJWT } from "jose";
import { APP_KEY_FIXTURES } from "../../../../scripts/fixtures/app-key-fixtures";
import { requireInfra, suiteFor, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { migrateAppBootstrap } from "../../../core/src/migrate/core/app-bootstrap";
import { migrate as migrateAudit } from "../../../core/src/migrate/core/audit";
import { migrate as migrateAuth } from "../../../core/src/migrate/core/auth";
import { migrate as migrateSettings } from "../../../core/src/migrate/core/settings";
import { platformStartFixture } from "../../scripts/platform-start.test-fixture";
import { bootstrapConnections } from "../../src/runtime/bootstrap-client";
import {
  BOOTSTRAP_BODY,
  BOOTSTRAP_PATH,
  bootstrapBodyDigest,
  signAppProof,
  signBootstrapProof,
} from "../../src/runtime/bootstrap-protocol";
import { sql } from "../../src/runtime/clients";

const NOW = Date.UTC(2030, 0, 2, 3, 4, 5);
const actor = {
  id: "33333333-3333-4333-8333-333333333333",
  uid: "bootstrap-admin",
  provider: "local" as const,
  roles: ["admin"] as ["admin"],
};
suiteFor(
  "database",
  "valkey",
  "nats",
)("Core signed bootstrap, two replicas sharing Postgres", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  let replicas: [SQL, SQL];
  let key: AppKey;
  let routes: [ReturnType<typeof createAppBootstrapRoutes>, ReturnType<typeof createAppBootstrapRoutes>];
  const ingress = async (_: unknown, next: () => Promise<void>) => next();
  const admit = async () => ({ limited: false, remaining: 1, resetIn: 1000 });
  const request = (proof: string, body = BOOTSTRAP_BODY) => ({
    method: "POST",
    headers: { Authorization: `Bearer ${proof}`, "Content-Type": "application/json" },
    body,
  });
  beforeAll(async () => {
    await requireInfra("database", "valkey", "nats");
    database = await useFreshDatabase("cloud_app_bootstrap");
    await migrateAuth();
    await migrateAudit();
    await migrateSettings();
    await migrateAppBootstrap();
    await migrateAppBootstrap();
    await sql`INSERT INTO auth.users (id, uid, provider, profile, admin) VALUES (${actor.id}::uuid, ${actor.uid}, 'local', 'user', true)`;
    const registered = await appKeys.register({ actor, appId: "inventory", publicKey: APP_KEY_FIXTURES[0].publicKey });
    if (!registered.ok) throw new Error(registered.error.message);
    key = {
      installationId: registered.data.installationId,
      keyId: registered.data.keyId,
      appId: "inventory",
      seed: APP_KEY_FIXTURES[0].seed,
    };
    replicas = [new SQL(database.url), new SQL(database.url)];
    routes = [createAppBootstrapRoutes({ db: replicas[0], ingress, admit }), createAppBootstrapRoutes({ db: replicas[1], ingress, admit })];
    jest.setSystemTime(NOW);
  }, 30_000);
  afterAll(async () => {
    jest.useRealTimers();
    await Promise.all(replicas?.map((db) => db.close()) ?? []);
    await sql.close();
    await database?.drop();
  });

  test("two Core replicas admit exactly one parallel copy; retries use a fresh proof and touch last_used_at", async () => {
    const proof = await signBootstrapProof(key);
    const responses = await Promise.all(routes.map((route) => route.request(BOOTSTRAP_PATH, request(proof))));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 403]);
    const accepted = responses.find((response) => response.status === 200)!;
    expect(accepted.headers.get("Cache-Control")).toBe("no-store");
    const payload = await accepted.json();
    expect(payload.identity).toEqual({ installationId: await getInstallationId(), appId: key.appId, keyId: key.keyId });
    expect(payload.connections.database.url).toBe(database.url);
    const [row] = await sql`SELECT last_used_at FROM auth.service_account_credentials WHERE id = ${key.keyId}::uuid`;
    expect(row?.last_used_at).toBeInstanceOf(Date);
    const [replay] = await sql`SELECT extract(epoch FROM retain_until)::bigint AS until FROM auth.app_proof_replays
      WHERE key_id = ${key.keyId}::uuid AND jti = ${decodeJwt(proof).jti!}`;
    expect(Number(replay?.until)).toBe(NOW / 1000 + 30 + 300);
    expect((await routes[1].request(BOOTSTRAP_PATH, request(await signBootstrapProof(key)))).status).toBe(200);
  });

  test("connections_allowed defaults true and denied keys fail on both replicas after signature verification", async () => {
    const [row] = await sql`SELECT connections_allowed FROM auth.service_account_credentials WHERE id = ${key.keyId}::uuid`;
    expect(row?.connections_allowed).toBe(true);
    const proof = await signBootstrapProof(key);
    await sql`UPDATE auth.service_account_credentials SET connections_allowed = false WHERE id = ${key.keyId}::uuid`;
    try {
      expect((await getActiveAppKey(key))?.connectionsAllowed).toBe(false);
      for (const route of routes) {
        const denied = await route.request(BOOTSTRAP_PATH, request(proof));
        expect(denied.status).toBe(403);
        expect(await denied.json()).toEqual({ code: "connections_not_permitted" });
        expect(denied.headers.get("Cache-Control")).toBe("no-store");
      }
      const invalid = await signBootstrapProof({ ...key, seed: APP_KEY_FIXTURES[1].seed });
      expect((await routes[0].request(BOOTSTRAP_PATH, request(invalid))).status).toBe(401);
      const [replay] = await sql`SELECT count(*)::int AS n FROM auth.app_proof_replays WHERE key_id = ${key.keyId}::uuid
        AND jti = ${decodeJwt(proof).jti!}`;
      expect(replay?.n).toBe(0);
    } finally {
      await sql`UPDATE auth.service_account_credentials SET connections_allowed = true WHERE id = ${key.keyId}::uuid`;
    }
    expect((await routes[1].request(BOOTSTRAP_PATH, request(proof))).status).toBe(200);
  });

  test("runner key cannot bootstrap even with connections_allowed, but can sign run acquisition", async () => {
    const enrolled = await appKeys.register({ actor, appId: "runner", publicKey: APP_KEY_FIXTURES[2].publicKey });
    if (!enrolled.ok) throw new Error(enrolled.error.message);
    const runnerKey: AppKey = {
      appId: "runner",
      keyId: enrolled.data.keyId,
      installationId: enrolled.data.installationId,
      seed: APP_KEY_FIXTURES[2].seed,
    };
    await sql`UPDATE auth.service_account_credentials SET connections_allowed = true WHERE id = ${runnerKey.keyId}::uuid`;
    for (const route of routes) {
      const response = await route.request(BOOTSTRAP_PATH, request(await signBootstrapProof(runnerKey)));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: "connections_not_permitted" });
    }
    const body = new TextEncoder().encode(JSON.stringify({ instanceId: "33333333-3333-4333-8333-333333333333", freeSlots: 2 }));
    const runRequest = { method: "POST", path: "/_internal/code/runner/fetch", body };
    const verified = await authenticateAppProof(await signAppProof(runnerKey, runRequest), runRequest);
    expect(verified.identity.appId).toBe("runner");
  });

  const lastRejectedStart = async () => {
    const result = await appKeys.list({ actor, appId: key.appId });
    if (!result.ok) throw new Error(result.error.message);
    return result.data.lastRejectedStart;
  };
  const keyApi = () =>
    createAdminAppKeyRoutes(async (c, next) => {
      c.set("user", {
        ...actor,
        profile: "user",
        givenname: "",
        sn: "",
        displayName: "Admin",
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
  let rejectionNonce = 0;
  const rejectionProof = async (claims = {}, identity = key, seed = identity.seed) =>
    new SignJWT({
      iss: identity.appId,
      sub: identity.appId,
      aud: `cloud-core:${identity.installationId}`,
      iat: NOW / 1000,
      exp: NOW / 1000 + 30,
      jti: `rejection-test-${++rejectionNonce}`,
      htm: "POST",
      htu: BOOTSTRAP_PATH,
      bdh: await bootstrapBodyDigest(new TextEncoder().encode(BOOTSTRAP_BODY)),
      ...claims,
    })
      .setProtectedHeader({ alg: "EdDSA", typ: "cloud-app+jwt", kid: identity.keyId })
      .sign(await importAppKeySeed(seed));
  const resetKey = async () => {
    await sql`UPDATE auth.service_account_credentials SET status = 'active', revoked_at = NULL, expires_at = NULL, connections_allowed = true
      WHERE id = ${key.keyId}::uuid`;
    await sql`UPDATE auth.service_accounts SET status = 'active' WHERE id = (
      SELECT service_account_id FROM auth.service_account_credentials WHERE id = ${key.keyId}::uuid)`;
  };

  test("verified refusals upsert all four reasons, preserve caller responses and clear after successful bootstrap", async () => {
    expect(await lastRejectedStart()).toBeNull();
    const empty = await keyApi().request(`/${key.appId}/keys`);
    expect(empty.status).toBe(200);
    expect((await empty.json()).lastRejectedStart).toBeNull();
    for (const reason of ["revoked", "expired", "disabled", "connections_not_permitted"] as const) {
      await resetKey();
      const proof = await rejectionProof();
      if (reason === "revoked")
        await sql`UPDATE auth.service_account_credentials SET status = 'revoked', revoked_at = now() WHERE id = ${key.keyId}::uuid`;
      if (reason === "expired")
        await sql`UPDATE auth.service_account_credentials SET expires_at = now() - interval '1 second' WHERE id = ${key.keyId}::uuid`;
      if (reason === "disabled")
        await sql`UPDATE auth.service_accounts SET status = 'disabled' WHERE id = (
        SELECT service_account_id FROM auth.service_account_credentials WHERE id = ${key.keyId}::uuid)`;
      if (reason === "connections_not_permitted")
        await sql`UPDATE auth.service_account_credentials SET connections_allowed = false WHERE id = ${key.keyId}::uuid`;
      try {
        const denied = await routes[0].request(BOOTSTRAP_PATH, request(proof));
        expect(denied.status).toBe(reason === "connections_not_permitted" ? 403 : 401);
        expect(await denied.json()).toEqual({ code: reason === "connections_not_permitted" ? reason : "invalid_proof" });
        expect(denied.headers.get("Cache-Control")).toBe("no-store");
        const rejection = await lastRejectedStart();
        expect(rejection).toMatchObject({ reason, keyId: key.keyId });
        expect(new Date(rejection!.at).toISOString()).toBe(rejection!.at);
        const response = await keyApi().request(`/${key.appId}/keys?page=2&perPage=1`);
        expect(response.status).toBe(200);
        expect((await response.json()).lastRejectedStart).toEqual(rejection);
        expect((await sql`SELECT app_id FROM auth.app_start_rejections WHERE app_id = ${key.appId}`).length).toBe(1);
        expect(
          (await sql`SELECT jti FROM auth.app_proof_replays WHERE key_id = ${key.keyId}::uuid AND jti = ${decodeJwt(proof).jti!}`).length,
        ).toBe(0);
      } finally {
        await resetKey();
      }
    }
    expect((await routes[1].request(BOOTSTRAP_PATH, request(await rejectionProof()))).status).toBe(200);
    expect(await lastRejectedStart()).toBeNull();
  });

  test("unverified claims, unknown keys and replay cannot create or replace rejection state", async () => {
    const consumed = await rejectionProof();
    expect((await routes[0].request(BOOTSTRAP_PATH, request(consumed))).status).toBe(200);
    await sql`UPDATE auth.service_account_credentials SET status = 'revoked', revoked_at = now() WHERE id = ${key.keyId}::uuid`;
    try {
      const variants = [
        rejectionProof({}, { ...key, keyId: "55555555-5555-4555-8555-555555555555" }),
        rejectionProof({}, key, APP_KEY_FIXTURES[1].seed),
        rejectionProof({ iss: "foreign-app", sub: "foreign-app" }),
        rejectionProof({ sub: "foreign-app" }),
        rejectionProof({ aud: "cloud-core:44444444-4444-4444-8444-444444444444" }),
        rejectionProof({ htm: "GET" }),
        rejectionProof({ htu: "/elsewhere" }),
        rejectionProof({ bdh: "wrong" }),
        rejectionProof({ iat: NOW / 1000 + 3 }),
        rejectionProof({ exp: NOW / 1000 }),
        rejectionProof({ exp: NOW / 1000 + 31 }),
        rejectionProof({ jti: "" }),
        rejectionProof({ jti: "x".repeat(65) }),
        rejectionProof({ jti: "null\0nonce" }),
        Promise.resolve("malformed"),
        Promise.resolve(consumed),
      ];
      const proofs = await Promise.all(variants);
      for (const prior of [null, "recorded"] as const) {
        if (prior) expect((await routes[0].request(BOOTSTRAP_PATH, request(await rejectionProof()))).status).toBe(401);
        const before = await lastRejectedStart();
        for (const proof of proofs) {
          const denied = await routes[1].request(BOOTSTRAP_PATH, request(proof));
          expect(denied.status).toBe(401);
          expect(await denied.json()).toEqual({ code: "invalid_proof" });
          expect(await lastRejectedStart()).toEqual(before);
        }
      }
    } finally {
      await resetKey();
    }
    expect((await routes[0].request(BOOTSTRAP_PATH, request(await rejectionProof()))).status).toBe(200);
    expect(await lastRejectedStart()).toBeNull();
  });

  test("an active connection-denied key must still prove every claim before recording", async () => {
    await sql`UPDATE auth.service_account_credentials SET connections_allowed = false WHERE id = ${key.keyId}::uuid`;
    try {
      const variants = [
        { proof: await rejectionProof({}, key, APP_KEY_FIXTURES[1].seed), code: "invalid_proof", status: 401 },
        {
          proof: await rejectionProof({ aud: "cloud-core:44444444-4444-4444-8444-444444444444" }),
          code: "wrong_installation",
          status: 403,
        },
        { proof: await rejectionProof({ sub: "foreign-app" }), code: "wrong_app", status: 403 },
        { proof: await rejectionProof({ bdh: "wrong" }), code: "invalid_proof", status: 401 },
      ];
      for (const variant of variants) {
        const response = await routes[0].request(BOOTSTRAP_PATH, request(variant.proof));
        expect(response.status).toBe(variant.status);
        expect(await response.json()).toEqual({ code: variant.code });
        expect(await lastRejectedStart()).toBeNull();
      }
    } finally {
      await resetKey();
    }
  });

  test("a consumed proof with a now-disallowed connection grant does not record a refusal", async () => {
    const proof = await rejectionProof();
    expect((await routes[0].request(BOOTSTRAP_PATH, request(proof))).status).toBe(200);
    await sql`UPDATE auth.service_account_credentials SET connections_allowed = false WHERE id = ${key.keyId}::uuid`;
    try {
      const response = await routes[1].request(BOOTSTRAP_PATH, request(proof));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: "connections_not_permitted" });
      expect(await lastRejectedStart()).toBeNull();
    } finally {
      await resetKey();
    }
  });

  test("signed non-bootstrap requests never record starts or clear a previous refusal", async () => {
    const body = new TextEncoder().encode(BOOTSTRAP_BODY);
    await sql`UPDATE auth.service_account_credentials SET connections_allowed = false WHERE id = ${key.keyId}::uuid`;
    try {
      await authenticateAppProof(await rejectionProof({ htu: "/api/platform/capabilities" }), {
        method: "POST",
        path: "/api/platform/capabilities",
        body,
      });
      expect(await lastRejectedStart()).toBeNull();
      expect((await routes[0].request(BOOTSTRAP_PATH, request(await rejectionProof()))).status).toBe(403);
      const before = await lastRejectedStart();
      await authenticateAppProof(await rejectionProof({ htu: "/api/platform/capabilities" }), {
        method: "POST",
        path: "/api/platform/capabilities",
        body,
      });
      expect(await lastRejectedStart()).toEqual(before);
      await sql`UPDATE auth.service_account_credentials SET status = 'revoked', revoked_at = now() WHERE id = ${key.keyId}::uuid`;
      await expect(
        authenticateAppProof(await rejectionProof({ htu: "/api/platform/capabilities" }), {
          method: "POST",
          path: "/api/platform/capabilities",
          body,
        }),
      ).rejects.toMatchObject({
        code: "invalid_proof",
      });
      expect(await lastRejectedStart()).toEqual(before);
    } finally {
      await resetKey();
    }
    expect((await routes[0].request(BOOTSTRAP_PATH, request(await rejectionProof()))).status).toBe(200);
  });

  test("failed or limited diagnostic admission and failed writes preserve the original refusal", async () => {
    await sql`UPDATE auth.service_account_credentials SET connections_allowed = false WHERE id = ${key.keyId}::uuid`;
    try {
      for (const down of [false, true]) {
        const route = createAppBootstrapRoutes({
          db: replicas[0],
          ingress,
          admit: async () => {
            if (down) throw new Error("Admission unavailable");
            return { limited: true, remaining: 0, resetIn: 1000 };
          },
        });
        const response = await route.request(BOOTSTRAP_PATH, request(await rejectionProof()));
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ code: "connections_not_permitted" });
        expect(await lastRejectedStart()).toBeNull();
      }
      await sql`ALTER TABLE auth.app_start_rejections RENAME TO app_start_rejections_unavailable`;
      try {
        const response = await routes[0].request(BOOTSTRAP_PATH, request(await rejectionProof()));
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ code: "connections_not_permitted" });
      } finally {
        await sql`ALTER TABLE auth.app_start_rejections_unavailable RENAME TO app_start_rejections`;
      }
      expect(await lastRejectedStart()).toBeNull();
    } finally {
      await resetKey();
    }
  });

  test("a failed diagnostic clear does not block an otherwise successful bootstrap", async () => {
    await sql`ALTER TABLE auth.app_start_rejections RENAME TO app_start_rejections_unavailable`;
    try {
      const response = await routes[0].request(BOOTSTRAP_PATH, request(await rejectionProof()));
      expect(response.status).toBe(200);
      expect((await response.json()).identity.keyId).toBe(key.keyId);
    } finally {
      await sql`ALTER TABLE auth.app_start_rejections_unavailable RENAME TO app_start_rejections`;
    }
  });

  test("directly inserted app keys on other account kinds or bindings are rejected like unknown keys", async () => {
    const bindings = [
      { kind: "standalone", appId: null, resourceType: null, resourceId: null, delegated: null },
      { kind: "agent", appId: null, resourceType: null, resourceId: null, delegated: null },
      { kind: "user_delegated", appId: null, resourceType: null, resourceId: null, delegated: actor.id },
      { kind: "resource_bound", appId: "inventory", resourceType: "file", resourceId: "inventory", delegated: null },
      { kind: "resource_bound", appId: "inventory", resourceType: "cloud.app", resourceId: "other", delegated: null },
      { kind: "resource_bound", appId: "other", resourceType: "cloud.app", resourceId: "inventory", delegated: null },
    ];
    for (const binding of bindings) {
      const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts
        (name, kind, app_id, resource_type, resource_id, delegated_user_id)
        VALUES (${`bootstrap-denied-${binding.kind}`}, ${binding.kind}, ${binding.appId}, ${binding.resourceType},
          ${binding.resourceId}, ${binding.delegated}::uuid) RETURNING id`;
      if (!account) throw new Error("Missing test account");
      try {
        const [credential] = await sql<{ id: string }[]>`INSERT INTO auth.service_account_credentials
          (service_account_id, name, kind, public_key, fingerprint)
          SELECT ${account.id}::uuid, 'test key', 'app_key', public_key, fingerprint
          FROM auth.service_account_credentials WHERE id = ${key.keyId}::uuid RETURNING id`;
        if (!credential) throw new Error("Missing test credential");
        const proof = await signBootstrapProof({ ...key, keyId: credential.id });
        for (const route of routes) {
          const denied = await route.request(BOOTSTRAP_PATH, request(proof));
          expect(denied.status).toBe(401);
          expect(await denied.json()).toEqual({ code: "invalid_proof" });
        }
      } finally {
        await sql`DELETE FROM auth.service_accounts WHERE id = ${account.id}::uuid`;
      }
    }
  });

  test("a lost HTTP response retries with a fresh proof accepted on the other replica", async () => {
    let attempt = 0;
    const result = await bootstrapConnections(key, "http://core.test", {
      log: () => {},
      random: () => 0,
      fetch: async (_, init) => {
        const response = await routes[attempt++ % 2]!.request(BOOTSTRAP_PATH, init);
        if (attempt === 1) {
          await response.body?.cancel();
          throw new Error("lost response");
        }
        return response;
      },
    });
    expect(attempt).toBe(2);
    expect(result.identity.keyId).toBe(key.keyId);
  });

  test("a cold Core listener and a temporarily unavailable warm Core recover through real HTTP retries", async () => {
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = reservation.port!;
    await reservation.stop(true);
    let server: ReturnType<typeof Bun.serve> | undefined;
    let requests = 0;
    try {
      const result = await bootstrapConnections(key, `http://127.0.0.1:${port}`, {
        log: () => {},
        random: () => 0.5,
        sleep: async () => {
          if (!server)
            server = Bun.serve({
              hostname: "127.0.0.1",
              port,
              fetch: async (request) => {
                if (++requests === 1) return new Response(null, { status: 503, headers: { "Retry-After": "1" } });
                return routes[1].fetch(request);
              },
            });
        },
      });
      expect(result.identity.keyId).toBe(key.keyId);
      expect(requests).toBe(2);
    } finally {
      await server?.stop(true);
    }
  });

  test("proof predicates reject changed body, method, path, lifetime, clock, app, installation and header", async () => {
    const valid = decodeJwt(await signBootstrapProof(key));
    const variants = [
      { claims: { htm: "GET" } },
      { claims: { htu: "/different" } },
      { claims: { sub: "other" } },
      { claims: { aud: "cloud-core:44444444-4444-4444-8444-444444444444" } },
      { claims: { exp: NOW / 1000 + 31 } },
      { claims: { iat: NOW / 1000 + 3, exp: NOW / 1000 + 30 } },
      { claims: { exp: NOW / 1000 } },
      { claims: { jti: "x".repeat(65) } },
      { claims: { bdh: await bootstrapBodyDigest(new TextEncoder().encode("[]")) } },
      { claims: {}, typ: "JWT" },
    ];
    for (const variant of variants) {
      const proof = await new SignJWT({ ...valid, jti: crypto.randomUUID(), ...variant.claims })
        .setProtectedHeader({ alg: "EdDSA", typ: variant.typ ?? "cloud-app+jwt", kid: key.keyId })
        .sign(await importAppKeySeed(key.seed));
      expect([401, 403]).toContain((await routes[0].request(BOOTSTRAP_PATH, request(proof))).status);
      const [count] =
        await sql`SELECT count(*)::int AS n FROM auth.app_proof_replays WHERE key_id = ${key.keyId}::uuid AND jti = ${decodeJwt(proof).jti!}`;
      expect(count?.n).toBe(0);
    }
    const wrongKey = await signBootstrapProof({ ...key, seed: APP_KEY_FIXTURES[1].seed });
    expect((await routes[0].request(BOOTSTRAP_PATH, request(wrongKey))).status).toBe(401);
    expect((await routes[0].request(`${BOOTSTRAP_PATH}?query=1`, request(await signBootstrapProof(key)))).status).toBe(400);
  });

  test("body limits precede even invalid proofs and ingress limits still apply to unauthenticated requests", async () => {
    let ingressCalls = 0;
    const route = createAppBootstrapRoutes({
      db: replicas[0],
      admit,
      ingress: async (c) => {
        ingressCalls++;
        return c.json({ code: "limited" }, 429);
      },
    });
    expect((await route.request(BOOTSTRAP_PATH, request("invalid", "xxx"))).status).toBe(413);
    expect(ingressCalls).toBe(0);
    expect((await route.request(BOOTSTRAP_PATH, request("invalid"))).status).toBe(429);
    const forged = { ...request("invalid", "xxx"), headers: { "Content-Length": "2" } };
    expect((await route.request(BOOTSTRAP_PATH, forged)).status).toBe(413);
    expect(ingressCalls).toBe(1);
    const streamed = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("123"));
        controller.close();
      },
    });
    expect((await route.request(BOOTSTRAP_PATH, { method: "POST", body: streamed })).status).toBe(413);
  });

  test("authenticated-key overload and failed Valkey admission leave the nonce unused", async () => {
    for (const down of [false, true]) {
      const route = createAppBootstrapRoutes({
        db: replicas[0],
        ingress,
        admit: async () => {
          if (down) throw new Error("Valkey unavailable PRIVATE");
          return { limited: true, remaining: 0, resetIn: 2000 };
        },
      });
      const proof = await signBootstrapProof(key);
      const result = await route.request(BOOTSTRAP_PATH, request(proof));
      expect(result.status).toBe(down ? 503 : 429);
      expect(result.headers.get("Cache-Control")).toBe("no-store");
      expect(result.headers.get("Retry-After")).toBe(down ? "1" : "2");
      expect(await result.text()).not.toContain("PRIVATE");
      const [replay] = await sql`SELECT count(*)::int AS n FROM auth.app_proof_replays WHERE key_id = ${key.keyId}::uuid
        AND jti = ${decodeJwt(proof).jti!}`;
      expect(replay?.n).toBe(0);
      const retried = await Promise.all(routes.map((replica) => replica.request(BOOTSTRAP_PATH, request(proof))));
      expect(retried.map((response) => response.status).sort()).toEqual([200, 403]);
    }
  });

  test("production ingress and authenticated-key admission use the shared Valkey budget", async () => {
    const route = createAppBootstrapRoutes({ db: replicas[0] });
    expect((await route.request(BOOTSTRAP_PATH, request("invalid"))).status).toBe(401);
    expect((await route.request(BOOTSTRAP_PATH, request(await signBootstrapProof(key)))).status).toBe(200);
  });

  test("direct ingress budgets use the socket peer independently of forwarded headers", async () => {
    const previous = await getSetting<number>("security.rate_limit_per_second");
    const route = createAppBootstrapRoutes({ db: replicas[0] });
    const peer = { requestIP: () => ({ address: "203.0.113.99", family: "IPv4", port: 12345 }) };
    try {
      await setSetting("security.rate_limit_per_second", 1);
      for (const [index, forwarded] of ["198.51.100.10", "198.51.100.11"].entries()) {
        const init = request("invalid");
        const response = await route.request(
          BOOTSTRAP_PATH,
          {
            ...init,
            headers: { ...init.headers, "X-Forwarded-For": forwarded, "X-Real-IP": forwarded },
          },
          peer,
        );
        expect(response.status).toBe(index === 0 ? 401 : 429);
      }
    } finally {
      await setSetting("security.rate_limit_per_second", previous);
    }
  });

  test("a packed custom server and dev preload use only a key and Core origin, then serve HTTP, WebSocket and readiness", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: routes[0].fetch });
    try {
      await platformStartFixture({ bootstrap: { key: formatAppKey(key), origin: `http://127.0.0.1:${server.port}`, now: NOW } });
    } finally {
      await server.stop(true);
    }
  }, 90_000);

  test("retention cleanup preserves unexpired records", async () => {
    const proof = await signBootstrapProof(key);
    await routes[0].request(BOOTSTRAP_PATH, request(proof));
    const jti = decodeJwt(proof).jti!;
    await sql`UPDATE auth.app_proof_replays SET retain_until = now() + interval '1 minute' WHERE key_id = ${key.keyId}::uuid AND jti = ${jti}`;
    await cleanupBootstrapProofs();
    expect((await sql`SELECT jti FROM auth.app_proof_replays WHERE key_id = ${key.keyId}::uuid AND jti = ${jti}`).length).toBe(1);
    await sql`UPDATE auth.app_proof_replays SET retain_until = now() - interval '1 minute' WHERE key_id = ${key.keyId}::uuid AND jti = ${jti}`;
    await cleanupBootstrapProofs();
    expect((await sql`SELECT jti FROM auth.app_proof_replays WHERE key_id = ${key.keyId}::uuid AND jti = ${jti}`).length).toBe(0);
  });

  test("nonce cleanup drains multiple pages, caps work at the admission budget and honours cancellation", async () => {
    const previous = await getSetting<number>("security.rate_limit_per_second");
    const seedExpired = async (count: number) => {
      await sql`INSERT INTO auth.app_proof_replays (key_id, jti, retain_until)
        SELECT ${key.keyId}::uuid, 'cleanup-' || n::text, now() - interval '1 minute' FROM generate_series(1, ${count}::int) AS n`;
    };
    try {
      await sql`DELETE FROM auth.app_proof_replays`;
      await seedExpired(350);
      expect(await cleanupBootstrapProofs()).toEqual({ deleted: 350, remaining: 0 });
      await setSetting("security.rate_limit_per_second", 1);
      await seedExpired(250);
      const cancelled = new AbortController();
      cancelled.abort(new Error("cleanup cancelled"));
      await expect(cleanupBootstrapProofs(sql, { signal: cancelled.signal })).rejects.toThrow("cleanup cancelled");
      const [unchanged] = await sql`SELECT count(*)::int AS n FROM auth.app_proof_replays WHERE retain_until <= now()`;
      expect(unchanged?.n).toBe(250);
      expect(await cleanupBootstrapProofs()).toEqual({ deleted: 120, remaining: 130 });
      expect(await cleanupBootstrapProofs()).toEqual({ deleted: 120, remaining: 10 });
      expect(await cleanupBootstrapProofs()).toEqual({ deleted: 10, remaining: 0 });
    } finally {
      await setSetting("security.rate_limit_per_second", previous);
      await sql`DELETE FROM auth.app_proof_replays WHERE key_id = ${key.keyId}::uuid AND jti LIKE 'cleanup-%'`;
    }
  });

  test("nonce cleanup stops before the next batch when maintenance is cancelled", async () => {
    await sql`INSERT INTO auth.app_proof_replays (key_id, jti, retain_until)
      SELECT ${key.keyId}::uuid, 'cancel-' || n::text, now() - interval '1 minute' FROM generate_series(1, 350) AS n`;
    const lock = await replicas[0].reserve();
    const controller = new AbortController();
    let pending: Promise<boolean> | undefined;
    let released = false;
    try {
      await lock`BEGIN`;
      await lock`LOCK TABLE auth.app_proof_replays IN ACCESS EXCLUSIVE MODE`;
      pending = cleanupBootstrapProofs(replicas[1], { signal: controller.signal }).then(
        () => false,
        () => true,
      );
      let waiting = false;
      const deadline = performance.now() + 3000;
      while (!waiting && performance.now() < deadline) {
        const [row] = await sql`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE '%WITH batch AS MATERIALIZED%'
        ) AS waiting`;
        waiting = row?.waiting === true;
        if (!waiting) await Bun.sleep(10);
      }
      expect(waiting).toBe(true);
      controller.abort();
      // Cancellation is cooperative between bounded batches; release the current statement's table lock.
      await lock`ROLLBACK`;
      lock.release();
      released = true;
      expect(await pending).toBe(true);
      const [rows] = await sql`SELECT count(*)::int AS n FROM auth.app_proof_replays WHERE jti LIKE 'cancel-%'`;
      expect(rows?.n).toBeGreaterThanOrEqual(250);
    } finally {
      controller.abort();
      if (!released) {
        await lock`ROLLBACK`;
        lock.release();
      }
      await pending;
      await sql`DELETE FROM auth.app_proof_replays WHERE jti LIKE 'cancel-%'`;
    }
  }, 10_000);

  test("revocation is immediately effective on both replicas, including a proof signed before revocation", async () => {
    const proofs = await Promise.all([signBootstrapProof(key), signBootstrapProof(key)]);
    const revoked = await appKeys.revoke({ actor, appId: key.appId, keyId: key.keyId });
    expect(revoked.ok).toBe(true);
    for (let i = 0; i < routes.length; i++) expect((await routes[i]!.request(BOOTSTRAP_PATH, request(proofs[i]!))).status).toBe(401);
  });
});
