import { describe, expect, test } from "bun:test";
import { visibleNavigationApps } from "../ssr/app-navigation";
import { type AppOptions, defineApp } from "./define-app";
import { inventory, person, publishedEntry } from "./define-app.fixture";
import { validateAppRegistryEntry } from "./registry-validation";
import { buildRuntimeFromRegistry } from "./runtime-context";

const nav = { href: "/app/inventory", section: "primary" } satisfies AppOptions["nav"];

describe("defineApp({ nav: { badge } })", () => {
  test("publishes the badge route with the navigation entry", async () => {
    const options = { ...inventory, nav: { ...nav, badge: "/api/inventory/badge" } } satisfies AppOptions;
    expect(defineApp(options).meta.nav?.badge).toBe("/api/inventory/badge");
    const entry = await publishedEntry(options);
    expect(entry.nav?.badge).toBe("/api/inventory/badge");
    expect(validateAppRegistryEntry(entry)).toBeNull();
    const [app] = visibleNavigationApps(buildRuntimeFromRegistry([entry]).apps, person);
    expect(app?.nav.badge).toBe("/api/inventory/badge");
  });

  test("an app without a badge publishes none", async () => {
    const entry = await publishedEntry({ ...inventory, nav });
    expect(entry.nav).not.toHaveProperty("badge");
    expect(buildRuntimeFromRegistry([entry]).apps[0]?.nav?.badge).toBeUndefined();
  });

  test("the badge must be a same-origin path the app itself serves", () => {
    for (const badge of [
      "/api/core/badge",
      "/api/inventory-other/badge",
      "/api/inventory/../core/badge",
      "api/inventory/badge",
      "//evil.example/api/inventory/badge",
      "https://evil.example/api/inventory/badge",
      "/api/inventory/ badge",
    ]) {
      expect(() => defineApp({ ...inventory, nav: { ...nav, badge } })).toThrow(`App "inventory" declares nav.badge "${badge}"`);
    }
    expect(defineApp({ ...inventory, nav: { ...nav, badge: "/api/inventory" } }).meta.nav?.badge).toBe("/api/inventory");
    expect(defineApp({ ...inventory, nav: { ...nav, badge: "/app/inventory/badge?view=all" } }).meta.nav?.badge).toBe(
      "/app/inventory/badge?view=all",
    );
  });
});
