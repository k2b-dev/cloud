import type { DateContext } from "@k2b/stdlib";
import type { RecordDisplayConfig, RecordQuery } from "../../../contracts";
import type { DslResolverDiagnostic } from "../../../query-dsl/resolver";
import type { Field, GridRecord, Table, View } from "../../../service";
import { gridsService } from "../../../service";
import * as publicResources from "../../../service/public-resources";
import type { AuthorizedRecordAccess } from "../../../service/record-access";
import { filterSearchableFields } from "../../../service/search";
import { activeDisplayConfig } from "../records-view/display-mode";
import { parseRecordsState, type RecordsState } from "../records-view/query-url";
import { emptyRecordDetail, loadRecordDetailData, writableDocumentTemplates } from "./workspace-record-detail-state";
import { compileViewSource, isComputedColumn, loadInitialRecords, outputFieldsForQuery } from "./workspace-records-query";
import { recordAccessForUser, resolveBaseLevel } from "./workspace-state-access";
import { buildViewer, okState } from "./workspace-state-helpers";
import type {
  AuthUser,
  GridsWorkspaceState,
  OkWorkspaceState,
  RuntimeView,
  WorkspaceBulkLauncher,
  WorkspaceCatalog,
  WorkspaceCommon,
  WorkspaceQueryResultViewRoute,
  WorkspaceRecordLauncher,
  WorkspaceRecordsRoute,
} from "./workspace-state-model";

const diagnosticsMessage = (diagnostics: Array<Pick<DslResolverDiagnostic, "message">>) =>
  diagnostics.map((diagnostic) => diagnostic.message).join("; ") || "invalid GQL source";

const workflowLaunchersForTable = async (
  user: AuthUser,
  baseId: string,
  tableId: string,
): Promise<{ bulk: WorkspaceBulkLauncher[]; record: WorkspaceRecordLauncher[] }> => {
  if (!gridsService.workflow?.listEnabledForBase) return { bulk: [], record: [] };
  const level = await resolveBaseLevel(user, baseId);
  if (!gridsService.permission.hasAtLeast(level, "write")) return { bulk: [], record: [] };
  const workflows = await gridsService.workflow.listEnabledForBase(baseId);
  const bulk: WorkspaceBulkLauncher[] = [];
  const record: WorkspaceRecordLauncher[] = [];
  for (const workflow of workflows) {
    for (const launcher of await gridsService.workflow.launcher.list(workflow.id, true)) {
      if (launcher.config.kind !== "bulk" && launcher.config.kind !== "record") continue;
      if (workflow.plan.bindings[`inputs.${launcher.config.input}.table`] !== tableId) continue;
      const projected = { ...launcher, workflowRevision: workflow.revision, workflowShortId: workflow.shortId };
      if (launcher.config.kind === "bulk") bulk.push(projected);
      else record.push(projected);
    }
  }
  const byName = (a: WorkspaceBulkLauncher | WorkspaceRecordLauncher, b: WorkspaceBulkLauncher | WorkspaceRecordLauncher) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  return { bulk: bulk.sort(byName), record: record.sort(byName) };
};

const selectedRecordMeta = (
  recordMeta: RecordQuery["recordMeta"] | null,
  selectedRecordId: string,
): NonNullable<RecordQuery["recordMeta"]> | null => {
  if (recordMeta?.ids?.length && !recordMeta.ids.includes(selectedRecordId)) return null;
  return { ...(recordMeta ?? {}), ids: [selectedRecordId] };
};

const loadSelectedRecordThroughView = async (params: {
  activeTable: Table;
  selectedRecordId: string;
  viewQuery: RecordQuery;
  user: AuthUser;
  dateConfig?: DateContext;
  recordAccess: AuthorizedRecordAccess;
}): Promise<GridRecord | null> => {
  const recordMeta = selectedRecordMeta(params.viewQuery.recordMeta ?? null, params.selectedRecordId);
  if (!recordMeta) return null;
  if (params.viewQuery.limit !== undefined) {
    let cursor: string | null = null;
    let remaining = params.viewQuery.limit;
    while (remaining > 0) {
      const pageSize = Math.min(remaining, 200);
      const result = await gridsService.record.list({
        tableId: params.activeTable.id,
        limit: pageSize,
        includeDeleted: params.viewQuery.includeDeleted,
        deletedOnly: params.viewQuery.deletedOnly,
        filter: params.viewQuery.filter ?? null,
        search: params.viewQuery.search ?? null,
        recordMeta: params.viewQuery.recordMeta ?? null,
        sort: params.viewQuery.sort ?? [],
        cursor,
        includeRelations: true,
        viewer: buildViewer(params.user),
        dateConfig: params.dateConfig,
        computedColumns: params.viewQuery.columns?.filter(isComputedColumn),
        recordAccess: params.recordAccess,
      });
      if (!result.ok) return null;
      const record = result.data.items.find((item) => item.id === params.selectedRecordId);
      if (record) return record;
      remaining -= result.data.items.length;
      cursor = result.data.nextCursor;
      if (!cursor || result.data.items.length === 0) return null;
    }
    return null;
  }
  const result = await gridsService.record.list({
    tableId: params.activeTable.id,
    limit: 1,
    includeDeleted: params.viewQuery.includeDeleted,
    deletedOnly: params.viewQuery.deletedOnly,
    filter: params.viewQuery.filter ?? null,
    search: params.viewQuery.search ?? null,
    recordMeta,
    sort: params.viewQuery.sort ?? [],
    cursor: null,
    includeRelations: true,
    viewer: buildViewer(params.user),
    dateConfig: params.dateConfig,
    computedColumns: params.viewQuery.columns?.filter(isComputedColumn),
    recordAccess: params.recordAccess,
  });
  if (!result.ok) return null;
  return result.data.items.find((record) => record.id === params.selectedRecordId) ?? null;
};

type ResolvedRecordsView = {
  activeTableLevel: "none" | "read" | "write" | "admin";
  activeView: View | null;
  activeViewForQuery: RuntimeView | null;
  queryResultView: View | null;
  canEditActiveView: boolean;
  fields: Field[];
  recordAccess: AuthorizedRecordAccess | null;
};

const resolveRecordsView = async (
  common: WorkspaceCommon,
  activeTable: Table,
  activeViewSlug?: string | null,
): Promise<ResolvedRecordsView | Extract<GridsWorkspaceState, { kind: "invalidQuery" }>> => {
  const activeTableLevel = common.catalog.tableLevels[activeTable.id] ?? "none";
  const viewsForTable = common.catalog.viewsByTable[activeTable.id] ?? [];
  const candidateView = activeViewSlug ? await gridsService.view.getByShortIdForTable(activeTable.id, activeViewSlug) : null;
  const catalogView = candidateView ? (viewsForTable.find((view) => view.id === candidateView.id) ?? null) : null;
  const candidateViewLevel = candidateView ? await resolveBaseLevel(common.params.user, common.base.id) : "none";
  const activeView =
    catalogView ?? (candidateView && gridsService.permission.hasAtLeast(candidateViewLevel, "read") ? candidateView : null);
  const allFields =
    common.catalog.fieldsByTable[activeTable.id] ?? (activeView ? await gridsService.field.listByTable(activeTable.id) : []);
  const viewCompilerCatalog: WorkspaceCatalog =
    activeView && !catalogView
      ? {
          ...common.catalog,
          tables: common.catalog.tables.some((table) => table.id === activeTable.id)
            ? common.catalog.tables
            : [...common.catalog.tables, activeTable],
          tableLevels: { ...common.catalog.tableLevels, [activeTable.id]: activeTableLevel },
          fieldsByTable: { ...common.catalog.fieldsByTable, [activeTable.id]: allFields },
          viewsByTable: { ...common.catalog.viewsByTable, [activeTable.id]: [activeView] },
        }
      : common.catalog;
  const localCompiledView = activeView ? compileViewSource(viewCompilerCatalog, activeTable, activeView) : null;
  const compiledView =
    localCompiledView && !localCompiledView.ok && activeView && !catalogView
      ? ({ ok: true, kind: "queryResult", fieldIds: [] } as const)
      : localCompiledView;
  if (compiledView && !compiledView.ok) {
    return {
      kind: "invalidQuery",
      title: "Invalid view GQL source",
      message: diagnosticsMessage(compiledView.diagnostics),
    };
  }
  const activeViewForQuery: RuntimeView | null =
    activeView && compiledView?.ok && compiledView.kind === "records"
      ? {
          ...activeView,
          query: compiledView.query,
          displayConfig: activeView.ui.displayConfig ?? { mode: "table" },
        }
      : null;
  const queryResultFieldIds = compiledView?.ok && compiledView.kind === "queryResult" ? new Set(compiledView.fieldIds) : null;
  const recordAccess = await recordAccessForUser(common.params.user, common.base.id);
  return {
    activeTableLevel,
    activeView,
    activeViewForQuery,
    queryResultView: activeView && compiledView?.ok && compiledView.kind === "queryResult" ? activeView : null,
    canEditActiveView:
      !!activeView && (activeView.ownerUserId === common.params.user.id || gridsService.permission.hasAtLeast(candidateViewLevel, "admin")),
    fields: activeViewForQuery
      ? outputFieldsForQuery(allFields, activeViewForQuery.query)
      : queryResultFieldIds
        ? allFields.filter((field) => queryResultFieldIds.has(field.id))
        : allFields,
    recordAccess,
  };
};

const buildQueryResultViewRoute = async (
  common: WorkspaceCommon,
  activeTable: Table,
  view: ResolvedRecordsView,
): Promise<WorkspaceQueryResultViewRoute> => {
  if (!view.queryResultView) throw new Error("Query result view route requires a query result view");
  const canManageTable = gridsService.permission.hasAtLeast(view.activeTableLevel, "admin");
  return {
    kind: "queryResultView",
    activeTable,
    activeView: view.queryResultView,
    fields: view.fields,
    canManageActiveTable: canManageTable,
    canEditActiveView: view.canEditActiveView,
    initialCursor: common.chrome.url.searchParams.get("cursor"),
    initialResult: null,
  };
};

const loadSelectedRecord = async (params: {
  common: WorkspaceCommon;
  activeTable: Table;
  view: ResolvedRecordsView;
  recordsState: RecordsState;
  initial: Awaited<ReturnType<typeof loadInitialRecords>>;
}): Promise<GridRecord | null> => {
  const selectedRecordId = params.recordsState.selectedRecordId;
  if (!selectedRecordId) return null;
  if (params.view.activeViewForQuery && !gridsService.permission.hasAtLeast(params.view.activeTableLevel, "read")) {
    return loadSelectedRecordThroughView({
      activeTable: params.activeTable,
      selectedRecordId,
      viewQuery: params.view.activeViewForQuery.query,
      user: params.common.params.user,
      dateConfig: params.common.params.dateConfig,
      recordAccess: params.view.recordAccess!,
    });
  }
  const listedRecord = params.initial.records.items.find((record) => record.id === selectedRecordId);
  if (listedRecord) return listedRecord;
  return gridsService.record.get(params.activeTable.id, selectedRecordId, {
    dateConfig: params.common.params.dateConfig,
    viewer: buildViewer(params.common.params.user),
    deleted: params.common.chrome.trashMode ? "only" : params.initial.effectiveIncludeDeleted ? "include" : "live",
    recordAccess: params.view.recordAccess!,
  });
};

const buildRecordsRoute = async (params: {
  common: WorkspaceCommon;
  activeTable: Table;
  view: ResolvedRecordsView;
  recordsState: RecordsState;
  displayConfig: RecordDisplayConfig;
  initial: Awaited<ReturnType<typeof loadInitialRecords>>;
  selectedRecord: GridRecord | null;
}): Promise<WorkspaceRecordsRoute> => {
  const { common, activeTable, view, recordsState, displayConfig, initial, selectedRecord } = params;
  const canReadTable = gridsService.permission.hasAtLeast(view.activeTableLevel, "read");
  const canManageTable = gridsService.permission.hasAtLeast(view.activeTableLevel, "admin");
  const initialSelectedRecordDetail = selectedRecord
    ? canReadTable
      ? await loadRecordDetailData({
          tableId: activeTable.id,
          recordId: selectedRecord.id,
          record: selectedRecord,
          fields: view.fields,
          viewer: buildViewer(common.params.user),
        })
      : activeTable.kind === "federated" && view.activeViewForQuery
        ? await loadRecordDetailData({
            tableId: activeTable.id,
            recordId: selectedRecord.id,
            record: selectedRecord,
            fields: view.fields,
            viewer: buildViewer(common.params.user),
            scope: "history",
          })
        : emptyRecordDetail(selectedRecord.id)
    : null;
  const workflowLaunchers = await workflowLaunchersForTable(common.params.user, common.base.id, activeTable.id);
  return {
    kind: "records",
    activeTable,
    activeView: view.activeViewForQuery,
    fields: view.fields,
    formsForTable: gridsService.permission.hasAtLeast(view.activeTableLevel, "read")
      ? (common.catalog.formsByTable[activeTable.id] ?? [])
      : [],
    canReadTable,
    canWriteRecords: activeTable.kind === "stored" && gridsService.permission.hasAtLeast(view.activeTableLevel, "write"),
    canManageActiveTable: canManageTable,
    canEditActiveView: view.canEditActiveView,
    otherTables: common.catalog.tables.map((table) => ({ id: table.id, name: table.name })),
    initialState: {
      query: {
        filter: initial.effectiveFilter ?? undefined,
        recordMeta: initial.effectiveRecordMeta ?? undefined,
        sort: initial.effectiveSort,
        groupBy: initial.effectiveGroupBy,
        groupSort: initial.effectiveGroupSort,
        aggregations: initial.effectiveAggregations,
        columns: initial.effective.columns,
        includeDeleted: initial.effectiveIncludeDeleted,
        deletedOnly: initial.effective.deletedOnly,
      },
      cursor: recordsState.cursor,
      selectedRecordId: recordsState.selectedRecordId,
      search: initial.effectiveSearch,
      calendar: recordsState.calendar,
      cardSize: recordsState.cardSize,
    },
    initialData: {
      items: initial.records.items,
      buckets: initial.groupedBuckets,
      aggregates: initial.aggregates,
      nextCursor: initial.records.nextCursor,
      explode: initial.groupedExplode,
      filePreviews: initial.records.filePreviews,
    },
    initialSelectedRecord: selectedRecord,
    initialSelectedRecordDetail,
    documentTemplates: writableDocumentTemplates(common, activeTable.id),
    relationLabels: initial.relationLabels,
    activeViewColumns: initial.effective.columns,
    searchableFields: filterSearchableFields(view.fields),
    groupedExplode: initial.groupedExplode,
    activeRecordQuery: view.activeViewForQuery?.query ?? null,
    displayConfig,
    bulkSelectionLaunchers: workflowLaunchers.bulk,
    recordActionLaunchers: workflowLaunchers.record,
  };
};

export const loadRecordsState = async (
  common: WorkspaceCommon,
  activeTable: Table,
  activeViewSlug?: string | null,
): Promise<OkWorkspaceState | Extract<GridsWorkspaceState, { kind: "invalidQuery" }>> => {
  const view = await resolveRecordsView(common, activeTable, activeViewSlug);
  if ("kind" in view) return view;
  if (!gridsService.permission.hasAtLeast(view.activeTableLevel, "read") && !view.activeView) {
    return okState(common, { kind: "empty" });
  }
  if (!view.recordAccess) return okState(common, { kind: "empty" });
  if (view.queryResultView) {
    return okState(common, await buildQueryResultViewRoute(common, activeTable, view), [
      ...common.chrome.titleBase,
      {
        title: activeTable.name,
        href: "/app/grids/" + common.base.shortId + "/table/" + activeTable.shortId,
      },
      { title: view.queryResultView.name },
    ]);
  }
  const parsedRecordsState = parseRecordsState(common.chrome.url.searchParams);
  const recordsState: RecordsState = {
    ...parsedRecordsState,
    selectedRecordId: parsedRecordsState.selectedRecordId
      ? await publicResources.resolveStoredPublicId("record", parsedRecordsState.selectedRecordId)
      : null,
  };
  const displayConfig = activeDisplayConfig(activeTable.displayConfig, view.activeViewForQuery?.displayConfig);
  const strictViewScope = !!view.activeViewForQuery && !gridsService.permission.hasAtLeast(view.activeTableLevel, "read");
  const initial = await loadInitialRecords({
    activeTable,
    fields: view.fields,
    recordsState,
    activeView: view.activeViewForQuery,
    strictViewScope,
    displayConfig,
    trashMode: strictViewScope ? view.activeViewForQuery?.query.deletedOnly === true : common.chrome.trashMode,
    user: common.params.user,
    dateConfig: common.params.dateConfig,
    recordAccess: view.recordAccess,
  });
  const selectedRecord = await loadSelectedRecord({ common, activeTable, view, recordsState, initial });
  const route = await buildRecordsRoute({ common, activeTable, view, recordsState, displayConfig, initial, selectedRecord });
  return okState(common, route, [
    ...common.chrome.titleBase,
    ...(view.activeView
      ? [
          {
            title: activeTable.name,
            href: "/app/grids/" + common.base.shortId + "/table/" + activeTable.shortId,
          },
          { title: view.activeView.name },
        ]
      : [{ title: activeTable.name }]),
  ]);
};
