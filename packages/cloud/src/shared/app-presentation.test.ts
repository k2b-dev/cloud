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

test("setting translations merge regional labels, placeholders and options without changing values", () => {
  const configured: AppMeta = {
    ...app,
    widgets: [
      {
        id: "stock",
        path: "/stock",
        title: "Stock",
        settings: {
          mode: {
            kind: "choice",
            label: "Mode",
            options: [
              { label: "All", value: "all" },
              { label: "Low", value: "low" },
            ],
            default: "all",
          },
          text: { kind: "text", label: "Text", placeholder: "Search", maxLength: 20 },
          space: { kind: "resource", label: "Space", type: "spaces.space" },
          toggle: { kind: "toggle", label: "Enabled", default: true },
        },
      },
    ],
    presentation: {
      baseLocale: "en",
      translations: {
        de: {
          widgets: {
            stock: {
              title: "Bestand",
              settings: {
                mode: { label: "Modus", options: { all: "Alle", low: "Wenig" } },
                text: { label: "Text DE", placeholder: "Suchen" },
                space: { label: "Raum" },
                toggle: { label: "Aktiv" },
              },
            },
          },
        },
        "de-CH": {
          widgets: { stock: { settings: { mode: { label: "Auswahl", options: { low: "Knapp" } }, text: { label: "Text CH" } } } },
        },
      },
    },
  };
  expect(resolveAppPresentation(configured, "de-CH").widgets?.[0]).toEqual({
    id: "stock",
    path: "/stock",
    title: "Bestand",
    settings: {
      mode: {
        kind: "choice",
        label: "Auswahl",
        options: [
          { label: "Alle", value: "all" },
          { label: "Knapp", value: "low" },
        ],
        default: "all",
      },
      text: { kind: "text", label: "Text CH", placeholder: "Suchen", maxLength: 20 },
      space: { kind: "resource", label: "Raum", type: "spaces.space" },
      toggle: { kind: "toggle", label: "Aktiv", default: true },
    },
  });
  expect(configured.widgets?.[0]?.settings?.mode?.label).toBe("Mode");
});

test("option translations use only their own value keys, including prototype property names", () => {
  const configured: AppMeta = {
    ...app,
    widgets: [
      {
        id: "stock",
        path: "/stock",
        settings: {
          mode: {
            kind: "choice",
            label: "Mode",
            options: [
              { label: "Prototype", value: "__proto__" },
              { label: "All", value: "all" },
            ],
          },
        },
      },
    ],
    presentation: {
      baseLocale: "en",
      translations: {
        de: {
          widgets: {
            stock: {
              settings: {
                mode: { label: "Modus", options: { all: "Alle" } },
              },
            },
          },
        },
      },
    },
  };
  expect(resolveAppPresentation(configured, "de").widgets?.[0]?.settings?.mode).toEqual({
    kind: "choice",
    label: "Modus",
    options: [
      { label: "Prototype", value: "__proto__" },
      { label: "Alle", value: "all" },
    ],
  });
});

test("translates panel labels through regional fallback without changing stable fields", () => {
  const configured = {
    ...app,
    panel: { href: "/app/inventory/panel", label: "Stock", icon: "ti ti-box", requiresRoles: ["user"] },
    presentation: { baseLocale: "en", translations: { de: { panelLabel: "Bestand" } } },
  } satisfies AppMeta;
  expect(resolveAppPresentation(configured, "de-CH").panel).toEqual({ ...configured.panel, label: "Bestand" });
  expect(resolveAppPresentation(configured, "fr").panel?.label).toBe("Stock");
  expect(configured.panel.label).toBe("Stock");
});
