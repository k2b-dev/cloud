import { describe, expect, test } from "bun:test";
import type { AppMeta } from "../contracts/app";
import { compileAppPresentation } from "./app-presentation";

const app: AppMeta = {
  id: "inventory",
  name: "Inventory",
  icon: "ti ti-package",
  description: "Track inventory.",
  routes: ["/app/inventory"],
  adminNav: [{ id: "settings", label: "Settings", links: [{ label: "General", href: "/admin/inventory", icon: "ti-settings" }] }],
  legalLinks: [{ label: "Terms", href: "/legal/inventory" }],
};

describe("compileAppPresentation", () => {
  test("canonicalizes locale keys and keeps labels scoped to stable presentation keys", () => {
    expect(
      compileAppPresentation(app, {
        baseLocale: "EN",
        translations: { "DE-ch": { adminGroups: { settings: "Einstellungen" }, adminLinks: { "/admin/inventory": "Allgemein" } } },
      }),
    ).toEqual({
      baseLocale: "en",
      translations: { "de-CH": { adminGroups: { settings: "Einstellungen" }, adminLinks: { "/admin/inventory": "Allgemein" } } },
    });
  });

  test("rejects invalid locales, duplicate canonical locales, and unknown presentation keys", () => {
    expect(() => compileAppPresentation(app, { baseLocale: "invalid!", translations: {} })).toThrow("valid BCP 47 locale");
    expect(() =>
      compileAppPresentation(app, { baseLocale: "en", translations: { de: { name: "Deutsch" }, DE: { name: "Doppelt" } } }),
    ).toThrow("duplicated after canonicalization");
    expect(() =>
      compileAppPresentation(app, { baseLocale: "en", translations: { de: { legalLinks: { "/unknown": "Unbekannt" } } } }),
    ).toThrow("unknown key");
  });
});
