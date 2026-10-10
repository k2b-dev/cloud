import { type DashboardWidgetSize, fitWidgetSize, isDashboardWidgetSize } from "@k2b/cloud/contracts";

export const DASHBOARD_COOKIE = "dashboard_settings";

export type DashboardShortcut =
  | {
      id: string;
      kind: "app";
      appId: string;
      title?: string;
      icon?: string;
    }
  | {
      id: string;
      kind: "link";
      href: string;
      title: string;
      icon: string;
    };

/** One widget on a person's board. The board's order is its reading order on every device. */
export type DashboardBoardEntry = { key: string; size: DashboardWidgetSize };

export type DashboardSettings = {
  shortcuts: DashboardShortcut[];
  /** The person's own board, or `null` while they follow the default board. */
  board: DashboardBoardEntry[] | null;
};

/** A declared widget the person may see, as the board, the gallery, and the default board know it. */
export type DashboardCatalogWidget = {
  key: string;
  appId: string;
  appName: string;
  appIcon: string;
  /** The app's own page, the header link until the widget answers with its own. */
  appHref?: string;
  title: string;
  description: string;
  sizes: DashboardWidgetSize[];
  defaultSize: DashboardWidgetSize;
  suggest: boolean;
};

export type DashboardAppSummary = {
  id: string;
  name: string;
  icon: string;
  href: string;
  description: string;
  /** The app's `nav.badge` route, so the app grid opened here shows the same counts as the shell's. */
  badge?: string;
};

export type DashboardLegalLink = {
  label: string;
  href: string;
  icon?: string;
};

export const DASHBOARD_MAX_ITEMS = 100;
export const DASHBOARD_MAX_SHORTCUTS = 50;
export const DASHBOARD_MAX_ID_LENGTH = 120;
export const DASHBOARD_MAX_TITLE_LENGTH = 80;
export const DASHBOARD_MAX_HREF_LENGTH = 2_000;

export const DEFAULT_DASHBOARD_SETTINGS: DashboardSettings = { shortcuts: [], board: null };

export const normalizeDashboardShortcutHref = (href: string): string => {
  const trimmed = href.trim();
  if (!trimmed || /^([a-z][a-z0-9+.-]*:|\/)/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
};

export const isSafeDashboardShortcutHref = (href: string): boolean => /^(\/|https?:\/\/|mailto:)/i.test(href);

const isKey = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.trim().length <= DASHBOARD_MAX_ID_LENGTH;

const uniqueStrings = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter(isKey).map((entry) => entry.trim()))].slice(0, DASHBOARD_MAX_ITEMS) : [];

const parseJsonString = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
};

const record = (value: unknown): Record<string, unknown> => {
  const parsed = parseJsonString(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
};

const normalizeShortcut = (value: unknown): DashboardShortcut | null => {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim().slice(0, DASHBOARD_MAX_ID_LENGTH) : crypto.randomUUID();

  if (raw.kind === "app" && typeof raw.appId === "string" && raw.appId.trim()) {
    return {
      id,
      kind: "app",
      appId: raw.appId.trim().slice(0, DASHBOARD_MAX_ID_LENGTH),
      title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim().slice(0, DASHBOARD_MAX_TITLE_LENGTH) : undefined,
      icon: typeof raw.icon === "string" && raw.icon.trim() ? raw.icon.trim().slice(0, DASHBOARD_MAX_ID_LENGTH) : undefined,
    };
  }

  if (raw.kind === "link" && typeof raw.href === "string" && raw.href.trim()) {
    const href = normalizeDashboardShortcutHref(raw.href).slice(0, DASHBOARD_MAX_HREF_LENGTH);
    if (!isSafeDashboardShortcutHref(href)) return null;
    const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim().slice(0, DASHBOARD_MAX_TITLE_LENGTH) : "Shortcut";
    const icon = typeof raw.icon === "string" && raw.icon.trim() ? raw.icon.trim().slice(0, DASHBOARD_MAX_ID_LENGTH) : "ti ti-link";
    return { id, kind: "link", href, title, icon };
  }

  return null;
};

export const normalizeDashboardShortcuts = (value: unknown): DashboardShortcut[] => {
  const parsed = parseJsonString(value);
  return Array.isArray(parsed)
    ? parsed
        .map(normalizeShortcut)
        .filter((shortcut): shortcut is DashboardShortcut => Boolean(shortcut))
        .slice(0, DASHBOARD_MAX_SHORTCUTS)
    : [];
};

/** A stored board, or `null` for "follows the default board". Each widget appears once, at its first place. */
export const normalizeDashboardBoard = (value: unknown): DashboardBoardEntry[] | null => {
  const parsed = parseJsonString(value);
  if (!Array.isArray(parsed)) return null;
  const seen = new Set<string>();
  const board: DashboardBoardEntry[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const { key, size } = entry as Record<string, unknown>;
    if (!isKey(key) || !isDashboardWidgetSize(size) || seen.has(key.trim())) continue;
    seen.add(key.trim());
    board.push({ key: key.trim(), size });
    if (board.length === DASHBOARD_MAX_ITEMS) break;
  }
  return board;
};

export const normalizeDashboardSettings = (value: unknown): DashboardSettings => {
  const raw = record(value);
  return { shortcuts: normalizeDashboardShortcuts(raw.shortcuts), board: normalizeDashboardBoard(raw.board) };
};

const SIZE_RANK: Record<DashboardWidgetSize, number> = { large: 0, medium: 1, small: 2 };

/**
 * The board of a person who has not arranged their own: every widget its app suggests and the person may see, in its
 * default size. Large widgets come first, then medium, then small, each in catalog order, so the rows fill without
 * gaps on four columns and on two.
 */
export const defaultDashboardBoard = (catalog: readonly DashboardCatalogWidget[]): DashboardBoardEntry[] =>
  catalog
    .filter((widget) => widget.suggest)
    .map((widget, index) => ({ widget, index }))
    .sort((a, b) => SIZE_RANK[a.widget.defaultSize] - SIZE_RANK[b.widget.defaultSize] || a.index - b.index)
    .map(({ widget }) => ({ key: widget.key, size: widget.defaultSize }))
    .slice(0, DASHBOARD_MAX_ITEMS);

/**
 * The part of a stored board the page shows, each widget in a size it offers today, and the part it cannot show now:
 * widgets of an app that is not running or that the person may no longer see. The board keeps the second part when it
 * is saved again, so an app that restarts does not lose its place on anyone's board.
 */
export const splitDashboardBoard = (
  board: readonly DashboardBoardEntry[],
  catalog: readonly DashboardCatalogWidget[],
): { shown: DashboardBoardEntry[]; kept: DashboardBoardEntry[] } => {
  const byKey = new Map(catalog.map((widget) => [widget.key, widget]));
  const shown: DashboardBoardEntry[] = [];
  const kept: DashboardBoardEntry[] = [];
  for (const entry of board) {
    const widget = byKey.get(entry.key);
    if (widget) shown.push({ key: entry.key, size: fitWidgetSize(entry.size, widget) });
    else kept.push(entry);
  }
  return { shown, kept };
};

/** The dashboard settings saved before widgets had sizes: zones, spans, one order, and widgets switched off. */
export type LegacyDashboardLayout = {
  hiddenWidgets: string[];
  widgets: { key: string; zone: "focus" | "overview" | "context"; span: "standard" | "wide" }[];
  order: string[];
};

export const normalizeLegacyDashboardLayout = (hiddenWidgets: unknown, layout: unknown): LegacyDashboardLayout => {
  const raw = record(layout);
  const widgets = new Map<string, LegacyDashboardLayout["widgets"][number]>();
  for (const value of Array.isArray(raw.widgets) ? raw.widgets.slice(0, DASHBOARD_MAX_ITEMS) : []) {
    if (!value || typeof value !== "object") continue;
    const { key, zone, span } = value as Record<string, unknown>;
    if (!isKey(key) || (zone !== "focus" && zone !== "overview" && zone !== "context") || (span !== "standard" && span !== "wide"))
      continue;
    widgets.set(key.trim(), { key: key.trim(), zone, span });
  }
  return { hiddenWidgets: uniqueStrings(hiddenWidgets), widgets: [...widgets.values()], order: uniqueStrings(raw.order) };
};

export const isEmptyLegacyDashboardLayout = (legacy: LegacyDashboardLayout): boolean =>
  legacy.hiddenWidgets.length === 0 && legacy.widgets.length === 0 && legacy.order.length === 0;

const ZONE_RANK = { focus: 0, overview: 1, context: 2 } as const;

/**
 * Converts settings saved before widgets had sizes into a board, once. The order is the order the old board resolved:
 * the saved order first, then every other widget in registry order, the focus zone above the overview and the side
 * column last. A widget the person set to the side column becomes small, one set to wide becomes large, any other
 * medium, each only when the widget offers that size and otherwise its default size; a widget they left as the app
 * recommended keeps its app's default size. A widget they switched off is not on the board, and neither is one they
 * may not see. Widgets of an app that is not running keep their place. A person who never changed a widget gets
 * `null`: they follow the default board like everyone without saved settings.
 */
export const migrateLegacyDashboardLayout = (
  legacy: LegacyDashboardLayout,
  declared: readonly Pick<DashboardCatalogWidget, "key" | "sizes" | "defaultSize">[],
  visible: ReadonlySet<string>,
): DashboardBoardEntry[] | null => {
  if (isEmptyLegacyDashboardLayout(legacy)) return null;
  const byKey = new Map(declared.map((widget) => [widget.key, widget]));
  const overrides = new Map(legacy.widgets.map((entry) => [entry.key, entry]));
  const hidden = new Set(legacy.hiddenWidgets);
  const keys = [...new Set([...legacy.order, ...declared.map((widget) => widget.key), ...overrides.keys()])].filter(
    (key) => !hidden.has(key) && (!byKey.has(key) || visible.has(key)),
  );
  return keys
    .map((key, index) => ({ key, index, zone: ZONE_RANK[overrides.get(key)?.zone ?? "overview"] }))
    .sort((a, b) => a.zone - b.zone || a.index - b.index)
    .map(({ key }): DashboardBoardEntry => {
      const override = overrides.get(key);
      const wanted: DashboardWidgetSize | undefined = override
        ? override.zone === "context"
          ? "small"
          : override.span === "wide"
            ? "large"
            : "medium"
        : undefined;
      const widget = byKey.get(key);
      if (!widget) return { key, size: wanted ?? "medium" };
      return { key, size: wanted ? fitWidgetSize(wanted, widget) : widget.defaultSize };
    })
    .slice(0, DASHBOARD_MAX_ITEMS);
};
