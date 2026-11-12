import { expect, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import type { MiddlewareHandler } from "hono";
import { person } from "../_internal/define-app.test-fixture";
import type { AuthContext } from "../server";
import { createAdminSecretsRoutes } from "./admin-secrets";

const authenticate =
  (scopes?: string[]): MiddlewareHandler<AuthContext> =>
  async (c, next) => {
    c.set("user", { ...person, roles: ["admin"] });
    if (scopes) c.set("oauthScopes", scopes);
    return next();
  };

test("status is admin-only, read-scoped, and never caches its registry response", async () => {
  let calls = 0;
  const routes = createAdminSecretsRoutes(authenticate(["read"]), async (input) => {
    calls++;
    expect(input.expect).toEqual(["mail", "gateway"]);
    expect(input.actor.roles).toContain("admin");
    return ok({ checkedAt: "2030-01-02T00:02:00.000Z", current: null, lastRingChange: null, ready: false, registryIssues: [], apps: [] });
  });
  const response = await routes.request("http://test/status?expect=mail,gateway");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
  expect((await response.json()).ready).toBe(false);
  expect(calls).toBe(1);
  expect((await routes.request("http://test/status?expect=../wrong")).status).toBe(400);
  expect((await createAdminSecretsRoutes(authenticate(["write"])).request("http://test/status")).status).toBe(403);
  expect((await createAdminSecretsRoutes().request("http://test/status")).status).toBe(401);
  const nonAdmin = createAdminSecretsRoutes(async (c, next) => {
    c.set("user", person);
    return next();
  });
  expect((await nonAdmin.request("http://test/status")).status).toBe(403);
});
