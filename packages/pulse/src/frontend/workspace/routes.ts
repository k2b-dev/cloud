export type WorkspaceView = "sources" | "coming-back";
export type WorkspaceRouteState = { view: WorkspaceView; sourceId: string };
export type WorkspaceHrefOptions = {
  baseId: string;
  state: { view: WorkspaceView; sourceId?: string };
};

const removedViews = new Set(["dashboards", "explorer", "signals", "resources", "events", "metrics", "states", "query-reference"]);

export const readWorkspacePathState = (path: string, baseId: string): WorkspaceRouteState => {
  const basePath = `/app/pulse/${baseId}`;
  if (baseId && (path === basePath || path.startsWith(`${basePath}/`))) {
    const [view, sourceId] = path.slice(basePath.length).split("/").filter(Boolean);
    if (view === "sources") return { view: "sources", sourceId: sourceId ?? "" };
    if (view && removedViews.has(view)) return { view: "coming-back", sourceId: "" };
  }
  return { view: "sources", sourceId: "" };
};

export const buildPulseWorkspaceHref = ({ baseId, state }: WorkspaceHrefOptions): string => {
  if (!baseId) return "/app/pulse";
  const base = `/app/pulse/${encodeURIComponent(baseId)}`;
  if (state.view === "coming-back") return `${base}/dashboards`;
  return `${base}/sources${state.sourceId ? `/${encodeURIComponent(state.sourceId)}` : ""}`;
};
