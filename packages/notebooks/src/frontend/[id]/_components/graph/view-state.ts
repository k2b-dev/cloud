import type { GraphLinksFilter } from "./model";

export const GRAPH_DISPLAYS = ["network"] as const;
export type GraphDisplay = (typeof GRAPH_DISPLAYS)[number];
export const DEFAULT_GRAPH_DISPLAY: GraphDisplay = "network";
export type GraphViewState = { view: GraphDisplay; list: boolean; links: GraphLinksFilter; hide: string[]; q: string };

function areaKeys(values: readonly string[]): string[] {
  return [...new Set(values.filter((key) => key === "top" || /^[0-9A-Za-z]{6}$/.test(key)))].slice(0, 64);
}
export function parseGraphViewState(params: URLSearchParams): GraphViewState {
  const links = params.get("links");
  const view = params.get("view");
  return {
    view: GRAPH_DISPLAYS.find((display) => display === view) ?? DEFAULT_GRAPH_DISPLAY,
    list: params.get("list") === "1",
    links: links === "linked" || links === "unlinked" ? links : "all",
    hide: areaKeys((params.get("hide") ?? "").split(",")),
    q: (params.get("q") ?? "").slice(0, 200),
  };
}
export function writeGraphViewState(url: URL, state: GraphViewState): URL {
  const next = new URL(url);
  const params = next.searchParams;
  const put = (key: string, value: string | null) => {
    if (value === null) params.delete(key);
    else params.set(key, value);
  };
  put("view", state.view === DEFAULT_GRAPH_DISPLAY ? null : state.view);
  put("list", state.list ? "1" : null);
  put("links", state.links === "all" ? null : state.links);
  put("hide", areaKeys(state.hide).join(",") || null);
  const q = state.q.slice(0, 200);
  put("q", q.trim() ? q : null);
  return next;
}
