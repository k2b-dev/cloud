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

test("the startup presentation compiler retains and trims declared setting translations", () => {
  const configured: AppMeta = {
    ...app,
    widgets: [
      {
        id: "stock",
        path: "/stock",
        settings: {
          mode: { kind: "choice", label: "Mode", options: [{ label: "All", value: "all" }] },
          text: { kind: "text", label: "Text" },
        },
      },
    ],
  };
  expect(
    compileAppPresentation(configured, {
      baseLocale: "en",
      translations: {
        de: {
          widgets: {
            stock: {
              settings: {
                mode: { label: " Modus ", options: { all: " Alle " } },
                text: { placeholder: " Suchen " },
              },
            },
          },
        },
      },
    }),
  ).toEqual({
    baseLocale: "en",
    translations: {
      de: {
        widgets: {
          stock: {
            settings: {
              mode: { label: "Modus", options: { all: "Alle" } },
              text: { placeholder: "Suchen" },
            },
          },
        },
      },
    },
  });
  expect(() =>
    compileAppPresentation(configured, {
      baseLocale: "en",
      translations: { de: { widgets: { stock: { settings: { missing: { label: "Missing" } } } } } },
    }),
  ).toThrow("not declared");
  expect(() =>
    compileAppPresentation(configured, {
      baseLocale: "en",
      translations: { de: { widgets: { stock: { settings: { mode: { options: { missing: "Missing" } } } } } } },
    }),
  ).toThrow("unknown key");
});

test("retains translated option values that name an object prototype property", () => {
  const configured: AppMeta = {
    ...app,
    widgets: [
      {
        id: "stock",
        path: "/stock",
        settings: {
          mode: { kind: "choice", label: "Mode", options: [{ label: "Prototype", value: "__proto__" }] },
        },
      },
    ],
  };
  const compiled = compileAppPresentation(configured, {
    baseLocale: "en",
    translations: {
      de: {
        widgets: {
          stock: {
            settings: {
              mode: { options: Object.fromEntries([["__proto__", "Prototyp"]]) },
            },
          },
        },
      },
    },
  });
  expect(compiled?.translations.de?.widgets?.stock?.settings?.mode?.options?.__proto__).toBe("Prototyp");
});

test("panelLabel is trimmed and bounded like name, and requires a declared panel", () => {
  const catalog = { baseLocale: "en", translations: { de: { panelLabel: " Bestand " } } };
  expect(() => compileAppPresentation(app, catalog)).toThrow("unknown key");
  const configured = { ...app, panel: { href: "/app/inventory/panel", label: "Stock", icon: "ti ti-box" } };
  expect(compileAppPresentation(configured, catalog)?.translations.de?.panelLabel).toBe("Bestand");
  for (const panelLabel of ["", " ", "x".repeat(201)])
    expect(() => compileAppPresentation(configured, { baseLocale: "en", translations: { de: { panelLabel } } })).toThrow(
      "1 to 200 characters",
    );
});
