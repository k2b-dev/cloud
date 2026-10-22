import type { DashboardRange } from "../../dashboard-contracts";
import { SQL_MAX_BYTES, SQL_MAX_PARAMETERS, SQL_PARAMETER_MAX_BYTES } from "../../sql-params";
import { dashboardRangeSearch } from "./dashboard-client";
import { readDashboardRange } from "./dashboard-data";

export type WorkspaceView = "overview" | "sources" | "coming-back" | "sql" | "dashboards";
export const PULSE_SIDEBAR_SQL_ID = "sql";
export const PULSE_SETTINGS_TABS = ["general", "members", "retention", "usage", "danger"] as const;
export type PulseSettingsTab = (typeof PULSE_SETTINGS_TABS)[number];
export type WorkspaceRouteState = {
  view: WorkspaceView;
  sourceId: string;
  dashboardId?: string;
  dashboardRange?: DashboardRange;
  queryId?: string;
  alertId?: string;
  sql?: string;
  params?: Record<string, string>;
  settings?: PulseSettingsTab;
};
export type WorkspaceHrefOptions = { baseId: string; state: Omit<WorkspaceRouteState, "sourceId"> & { sourceId?: string } };
// Same 4,000-character workspace-href budget as Mail. Omit console payloads atomically,
// never truncate SQL or values into a different query. Saved query identity always survives.
export const MAX_PULSE_WORKSPACE_HREF_LENGTH = 4_000;
const bytes = (value: string) => new TextEncoder().encode(value).length;
const removedViews = new Set(["explorer", "signals", "resources", "events", "metrics", "states", "query-reference"]);
const decode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
};
export const readConsoleParams = (raw: unknown): Record<string, string> | null => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entries = Object.entries(raw);
  if (
    entries.length > SQL_MAX_PARAMETERS ||
    entries.some(
      ([name, value]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name === "base_tz" || typeof value !== "string" || bytes(value) > SQL_PARAMETER_MAX_BYTES,
    )
  )
    return null;
  return Object.fromEntries(entries);
};
export const readWorkspacePathState = (path: string, baseId: string): WorkspaceRouteState => {
  const url = new URL(path, "http://pulse.invalid");
  const basePath = `/app/pulse/${encodeURIComponent(baseId)}`;
  let state: WorkspaceRouteState = { view: "overview", sourceId: "" };
  if (!baseId || (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`))) return state;
  const [view, id] = url.pathname.slice(basePath.length).split("/").filter(Boolean);
  if (view === "sources") state = { view: "sources", sourceId: decode(id ?? "") };
  else if (view === "dashboards")
    state = { view: "dashboards", sourceId: "", dashboardId: decode(id ?? ""), dashboardRange: readDashboardRange(path) };
  else if (view && removedViews.has(view)) state.view = "coming-back";
  else if (view === "sql") {
    state = { view: "sql", sourceId: "", queryId: decode(id ?? ""), sql: undefined, params: {} };
    const alertId = url.searchParams.get("alert");
    if (!state.queryId && alertId && /^[A-Za-z0-9-]{6,36}$/.test(alertId)) state.alertId = alertId;
    if (!state.queryId && !state.alertId) state.sql = "";
    if (`${url.pathname}${url.search}`.length <= MAX_PULSE_WORKSPACE_HREF_LENGTH) {
      const sql = url.searchParams.get("sql");
      if (sql !== null && bytes(sql) <= SQL_MAX_BYTES) state.sql = sql;
      else if (!state.queryId && !state.alertId) state.sql = "";
      try {
        state.params = readConsoleParams(JSON.parse(url.searchParams.get("params") ?? "{}")) ?? {};
      } catch {
        /* Malformed URL data is an empty draft. */
      }
    }
  }
  const settings = url.searchParams.get("settings");
  const tab = PULSE_SETTINGS_TABS.find((tab) => tab === settings);
  if (tab) state.settings = tab;
  return state;
};

export const buildPulseWorkspaceHref = ({ baseId, state }: WorkspaceHrefOptions): string => {
  if (!baseId) return "/app/pulse";
  const base = `/app/pulse/${encodeURIComponent(baseId)}`;
  const path =
    state.view === "overview"
      ? base
      : state.view === "dashboards"
        ? `${base}/dashboards${state.dashboardId ? `/${encodeURIComponent(state.dashboardId)}` : ""}`
        : state.view === "coming-back"
          ? `${base}/dashboards`
          : state.view === "sql"
            ? `${base}/sql${state.queryId ? `/${encodeURIComponent(state.queryId)}` : ""}`
            : `${base}/sources${state.sourceId ? `/${encodeURIComponent(state.sourceId)}` : ""}`;
  const search = new URLSearchParams(state.view === "dashboards" ? dashboardRangeSearch(state.dashboardRange ?? {}) : undefined);
  if (state.settings) search.set("settings", state.settings);
  if (state.view === "sql" && state.alertId && !state.queryId) search.set("alert", state.alertId);
  const fallback = `${path}${search.size ? `?${search}` : ""}`;
  if (state.view === "sql" && !state.alertId) {
    if (state.sql !== undefined && bytes(state.sql) <= SQL_MAX_BYTES) search.set("sql", state.sql);
    else if (state.sql !== undefined) return fallback;
    const params = readConsoleParams(state.params) ?? {};
    if (Object.keys(params).length) search.set("params", JSON.stringify(params));
  }
  const href = `${path}${search.size ? `?${search}` : ""}`;
  return href.length <= MAX_PULSE_WORKSPACE_HREF_LENGTH ? href : fallback;
};
