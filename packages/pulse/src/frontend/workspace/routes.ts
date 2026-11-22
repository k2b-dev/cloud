import { SQL_MAX_BYTES, SQL_MAX_PARAMETERS, SQL_PARAMETER_MAX_BYTES } from "../../sql-params";

/** The four tabs of a base. Old overview and dashboard paths are server redirects to the base, not views. */
export type WorkspaceView = "sources" | "data" | "usage" | "sql";
export const PULSE_SIDEBAR_SQL_ID = "sql";
export const PULSE_SETTINGS_TABS = ["general", "members", "retention", "usage", "danger"] as const;
export type PulseSettingsTab = (typeof PULSE_SETTINGS_TABS)[number];
export type WorkspaceRouteState = {
  view: WorkspaceView;
  sourceId: string;
  queryId?: string;
  /** On `sources`: the fired alert open in the detail column. On `sql`: the alert whose SQL the console opens. */
  alertId?: string;
  /** On `data`: the data kind open in the detail. */
  kind?: string;
  sql?: string;
  params?: Record<string, string>;
  settings?: PulseSettingsTab;
};
export type WorkspaceHrefOptions = { baseId: string; state: Omit<WorkspaceRouteState, "sourceId"> & { sourceId?: string } };
// Same 4,000-character workspace-href budget as Mail. Omit console payloads atomically,
// never truncate SQL or values into a different query. Saved query identity always survives.
export const MAX_PULSE_WORKSPACE_HREF_LENGTH = 4_000;
const bytes = (value: string) => new TextEncoder().encode(value).length;
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
  let state: WorkspaceRouteState = { view: "sources", sourceId: "" };
  if (!baseId || (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`))) return state;
  const [view, id] = url.pathname.slice(basePath.length).split("/").filter(Boolean);
  const alertId = url.searchParams.get("alert");
  const validAlert = alertId && /^[A-Za-z0-9-]{6,36}$/.test(alertId) ? alertId : undefined;
  if (!view || view === "sources") {
    state = { view: "sources", sourceId: decode(id ?? "") };
    if (!state.sourceId && validAlert) state.alertId = validAlert;
  } else if (view === "usage") state = { view: "usage", sourceId: "" };
  else if (view === "data") {
    state = { view: "data", sourceId: "" };
    const kind = url.searchParams.get("kind");
    if (kind && kind.length <= 500) state.kind = kind;
  } else if (view === "sql") {
    state = { view: "sql", sourceId: "", queryId: decode(id ?? ""), sql: undefined, params: {} };
    if (!state.queryId && validAlert) state.alertId = validAlert;
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
    state.view === "usage"
      ? `${base}/usage`
      : state.view === "data"
        ? `${base}/data`
        : state.view === "sql"
          ? `${base}/sql${state.queryId ? `/${encodeURIComponent(state.queryId)}` : ""}`
          : state.sourceId
            ? `${base}/sources/${encodeURIComponent(state.sourceId)}`
            : base;
  const search = new URLSearchParams();
  if (state.view === "data" && state.kind) search.set("kind", state.kind);
  if (state.settings) search.set("settings", state.settings);
  if (state.view === "sql" && state.alertId && !state.queryId) search.set("alert", state.alertId);
  if (state.view === "sources" && state.alertId && !state.sourceId) search.set("alert", state.alertId);
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
