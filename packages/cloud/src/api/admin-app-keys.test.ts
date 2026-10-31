import { expect, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import type { MiddlewareHandler } from "hono";
import { generateSpecs } from "hono-openapi";
import { APP_KEY_FIXTURES, INSTALLATION_ID, KEY_ID } from "../../../../scripts/fixtures/app-key-fixtures";
import type { AuthContext } from "../server";
import { appKeys } from "../services/app-keys";
import { createAdminAppKeyRoutes } from "./admin-app-keys";

const actor: AuthContext["Variables"]["user"] = {
  id: INSTALLATION_ID,
  uid: "admin",
  provider: "local",
  roles: ["admin"],
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
};
// Only the authentication seam is replaced; service authorization has its own guards below.
const authenticate: MiddlewareHandler<AuthContext> = async (c, next) => {
  c.set("user", actor);
  await next();
};
const calls: unknown[] = [];
const service: typeof appKeys = {
  register: async (input) => {
    calls.push(input);
    return ok({
      installationId: INSTALLATION_ID,
      keyId: KEY_ID,
      fingerprint: APP_KEY_FIXTURES[0].fingerprint,
      status: "active",
      accountStatus: "active",
    });
  },
  list: async () =>
    ok({ installationId: INSTALLATION_ID, lastRejectedStart: null, items: [], page: 1, perPage: 100, total: 0, hasNext: false }),
  listApps: async () => ok({ installationId: INSTALLATION_ID, items: [], page: 1, perPage: 100, total: 0, hasNext: false }),
  revoke: async (input) => {
    calls.push(input);
    return ok();
  },
};
const request = (path: string, method = "GET", body?: unknown) =>
  new Request(`http://test${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

test("admin routes expose installation, register and revoke exact app keys with private responses disabled", async () => {
  const routes = createAdminAppKeyRoutes(authenticate, service);
  const response = await routes.request(request("/oauth/keys", "POST", { publicKey: APP_KEY_FIXTURES[0].publicKey, name: "Deploy" }));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.json()).toEqual({
    installationId: INSTALLATION_ID,
    keyId: KEY_ID,
    fingerprint: APP_KEY_FIXTURES[0].fingerprint,
    status: "active",
    accountStatus: "active",
  });
  expect(calls.at(-1)).toMatchObject({ appId: "oauth", actor, publicKey: APP_KEY_FIXTURES[0].publicKey });
  expect((await routes.request(request("/keys"))).status).toBe(200);
  expect((await routes.request(request("/not-running/keys"))).status).toBe(200);
  expect((await routes.request(request(`/not-running/keys/${KEY_ID}`, "DELETE"))).status).toBe(200);
  expect(calls.at(-1)).toMatchObject({ appId: "not-running", keyId: KEY_ID });
});

test("invalid app IDs, reserved IDs, payloads and pagination never reach the service", async () => {
  const routes = createAdminAppKeyRoutes(authenticate, service);
  const before = calls.length;
  for (const id of ["core", "gateway", "Bad", "bad_app"])
    expect((await routes.request(request(`/${id}/keys`, "POST", { publicKey: APP_KEY_FIXTURES[0].publicKey }))).status).toBe(400);
  expect((await routes.request(request("/inventory/keys", "POST", { publicKey: "bad" }))).status).toBe(400);
  expect(
    (await routes.request(request("/inventory/keys", "POST", { publicKey: APP_KEY_FIXTURES[0].publicKey, seed: "must-not-reach-service" })))
      .status,
  ).toBe(400);
  for (const grants of [["unknown"], ["oauth:issue", "oauth:issue"], "oauth:issue"])
    expect((await routes.request(request("/inventory/keys", "POST", { publicKey: APP_KEY_FIXTURES[0].publicKey, grants }))).status).toBe(
      400,
    );
  expect((await routes.request(request("/keys?perPage=501"))).status).toBe(400);
  expect(calls.length).toBe(before);
});

test("anonymous and non-admin requests cannot use the production admin middleware", async () => {
  const routes = createAdminAppKeyRoutes();
  expect((await routes.request(request("/keys"))).status).toBe(401);
  const nonAdmin = createAdminAppKeyRoutes(async (c, next) => {
    c.set("user", { ...actor, roles: ["user"] });
    return next();
  });
  // The owning service enforces admin permission independently of route middleware.
  const response = await nonAdmin.request(request("/keys"));
  expect(response.status).toBe(403);
});

test("all app-key service mutations and reads reject non-admin actors before data access", async () => {
  const user: typeof actor = { ...actor, roles: ["user"] };
  for (const result of [
    await appKeys.register({ actor: user, appId: "inventory", publicKey: APP_KEY_FIXTURES[0].publicKey }),
    await appKeys.list({ actor: user, appId: "inventory" }),
    await appKeys.listApps({ actor: user }),
    await appKeys.revoke({ actor: user, appId: "inventory", keyId: KEY_ID }),
  ]) {
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.status).toBe(403);
  }
});

test("OAuth read scope cannot mutate app keys even with an admin role", async () => {
  const routes = createAdminAppKeyRoutes(async (c, next) => {
    c.set("user", actor);
    c.set("oauthScopes", ["read"]);
    await next();
  }, service);
  const before = calls.length;
  expect((await routes.request(request("/oauth/keys", "POST", { publicKey: APP_KEY_FIXTURES[0].publicKey }))).status).toBe(403);
  expect((await routes.request(request(`/oauth/keys/${KEY_ID}`, "DELETE"))).status).toBe(403);
  expect(calls.length).toBe(before);
});

test("enrollment passes explicit grant and empty grant choices to the owning service", async () => {
  const routes = createAdminAppKeyRoutes(authenticate, service);
  for (const grants of [["oauth:issue"], []]) {
    const response = await routes.request(request("/acme-oauth/keys", "POST", { publicKey: APP_KEY_FIXTURES[0].publicKey, grants }));
    expect(response.status).toBe(200);
    expect(calls.at(-1)).toMatchObject({ appId: "acme-oauth", grants });
  }
});

test("the admin key-list OpenAPI response declares the nullable rejection and its closed reason enum", async () => {
  const spec = await generateSpecs(createAdminAppKeyRoutes(authenticate, service));
  const response = spec.paths?.["/{appId}/keys"]?.get?.responses?.["200"];
  expect(response).toBeDefined();
  const schema = JSON.stringify(response);
  expect(schema).toContain('"lastRejectedStart"');
  expect(schema).toContain('"connections_not_permitted"');
  expect(schema).toContain('"revoked"');
  expect(schema).toContain('"expired"');
  expect(schema).toContain('"disabled"');
  expect(schema).toContain('"keyId"');
});
