import { describe, expect, test } from "bun:test";
import { validateAppRegistryEntry } from "./registry-validation";

const valid = {
  id: "core",
  name: "Core",
  icon: "cloud",
  description: "Core",
  baseUrl: "http://core:3000",
  routes: ["/", "/auth"],
  runtime: { release: "sha-0123456789ab", syncVersion: "5.9.1" },
};

describe("validateAppRegistryEntry", () => {
  test("accepts a valid entry", () => expect(validateAppRegistryEntry(valid)).toBeNull());
  test("rejects a scalar entry", () => expect(validateAppRegistryEntry("broken")).toBe("entry must be an object"));
  test("rejects invalid routes", () => expect(validateAppRegistryEntry({ ...valid, routes: ["auth"] })).toContain("routes"));
  test("rejects a non-HTTP or credential-bearing base URL", () => {
    expect(validateAppRegistryEntry({ ...valid, baseUrl: "file:///tmp/app" })).toContain("baseUrl");
    expect(validateAppRegistryEntry({ ...valid, baseUrl: "http://user:secret@app:3000" })).toContain("baseUrl");
  });
  test("rejects partial runtime metadata", () =>
    expect(validateAppRegistryEntry({ ...valid, runtime: { release: valid.runtime.release } })).toContain("runtime.syncVersion"));
  test("accepts valid app presentation and rejects malformed translation maps", () => {
    expect(validateAppRegistryEntry({ ...valid, presentation: { baseLocale: "en", translations: { de: { name: "Kern" } } } })).toBeNull();
    expect(validateAppRegistryEntry({ ...valid, presentation: { baseLocale: "en", translations: { de: { adminLinks: [] } } } })).toContain(
      "presentation.translations.de.adminLinks",
    );
  });
  test("accepts a valid Help summary", () =>
    expect(
      validateAppRegistryEntry({
        ...valid,
        help: {
          manifestHash: "sha256",
          pageBase: "/app/core/help",
          baseLocale: "en",
        },
      }),
    ).toBeNull());
  test("accepts a mobile app part only at /pwa/<id>", () => {
    expect(validateAppRegistryEntry({ ...valid, pwa: { href: "/pwa/core" } })).toBeNull();
    expect(validateAppRegistryEntry({ ...valid, pwa: { href: "/pwa/core", requiresRoles: ["user"] } })).toBeNull();
    expect(validateAppRegistryEntry({ ...valid, pwa: { href: "/pwa/spaces" } })).toContain("pwa");
    expect(validateAppRegistryEntry({ ...valid, pwa: { href: "/app/core" } })).toContain("pwa");
    expect(validateAppRegistryEntry({ ...valid, pwa: "/pwa/core" })).toContain("pwa");
    expect(validateAppRegistryEntry({ ...valid, pwa: { href: "/pwa/core", requiresRoles: "user" } })).toContain("pwa.requiresRoles");
  });
  test("accepts a navigation badge only as a same-origin path below the entry's own routes", () => {
    const nav = { href: "/", section: "primary" };
    const reason = "nav.badge must be a same-origin path below one of the entry's routes";
    expect(validateAppRegistryEntry({ ...valid, nav: { ...nav, badge: "/api/core/badge" } })).toBeNull();
    for (const badge of [
      7,
      "api/core/badge",
      "//evil.example/badge",
      "https://evil.example/badge",
      "/api/core/ badge",
      // Even an entry that owns "/" may not name a path the browser sends as "//host/...".
      "/api/..//evil.example/badge",
      "/api/%2e%2e//evil.example/badge",
    ]) {
      expect(validateAppRegistryEntry({ ...valid, nav: { ...nav, badge } })).toBe(reason);
    }
    const inventory = { ...valid, id: "inventory", routes: ["/api/inventory"], nav: { href: "/app/inventory", section: "primary" } };
    expect(validateAppRegistryEntry({ ...inventory, nav: { ...inventory.nav, badge: "/api/inventory/badge" } })).toBeNull();
    for (const badge of ["/api/core/badge", "/api/inventory-other/badge", "/api/inventory/%2e%2e/core/badge"]) {
      expect(validateAppRegistryEntry({ ...inventory, nav: { ...inventory.nav, badge } })).toBe(reason);
    }
  });
  test("rejects a relative Help route", () =>
    expect(
      validateAppRegistryEntry({
        ...valid,
        help: { manifestHash: "sha256", pageBase: "help", documents: [] },
      }),
    ).toContain("help"));
});

test("validates optional outgoing mail permission declarations", () => {
  expect(validateAppRegistryEntry({ ...valid, platformPermissions: ["mail:send"] })).toBeNull();
  expect(validateAppRegistryEntry({ ...valid, platformPermissions: [] })).toBeNull();
  for (const platformPermissions of ["mail:send", ["unknown"], [1]])
    expect(validateAppRegistryEntry({ ...valid, platformPermissions })).toContain("platformPermissions");
});
