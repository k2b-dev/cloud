import { afterAll, beforeAll, expect, jest, test } from "bun:test";
import { createAppBootstrapRoutes } from "@k2b/cloud/api";
import { type AppKey, formatAppKey, importAppKeySeed } from "@k2b/cloud/app-key";
import { cleanupBootstrapProofs } from "@k2b/cloud/services/app-bootstrap";
import { appKeys, getActiveAppKey, getInstallationId } from "@k2b/cloud/services/app-keys";
import { get as getSetting, set as setSetting } from "@k2b/cloud/services/settings";
import { SQL, sql } from "bun";
import { decodeJwt, SignJWT } from "jose";
import { APP_KEY_FIXTURES } from "../../../../scripts/fixtures/app-key-fixtures";
import { requireInfra, suiteFor, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { migrateAppBootstrap } from "../../../core/src/migrate/core/app-bootstrap";
import { migrate as migrateAudit } from "../../../core/src/migrate/core/audit";
import { migrate as migrateAuth } from "../../../core/src/migrate/core/auth";
import { migrate as migrateSettings } from "../../../core/src/migrate/core/settings";
import { platformStartFixture } from "../../scripts/platform-start.test-fixture";
import { bootstrapConnections } from "../../src/runtime/bootstrap-client";
import { BOOTSTRAP_BODY, BOOTSTRAP_PATH, bootstrapBodyDigest, signBootstrapProof } from "../../src/runtime/bootstrap-protocol";

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

  test("authenticated-key overload consumes the nonce; failed Valkey admission returns retryable 503", async () => {
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
      expect((await routes[1].request(BOOTSTRAP_PATH, request(proof))).status).toBe(403);
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
    await cleanupBootstrapProofs();
    expect((await sql`SELECT jti FROM auth.app_proof_replays WHERE key_id = ${key.keyId}::uuid AND jti = ${jti}`).length).toBe(1);
    await sql`UPDATE auth.app_proof_replays SET retain_until = now() - interval '1 minute' WHERE key_id = ${key.keyId}::uuid AND jti = ${jti}`;
    await cleanupBootstrapProofs();
    expect((await sql`SELECT jti FROM auth.app_proof_replays WHERE key_id = ${key.keyId}::uuid AND jti = ${jti}`).length).toBe(0);
  });

  test("revocation is immediately effective on both replicas, including a proof signed before revocation", async () => {
    const proofs = await Promise.all([signBootstrapProof(key), signBootstrapProof(key)]);
    const revoked = await appKeys.revoke({ actor, appId: key.appId, keyId: key.keyId });
    expect(revoked.ok).toBe(true);
    for (let i = 0; i < routes.length; i++) expect((await routes[i]!.request(BOOTSTRAP_PATH, request(proofs[i]!))).status).toBe(401);
  });
});
