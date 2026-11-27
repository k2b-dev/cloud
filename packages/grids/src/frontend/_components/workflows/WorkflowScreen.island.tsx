import { navigationState } from "../workspace/navigation-catalog";
import type { PublicOkWorkspaceState } from "../workspace/workspace-public-state-model";
import WorkflowScreen from "./WorkflowScreen";

/** A workflow of a base on v2: the workflows route of the base page, with the base's frame. */
export default function WorkflowScreenIsland(props: { state: PublicOkWorkspaceState }) {
  const state = props.state;
  const route = state.route;
  if (route.kind !== "workflows") return null;
  const base = `/app/grids/${encodeURIComponent(state.base.id)}/workflows`;
  return (
    <WorkflowScreen
      frame={navigationState(state)}
      revision={state.workspaceRevision}
      baseId={state.base.id}
      tables={state.catalog.tables}
      activeWorkflow={route.activeWorkflow}
      workflowHref={route.activeWorkflow ? `${base}/${encodeURIComponent(route.activeWorkflow.id)}` : base}
      selectedRunId={route.selectedRunId}
      initialSelectedRun={route.initialSelectedRun}
      workflows={state.catalog.workflows}
      workflowLevels={state.catalog.workflowLevels}
      canRunActiveWorkflow={route.canRunActiveWorkflow}
      canManageActiveWorkflow={route.canManageActiveWorkflow}
      editMode={state.adminModeRequested}
      initialOverview={route.initialOverview}
      liveCursor={state.liveCursor}
    />
  );
}
