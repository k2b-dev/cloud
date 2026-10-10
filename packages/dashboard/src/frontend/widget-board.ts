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
 * Widgets that answered `403` or `204` the last time this account loaded the dashboard on this device. The page reserves
 * no space for them, so the widgets it does reserve space for keep their place when their data arrives. `owner` stands
 * for the account, so a shared device never applies one account's hint to another.
 */
export type DashboardWidgetHint = { owner: string; forbidden: string[]; empty: string[] };

export const DASHBOARD_WIDGET_HINT_COOKIE = "dashboard_widgets";
const HINT_COOKIE_PATH = "/app/dashboard";
const HINT_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
/** RFC 6265 guarantees 4096 bytes per cookie, counting its name, value, and attributes; a browser drops a larger one. */
const COOKIE_MAX_BYTES = 4096;

const hintKeys = (value: unknown): string[] =>
  Array.isArray(value)
    ? [
        ...new Set(
          value.filter((key): key is string => typeof key === "string" && key.length > 0 && key.length <= 2 * DASHBOARD_MAX_ID_LENGTH),
        ),
      ].slice(0, DASHBOARD_MAX_ITEMS)
    : [];

export const emptyDashboardWidgetHint = (owner: string): DashboardWidgetHint => ({ owner, forbidden: [], empty: [] });

/** Reads `owner`'s hint from a `Cookie` header; anything unreadable, or another account's hint, is no hint. */
export const readDashboardWidgetHint = (cookieHeader: string, owner: string): DashboardWidgetHint => {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${DASHBOARD_WIDGET_HINT_COOKIE}=([^;]+)`));
  if (!match?.[1]) return emptyDashboardWidgetHint(owner);
  try {
    const value: unknown = JSON.parse(decodeURIComponent(match[1]));
    if (!value || typeof value !== "object") return emptyDashboardWidgetHint(owner);
    const hint = value as Record<string, unknown>;
    if (hint.owner !== owner) return emptyDashboardWidgetHint(owner);
    return { owner, forbidden: hintKeys(hint.forbidden), empty: hintKeys(hint.empty) };
  } catch {
    return emptyDashboardWidgetHint(owner);
  }
};

/**
 * The hint after the answers so far: a widget that answered replaces what was known about it, a widget that failed or
 * is still loading keeps its old entry, and widgets this page did not ask, because they are hidden or no longer
 * declared, drop out.
 */
export const nextDashboardWidgetHint = (
  hint: DashboardWidgetHint,
  tiles: DashboardTiles,
  requested: readonly string[],
): DashboardWidgetHint => {
  const asked = new Set(requested);
  const known = (key: string, previous: "forbidden" | "empty") => {
    const status = tiles[key]?.status;
    if (status === "ok") return false;
    if (status === "forbidden" || status === "empty") return status === previous;
    return true;
  };
  const answered = (status: "forbidden" | "empty") =>
    Object.entries(tiles).flatMap(([key, tile]) => (tile.status === status && asked.has(key) ? [key] : []));
  return {
    owner: hint.owner,
    forbidden: [...new Set([...hint.forbidden.filter((key) => asked.has(key) && known(key, "forbidden")), ...answered("forbidden")])],
    empty: [...new Set([...hint.empty.filter((key) => asked.has(key) && known(key, "empty")), ...answered("empty")])],
  };
};

export const sameDashboardWidgetHint = (a: DashboardWidgetHint, b: DashboardWidgetHint): boolean =>
  JSON.stringify([a.owner, [...a.forbidden].sort(), [...a.empty].sort()]) ===
  JSON.stringify([b.owner, [...b.forbidden].sort(), [...b.empty].sort()]);

/**
 * The `document.cookie` assignment that stores `hint` for the dashboard page only. A hint too large for one cookie
 * leaves widgets out until it fits; the page then simply reserves their space again.
 */
export const dashboardWidgetHintCookie = (hint: DashboardWidgetHint, secure: boolean): string => {
  const cookie = (value: DashboardWidgetHint) =>
    `${DASHBOARD_WIDGET_HINT_COOKIE}=${encodeURIComponent(JSON.stringify(value))}; path=${HINT_COOKIE_PATH}; max-age=${HINT_COOKIE_MAX_AGE_SECONDS}; samesite=lax${secure ? "; secure" : ""}`;
  const fitted = { owner: hint.owner, forbidden: [...hint.forbidden], empty: [...hint.empty] };
  while (cookie(fitted).length > COOKIE_MAX_BYTES && fitted.forbidden.length + fitted.empty.length > 0)
    (fitted.empty.length > 0 ? fitted.empty : fitted.forbidden).pop();
  return cookie(fitted);
};

/**
 * The widget lists of the edit dialog. A hidden widget is never asked, so it is always listed, to show it again. For
 * the others, a widget's answer on this page wins over the hint; until it answers, the hint decides. `forbidden`
 * widgets are listed as not available at the user's access level, and `empty` ones are left out, as before.
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
    if (hiddenKeys.has(widget.key)) {
      available.push(widget);
      continue;
    }
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
    else if (status !== "empty")
      available.push(tile?.status === "ok" ? { ...widget, title: tile.widget.title, icon: tile.widget.icon ?? widget.icon } : widget);
  }
  return { available, inaccessible };
};
