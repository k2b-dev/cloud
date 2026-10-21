import { SQL_MAX_BYTES } from "../../sql-params";
import { buildPulseWorkspaceHref, readConsoleParams, type WorkspaceRouteState } from "./routes";

const KEY = "pulseSqlDraft";
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const routeHref = (href: string) => {
  const url = new URL(href, "http://pulse.invalid");
  url.searchParams.delete("settings");
  return `${url.pathname}${url.search}`;
};

/** One bounded draft per history entry; keep navigation state belonging to the host. */
export const sqlDraftHistoryState = (previous: unknown, baseId: string, route: WorkspaceRouteState) => {
  const state: Record<string, unknown> = record(previous) ? { ...previous } : {};
  delete state[KEY];
  const href = buildPulseWorkspaceHref({ baseId, state: route });
  const search = new URL(href, "http://pulse.invalid").searchParams;
  const params = readConsoleParams(route.params ?? {});
  if (
    params &&
    (route.sql === undefined || new TextEncoder().encode(route.sql).length <= SQL_MAX_BYTES) &&
    ((route.sql !== undefined && !search.has("sql")) || (Object.keys(params).length > 0 && !search.has("params")))
  ) {
    // Reuse the route parser when restoring untrusted history state.
    state[KEY] = { baseId, href: routeHref(href), ...(route.sql === undefined ? {} : { sql: route.sql }), params };
  }
  return state;
};

export const readSqlDraftHistory = (historyState: unknown, baseId: string, href: string): WorkspaceRouteState | null => {
  const draft = record(historyState) ? historyState[KEY] : undefined;
  if (
    !record(draft) ||
    draft.baseId !== baseId ||
    draft.href !== routeHref(href) ||
    (draft.sql !== undefined && typeof draft.sql !== "string") ||
    !record(draft.params)
  )
    return null;
  // Validation uses the same per-field limits as URLs, without the URL length
  // budget: a history draft never travels in an HTTP request or shared link.
  const route = new URL(href, "http://pulse.invalid");
  const prefix = `/app/pulse/${encodeURIComponent(baseId)}/sql`;
  if (route.pathname !== prefix && !route.pathname.startsWith(`${prefix}/`)) return null;
  if (typeof draft.sql === "string" && new TextEncoder().encode(draft.sql).length > SQL_MAX_BYTES) return null;
  const params = readConsoleParams(draft.params);
  if (!params) return null;
  return { view: "sql", sourceId: "", ...(typeof draft.sql === "string" ? { sql: draft.sql } : {}), params };
};
