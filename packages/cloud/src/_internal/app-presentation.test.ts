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
  widgets: [{ id: "stock", path: "/api/inventory/widget/stock", title: "Stock", description: "Low stock." }],
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

  test("translates widget titles and descriptions only for declared widgets, within their bounds", () => {
    expect(
      compileAppPresentation(app, {
        baseLocale: "en",
        translations: { de: { widgets: { stock: { title: " Bestand ", description: "Knapper Bestand." } } } },
      }),
    ).toEqual({ baseLocale: "en", translations: { de: { widgets: { stock: { title: "Bestand", description: "Knapper Bestand." } } } } });
    expect(() =>
      compileAppPresentation(app, { baseLocale: "en", translations: { de: { widgets: { missing: { title: "Fehlt" } } } } }),
    ).toThrow("unknown key");
    expect(() =>
      compileAppPresentation(app, { baseLocale: "en", translations: { de: { widgets: { stock: { title: "x".repeat(81) } } } } }),
    ).toThrow("1 to 80 characters");
  });
});
