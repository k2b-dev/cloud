import { navigationState } from "../workspace/navigation-catalog";
import type { PublicOkWorkspaceState, PublicWorkspaceRecordsRoute } from "../workspace/workspace-public-state-model";
import RecordsView from "./RecordsView";

/** The records page of a table or view on v2: the records route of the base page, with the base's frame. */
export default function RecordsScreen(props: { state: PublicOkWorkspaceState; userId?: string; now?: string }) {
  const state = props.state;
  const records = state.route as PublicWorkspaceRecordsRoute;
  return (
    <RecordsView
      frame={navigationState(state)}
      revision={state.workspaceRevision}
      currentUserId={props.userId}
      baseId={state.base.id}
      baseName={state.base.name}
      tableId={records.activeTable.id}
      tableKind={records.activeTable.kind}
      tableName={records.activeTable.name}
      tableDescription={records.activeTable.description ?? null}
      tableIcon={records.activeTable.icon ?? null}
      tableColumns={records.activeTable.columns}
      tableUpdatedAt={records.activeTable.updatedAt}
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
      initialError={records.initialError}
      initialEventCursor={state.liveCursor}
      initialSelectedRecord={records.initialSelectedRecord}
      initialSelectedRecordDetail={records.initialSelectedRecordDetail}
      now={props.now}
      documentTemplates={records.documentTemplates}
      relationLabels={records.relationLabels}
      viewColumns={records.activeViewColumns}
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
