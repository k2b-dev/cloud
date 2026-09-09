import { AppWorkspace, Placeholder, useLocale } from "@k2b/ui";
import { createSignal, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import type { GridsWorkflowRun } from "../../../workflows/contracts";
import CustomAppBuilder from "../custom-apps/CustomAppBuilder";
import DocumentsWorkspace from "../documents/DocumentsWorkspace";
import DocumentTemplateWorkspace from "../documents/DocumentTemplateWorkspace";
import QueryResultView from "../query/QueryResultView";
import QueryWorkspace from "../query/QueryWorkspace";
import RecordsView from "../records-view/RecordsView";
import { WorkflowRunDetailPanel } from "../workflows/WorkflowRunDetailPanel";
import WorkflowsPage from "../workflows/WorkflowsPage";
import BaseOverview from "./BaseOverview";
import { workspaceMessages } from "./messages";
import { workspaceMainClass } from "./workspace-layout";
import type {
  PublicOkWorkspaceState,
  PublicWorkspaceQueryResultViewRoute,
  PublicWorkspaceRecordsRoute,
} from "./workspace-public-state-model";

type PublicWorkspaceDocumentTemplateRoute = Extract<PublicOkWorkspaceState["route"], { kind: "documentTemplate" }>;
type PublicWorkspaceQueryRoute = Extract<PublicOkWorkspaceState["route"], { kind: "query" }>;
type PublicWorkspaceWorkflowsRoute = Extract<PublicOkWorkspaceState["route"], { kind: "workflows" }>;

export default function GridsRoute(props: { state: PublicOkWorkspaceState; cloudUrl: string }) {
  const { t } = workspaceMessages.resolve([useLocale()()]);
  const state = props.state;
  const route = state.route;
  if (route.kind === "overview") return <BaseOverview state={state} />;
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

  if (route.kind === "records") {
    const records = route as PublicWorkspaceRecordsRoute;
    return (
      <RecordsView
        cloudUrl={props.cloudUrl}
        baseId={state.base.id}
        baseName={state.base.name}
        tableId={records.activeTable.id}
        tableKind={records.activeTable.kind}
        tableName={records.activeTable.name}
        tableDescription={records.activeTable.description ?? null}
        tableIcon={records.activeTable.icon ?? null}
        tableColumns={records.activeTable.columns}
        tableAuditPolicy={records.activeTable.auditPolicy}
        tableMutationPolicy={records.activeTable.mutationPolicy}
        disableDirectInsert={records.activeTable.disableDirectInsert}
        viewId={records.activeView?.id ?? null}
        fields={records.fields}
        tables={state.catalog.tables}
        viewsByTable={state.catalog.viewsByTable}
        forms={records.formsForTable}
        canReadTable={records.canReadTable}
        canWrite={records.canWriteRecords}
        canManageTable={records.canManageActiveTable}
        canManageBase={state.canManageBase}
        trashMode={records.initialState.query.deletedOnly === true}
        initialAdminMode={state.adminModeRequested}
        activeView={records.activeView}
        canEditActiveView={records.canEditActiveView}
        otherTables={records.otherTables}
        fieldsByTable={state.catalog.fieldsByTable}
        viewMode={records.activeView !== null}
        initialState={records.initialState}
        initialData={records.initialData}
        initialEventCursor={state.recordEventCursor}
        initialSelectedRecord={records.initialSelectedRecord}
        initialSelectedRecordDetail={records.initialSelectedRecordDetail}
        documentTemplates={records.documentTemplates}
        relationLabels={records.relationLabels}
        viewColumns={records.activeViewColumns}
        searchableFields={records.searchableFields}
        groupedExplode={records.groupedExplode}
        activeRecordQuery={records.activeRecordQuery}
        displayConfig={records.displayConfig}
        bulkSelectionLaunchers={records.bulkSelectionLaunchers}
        recordActionLaunchers={records.recordActionLaunchers}
        dateConfig={state.dateConfig}
        workspaceRouteKey={`records:${records.activeTable.id}:${records.activeView?.id ?? ""}:${state.adminModeRequested}`}
      />
    );
  }

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
                />
              );
            })()}
          </Match>
          <Match when={route.kind === "query"}>
            {(() => {
              const query = route as PublicWorkspaceQueryRoute;
              return (
                <QueryWorkspace
                  baseId={state.base.id}
                  baseName={state.base.name}
                  initialQuery={query.initialQuery}
                  initialCursor={query.initialCursor}
                  initialPreview={query.initialPreview}
                  queryPath={query.queryPath}
                  currentSource={query.currentSource}
                  tables={state.catalog.tables}
                  fieldsByTable={state.catalog.fieldsByTable}
                  viewsByTable={state.catalog.viewsByTable}
                />
              );
            })()}
          </Match>
          <Match when={route.kind === "queryResultView"}>
            {(() => {
              const queryResult = route as PublicWorkspaceQueryResultViewRoute;
              return (
                <QueryResultView
                  baseId={state.base.id}
                  route={queryResult}
                  tables={
                    state.catalog.tables.some((table) => table.id === queryResult.activeTable.id)
                      ? state.catalog.tables
                      : [...state.catalog.tables, queryResult.activeTable]
                  }
                  fieldsByTable={{
                    ...state.catalog.fieldsByTable,
                    [queryResult.activeTable.id]: queryResult.fields,
                  }}
                  editMode={state.adminModeRequested}
                />
              );
            })()}
          </Match>
          <Match when={route.kind === "documentTemplate"}>
            {(() => {
              const document = route as PublicWorkspaceDocumentTemplateRoute;
              return (
                <DocumentTemplateWorkspace
                  baseId={state.base.id}
                  table={document.table}
                  template={document.template}
                  editableTemplate={document.editableTemplate}
                  canWriteTemplate={document.canWriteTemplate}
                  canManageTemplate={document.canManageTemplate}
                  editMode={state.adminModeRequested}
                  initialRecordId={document.initialRecordId}
                  initialDocumentViewMode={document.initialDocumentViewMode}
                  initialBrowserPage={document.initialBrowserPage}
                  dateConfig={state.dateConfig}
                />
              );
            })()}
          </Match>
          <Match when={route.kind === "documents"}>
            {(() => {
              if (route.kind !== "documents") return null;
              return (
                <DocumentsWorkspace
                  baseId={state.base.id}
                  documentTemplateLevels={state.catalog.documentTemplateLevels}
                  initialBrowserPage={route.initialBrowserPage}
                />
              );
            })()}
          </Match>
          <Match when={route.kind === "empty"}>
            <Placeholder
              surface="paper"
              description={
                <>
                  <Show
                    when={state.catalog.sidebarForms.length > 0 || state.catalog.sidebarDocumentTemplates.length > 0}
                    fallback={
                      state.canCreateTables ? (state.adminModeRequested ? t.noTablesCreate : t.noTablesEditMode) : t.noTablesWriteAccess
                    }
                  >
                    {state.catalog.sidebarDocumentTemplates.length > 0
                      ? t.limitedAccess({
                          forms: state.catalog.sidebarForms.length,
                          documents: state.catalog.sidebarDocumentTemplates.length,
                        })
                      : t.formOnlyAccess({ count: state.catalog.sidebarForms.length })}
                  </Show>
                </>
              }
            />
          </Match>
        </Switch>
      </AppWorkspace.Main>
      <AppWorkspace.Detail
        id="workflow-run"
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
