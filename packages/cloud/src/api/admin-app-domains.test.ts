import { expect, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { APP_KEY_FIXTURES, INSTALLATION_ID, KEY_ID } from "../../../../scripts/fixtures/app-key-fixtures";
import { person } from "../_internal/define-app.test-fixture";
import type { AuthContext } from "../server";
import { appDomains } from "../services/app-domains";
import { appKeys } from "../services/app-keys";
import { createAdminAppDomainRoutes } from "./admin-app-domains";
import { createAdminAppKeyRoutes } from "./admin-app-keys";

const actor = { ...person, roles: ["admin"] as const };
const authenticate: MiddlewareHandler<AuthContext> = async (c, next) => {
  c.set("user", { ...actor, roles: [...actor.roles] });
  return next();
};
const domain = { host: "site.example.test", redirectTo: null, createdAt: "2026-10-30T12:00:00.000Z", active: true, status: null };
const request = (path: string, method = "GET", body?: unknown) =>
  new Request(`https://cloud.example.test${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

test("domain routes expose all admin operations; assignment responds before the first network check completes", async () => {
  const calls: { method: string; input: unknown }[] = [];
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof appDomains.check>>>();
  const service: typeof appDomains = {
    list: async (input) => {
      calls.push({ method: "list", input });
      return ok({ domains: [domain] });
    },
    add: async (input) => {
      calls.push({ method: "add", input });
      return ok(domain);
    },
    set: async (input) => {
      calls.push({ method: "set", input });
      return ok(domain);
    },
    remove: async (input) => {
      calls.push({ method: "remove", input });
      return ok({ deleted: true });
    },
    check: async (input) => {
      calls.push({ method: "check", input });
      return pending.promise;
    },
  };
  const routes = createAdminAppDomainRoutes(authenticate, service);
  try {
    const created = await routes.request(request("/site/domains", "POST", { host: "SITE.example.test" }));
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toContain("no-store");
    expect(await created.json()).toEqual(domain);
    expect(calls).toMatchObject([
      { method: "add", input: { appId: "site", host: "SITE.example.test" } },
      { method: "check", input: { appId: "site", host: domain.host } },
    ]);
    expect((await routes.request(request("/site/domains"))).status).toBe(200);
    expect((await routes.request(request(`/site/domains/${domain.host}`, "PATCH", { redirectTo: null }))).status).toBe(200);
    expect((await routes.request(request(`/site/domains/${domain.host}`, "DELETE"))).status).toBe(200);
    pending.resolve(ok({ status: null }));
    expect(await (await routes.request(request(`/site/domains/${domain.host}/check`, "POST"))).json()).toEqual({ status: null });
  } finally {
    pending.resolve(ok({ status: null }));
  }
});

test("production authentication and service permissions reject anonymous and non-admin callers before storage", async () => {
  const routes = createAdminAppDomainRoutes();
  expect((await routes.request(request("/site/domains"))).status).toBe(401);
  const user = { ...person, roles: ["user"] as typeof person.roles };
  const input = { actor: user, appId: "site", host: domain.host };
  for (const result of [
    await appDomains.list(input),
    await appDomains.add(input),
    await appDomains.set({ ...input, redirectTo: null }),
    await appDomains.remove(input),
    await appDomains.check(input),
  ]) {
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.status).toBe(403);
  }
});

test("OAuth read and write scopes cannot change administrator domain settings", async () => {
  for (const scope of ["read", "write"]) {
    const routes = createAdminAppDomainRoutes(async (c, next) => {
      c.set("user", { ...actor, roles: [...actor.roles] });
      c.set("oauthScopes", [scope]);
      return next();
    });
    for (const [method, path, body] of [
      ["POST", "/site/domains", { host: domain.host }],
      ["PATCH", `/site/domains/${domain.host}`, { redirectTo: null }],
      ["DELETE", `/site/domains/${domain.host}`, undefined],
      ["POST", `/site/domains/${domain.host}/check`, undefined],
    ] as const)
      expect((await routes.request(request(path, method, body))).status).toBe(403);
  }
});

test("domain middleware does not change sibling app administration routes", async () => {
  const keys: typeof appKeys = {
    ...appKeys,
    register: async () =>
      ok({
        installationId: INSTALLATION_ID,
        keyId: KEY_ID,
        fingerprint: APP_KEY_FIXTURES[0].fingerprint,
        status: "active",
        accountStatus: "active",
      }),
    revoke: async () => ok(),
  };
  const routes = new Hono<AuthContext>()
    .use("*", async (c, next) => {
      c.set("oauthScopes", ["write"]);
      return next();
    })
    .route("/apps", createAdminAppDomainRoutes(authenticate))
    .route("/apps", createAdminAppKeyRoutes(authenticate, keys));
  expect((await routes.request(request("/apps/site/keys", "POST", { publicKey: APP_KEY_FIXTURES[0].publicKey }))).status).toBe(200);
  expect((await routes.request(request(`/apps/site/keys/${KEY_ID}`, "DELETE"))).status).toBe(200);
});
