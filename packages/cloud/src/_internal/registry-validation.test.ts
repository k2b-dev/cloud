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
