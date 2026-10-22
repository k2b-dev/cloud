import { expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import type { AppRegistryEntry } from "../contracts/registry";
import type { AuthContext, RequestAuthority } from "../server/middleware/auth";
import { buildAdminGroups } from "../ssr/admin-navigation";
import { hasDedicatedRuntimeRoute, visibleNavigationApps, visiblePanelProviders, visiblePwaParts } from "../ssr/app-navigation";
import { getDisplayRuntimeContext, getRuntimeContext, preloadDisplayApps } from "../ssr/runtime";
import * as access from "./app-access";
import { discoverableAppEntries, discoverableApps } from "./app-discovery";
import { buildProjectedUser } from "./session/user";

const user = buildProjectedUser({ id: "11111111-1111-4111-8111-111111111111", provider: "local", profile: "user", effective_admin: false });
const authority: RequestAuthority = {
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId: user.id },
  credentialKind: "session",
  scopes: [],
};
const app = (id: string, access?: AppRegistryEntry["access"]): AppRegistryEntry => ({
  id,
  access,
  name: id,
  description: id,
  icon: "ti ti-apps",
  baseUrl: "http://test.invalid",
  routes: [`/pwa/${id}`, `/app/${id}`],
  nav: { href: `/app/${id}`, section: "primary" },
  pwa: { href: `/pwa/${id}` },
  panel: { href: `/app/${id}/panel`, label: id, icon: "ti ti-apps" },
  searchLinks: [{ href: `/app/${id}/secret`, label: `${id} content` }],
});

test("discovery preserves legacy apps, applies declared access, and retains finer UI constraints", async () => {
  const apps = [
    app("legacy"),
    app("allowed", { kind: "signedIn" }),
    app("denied", { kind: "roles", roles: ["admin"] }),
    { ...app("finer", { kind: "signedIn" }), nav: { href: "/app/finer", section: "primary" as const, requiresRoles: ["admin" as const] } },
  ];
  const visible = await discoverableApps(authority, apps);
  expect(visible.map((entry) => entry.id)).toEqual(["legacy", "allowed", "finer"]);
  expect(visibleNavigationApps(visible, user).map((entry) => entry.id)).toEqual(["legacy", "allowed"]);
  expect(visiblePwaParts(visible, user, "en").map((entry) => entry.id)).toEqual(["allowed", "finer", "legacy"]);
  expect(visiblePanelProviders(visible, user, "en").map((entry) => entry.id)).toEqual(["allowed", "finer", "legacy"]);
  expect((await discoverableApps(null, apps)).map((entry) => entry.id)).toEqual(["legacy"]);
});

test("one batch receives the original resolved authority and filters every record owned by a denied app", async () => {
  const apps = [app("one", { kind: "grants" }), app("two", { kind: "grants" })];
  const resolve = spyOn(access, "usableAppIds").mockResolvedValue(new Set(["one"]));
  let reads = 0;
  try {
    const entries = [
      { appId: "one", content: "first" },
      { appId: "two", content: "hidden" },
      { appId: "one", content: "second" },
    ];
    expect(
      await discoverableAppEntries(authority, entries, async () => {
        reads++;
        return apps;
      }),
    ).toEqual([entries[0]!, entries[2]!]);
    expect(reads).toBe(1);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]?.[0]).toBe(authority);
    expect(resolve.mock.calls[0]?.[1]).toEqual(apps);
  } finally {
    resolve.mockRestore();
  }
});

test("SSR preloads display access after authentication while retaining the complete routing runtime", async () => {
  const apps = [app("legacy"), app("denied", { kind: "roles", roles: ["admin"] })];
  const server = new Hono<AuthContext & { Variables: { runtime: { apps: AppRegistryEntry[] } } }>()
    .use(async (c, next) => {
      c.set("actor", authority.actor);
      c.set("accessSubject", authority.accessSubject);
      c.set("credentialKind", authority.credentialKind);
      c.set("runtime", { apps });
      await next();
    })
    .get("/", async (c) => {
      await preloadDisplayApps(c);
      return c.json({
        routing: getRuntimeContext(c).apps.map((app) => app.id),
        display: getDisplayRuntimeContext(c).apps.map((app) => app.id),
      });
    });
  expect(await (await server.request("/")).json()).toEqual({ routing: ["legacy", "denied"], display: ["legacy"] });
});

test("administration navigation hides app-owned destinations without a use grant", async () => {
  const admin = { ...user, roles: ["admin" as const] };
  const hidden = {
    ...app("hidden", { kind: "grants" }),
    adminHref: "/admin/hidden",
    routes: ["/admin/gateway", "/admin/observability"],
    adminNav: [{ label: "Hidden app", links: [{ href: "/admin/hidden", label: "Hidden destination", icon: "ti ti-lock" }] }],
  };
  const resolver = spyOn(access, "usableAppIds").mockResolvedValue(new Set(["legacy"]));
  try {
    const server = new Hono<AuthContext & { Variables: { runtime: { apps: AppRegistryEntry[] } } }>()
      .use(async (c, next) => {
        c.set("actor", { kind: "user", user: admin });
        c.set("accessSubject", { type: "user", userId: user.id });
        c.set("credentialKind", "session");
        c.set("runtime", { apps: [app("legacy"), hidden] });
        await preloadDisplayApps(c);
        await next();
      })
      .get("/", (c) => {
        const visible = getDisplayRuntimeContext(c).apps;
        expect(hasDedicatedRuntimeRoute(visible, "/admin/gateway", "core")).toBe(false);
        expect(hasDedicatedRuntimeRoute(visible, "/admin/observability", "core")).toBe(false);
        return c.json(buildAdminGroups(visible));
      });
    const text = await (await server.request("/")).text();
    expect(text).not.toContain("Hidden");
    expect(text).not.toContain("/admin/hidden");
    expect(text).toContain("/admin");
  } finally {
    resolver.mockRestore();
  }
});
