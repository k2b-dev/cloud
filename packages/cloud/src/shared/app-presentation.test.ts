import { describe, expect, test } from "bun:test";
import type { AppMeta } from "../contracts/app";
import { resolveAppPresentation } from "./app-presentation";

const app: AppMeta = {
  id: "inventory",
  name: "Inventory",
  icon: "ti ti-package",
  description: "Track inventory.",
  routes: ["/app/inventory"],
  adminNav: [{ id: "inventory", label: "Inventory", links: [{ label: "Settings", href: "/admin/inventory", icon: "ti-settings" }] }],
  legalLinks: [{ label: "Inventory terms", href: "/legal/inventory" }],
  presentation: {
    baseLocale: "en",
    translations: {
      de: {
        name: "Inventar",
        description: "Inventar verwalten.",
        adminGroups: { inventory: "Inventar" },
        adminLinks: { "/admin/inventory": "Einstellungen" },
        legalLinks: { "/legal/inventory": "Inventarbedingungen" },
      },
      "de-CH": { description: "Schweizer Inventar verwalten." },
    },
  },
};

describe("app presentation", () => {
  test("resolves exact and ancestor overlays without changing stable metadata", () => {
    const resolved = resolveAppPresentation(app, "de-CH");
    expect(resolved).toMatchObject({
      id: "inventory",
      name: "Inventar",
      description: "Schweizer Inventar verwalten.",
      routes: ["/app/inventory"],
      adminNav: [{ id: "inventory", label: "Inventar", links: [{ label: "Einstellungen", href: "/admin/inventory" }] }],
      legalLinks: [{ label: "Inventarbedingungen", href: "/legal/inventory" }],
    });
    expect(app.name).toBe("Inventory");
  });

  test("falls back to the complete base presentation", () => {
    expect(resolveAppPresentation(app, "fr")).toBe(app);
  });
});
