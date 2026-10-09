import type { WidgetResponse, WidgetStreamLine } from "@k2b/cloud/browser/widgets";
import { DASHBOARD_MAX_ID_LENGTH, DASHBOARD_MAX_ITEMS, type DashboardWidgetSummary } from "../shared";

/**
 * What one widget on the board shows. Every requested widget starts as `loading` and settles once, when its line
 * arrives; a failed widget can be asked again on its own.
 */
export type DashboardTileState =
  | { status: "loading" }
  | { status: "ok"; widget: WidgetResponse }
  | { status: "empty" | "forbidden" | "timeout" | "error" };

export type DashboardTiles = Record<string, DashboardTileState>;

/** Marks `keys` as loading, before the first request or a retry. */
export const loadingDashboardTiles = (tiles: DashboardTiles, keys: readonly string[]): DashboardTiles => ({
  ...tiles,
  ...Object.fromEntries(keys.map((key) => [key, { status: "loading" } as const])),
});

/** Only a widget that is loading takes a line, which bounds the lines a board accepts. */
export const applyDashboardWidgetLine = (tiles: DashboardTiles, line: WidgetStreamLine): DashboardTiles => {
  if (line.type !== "widget" || tiles[line.key]?.status !== "loading") return tiles;
  return { ...tiles, [line.key]: line.status === "ok" ? { status: "ok", widget: line.widget } : { status: line.status } };
};

/** The request failed or the stream broke off: every widget of `keys` still loading has failed on its own. */
export const breakDashboardTiles = (tiles: DashboardTiles, keys: readonly string[]): DashboardTiles => ({
  ...tiles,
  ...Object.fromEntries(keys.flatMap((key) => (tiles[key]?.status === "loading" ? [[key, { status: "error" } as const]] : []))),
});

/**
 * Widgets that answered `403` or `204` the last time this device loaded the dashboard. The page reserves no space for
 * them, so the widgets it does reserve space for keep their place when their data arrives.
 */
export type DashboardWidgetHint = { forbidden: string[]; empty: string[] };

export const DASHBOARD_WIDGET_HINT_COOKIE = "dashboard_widgets";
const HINT_COOKIE_PATH = "/app/dashboard";
const HINT_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

const hintKeys = (value: unknown): string[] =>
  Array.isArray(value)
    ? [
        ...new Set(
          value.filter((key): key is string => typeof key === "string" && key.length > 0 && key.length <= 2 * DASHBOARD_MAX_ID_LENGTH),
        ),
      ].slice(0, DASHBOARD_MAX_ITEMS)
    : [];

export const emptyDashboardWidgetHint = (): DashboardWidgetHint => ({ forbidden: [], empty: [] });

/** Reads the hint from a `Cookie` header; anything unreadable is no hint. */
export const readDashboardWidgetHint = (cookieHeader: string): DashboardWidgetHint => {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${DASHBOARD_WIDGET_HINT_COOKIE}=([^;]+)`));
  if (!match?.[1]) return emptyDashboardWidgetHint();
  try {
    const value: unknown = JSON.parse(decodeURIComponent(match[1]));
    if (!value || typeof value !== "object") return emptyDashboardWidgetHint();
    const hint = value as Record<string, unknown>;
    return { forbidden: hintKeys(hint.forbidden), empty: hintKeys(hint.empty) };
  } catch {
    return emptyDashboardWidgetHint();
  }
};

/**
 * The hint after this load: a widget that answered replaces what was known about it, a widget that failed or is still
 * loading keeps its old entry, and widgets that are no longer declared drop out.
 */
export const nextDashboardWidgetHint = (
  hint: DashboardWidgetHint,
  tiles: DashboardTiles,
  registered: readonly string[],
): DashboardWidgetHint => {
  const declared = new Set(registered);
  const known = (key: string, previous: "forbidden" | "empty") => {
    const status = tiles[key]?.status;
    if (status === "ok") return false;
    if (status === "forbidden" || status === "empty") return status === previous;
    return true;
  };
  const answered = (status: "forbidden" | "empty") =>
    Object.entries(tiles).flatMap(([key, tile]) => (tile.status === status && declared.has(key) ? [key] : []));
  return {
    forbidden: [...new Set([...hint.forbidden.filter((key) => declared.has(key) && known(key, "forbidden")), ...answered("forbidden")])],
    empty: [...new Set([...hint.empty.filter((key) => declared.has(key) && known(key, "empty")), ...answered("empty")])],
  };
};

export const sameDashboardWidgetHint = (a: DashboardWidgetHint, b: DashboardWidgetHint): boolean =>
  JSON.stringify([[...a.forbidden].sort(), [...a.empty].sort()]) === JSON.stringify([[...b.forbidden].sort(), [...b.empty].sort()]);

/** The `document.cookie` assignment that stores `hint` for the dashboard page only. */
export const dashboardWidgetHintCookie = (hint: DashboardWidgetHint, secure: boolean): string =>
  `${DASHBOARD_WIDGET_HINT_COOKIE}=${encodeURIComponent(JSON.stringify(hint))}; path=${HINT_COOKIE_PATH}; max-age=${HINT_COOKIE_MAX_AGE_SECONDS}; samesite=lax${secure ? "; secure" : ""}`;

/**
 * The widget lists of the edit dialog. A widget's answer on this page wins over the hint; until it answers, the hint
 * decides. `forbidden` widgets are listed as not available at the user's access level, and `empty` ones only when the
 * user hid them, as before.
 */
export const summarizeDashboardWidgets = (
  widgets: readonly DashboardWidgetSummary[],
  hint: DashboardWidgetHint,
  tiles: DashboardTiles,
  hidden: readonly string[],
): { available: DashboardWidgetSummary[]; inaccessible: DashboardWidgetSummary[] } => {
  const forbidden = new Set(hint.forbidden);
  const empty = new Set(hint.empty);
  const hiddenKeys = new Set(hidden);
  const available: DashboardWidgetSummary[] = [];
  const inaccessible: DashboardWidgetSummary[] = [];
  for (const widget of widgets) {
    const tile = tiles[widget.key];
    const status =
      tile && tile.status !== "loading"
        ? tile.status
        : forbidden.has(widget.key)
          ? "forbidden"
          : empty.has(widget.key)
            ? "empty"
            : "unknown";
    if (status === "forbidden") inaccessible.push(widget);
    else if (status !== "empty" || hiddenKeys.has(widget.key))
      available.push(tile?.status === "ok" ? { ...widget, title: tile.widget.title, icon: tile.widget.icon ?? widget.icon } : widget);
  }
  return { available, inaccessible };
};
