import { describe, expect, test } from "bun:test";
import {
  DASHBOARD_MAX_ITEMS,
  DASHBOARD_MAX_SHORTCUTS,
  type DashboardCatalogWidget,
  defaultDashboardBoard,
  isSafeDashboardShortcutHref,
  migrateLegacyDashboardLayout,
  normalizeDashboardBoard,
  normalizeDashboardSettings,
  normalizeDashboardShortcutHref,
  normalizeLegacyDashboardLayout,
  splitDashboardBoard,
} from "./shared";

const widget = (key: string, overrides: Partial<DashboardCatalogWidget> = {}): DashboardCatalogWidget => ({
  key,
  appId: key.split("/")[0]!,
  appName: key.split("/")[0]!,
  appIcon: "ti ti-box",
  title: key,
  description: `${key} widget`,
  sizes: ["small", "medium", "large"],
  defaultSize: "medium",
  suggest: false,
  ...overrides,
});

describe("normalizeDashboardSettings", () => {
  test("reads shortcuts stored as a JSON string, and a missing board as following the default", () => {
    const settings = normalizeDashboardSettings({ shortcuts: JSON.stringify([{ id: "shortcut-1", kind: "app", appId: "contacts" }]) });
    expect(settings).toEqual({ shortcuts: [{ id: "shortcut-1", kind: "app", appId: "contacts" }], board: null });
  });

  test("adds https to shortcut links without a protocol", () => {
    expect(normalizeDashboardShortcutHref("kolb-antik.com")).toBe("https://kolb-antik.com");
    expect(normalizeDashboardShortcutHref("http://kolb-antik.com")).toBe("http://kolb-antik.com");
    expect(normalizeDashboardShortcutHref("https://kolb-antik.com")).toBe("https://kolb-antik.com");
  });

  test("normalizes and caps user-controlled shortcuts", () => {
    const settings = normalizeDashboardSettings({
      shortcuts: Array.from({ length: DASHBOARD_MAX_SHORTCUTS + 5 }, (_, index) => ({
        id: ` shortcut-${index} `,
        kind: "link",
        href: index === 0 ? "javascript:alert(1)" : "example.com",
        title: " Example ",
        icon: " ti ti-link ",
      })),
    });
    expect(settings.shortcuts).toHaveLength(DASHBOARD_MAX_SHORTCUTS);
    expect(settings.shortcuts[0]).toMatchObject({ id: "shortcut-1", kind: "link", href: "https://example.com", title: "Example" });
  });

  test("keeps each widget once on a stored board, in a known size, and caps its length", () => {
    expect(
      normalizeDashboardBoard([
        { key: " spaces/today ", size: "large" },
        { key: "spaces/today", size: "small" },
        { key: "weather/current", size: "huge" },
        { key: "", size: "small" },
        "notebooks/recent",
        { key: "notebooks/recent", size: "medium" },
      ]),
    ).toEqual([
      { key: "spaces/today", size: "large" },
      { key: "notebooks/recent", size: "medium" },
    ]);
    expect(normalizeDashboardBoard(JSON.stringify([{ key: "a/b", size: "small" }]))).toEqual([{ key: "a/b", size: "small" }]);
    expect(normalizeDashboardBoard([])).toEqual([]);
    expect(normalizeDashboardBoard(null)).toBeNull();
    expect(
      normalizeDashboardBoard(Array.from({ length: DASHBOARD_MAX_ITEMS + 3 }, (_, index) => ({ key: `app/${index}`, size: "small" }))),
    ).toHaveLength(DASHBOARD_MAX_ITEMS);
  });
});

describe("dashboard shortcut URLs", () => {
  test("allows only relative, HTTP(S), and mailto links", () => {
    expect(isSafeDashboardShortcutHref("/app/docs")).toBeTrue();
    expect(isSafeDashboardShortcutHref("https://example.com")).toBeTrue();
    expect(isSafeDashboardShortcutHref("mailto:team@example.com")).toBeTrue();
    expect(isSafeDashboardShortcutHref("javascript:alert(1)")).toBeFalse();
    expect(isSafeDashboardShortcutHref("data:text/html,unsafe")).toBeFalse();
  });
});

describe("defaultDashboardBoard", () => {
  test("holds every suggested widget in its default size, large first, then medium, then small, each in catalog order", () => {
    const catalog = [
      widget("weather/current", { suggest: true, defaultSize: "small" }),
      widget("notebooks/recent", { suggest: true, defaultSize: "medium" }),
      widget("quotes/quote"),
      widget("spaces/today", { suggest: true, defaultSize: "large" }),
      widget("venue/today", { suggest: true, defaultSize: "small" }),
    ];
    expect(defaultDashboardBoard(catalog)).toEqual([
      { key: "spaces/today", size: "large" },
      { key: "notebooks/recent", size: "medium" },
      { key: "weather/current", size: "small" },
      { key: "venue/today", size: "small" },
    ]);
    expect(defaultDashboardBoard([widget("quotes/quote")])).toEqual([]);
  });
});

describe("splitDashboardBoard", () => {
  test("shows what the catalog offers in a size it offers today, and keeps the rest for the next save", () => {
    const catalog = [widget("weather/current", { sizes: ["small", "medium"], defaultSize: "small" }), widget("spaces/today")];
    expect(
      splitDashboardBoard(
        [
          { key: "weather/current", size: "large" },
          { key: "gateway-ops/health", size: "small" },
          { key: "spaces/today", size: "large" },
        ],
        catalog,
      ),
    ).toEqual({
      shown: [
        { key: "weather/current", size: "small" },
        { key: "spaces/today", size: "large" },
      ],
      kept: [{ key: "gateway-ops/health", size: "small" }],
    });
  });
});

describe("migrateLegacyDashboardLayout", () => {
  const declared = [
    widget("gateway-ops/health", { sizes: ["small", "medium"], defaultSize: "small" }),
    widget("spaces/today", { sizes: ["medium", "large"], defaultSize: "large" }),
    widget("weather/current", { sizes: ["small", "medium"], defaultSize: "small" }),
    widget("notebooks/recent", { sizes: ["medium", "large"], defaultSize: "medium" }),
    widget("quotes/quote", { sizes: ["small", "medium"], defaultSize: "medium" }),
    widget("accounts/admin-queue", { sizes: ["small", "medium", "large"], defaultSize: "medium" }),
  ];
  const visible = new Set(declared.map((entry) => entry.key).filter((key) => key !== "accounts/admin-queue"));

  test("a person who never changed a widget follows the default board", () => {
    expect(migrateLegacyDashboardLayout(normalizeLegacyDashboardLayout([], { widgets: [], order: [] }), declared, visible)).toBeNull();
    expect(migrateLegacyDashboardLayout(normalizeLegacyDashboardLayout(undefined, "not json"), declared, visible)).toBeNull();
  });

  test("keeps the resolved order, maps zones and widths to sizes the widget offers, and leaves out switched-off widgets", () => {
    const legacy = normalizeLegacyDashboardLayout(["quotes/quote"], {
      widgets: [
        { key: "weather/current", zone: "context", span: "standard" },
        { key: "notebooks/recent", zone: "focus", span: "wide" },
        // Wide asks for large, which this widget does not offer: it gets its default size.
        { key: "gateway-ops/health", zone: "overview", span: "wide" },
        { key: "uninstalled/widget", zone: "overview", span: "standard" },
      ],
      order: ["uninstalled/widget", "weather/current", "spaces/today", "notebooks/recent"],
    });
    expect(migrateLegacyDashboardLayout(legacy, declared, visible)).toEqual([
      // The focus zone stood above everything else.
      { key: "notebooks/recent", size: "large" },
      // An app that is not running keeps its place, in the size its override asked for.
      { key: "uninstalled/widget", size: "medium" },
      // A widget left as the app recommended keeps its app's default size.
      { key: "spaces/today", size: "large" },
      { key: "gateway-ops/health", size: "small" },
      // The side column came last.
      { key: "weather/current", size: "small" },
    ]);
  });

  test("an overview widget becomes medium when it offers medium, and widgets the person may not see stay off", () => {
    const legacy = normalizeLegacyDashboardLayout([], {
      widgets: [
        { key: "spaces/today", zone: "overview", span: "standard" },
        { key: "accounts/admin-queue", zone: "focus", span: "wide" },
      ],
      order: [],
    });
    expect(migrateLegacyDashboardLayout(legacy, declared, visible)).toEqual([
      { key: "gateway-ops/health", size: "small" },
      { key: "spaces/today", size: "medium" },
      { key: "weather/current", size: "small" },
      { key: "notebooks/recent", size: "medium" },
      { key: "quotes/quote", size: "medium" },
    ]);
  });

  test("a person who only switched widgets off gets every other widget in registry order", () => {
    const legacy = normalizeLegacyDashboardLayout(["gateway-ops/health", "spaces/today", "weather/current"], {});
    expect(migrateLegacyDashboardLayout(legacy, declared, visible)).toEqual([
      { key: "notebooks/recent", size: "medium" },
      { key: "quotes/quote", size: "medium" },
    ]);
  });
});
