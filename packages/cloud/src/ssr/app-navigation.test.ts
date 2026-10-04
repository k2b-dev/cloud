import { describe, expect, test } from "bun:test";
import type { RuntimeAppMeta } from "../contracts/app";
import type { Role, User } from "../contracts/shared";
import { hasDedicatedRuntimeRoute, resolveRuntimeRoute, visibleNavigationApps, visiblePwaParts } from "./app-navigation";

const user = {
  id: "user-id",
  uid: "user",
  roles: ["user", "local", "local/user"],
  provider: "local",
  profile: "user",
  givenname: "Test",
  sn: "User",
  displayName: "Test User",
  mail: "test@example.test",
  avatarHash: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  ipa: null,
} satisfies User;

const apps = [
  {
    id: "public",
    name: "Public",
    icon: "ti ti-world",
    description: "Public app",
    routes: ["/app/public"],
    nav: { href: "/app/public", section: "primary" },
  },
  {
    id: "hidden",
    name: "Hidden",
    icon: "ti ti-eye-off",
    description: "Hidden app",
    routes: ["/app/hidden"],
    nav: { href: "/app/hidden", section: "hidden" },
  },
  {
    id: "admin",
    name: "Admin",
    icon: "ti ti-shield",
    description: "Admin app",
    routes: ["/admin/admin"],
    nav: { href: "/admin/admin", section: "more", requiresRoles: ["admin"] },
  },
] satisfies RuntimeAppMeta[];

describe("visibleNavigationApps", () => {
  test("keeps only apps visible to the current user", () => {
    expect(visibleNavigationApps(apps, user).map((app) => app.id)).toEqual(["public"]);
  });

  test("includes role-gated apps when the user has the role", () => {
    expect(visibleNavigationApps(apps, { ...user, roles: [...user.roles, "admin"] }).map((app) => app.id)).toEqual(["public", "admin"]);
  });
});

describe("visiblePwaParts", () => {
  const part = (id: string, name: string, requiresRoles?: Role[]) =>
    ({
      id,
      name,
      icon: "ti ti-box",
      description: `${name} app`,
      routes: [`/pwa/${id}`],
      pwa: { href: `/pwa/${id}`, requiresRoles },
    }) satisfies RuntimeAppMeta;
  const parts = [
    { ...part("zeiten", "Zeiten"), presentation: { baseLocale: "en", translations: { de: { name: "Arbeitszeit" } } } },
    part("spaces", "Spaces", ["user"]),
    part("guests", "Guest Desk", ["guest"]),
    part("ops", "Operations", ["admin"]),
    // Navigation alone does not make a part.
    ...apps,
  ] satisfies RuntimeAppMeta[];

  test("lists only parts the user may see, sorted by their localized name", () => {
    expect(visiblePwaParts(parts, user, "en").map((app) => app.name)).toEqual(["Spaces", "Zeiten"]);
    expect(visiblePwaParts(parts, user, "de").map((app) => app.name)).toEqual(["Arbeitszeit", "Spaces"]);
  });

  test("shows nothing without a user and applies the guest rule", () => {
    expect(visiblePwaParts(parts, undefined, "en")).toEqual([]);
    expect(visiblePwaParts(parts, { ...user, profile: "guest", roles: ["guest"] }, "en").map((app) => app.id)).toEqual([
      "guests",
      "zeiten",
    ]);
  });

  test("keeps admin parts away from app sessions, which never carry the admin role", () => {
    expect(visiblePwaParts(parts, { ...user, roles: [...user.roles, "admin"] }, "en").map((app) => app.id)).toContain("ops");
    expect(visiblePwaParts(parts, user, "en").map((app) => app.id)).not.toContain("ops");
  });
});

describe("runtime route matching", () => {
  const routeApps = [
    { id: "core", name: "Core", icon: "ti ti-cloud", description: "Core", routes: ["/", "/admin"] },
    {
      id: "gateway-ops",
      name: "Gateway",
      icon: "ti ti-route",
      description: "Gateway",
      routes: ["/admin/gateway", "/admin/observability"],
    },
  ] satisfies RuntimeAppMeta[];

  test("returns the most specific registered route", () => {
    expect(resolveRuntimeRoute(routeApps, "/admin/observability/jobs?window=24h")).toMatchObject({
      app: { id: "gateway-ops" },
      prefix: "/admin/observability",
    });
  });

  test("distinguishes a dedicated cross-app route from the current app fallback", () => {
    expect(hasDedicatedRuntimeRoute(routeApps, "/admin/gateway/apps", "core")).toBe(true);
    expect(hasDedicatedRuntimeRoute(routeApps, "/admin/missing", "core")).toBe(false);
    expect(hasDedicatedRuntimeRoute(routeApps, "/app/missing", "core")).toBe(false);
  });
});
