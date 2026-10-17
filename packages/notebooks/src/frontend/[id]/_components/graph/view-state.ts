import type { GraphLinksFilter } from "./model";

export const GRAPH_DISPLAYS = ["network"] as const;
export type GraphDisplay = (typeof GRAPH_DISPLAYS)[number];
export const DEFAULT_GRAPH_DISPLAY: GraphDisplay = "network";
export const GRAPH_QUERY_MAX = 200;
export type GraphViewState = { display: GraphDisplay; list: boolean; links: GraphLinksFilter; hide: string[]; q: string };

/** Valid, deduplicated area keys. No count cap: the toggles only add areas that exist, and the request URL limit bounds the rest. */
function areaKeys(values: readonly string[]): string[] {
  return [...new Set(values.filter((key) => key === "top" || /^[0-9A-Za-z]{6}$/.test(key)))];
}
export function normalizeGraphViewState(state: GraphViewState): GraphViewState {
  return {
    ...state,
    display: GRAPH_DISPLAYS.find((display) => display === state.display) ?? DEFAULT_GRAPH_DISPLAY,
    hide: areaKeys(state.hide),
    q: state.q.slice(0, GRAPH_QUERY_MAX),
  };
}
export function parseGraphViewState(params: URLSearchParams): GraphViewState {
  const links = params.get("links");
  const display = params.get("display");
  return normalizeGraphViewState({
    display: GRAPH_DISPLAYS.find((value) => value === display) ?? DEFAULT_GRAPH_DISPLAY,
    list: params.get("list") === "1",
    links: links === "linked" || links === "unlinked" ? links : "all",
    hide: (params.get("hide") ?? "").split(","),
    q: params.get("q") ?? "",
  });
}
export function writeGraphViewState(url: URL, state: GraphViewState): URL {
  const normalized = normalizeGraphViewState(state);
  const next = new URL(url);
  const params = next.searchParams;
  const put = (key: string, value: string | null) => {
    if (value === null) params.delete(key);
    else params.set(key, value);
  };
  put("display", normalized.display === DEFAULT_GRAPH_DISPLAY ? null : normalized.display);
  put("list", normalized.list ? "1" : null);
  put("links", normalized.links === "all" ? null : normalized.links);
  put("hide", normalized.hide.join(",") || null);
  put("q", normalized.q.trim() ? normalized.q : null);
  return next;
}
