import { AppWorkspace } from "@k2b/ui";
import { createSignal, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import type { GridsWorkflowRun } from "../../../workflows/contracts";
import CustomAppBuilder from "../custom-apps/CustomAppBuilder";
import { WorkflowRunDetailPanel } from "../workflows/WorkflowRunDetailPanel";
import WorkflowsPage from "../workflows/WorkflowsPage";
import { workspaceMainClass } from "./workspace-layout";
import type { PublicOkWorkspaceState } from "./workspace-public-state-model";

type PublicWorkspaceWorkflowsRoute = Extract<PublicOkWorkspaceState["route"], { kind: "workflows" }>;

export default function GridsRoute(props: { state: PublicOkWorkspaceState; userId?: string; now?: string }) {
  const state = props.state;
  const route = state.route;
  // The base home (overview, empty) renders on v2 in frame/BaseHome; this island serves the remaining kinds.
  if (route.kind === "overview" || route.kind === "empty") return null;
  const [selectedWorkflowRunId, setSelectedWorkflowRunId] = createSignal(route.kind === "workflows" ? route.selectedRunId : null);
  const [workflowRunUpdate, setWorkflowRunUpdate] = createSignal<GridsWorkflowRun | null>(null);

  if (route.kind === "customApp") {
    return (
      <CustomAppBuilder
        app={route.app}
        baseId={state.base.id}
        catalog={state.catalog}
        dateConfig={state.dateConfig}
        editMode={state.adminModeRequested}
        initialSettingsOpen={route.initialSettingsOpen}
      />
    );
  }

  const updateWorkflowRun = (runId: string | null) => {
    const url = new URL(window.location.href);
    if (runId) url.searchParams.set("run", runId);
    else url.searchParams.delete("run");
    window.history.pushState(null, "", `${url.pathname}${url.search}`);
    setWorkflowRunUpdate(null);
    setSelectedWorkflowRunId(runId);
  };

  const reloadRoute = () => window.location.reload();

  onMount(() => {
    if (route.kind === "workflows") {
      const onPopState = () => {
        setWorkflowRunUpdate(null);
        setSelectedWorkflowRunId(new URL(window.location.href).searchParams.get("run"));
      };
      window.addEventListener("popstate", onPopState);
      onCleanup(() => window.removeEventListener("popstate", onPopState));
    }
  });

  // Records render on v2 in records-view/RecordsScreen; this island serves the remaining kinds.
  if (
    route.kind === "records" ||
    route.kind === "documents" ||
    route.kind === "query" ||
    route.kind === "queryResultView" ||
    route.kind === "documentTemplate"
  )
    return null;

  return (
    <>
      <AppWorkspace.Main class={workspaceMainClass(route.kind)} scroll={false}>
        <Switch>
          <Match when={route.kind === "workflows"}>
            {(() => {
              const workflows = route as PublicWorkspaceWorkflowsRoute;
              return (
                <WorkflowsPage
                  baseId={state.base.id}
                  tables={state.catalog.tables}
                  activeWorkflow={workflows.activeWorkflow}
                  selectedRunId={selectedWorkflowRunId()}
                  runUpdate={workflowRunUpdate()}
                  canCreateWorkflows={state.canManageBase}
                  canRunActiveWorkflow={workflows.canRunActiveWorkflow}
                  canManageActiveWorkflow={workflows.canManageActiveWorkflow}
                  editMode={state.adminModeRequested}
                  initialOverview={workflows.initialOverview}
                  onWorkflowChanged={reloadRoute}
                  onSelectRun={updateWorkflowRun}
                  liveCursor={state.liveCursor}
                />
              );
            })()}
          </Match>
        </Switch>
      </AppWorkspace.Main>
      <AppWorkspace.Detail
        id="workflow-run"
        onClose={() => updateWorkflowRun(null)}
        open={Boolean(selectedWorkflowRunId())}
        width="lg"
        viewTransitionName="grids-workflow-run-detail"
      >
        <Show keyed when={selectedWorkflowRunId()}>
          {(runId) => (
            <WorkflowRunDetailPanel
              runId={runId}
              initialDetail={route.kind === "workflows" && route.initialSelectedRun?.run.id === runId ? route.initialSelectedRun : null}
              workflows={state.catalog.workflows}
              workflowLevels={state.catalog.workflowLevels}
              tables={state.catalog.tables}
              liveCursor={state.liveCursor}
              onRunUpdated={setWorkflowRunUpdate}
              onSelectRun={updateWorkflowRun}
              onClose={() => updateWorkflowRun(null)}
            />
          )}
        </Show>
      </AppWorkspace.Detail>
    </>
  );
}
