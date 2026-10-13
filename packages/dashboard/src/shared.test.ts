import { describe, expect, test } from "bun:test";
import { WIDGET_REQUEST_MAX_ID_LENGTH, WIDGET_SETTING_TEXT_MAX_LENGTH, WIDGET_SETTINGS_MAX_FIELDS } from "@k2b/cloud/contracts";
import {
  DASHBOARD_MAX_ID_LENGTH,
  DASHBOARD_MAX_ITEMS,
  DASHBOARD_MAX_SHORTCUTS,
  DASHBOARD_MAX_TITLE_LENGTH,
  type DashboardBoardEntry,
  type DashboardCatalogWidget,
  defaultDashboardBoard,
  isSafeDashboardShortcutHref,
  migrateLegacyDashboardLayout,
  newDashboardEntryId,
  normalizeDashboardBoard,
  normalizeDashboardSettings,
  normalizeDashboardShortcutHref,
  normalizeLegacyDashboardLayout,
  restoreKeptDashboardEntries,
  splitDashboardBoard,
  widgetRequestSettings,
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

  test("keeps each entry id once on a stored board, in a known size, and caps its length", () => {
    expect(
      normalizeDashboardBoard([
        { id: " spaces/today ", key: " spaces/today ", size: "large" },
        { id: "spaces/today", key: "spaces/today", size: "small" },
        { id: "weather/current", key: "weather/current", size: "huge" },
        { key: "", size: "small" },
        "notebooks/recent",
        { id: "notebooks/recent", key: "notebooks/recent", size: "medium" },
      ]),
    ).toEqual([
      { id: "spaces/today", key: "spaces/today", size: "large" },
      { id: "notebooks/recent", key: "notebooks/recent", size: "medium" },
    ]);
    expect(normalizeDashboardBoard(JSON.stringify([{ id: "a/b", key: "a/b", size: "small" }]))).toEqual([
      { id: "a/b", key: "a/b", size: "small" },
    ]);
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
      { id: "spaces/today", key: "spaces/today", size: "large" },
      { id: "notebooks/recent", key: "notebooks/recent", size: "medium" },
      { id: "weather/current", key: "weather/current", size: "small" },
      { id: "venue/today", key: "venue/today", size: "small" },
    ]);
    expect(defaultDashboardBoard([widget("quotes/quote")])).toEqual([]);
  });
});

describe("splitDashboardBoard", () => {
  test("shows what the catalog offers in a size it offers today, and keeps the rest at its place for the next save", () => {
    const catalog = [widget("weather/current", { sizes: ["small", "medium"], defaultSize: "small" }), widget("spaces/today")];
    const stored = [
      { id: "weather/current", key: "weather/current", size: "large" },
      { id: "gateway-ops/health", key: "gateway-ops/health", size: "small" },
      { id: "spaces/today", key: "spaces/today", size: "large" },
      { id: "stopped/widget", key: "stopped/widget", size: "medium" },
    ] as const;
    const { shown, kept } = splitDashboardBoard(stored, catalog);
    expect({ shown, kept }).toEqual({
      shown: [
        { id: "weather/current", key: "weather/current", size: "small" },
        { id: "spaces/today", key: "spaces/today", size: "large" },
      ],
      kept: [
        { id: "gateway-ops/health", key: "gateway-ops/health", size: "small", index: 1 },
        { id: "stopped/widget", key: "stopped/widget", size: "medium", index: 3 },
      ],
    });
    // Saving the board unchanged stores it as it was, with the unavailable widgets where they stood.
    expect(restoreKeptDashboardEntries(shown, kept)).toEqual([
      { id: "weather/current", key: "weather/current", size: "small" },
      { id: "gateway-ops/health", key: "gateway-ops/health", size: "small" },
      { id: "spaces/today", key: "spaces/today", size: "large" },
      { id: "stopped/widget", key: "stopped/widget", size: "medium" },
    ]);
    // After an edit they keep their position; past the end of a shorter board they come last.
    expect(restoreKeptDashboardEntries([{ id: "spaces/today", key: "spaces/today", size: "medium" }], kept)).toEqual([
      { id: "spaces/today", key: "spaces/today", size: "medium" },
      { id: "gateway-ops/health", key: "gateway-ops/health", size: "small" },
      { id: "stopped/widget", key: "stopped/widget", size: "medium" },
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
      { id: "spaces/today", key: "spaces/today", size: "large" },
      // Recommended wide.
      { id: "notebooks/recent", key: "notebooks/recent", size: "large" },
      // Recommended for the side column, which came last.
      { id: "gateway-ops/health", key: "gateway-ops/health", size: "small" },
      { id: "weather/current", key: "weather/current", size: "small" },
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
      { id: "spaces/today", key: "spaces/today", size: "large" },
      { id: "notebooks/recent", key: "notebooks/recent", size: "large" },
      // An app that is not running keeps its place, in the size its override asked for.
      { id: "uninstalled/widget", key: "uninstalled/widget", size: "medium" },
      // Wide asks for large even though the widget offers only small and medium today; the page shows it in a size
      // it offers, so a widget whose app still runs an image from before sizes existed keeps the person's choice.
      { id: "gateway-ops/health", key: "gateway-ops/health", size: "large" },
      { id: "weather/current", key: "weather/current", size: "small" },
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
      { id: "gateway-ops/health", key: "gateway-ops/health", size: "medium" },
      { id: "quotes/quote", key: "quotes/quote", size: "medium" },
      { id: "notebooks/recent", key: "notebooks/recent", size: "large" },
      // Recommended for the focus zone, but it was full: the overview, still wide.
      { id: "spaces/today", key: "spaces/today", size: "large" },
      { id: "weather/current", key: "weather/current", size: "small" },
    ]);
  });

  test("a person who only switched widgets off gets every other widget in registry order", () => {
    const legacy = normalizeLegacyDashboardLayout(["gateway-ops/health", "spaces/today", "weather/current"], {});
    expect(migrateLegacyDashboardLayout(legacy, declared, visible)).toEqual([
      { id: "notebooks/recent", key: "notebooks/recent", size: "large" },
      { id: "quotes/quote", key: "quotes/quote", size: "medium" },
    ]);
  });
});

test("old entries gain ids, distinct instances survive, and the first duplicate id wins", () => {
  expect(
    normalizeDashboardBoard([
      { key: "weather/current", size: "small" },
      { id: "w2", key: "weather/current", size: "medium" },
      { id: "w2", key: "spaces/today", size: "large" },
      { id: " ", key: "spaces/today", size: "large" },
    ]),
  ).toEqual([
    { id: "weather/current", key: "weather/current", size: "small" },
    { id: "w2", key: "weather/current", size: "medium" },
    { id: "spaces/today", key: "spaces/today", size: "large" },
  ]);
  expect(DASHBOARD_MAX_ID_LENGTH).toBe(WIDGET_REQUEST_MAX_ID_LENGTH);
});

test("stored settings tolerate invalid members and bound title snapshots", () => {
  const settings = {
    place: "berlin",
    done: false,
    space: { type: "spaces.space", id: "a", title: `  ${"A".repeat(100)}  ` },
    note: "hello",
  };
  const entry = { key: "spaces/today", size: "large" };
  expect(normalizeDashboardBoard([{ ...entry, settings }])?.[0]?.settings).toEqual({
    ...settings,
    space: { type: "spaces.space", id: "a", title: "A".repeat(DASHBOARD_MAX_TITLE_LENGTH) },
  });
  for (const settings of [
    [],
    new Date(),
    { constructor: true, bad_name: "x", text: "x".repeat(WIDGET_SETTING_TEXT_MAX_LENGTH + 1), ref: { type: "", id: "a" } },
  ]) {
    expect(normalizeDashboardBoard([{ ...entry, settings }])?.[0]).not.toHaveProperty("settings");
  }
  const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`field${i}`, true]));
  expect(Object.keys(normalizeDashboardBoard([{ ...entry, settings: many }])?.[0]?.settings ?? {})).toHaveLength(
    WIDGET_SETTINGS_MAX_FIELDS,
  );
});

test("split and restore keep whole unavailable entries and drop extra instances without settings", () => {
  const board: DashboardBoardEntry[] = [
    { id: "one", key: "a/one", size: "small" as const, settings: { note: "old" } },
    { id: "two", key: "a/one", size: "small" as const },
    { id: "offline", key: "stopped/widget", size: "large" as const, settings: { space: { type: "spaces.space", id: "a", title: "Home" } } },
  ];
  const split = splitDashboardBoard(board, [widget("a/one")]);
  expect(split.shown).toEqual([{ id: "one", key: "a/one", size: "small" }]);
  expect(split.kept).toEqual([{ ...board[2]!, index: 2 }]);
  expect(restoreKeptDashboardEntries(split.shown, split.kept)).toEqual([split.shown[0]!, board[2]!]);
  expect(splitDashboardBoard(board, [widget("a/one", { settings: { note: { kind: "text", label: "Note" } } })]).shown).toEqual(
    board.slice(0, 2),
  );
});

test("new entry ids use an available short key or a fresh uuid", () => {
  expect(newDashboardEntryId("a/b", new Set())).toBe("a/b");
  const taken = new Set(["a/b"]);
  const next = newDashboardEntryId("a/b", taken);
  expect(next).toMatch(/^[a-f0-9-]{36}$/);
  expect(newDashboardEntryId("a/b", taken)).not.toBe(next);
  expect(newDashboardEntryId("x".repeat(121), new Set())).toMatch(/^[a-f0-9-]{36}$/);
});

test("widget request settings strip resource titles and omit empty settings", () => {
  expect(widgetRequestSettings({ space: { type: "spaces.space", id: "a", title: "Home" }, note: "hi", done: false })).toEqual({
    space: { type: "spaces.space", id: "a" },
    note: "hi",
    done: false,
  });
  expect(widgetRequestSettings(undefined)).toBeUndefined();
  expect(widgetRequestSettings({})).toBeUndefined();
});
