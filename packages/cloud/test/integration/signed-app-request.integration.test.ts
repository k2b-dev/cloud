import { afterAll, beforeAll, expect, jest, test } from "bun:test";
import { authenticateSignedAppRequest } from "@k2b/cloud/api";
import type { AppKey } from "@k2b/cloud/app-key";
import { mandates } from "@k2b/cloud/services";
import { authenticateBootstrap } from "@k2b/cloud/services/app-bootstrap";
import { appKeys } from "@k2b/cloud/services/app-keys";
import { SQL, sql } from "bun";
import { Hono } from "hono";
import { decodeJwt, generateKeyPair } from "jose";
import { APP_KEY_FIXTURES } from "../../../../scripts/fixtures/app-key-fixtures";
import { requireInfra, suiteFor, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { createIdentityInvocationRoutes } from "../../../core/src/api/identity-invocation";
import { createIdentityMandateRoutes } from "../../../core/src/api/identity-mandates";
import { createIdentityOAuthIssuanceRoutes } from "../../../core/src/api/identity-oauth-issuance";
import { migrateAppBootstrap } from "../../../core/src/migrate/core/app-bootstrap";
import { migrate as migrateAudit } from "../../../core/src/migrate/core/audit";
import { migrate as migrateAuth } from "../../../core/src/migrate/core/auth";
import { migrate as migrateSettings } from "../../../core/src/migrate/core/settings";
import { BOOTSTRAP_PATH, signAppProof, signBootstrapProof } from "../../src/runtime/bootstrap-protocol";

const NOW = Date.UTC(2030, 0, 2, 3, 4, 5);
const actor = {
  id: "33333333-3333-4333-8333-333333333333",
  uid: "signed-app-admin",
  provider: "local" as const,
  roles: ["admin"] as ["admin"],
};
const path = "/api/_internal/identity/v1/invoke";
const encode = (body: string) => new TextEncoder().encode(body);
suiteFor(
  "database",
  "valkey",
  "nats",
)("signed app requests, shared Core replicas", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  let replicas: [SQL, SQL];
  let key: AppKey;
  let oauthKey: AppKey;
  let routes: [Hono, Hono];
  const admitted = async () => ({ limited: false, remaining: 1, resetIn: 1000 });
  beforeAll(async () => {
    await requireInfra("database", "valkey", "nats");
    database = await useFreshDatabase("cloud_signed_workload_requests");
    await migrateAuth();
    await migrateAudit();
    await migrateSettings();
    await migrateAppBootstrap();
    await sql`INSERT INTO auth.users (id, uid, provider, profile, admin) VALUES (${actor.id}::uuid, ${actor.uid}, 'local', 'user', true)`;
    const enroll = async (appId: string, fixture: { seed: string; publicKey: string } = APP_KEY_FIXTURES[0]) => {
      const result = await appKeys.register({ actor, appId, publicKey: fixture.publicKey });
      if (!result.ok) throw new Error(result.error.message);
      return { appId, keyId: result.data.keyId, installationId: result.data.installationId, seed: fixture.seed };
    };
    key = await enroll("mail");
    oauthKey = await enroll("oauth", APP_KEY_FIXTURES[1]);
    replicas = [new SQL(database.url), new SQL(database.url)];
    const makeRoutes = (db: SQL) =>
      new Hono().all("*", async (c) => {
        const scope = c.req.path.includes("/oauth/") ? "oauth:issue" : "identity:invoke";
        const authenticated = await authenticateSignedAppRequest(c, scope, { db, ingress: admitted, admit: admitted });
        if (authenticated instanceof Response) return authenticated;
        // The domain still reads the identical body, and sees its own idempotency key.
        return c.json({ authenticated, body: c.req.method === "GET" ? null : await c.req.json() });
      });
    routes = [makeRoutes(replicas[0]), makeRoutes(replicas[1])];
    jest.setSystemTime(NOW);
  }, 30_000);
  afterAll(async () => {
    jest.useRealTimers();
    await Promise.all(replicas?.map((db) => db.close()) ?? []);
    await sql.close();
    await database?.drop();
  });
  const signed = async (appKey: AppKey, body: string, method = "POST", target = path) => {
    const proof = await signAppProof(appKey, { method, path: target, body: encode(body) });
    return {
      proof,
      init: {
        method,
        headers: { authorization: `Bearer ${proof}`, "x-cloud-app-id": appKey.appId, "content-type": "application/json" },
        ...(method === "GET" ? {} : { body }),
      },
    };
  };

  test("two different requests in one run and a lost-response retry consume distinct proofs, preserving domain idempotency", async () => {
    const first = await signed(key, JSON.stringify({ runId: "run-1", idempotencyKey: "effect-1", input: "one" }));
    const retry = await signed(key, JSON.stringify({ runId: "run-1", idempotencyKey: "effect-1", input: "one" }));
    const second = await signed(key, JSON.stringify({ runId: "run-1", idempotencyKey: "effect-2", input: "two" }));
    const replies = [];
    for (const request of [first, retry, second]) {
      const response = await routes[0].request(path, request.init);
      expect(response.status).toBe(200);
      replies.push(await response.json());
    }
    expect(replies[0].body).toEqual(replies[1].body);
    expect(replies[2].body.input).toBe("two");
    expect(replies[0].authenticated).toMatchObject({ appId: "mail", credentialId: key.keyId, scope: "identity:invoke" });
    expect(new Set([first, retry, second].map(({ proof }) => decodeJwt(proof).jti)).size).toBe(3);
    const responses = await Promise.all(routes.map((route) => route.request(path, first.init)));
    expect(responses.map((response) => response.status)).toEqual([403, 403]);
    const fresh = await signed(key, "{}");
    const concurrent = await Promise.all(routes.map((route) => route.request(path, fresh.init)));
    expect(concurrent.map((response) => response.status).sort()).toEqual([200, 403]);
  });

  test("changed method, target, query, body and declared app are rejected before domain work", async () => {
    for (const changed of ["method", "target", "query", "body", "app"] as const) {
      const request = await signed(key, '{ "input": "one" }');
      const target = changed === "target" ? path + "/other" : changed === "query" ? path + "?changed=1" : path;
      const response = await routes[0].request(target, {
        ...request.init,
        method: changed === "method" ? "PUT" : "POST",
        body: changed === "body" ? '{"input":"one"}' : request.init.body,
        headers: { ...request.init.headers, "x-cloud-app-id": changed === "app" ? "chat" : "mail" },
      });
      expect(response.status).toBe(changed === "app" ? 403 : 401);
    }
  });

  test("only oauth keys carry oauth:issue", async () => {
    const target = "/api/_internal/identity/v1/oauth/token";
    const denied = await signed(key, "{}", "POST", target);
    const response = await routes[0].request(target, denied.init);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: "scope_not_permitted", message: "App is not permitted to issue OAuth credentials" });
    const allowed = await signed(oauthKey, "{}", "POST", target);
    expect((await routes[0].request(target, allowed.init)).status).toBe(200);
  });

  test("Core OAuth, invocation and mandate routes accept signed requests without legacy credentials", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    let signerCalls = 0;
    const routes = new Hono()
      .route(
        "/api/_internal/identity/v1",
        createIdentityOAuthIssuanceRoutes({
          authenticate: () => {
            throw new Error("Signed OAuth must not use the legacy broker");
          },
          withActiveSigner: async (_purpose, use) => {
            signerCalls++;
            return use({ kid: "signed-test", key: privateKey, signUntil: new Date(NOW + 60_000), issuer: "https://cloud.test" }, sql);
          },
        }),
      )
      .route(
        "/api/_internal/identity/v1",
        createIdentityInvocationRoutes({
          authenticateWorkload: async () => {
            throw new Error("Signed invocation must not use legacy authentication");
          },
        }),
      )
      .route(
        "/api/_internal/identity/v1",
        createIdentityMandateRoutes({
          authenticateWorkload: async () => {
            throw new Error("Signed mandate must not use legacy authentication");
          },
          service: { ...mandates, get: async () => null },
        }),
      );
    const readyPath = "/api/_internal/identity/v1/oauth/ready";
    const ready = await signed(oauthKey, "", "POST", readyPath);
    expect((await routes.request(readyPath, ready.init)).status).toBe(204);
    expect(signerCalls).toBe(1);
    const denied = await signed(key, "", "POST", readyPath);
    expect((await routes.request(readyPath, denied.init)).status).toBe(403);
    expect(signerCalls).toBe(1);
    const malformed = await signed(key, "{}");
    expect((await routes.request(path, malformed.init)).status).toBe(400);
    const mandatePath = "/api/_internal/identity/v1/mandates/44444444-4444-4444-8444-444444444444";
    const missing = await signed(key, "", "GET", mandatePath);
    expect((await routes.request(mandatePath, missing.init)).status).toBe(404);
  });

  test("connections_allowed=false still signs, but cannot bootstrap", async () => {
    await sql`UPDATE auth.service_account_credentials SET connections_allowed=false WHERE id=${key.keyId}::uuid`;
    try {
      const request = await signed(key, "{}");
      expect((await routes[1].request(path, request.init)).status).toBe(200);
      await expect(
        authenticateBootstrap(await signBootstrapProof(key), { method: "POST", path: BOOTSTRAP_PATH, body: encode("{}") }, replicas[0]),
      ).rejects.toMatchObject({ code: "connections_not_permitted" });
    } finally {
      await sql`UPDATE auth.service_account_credentials SET connections_allowed=true WHERE id=${key.keyId}::uuid`;
    }
  });

  test("revocation is immediate on both warm replicas", async () => {
    const request = await signed(oauthKey, "{}");
    expect((await routes[0].request(path, request.init)).status).toBe(200);
    const pending = await signed(oauthKey, "{}");
    const revoked = await appKeys.revoke({ actor, appId: "oauth", keyId: oauthKey.keyId });
    expect(revoked.ok).toBe(true);
    for (const route of routes) expect((await route.request(path, pending.init)).status).toBe(401);
  });
});
