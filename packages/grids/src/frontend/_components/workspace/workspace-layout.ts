import type { GridsWorkspaceRoute } from "./workspace-state-model";

type WorkspaceRouteKind = GridsWorkspaceRoute["kind"];
type WorkspaceSurface = "edge-to-edge" | "inset";

const WORKSPACE_SURFACES = {
  customApp: "edge-to-edge",
  queryResultView: "inset",
  documentTemplate: "inset",
  documents: "inset",
  overview: "edge-to-edge",
  empty: "inset",
  // Query panes own their full workbench gutters.
  query: "edge-to-edge",
  records: "inset",
  workflows: "inset",
} satisfies Record<WorkspaceRouteKind, WorkspaceSurface>;

export const workspaceRootClass = (editMode: boolean): string => `min-h-0 flex-1${editMode ? " grids-workspace-editing" : ""}`;

export const workspaceMainClass = (kind: WorkspaceRouteKind): string | undefined =>
  WORKSPACE_SURFACES[kind] === "inset" ? "p-[var(--ui-space-shell)]" : undefined;
