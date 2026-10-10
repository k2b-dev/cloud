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
  restoreKeptDashboardEntries,
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
  test("shows what the catalog offers in a size it offers today, and keeps the rest at its place for the next save", () => {
    const catalog = [widget("weather/current", { sizes: ["small", "medium"], defaultSize: "small" }), widget("spaces/today")];
    const stored = [
      { key: "weather/current", size: "large" },
      { key: "gateway-ops/health", size: "small" },
      { key: "spaces/today", size: "large" },
      { key: "stopped/widget", size: "medium" },
    ] as const;
    const { shown, kept } = splitDashboardBoard(stored, catalog);
    expect({ shown, kept }).toEqual({
      shown: [
        { key: "weather/current", size: "small" },
        { key: "spaces/today", size: "large" },
      ],
      kept: [
        { key: "gateway-ops/health", size: "small", index: 1 },
        { key: "stopped/widget", size: "medium", index: 3 },
      ],
    });
    // Saving the board unchanged stores it as it was, with the unavailable widgets where they stood.
    expect(restoreKeptDashboardEntries(shown, kept)).toEqual([
      { key: "weather/current", size: "small" },
      { key: "gateway-ops/health", size: "small" },
      { key: "spaces/today", size: "large" },
      { key: "stopped/widget", size: "medium" },
    ]);
    // After an edit they keep their position; past the end of a shorter board they come last.
    expect(restoreKeptDashboardEntries([{ key: "spaces/today", size: "medium" }], kept)).toEqual([
      { key: "spaces/today", size: "medium" },
      { key: "gateway-ops/health", size: "small" },
      { key: "stopped/widget", size: "medium" },
    ]);
  });
});

describe("migrateLegacyDashboardLayout", () => {
  // Registry order, with the zone and width each app recommended before sizes existed.
  const declared = [
    { key: "gateway-ops/health", presentation: { defaultZone: "context" as const } },
    { key: "notebooks/recent", presentation: { defaultSpan: "wide" as const } },
    { key: "spaces/today", presentation: { defaultZone: "focus" as const, defaultSpan: "wide" as const } },
    { key: "weather/current", presentation: { defaultZone: "context" as const } },
    { key: "quotes/quote" },
    { key: "accounts/admin-queue" },
  ];
  const visible = new Set(declared.map((entry) => entry.key).filter((key) => key !== "accounts/admin-queue"));

  test("a person who never changed a widget follows the default board", () => {
    expect(migrateLegacyDashboardLayout(normalizeLegacyDashboardLayout([], { widgets: [], order: [] }), declared, visible)).toBeNull();
    expect(migrateLegacyDashboardLayout(normalizeLegacyDashboardLayout(undefined, "not json"), declared, visible)).toBeNull();
  });

  test("a person who only switched a widget off keeps the board they saw, with the apps' recommendations", () => {
    expect(migrateLegacyDashboardLayout(normalizeLegacyDashboardLayout(["quotes/quote"], {}), declared, visible)).toEqual([
      // Recommended for the focus zone, which stood above everything else, and wide.
      { key: "spaces/today", size: "large" },
      // Recommended wide.
      { key: "notebooks/recent", size: "large" },
      // Recommended for the side column, which came last.
      { key: "gateway-ops/health", size: "small" },
      { key: "weather/current", size: "small" },
    ]);
  });

  test("keeps the saved order and the person's own zones and widths, and stores each size as wanted", () => {
    const legacy = normalizeLegacyDashboardLayout(["quotes/quote"], {
      widgets: [
        { key: "weather/current", zone: "context", span: "standard" },
        { key: "notebooks/recent", zone: "focus", span: "wide" },
        { key: "gateway-ops/health", zone: "overview", span: "wide" },
        { key: "uninstalled/widget", zone: "overview", span: "standard" },
      ],
      order: ["uninstalled/widget", "weather/current", "spaces/today", "notebooks/recent"],
    });
    expect(migrateLegacyDashboardLayout(legacy, declared, visible)).toEqual([
      // One focus widget of the person's own leaves room for one recommended one.
      { key: "spaces/today", size: "large" },
      { key: "notebooks/recent", size: "large" },
      // An app that is not running keeps its place, in the size its override asked for.
      { key: "uninstalled/widget", size: "medium" },
      // Wide asks for large even though the widget offers only small and medium today; the page shows it in a size
      // it offers, so a widget whose app still runs an image from before sizes existed keeps the person's choice.
      { key: "gateway-ops/health", size: "large" },
      { key: "weather/current", size: "small" },
    ]);
  });

  test("the focus zone takes no recommended widget once the person put two there, and widgets they may not see stay off", () => {
    const legacy = normalizeLegacyDashboardLayout([], {
      widgets: [
        { key: "quotes/quote", zone: "focus", span: "standard" },
        { key: "gateway-ops/health", zone: "focus", span: "standard" },
        { key: "accounts/admin-queue", zone: "focus", span: "wide" },
      ],
      order: [],
    });
    expect(migrateLegacyDashboardLayout(legacy, declared, visible)).toEqual([
      { key: "gateway-ops/health", size: "medium" },
      { key: "quotes/quote", size: "medium" },
      { key: "notebooks/recent", size: "large" },
      // Recommended for the focus zone, but it was full: the overview, still wide.
      { key: "spaces/today", size: "large" },
      { key: "weather/current", size: "small" },
    ]);
  });

  test("a person who only switched widgets off gets every other widget in registry order", () => {
    const legacy = normalizeLegacyDashboardLayout(["gateway-ops/health", "spaces/today", "weather/current"], {});
    expect(migrateLegacyDashboardLayout(legacy, declared, visible)).toEqual([
      { key: "notebooks/recent", size: "large" },
      { key: "quotes/quote", size: "medium" },
    ]);
  });
});
