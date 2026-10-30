import { describe, expect, test } from "bun:test";
import type { AppRegistryDetail } from "@k2b/cloud";
import type { AuthContext } from "@k2b/cloud/server";
import { Hono } from "hono";
import { adminAuthority } from "../../../scripts/fixtures/app-status";
import { createAdminAppListingRoutes } from "./api/admin-app-listing";
import { removeAppListing } from "./app-listing";

const live: AppRegistryDetail = {
  id: "mail",
  name: "Mail",
  icon: "ti ti-mail",
  description: "Mail",
  baseUrl: "http://mail.test",
  routes: ["/app/mail"],
  createdAt: 1,
  updatedAt: 2,
  expiresAt: 3,
  version: "1",
};
const dependencies = () => {
  const effects: string[] = [];
  return {
    effects,
    registry: async () => ({ apps: [] as AppRegistryDetail[], issues: [] }),
    providers: async () => [{ appId: "monitor", name: "Monitor" }],
    keepVisible: async () => {
      effects.push("visible");
    },
    hide: async () => {
      effects.push("hide");
    },
    forget: async () => {
      effects.push("forget");
      return { failures: [] as unknown[] };
    },
  };
};
const params = () => ({ authority: adminAuthority(), appId: "mail", locale: "de" });

describe("offline app listing removal", () => {
  test("rejects running apps before any effect", async () => {
    const service = dependencies();
    const result = await removeAppListing(params(), { ...service, registry: async () => ({ apps: [live], issues: [] }) });
    expect(result).toMatchObject({ ok: false, status: 409, code: "app_running" });
    expect(service.effects).toEqual([]);
  });
  test("retains an anchor and does not hide after partial provider failure", async () => {
    const service = dependencies();
    const result = await removeAppListing(params(), {
      ...service,
      forget: async (input) => {
        expect(input.requiredProviders).toEqual([{ appId: "monitor", name: "Monitor" }]);
        return { failures: ["offline"] };
      },
    });
    expect(result).toMatchObject({ ok: false, status: 503, code: "forget_failed" });
    expect(service.effects).toEqual(["visible"]);
  });
  test("hides only after successful forget and a fresh live check", async () => {
    const service = dependencies();
    const result = await removeAppListing(params(), service);
    expect(result).toEqual({ ok: true, data: { appId: "mail", hidden: true } });
    expect(service.effects).toEqual(["visible", "forget", "hide"]);
    const restarted = dependencies();
    let reads = 0;
    const running = await removeAppListing(params(), {
      ...restarted,
      registry: async () => ({ apps: ++reads === 2 ? [live] : [], issues: [] }),
    });
    expect(running).toMatchObject({ status: 409, code: "app_running" });
    expect(restarted.effects).toEqual(["visible", "forget"]);
  });
  test("refuses uncertain registry state and cancelled operations", async () => {
    const service = dependencies();
    const result = await removeAppListing(params(), {
      ...service,
      registry: async () => ({ apps: [], issues: [{ key: "apps/mail", version: "1", reason: "unreadable" }] }),
    });
    expect(result).toMatchObject({ status: 503, code: "forget_failed" });
    expect(service.effects).toEqual([]);
    const controller = new AbortController();
    controller.abort();
    expect(await removeAppListing({ ...params(), signal: controller.signal }, service)).toMatchObject({ code: "forget_failed" });
    expect(service.effects).toEqual([]);
  });
  test("enforces administrator and OAuth write authority at the service and route", async () => {
    const service = dependencies();
    const input = params();
    if (input.authority.actor.kind === "user") input.authority.actor.user.roles = [];
    expect(await removeAppListing(input, service)).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(service.effects).toEqual([]);
    const authority = { ...adminAuthority(), credentialKind: "oauth" as const, scopes: ["read"] };
    expect(await removeAppListing({ ...params(), authority }, service)).toMatchObject({ status: 403, code: "FORBIDDEN" });
    const invoked = adminAuthority();
    invoked.credentialKind = "invocation";
    invoked.scopes = ["read"];
    invoked.actor.delegation = { kind: "invocation", callingAppId: "monitor", credentialKind: "oauth", invocationId: "test" };
    expect(await removeAppListing({ ...params(), authority: invoked }, service)).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(service.effects).toEqual([]);
    const route = new Hono<AuthContext>().route(
      "/api/admin/apps",
      createAdminAppListingRoutes(
        async (c, next) => {
          c.set("actor", authority.actor);
          c.set("accessSubject", authority.accessSubject);
          c.set("credentialKind", authority.credentialKind);
          c.set("credentialScopes", authority.scopes);
          c.set("oauthScopes", authority.scopes);
          return next();
        },
        (input) => removeAppListing(input, service),
      ),
    );
    expect((await route.request("/api/admin/apps/mail/listing", { method: "DELETE" })).status).toBe(403);
    const anonymous = new Hono().route("/api/admin/apps", createAdminAppListingRoutes());
    expect((await anonymous.request("/api/admin/apps/mail/listing", { method: "DELETE" })).status).toBe(401);
  });
  test("listing middleware leaves sibling app-key reads alone", async () => {
    const authority = { ...adminAuthority(), credentialKind: "oauth" as const, scopes: ["read"] };
    const routes = createAdminAppListingRoutes(async (c, next) => {
      c.set("actor", authority.actor);
      c.set("accessSubject", authority.accessSubject);
      c.set("credentialKind", "oauth");
      c.set("oauthScopes", ["read"]);
      return next();
    });
    const route = new Hono<AuthContext>().route("/api/admin/apps", routes).get("/api/admin/apps/:appId/keys", (c) => c.json({ keys: [] }));
    expect((await route.request("/api/admin/apps/mail/keys")).status).toBe(200);
  });
  test("route returns stable errors with no-store and no-transform", async () => {
    const input = params();
    const service = dependencies();
    const route = new Hono<AuthContext>().route(
      "/api/admin/apps",
      createAdminAppListingRoutes(
        async (c, next) => {
          c.set("actor", input.authority.actor);
          c.set("accessSubject", input.authority.accessSubject);
          c.set("credentialKind", "session");
          return next();
        },
        (input) => removeAppListing(input, { ...service, forget: async () => ({ failures: ["unavailable"] }) }),
      ),
    );
    const response = await route.request("/api/admin/apps/mail/listing", { method: "DELETE" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "forget_failed" });
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Cache-Control")).toContain("no-transform");
  });
});
