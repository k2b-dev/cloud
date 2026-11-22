import { publishPageContext } from "@k2b/cloud/browser/panel";
import type { DateContext } from "@k2b/stdlib";
import {
  AppWorkspace,
  Button,
  ButtonLink,
  dialogCore,
  NoticeCard,
  PanelDialog,
  panelDialogWideOptions,
  prompts,
  StatusRow,
  useLocale,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { preloadBarcodes } from "#barcode-drawing";
import type {
  PublicField as Field,
  PublicForm as Form,
  PublicGridRecord as GridRecord,
  PublicTable as Table,
  PublicTableQueryResult as TableQueryResult,
  PublicView as View,
} from "../../../api/public-dto";
import type {
  AggregationSpec,
  ColumnSpec,
  FieldColumnSpec,
  GroupBySpec,
  RecordDisplayConfig,
  RecordQuery,
  TableAuditPolicy,
  TableMutationPolicy,
} from "../../../contracts";
import { simpleQueryToGqlSource } from "../../../query-dsl/record-query-source";
import { filterSearchableFields } from "../../../searchable-fields";
import { defaultTableAggregations } from "../../../table-defaults";
import { gridsPageScope } from "../../page-context";
import type { PublicDocumentTemplateSummary } from "../documents/public-document-types";
import QueryWorkspace from "../query/QueryWorkspace";
import type { QueryWorkspaceCurrentSource } from "../query/query-workspace-model";
import { openCombinedAuditDialog } from "../records/CombinedAuditDialog";
import { openExportRecordsDialog } from "../records/ExportRecordsDialog";
import { recordMessages } from "../records/messages";
import { createRecordAccess } from "../records/record-access";
import { fieldDisplayFormatForView } from "../records/record-display";
import type { GroupBucket } from "../table/GroupedTable";
import { GridCreateActions, GridCreatePrimary, offersGridCreateActions } from "../toolbar/GridCreateActions";
import GridToolbar, { type GridToolbarSaveView } from "../toolbar/GridToolbar";
// Plain children share RecordsView's hydrated state; nested islands cannot
// serialize the callback props used by these controls.
import { workspaceMainClass } from "../workspace/workspace-layout";
import type {
  PublicWorkspaceBulkLauncher as WorkspaceBulkLauncher,
  PublicWorkspaceRecordDetail as WorkspaceRecordDetail,
  PublicWorkspaceRecordLauncher as WorkspaceRecordLauncher,
} from "../workspace/workspace-public-state-model";
import { activeDisplayConfig, calendarQueryFilter, cardImageFieldIds, removeCalendarQueryFilter } from "./display-mode";
import { recordsViewMessages } from "./messages";
import type { CardSize, RecordsState } from "./query-url";
import { cleanRecordMetaQuery, openRecordMetadataDialog, recordMetaActiveCount } from "./RecordMetadataDialog";
import { RecordsAdminToolbar } from "./RecordsAdminToolbar";
import RecordsDetailSurface from "./RecordsDetailSurface";
import RecordsResultSurface from "./RecordsResultSurface";
import { recordCountText as formatRecordCount } from "./record-count";
import { createRecordsAdminController } from "./records-admin-controller";
import { createRecordsBulkController } from "./records-bulk-controller";
import { createRecordsDataController } from "./records-data-controller";
import { forgetRecordsHeadStatus, NEW_RECORD_PARAM, onRecordsHeadCommand, publishRecordsHeadStatus } from "./records-head-bus";
import { createRecordsSelectionController } from "./records-selection-controller";
import { createRecordsUrlController } from "./records-url-controller";
import { createRecordsViewColumnController, isFieldColumn } from "./records-view-columns";
import { aggregationRowsFromQuery, applyToolbarQueryPatch, filterRowsFromQuery, type ToolbarQueryPatch } from "./toolbar-query";

export const QUERY_PANEL_DIALOG_OPTIONS = panelDialogWideOptions;

/**
 * Records-area island. It owns presentation state and delegates URL,
 * query/live data, columns, and admin mutations to focused controllers.
 */

type RuntimeView = View & {
  query: RecordQuery;
  displayConfig: RecordDisplayConfig;
};

type Props = {
  /** The viewer, marked as "You" among the people with access. */
  currentUserId?: string;
  /** UUID of the base — for API calls. */
  baseId: string;
  baseName?: string;
  /** UUID of the active table — for API calls (POST /api/grids/.../by-table/<uuid>). */
  tableId: string;
  tableKind: "stored" | "federated";
  /** Human table name for record-write dialog context. */
  tableName: string;
  tableDescription: string | null;
  tableIcon?: string | null;
  tableColumns: FieldColumnSpec[];
  /** The table version `tableColumns` belongs to. */
  tableUpdatedAt: string;
  tableAuditPolicy: TableAuditPolicy;
  tableMutationPolicy: TableMutationPolicy;
  /** Table-level setting: when true, records should be created through forms. */
  disableDirectInsert: boolean;
  /** Short-id of the active saved view, or null when no view. Drives
   *  the `/view/<short>` URL segment. */
  viewId: string | null;
  fields: Field[];
  tables: Table[];
  viewsByTable: Record<string, View[]>;
  forms: Form[];
  canReadTable: boolean;
  canWrite: boolean;
  canManageTable: boolean;
  canManageBase: boolean;
  trashMode: boolean;
  initialAdminMode: boolean;
  activeView?: RuntimeView | null;
  canEditActiveView?: boolean;
  /** Tables in the same base, including the active table for self-relations. */
  otherTables: Array<{ id: string; name: string }>;
  fieldsByTable: Record<string, Field[]>;
  /** True on a saved-view route. Its query is edited through view settings,
   *  so the ad-hoc table toolbar is hidden. */
  viewMode: boolean;
  initialState: RecordsState;
  initialData: TableQueryResult;
  /** Message of the server's failed records read; `initialData` is then empty. */
  initialError: string | null;
  initialEventCursor: string | null;
  /** Selected-record payload from SSR — non-null when the URL had
   *  ?record=<id> at initial render. Lets the panel show immediately
   *  on deep-link without a client-side fetch. */
  initialSelectedRecord: GridRecord | null;
  initialSelectedRecordDetail: WorkspaceRecordDetail | null;
  documentTemplates: PublicDocumentTemplateSummary[];
  relationLabels: Record<string, string>;
  viewColumns: ColumnSpec[] | undefined;
  groupedExplode: boolean;
  /** Stored query of the active path-based view, used as the base for URL overrides. */
  activeRecordQuery: RecordQuery | null;
  displayConfig: RecordDisplayConfig;
  bulkSelectionLaunchers: WorkspaceBulkLauncher[];
  recordActionLaunchers: WorkspaceRecordLauncher[];
  dateConfig?: DateContext;
  /** Server time for the same history on the server and the first browser render. */
  now?: string;
  workspaceRouteKey: string;
};

export default function RecordsView(props: Props) {
  const locale = useLocale();
  const t = () => recordsViewMessages.resolve([locale()]).t;
  const recordAccess = createRecordAccess(
    () => props.baseId,
    () => recordMessages.resolve([locale()]).t.accessLoadFailed,
  );
  // ── Canonical state ────────────────────────────────────────────────
  const [tableName, setTableName] = createSignal(props.tableName);
  const [tableDescription, setTableDescription] = createSignal(props.tableDescription);
  const [tableIcon, setTableIcon] = createSignal(props.tableIcon ?? null);
  const [tableColumns, setTableColumns] = createSignal<FieldColumnSpec[]>(props.tableColumns);
  const [tableUpdatedAt, setTableUpdatedAt] = createSignal(props.tableUpdatedAt);
  const [tableAuditPolicy, setTableAuditPolicy] = createSignal<TableAuditPolicy>(props.tableAuditPolicy);
  const [tableMutationPolicy, setTableMutationPolicy] = createSignal<TableMutationPolicy>(props.tableMutationPolicy);
  const mutationSourceAllowed = (source: "direct" | "form" | "workflow") => {
    const policy = tableMutationPolicy();
    return policy.mode === "all" || policy.sources.includes(source);
  };
  const canDirectWrite = () => props.canWrite && mutationSourceAllowed("direct");
  const canRunWorkflows = () => props.canWrite && mutationSourceAllowed("workflow");
  const [tableDisplayConfig, setTableDisplayConfig] = createSignal<RecordDisplayConfig>(
    props.activeView ? { mode: "table" } : props.displayConfig,
  );
  const [viewDisplayConfig, setViewDisplayConfig] = createSignal<RecordDisplayConfig | null>(props.activeView?.displayConfig ?? null);
  const displayConfig = () => activeDisplayConfig(tableDisplayConfig(), viewDisplayConfig());
  const [disableDirectInsert, setDisableDirectInsert] = createSignal(props.disableDirectInsert);
  const [fields, setFields] = createSignal<Field[]>([...props.fields].sort((a, b) => a.position - b.position));
  // A saved view narrows `fields` to its output columns, which for a grouped view can be just the group field.
  // Group members are whole table records, so the group panel reads the table's own fields.
  const viewTableFieldsFromProps = props.activeView ? props.fieldsByTable[props.tableId] : undefined;
  const [viewTableFields, setViewTableFields] = createSignal<Field[] | null>(
    viewTableFieldsFromProps ? [...viewTableFieldsFromProps].sort((a, b) => a.position - b.position) : null,
  );
  const tableFields = () => viewTableFields() ?? fields();
  const setTableFields = viewTableFieldsFromProps ? (next: Field[]) => setViewTableFields(next) : undefined;
  const [forms, setForms] = createSignal<Form[]>(props.forms);
  const isSavedView = () => props.viewMode || !!props.activeView || !!props.viewId;
  const canUseEditMode = () => (isSavedView() ? !!props.canEditActiveView : props.canManageTable);
  const queryWorkspaceHref = () =>
    props.viewId
      ? `/app/grids/${props.baseId}/table/${props.tableId}/view/${props.viewId}/query`
      : `/app/grids/${props.baseId}/table/${props.tableId}/query`;
  const [adminMode, setAdminMode] = createSignal(props.initialAdminMode && canUseEditMode());
  const [viewColumns, setViewColumns] = createSignal<ColumnSpec[] | undefined>(props.viewColumns ?? props.initialState.query.columns);
  const [query, setQuery] = createSignal<RecordQuery>({
    ...props.initialState.query,
    ...(props.activeRecordQuery?.limit !== undefined ? { limit: props.activeRecordQuery.limit } : {}),
  });
  const [cursor, setCursor] = createSignal<string | null>(props.initialState.cursor);
  const [selectedRecordId, setSelectedRecordId] = createSignal<string | null>(props.initialState.selectedRecordId);
  const [selectedGroup, setSelectedGroup] = createSignal<GroupBucket | null>(null);
  const resolvedSearchState = (state: RecordsState["search"]): RecordsState["search"] => {
    if (state.override) return state;
    const saved = props.activeRecordQuery?.search;
    if (!saved) return state;
    return {
      q: saved.q,
      fieldIds: saved.fieldIds ?? [],
      override: false,
    };
  };
  const [search, setSearch] = createSignal<RecordsState["search"]>(resolvedSearchState(props.initialState.search));
  // The search follows the fields the page shows, so adding, editing, or deleting a field applies without a reload.
  const searchableFields = createMemo(() => filterSearchableFields(fields()));
  /**
   * A scope field that was deleted or stopped being searchable makes every records read fail; keep only the others.
   * A saved view can search table fields outside its columns, so this checks the table's fields.
   */
  const searchableFieldIds = (fieldIds: string[]) => {
    const available = new Set(filterSearchableFields(tableFields()).map((field) => field.id));
    return fieldIds.filter((id) => available.has(id));
  };
  const [calendarState, setCalendarState] = createSignal<RecordsState["calendar"]>(props.initialState.calendar);
  const [cardSize, setCardSize] = createSignal<CardSize>(props.initialState.cardSize);
  const groupBy = () => (query().groupBy ?? []) as GroupBySpec[];
  const aggregations = () => (query().aggregations ?? []) as AggregationSpec[];
  const toolbarFilterRows = createMemo(() => filterRowsFromQuery(query().filter));
  const toolbarSortRows = createMemo(() => query().sort ?? []);
  const toolbarGroupByRows = createMemo(() => groupBy());
  const toolbarAggregationRows = createMemo(() => aggregationRowsFromQuery(aggregations()));
  const activeRecordMetaCount = createMemo(() => recordMetaActiveCount(query().recordMeta));
  const isGrouped = () => groupBy().length > 0;
  const customForms = () => forms().filter((form) => !form.isDefault);
  const formsButtonLabel = () => {
    const count = customForms().length;
    return count > 0 ? t().forms({ count }) : t().addForm;
  };
  const renderMode = () => (isGrouped() || props.trashMode ? "table" : displayConfig().mode);
  const detailMode = (): "live" | "trash" => (query().deletedOnly ? "trash" : "live");

  // ── Query source ──────────────────────────────────────────────────
  // Search is a peer of filter/sort/group/agg in the wire query. We fold
  // the SearchBar's `{q, fieldIds}` signal into `query.search` here so a
  // keystroke updates the source signal and the API request body in one
  // step — the records service compiles it into SQL separately from the
  // structured FilterTree.
  const queryWithSearch = (): RecordQuery => {
    const { search: _savedSearch, ...baseQuery } = query();
    const q = search().q.trim();
    const withSearch = q ? { ...baseQuery, search: { q, fieldIds: search().fieldIds } } : baseQuery;
    const withCalendar = {
      ...withSearch,
      filter: calendarQueryFilter({
        baseFilter: withSearch.filter,
        fields: fields(),
        displayConfig: displayConfig(),
        calendar: calendarState(),
        dateConfig: props.dateConfig,
      }),
    };
    return withCalendar;
  };

  const queryCurrentSource = (): QueryWorkspaceCurrentSource =>
    props.activeView
      ? {
          kind: "view",
          viewId: props.activeView.id,
          label: props.activeView.name,
          ref: props.activeView.id,
        }
      : {
          kind: "table",
          tableId: props.tableId,
          label: tableName(),
          ref: props.tableId,
        };

  const queryPanelInitialSource = () => {
    const source = simpleQueryToGqlSource({ tableId: props.tableId, query: queryWithSearch() });
    return source.ok ? source.source : "";
  };

  const openQueryPanel = () => {
    void dialogCore.open<void>(
      (close) => (
        <PanelDialog>
          <PanelDialog.Header title={t().query} subtitle={tableName()} icon="ti ti-code" close={() => close()} />
          <PanelDialog.Body>
            <div class="flex h-[min(72vh,46rem)] min-h-[30rem] min-w-0 overflow-hidden">
              <QueryWorkspace
                baseId={props.baseId}
                baseName={props.baseName}
                initialQuery={queryPanelInitialSource()}
                queryPath={queryWorkspaceHref()}
                currentSource={queryCurrentSource()}
                tables={props.tables}
                fieldsByTable={{ ...props.fieldsByTable, [props.tableId]: fields() }}
                viewsByTable={props.viewsByTable}
                syncQueryToUrl={false}
              />
            </div>
          </PanelDialog.Body>
          <PanelDialog.Footer>
            <ButtonLink variant="secondary" size="sm" href={queryWorkspaceHref()}>
              <i class="ti ti-arrows-maximize" /> {t().fullWorkspace}
            </ButtonLink>
            <Button variant="primary" size="sm" type="button" onClick={() => close()}>
              {t().done}
            </Button>
          </PanelDialog.Footer>
        </PanelDialog>
      ),
      QUERY_PANEL_DIALOG_OPTIONS,
    );
  };

  let selectionController: ReturnType<typeof createRecordsSelectionController> | undefined;
  const recordsData = createRecordsDataController({
    tableId: props.tableId,
    trashMode: props.trashMode,
    source: () => ({
      tableId: props.tableId,
      viewId: props.activeView?.id,
      query: queryWithSearch(),
      cursor: cursor(),
      filePreviewFieldIds: renderMode() === "cards" ? cardImageFieldIds(displayConfig()) : [],
      calendar: calendarState(),
    }),
    initialData: props.initialData,
    initialError: props.initialError,
    initialEventCursor: props.initialEventCursor,
    cursor,
    setCursor,
    isGrouped,
    // Record dialogs own draft values and optimistic versions, not this result set.
    hasBlockingDialog: () => false,
    onOptimisticDelete: (recordId) => {
      if (recordId === selectedRecordId()) selectionController?.close();
    },
    onRefreshed: (result) => selectionController?.verifyAfterRefresh(result),
    onRevoked: (error) => {
      selectionController?.close();
      dialogCore.close();
      prompts.error(error.message || t().accessChanged);
    },
    onFatal: (error) => prompts.error(error.message || t().liveUnavailable),
  });
  const {
    data,
    failure: queryFailure,
    refetch,
    items,
    buckets,
    aggregates,
    relationLabels: liveRelationLabels,
    filePreviews,
    nextCursor,
    liveRefreshing,
    busy: recordsBusy,
    needsManualRefresh,
    highlightedRecordIds,
    invalidate: invalidateLiveRefreshes,
    loadNextPage: loadNextFlatPage,
    refreshVisibleRecords,
    replaceRecord,
    removeRecord,
  } = recordsData;
  const retryQuery = () => void refetch();

  const queryForUrl = (): RecordQuery => {
    const current = query();
    if (renderMode() !== "calendar") return current;
    return {
      ...current,
      filter: removeCalendarQueryFilter({
        queryFilter: current.filter,
        fields: fields(),
        displayConfig: displayConfig(),
        calendar: calendarState(),
        dateConfig: props.dateConfig,
      }),
    };
  };

  const { sync: syncUrl } = createRecordsUrlController({
    path: {
      baseId: props.baseId,
      tableId: props.tableId,
      viewId: props.viewId,
    },
    activeRecordQuery: props.activeRecordQuery,
    state: () => ({
      query: queryForUrl(),
      cursor: null,
      selectedRecordId: selectedRecordId(),
      search: search(),
      calendar: calendarState(),
      cardSize: cardSize(),
    }),
    adminMode,
    canUseEditMode,
    beforePopState: invalidateLiveRefreshes,
    applyPopState: ({ state: restored, adminMode: restoredAdminMode }) => {
      setQuery(restored.query);
      setViewColumns(restored.query.columns ?? props.viewColumns);
      setCursor(restored.cursor);
      setSelectedRecordId(restored.selectedRecordId);
      setSelectedGroup(null);
      // An older history entry can still name a field deleted since.
      setSearch(resolvedSearchState({ ...restored.search, fieldIds: searchableFieldIds(restored.search.fieldIds) }));
      setCalendarState(restored.calendar);
      setCardSize(restored.cardSize);
      setAdminMode(restoredAdminMode);
    },
  });

  selectionController = createRecordsSelectionController({
    tableId: props.tableId,
    activeViewId: props.activeView?.id,
    mode: detailMode,
    items: () => items() as GridRecord[],
    selectedRecordId,
    setSelectedRecordId,
    initialRecord: props.initialSelectedRecord,
    initialDetail: props.initialSelectedRecordDetail,
    syncUrl,
    locale,
  });
  const {
    record: selectedRecord,
    detail: selectedRecordDetail,
    failure: selectedRecordFailure,
    close: closeSelectedRecord,
    clearState: clearSelectedRecordState,
    selectRecord: selectResolvedRecord,
    openRecord: openUnresolvedRecord,
    setFetchedRecord,
    retry: retrySelectedRecord,
    refreshDetail: refreshSelectedRecordDetail,
  } = selectionController;

  createEffect(() => {
    onCleanup(publishPageContext({ scope: gridsPageScope(props.baseId, selectedRecord()) }));
  });

  const bulkSelectionEnabled = () =>
    props.bulkSelectionLaunchers.length > 0 && !props.trashMode && !isGrouped() && renderMode() === "table";
  const bulkSelection = createRecordsBulkController({
    baseId: props.baseId,
    tableId: props.tableId,
    enabled: bulkSelectionEnabled,
    items: () => items() as GridRecord[],
    query: queryWithSearch,
    locale,
    scopeKey: () =>
      JSON.stringify({
        tableId: props.tableId,
        viewId: props.activeView?.id ?? null,
        trashMode: props.trashMode,
        renderMode: renderMode(),
        query: queryWithSearch(),
      }),
  });
  const {
    selectedIds: bulkSelectedRecordIds,
    selectedCount: selectedBulkCount,
    queueing: bulkQueueing,
    clear: clearBulkSelection,
    toggleRecord: toggleBulkRecordSelection,
    toggleVisible: toggleVisibleBulkRecords,
    queueWorkflow: queueBulkWorkflow,
  } = bulkSelection;

  // Relation labels: SSR seeded a static prop, and every query response
  // carries labels for its relation cells, bucket keys, and relation
  // filter values. Merge both so the table, cards, groups, detail, and
  // filter chips see one consistent id→label map. Newer responses take
  // precedence.
  const mergedRelationLabels = () => ({
    ...props.relationLabels,
    ...liveRelationLabels(),
    ...(selectedRecordDetail()?.relationLabels ?? {}),
  });

  // ── Commit handlers (called from children) ─────────────────────────
  /**
   * Toolbar emits the current shape of filter/sort/group/agg. We merge
   * it into the canonical query, drop cursor (its domain depends on
   * sort + grouped-vs-flat), and replaceState the URL.
   */
  const onToolbarCommit = (patch: ToolbarQueryPatch) => {
    invalidateLiveRefreshes();
    setQuery((prev) => applyToolbarQueryPatch(prev, patch));
    setSelectedGroup(null);
    setCursor(null);
    syncUrl({ replace: true });
  };

  const commitSearch = (next: RecordsState["search"]) => {
    invalidateLiveRefreshes();
    setSearch(next);
    setSelectedGroup(null);
    setCursor(null);
    syncUrl({ replace: true });
  };

  /** SearchBar's onSearchChange. Mirror semantics to onToolbarCommit. */
  const onSearchChange = (next: { q: string; fieldIds: string[] }) => commitSearch({ ...next, override: true });

  // When a field leaves the searchable list, drop it from the scope and keep the rest of the search. Saved views never
  // change their fields here, so they keep the scope they were saved with.
  createEffect(
    on(
      searchableFields,
      () => {
        const current = search();
        const fieldIds = searchableFieldIds(current.fieldIds);
        if (fieldIds.length < current.fieldIds.length) commitSearch({ ...current, fieldIds });
      },
      { defer: true },
    ),
  );

  const resultNarrowed = () => Boolean(search().q.trim()) || (!props.viewMode && Boolean(query().filter || query().recordMeta));

  const clearResultNarrowing = () => {
    invalidateLiveRefreshes();
    setSearch({ q: "", fieldIds: [], override: true });
    if (!props.viewMode) {
      setQuery((current) => ({ ...current, filter: undefined, recordMeta: undefined }));
    }
    setSelectedGroup(null);
    setCursor(null);
    syncUrl({ replace: true });
  };

  const onCalendarChange = (next: RecordsState["calendar"]) => {
    invalidateLiveRefreshes();
    setCalendarState(next);
    setSelectedGroup(null);
    setCursor(null);
    syncUrl({ replace: true });
  };

  const onCardSizeChange = (next: CardSize) => {
    setCardSize(next);
    syncUrl({ replace: true });
  };

  const openRecordMetaDialog = async () => {
    const next = await openRecordMetadataDialog({ tableId: props.tableId, initial: query().recordMeta });
    if (next === null) return;
    invalidateLiveRefreshes();
    setQuery((prev) => ({ ...prev, recordMeta: cleanRecordMetaQuery(next) }));
    setSelectedGroup(null);
    setCursor(null);
    syncUrl({ replace: true });
  };

  const applyLiveRefresh = () => refreshVisibleRecords();

  /** Row click in the grid → open the detail panel. pushState so the
   *  browser back button closes the panel — that's the natural mental
   *  model ("back undoes my last forward action"). */
  const onSelectRecord = (rec: GridRecord) => {
    setSelectedGroup(null);
    selectResolvedRecord(rec);
  };

  const openRecordById = (recordId: string, deleted: boolean) => {
    if (deleted && !props.trashMode) {
      window.location.assign(
        `/app/grids/${encodeURIComponent(props.baseId)}/table/${encodeURIComponent(props.tableId)}?trash=1&record=${encodeURIComponent(recordId)}`,
      );
      return;
    }
    const record = items().find((item) => item.id === recordId);
    if (record) {
      onSelectRecord(record);
      return;
    }
    setSelectedGroup(null);
    openUnresolvedRecord(recordId);
  };

  const openCombinedAudit = () =>
    openCombinedAuditDialog({
      tableId: props.tableId,
      tableName: tableName(),
      fields: fields(),
      dateConfig: props.dateConfig,
      onOpenRecord: openRecordById,
    });

  const onSelectGroup = (bucket: GroupBucket) => {
    setSelectedRecordId(null);
    clearSelectedRecordState();
    setSelectedGroup(bucket);
    syncUrl({ replace: true });
  };

  /** Detail-panel close button. replaceState because closing isn't a
   *  "forward" action — undoing it via back wouldn't be useful. */
  const onCloseDetail = () => {
    closeSelectedRecord();
  };

  const onCloseGroupDetail = () => {
    setSelectedGroup(null);
  };

  const onOpenGroupedRecord = (record: GridRecord) => {
    setSelectedGroup(null);
    selectResolvedRecord(record);
  };

  /** Toolbar's row-create flow finished — open the new record's detail
   *  panel so the user can finish setting up relation fields (which
   *  the create-prompt can't render an input for). pushState so the
   *  back button collapses the picker first. */
  const onRecordCreated = (record: GridRecord) => {
    selectResolvedRecord(record);
    void refreshVisibleRecords({ recordIds: [record.id], force: true });
  };

  /** Keep the selected panel and visible page in sync after an in-place edit. */
  const onRecordUpdated = (record: GridRecord) => {
    setFetchedRecord(() => record);
    replaceRecord(record);
    void refreshVisibleRecords({ recordIds: [record.id], force: true });
    void refreshSelectedRecordDetail(record.id);
  };

  /** After a delete or restore: close the panel + refetch. */
  const onRecordRemoved = () => {
    const recordId = selectedRecordId();
    if (recordId) removeRecord(recordId);
    closeSelectedRecord();
    void refreshVisibleRecords({ force: true });
  };

  // ── Row-1 helpers (record count + export dialog) ───────────────────
  // Lifted out of GridToolbar because row 1 is always rendered (even on
  // saved views and in trash mode) — these need to live next to the
  // search bar, not inside the optional editing toolbar.
  const recordCountText = (): string => {
    if (isGrouped()) {
      return formatRecordCount(buckets().length, "group", Boolean(nextCursor()), locale());
    }
    return formatRecordCount(items().length, "record", Boolean(nextCursor()), locale());
  };

  const tableAggregationSpecs = (): AggregationSpec[] => {
    if (props.trashMode || isGrouped()) return [];
    const explicit = aggregations();
    if (explicit.length > 0) return explicit;
    return defaultTableAggregations(fields(), t().records);
  };

  const openExportDialog = () => {
    void openExportRecordsDialog({
      tableId: props.tableId,
      fields: fields(),
      query: queryWithSearch(),
      viewColumns: effectiveViewColumns()?.filter(isFieldColumn),
    });
  };

  const setAdminModeAndUrl = (next: boolean) => {
    if (!canUseEditMode()) return;
    setAdminMode(next);
    syncUrl({ replace: true });
  };

  const {
    reloadTableColumns,
    effectiveViewColumns,
    visibleGroupedColumnOrder,
    hiddenViewColumnCount,
    hiddenFlatFields,
    showFlatViewColumns,
    moveViewColumnInline,
    openViewColumnSettings,
    moveGroupedViewColumnInline,
    openGroupedViewColumnSettings,
    openAddViewColumnDialog,
    openAddComputedColumn,
    clearComputedColumns,
  } = createRecordsViewColumnController({
    props: {
      activeView: props.activeView,
      tableId: props.tableId,
      baseId: props.baseId,
    },
    fields,
    setFields,
    setTableFields,
    tableColumns,
    setTableColumns,
    tableUpdatedAt,
    setTableUpdatedAt,
    query,
    setQuery,
    viewColumns,
    setViewColumns,
    groupBy,
    aggregations,
    isGrouped,
    isSavedView,
    renderMode,
    syncUrl,
    locale,
  });

  const { openFieldSettings, openTableSettings, openAddField, openForms, openTemplates, openViewSettings } = createRecordsAdminController({
    baseId: props.baseId,
    tableId: props.tableId,
    tableKind: props.tableKind,
    tableName,
    setTableName,
    tableDescription,
    setTableDescription,
    tableIcon,
    setTableIcon,
    tableColumns,
    setTableColumns,
    tableUpdatedAt,
    setTableUpdatedAt,
    reloadTableColumns,
    tableDisplayConfig,
    setTableDisplayConfig,
    tableAuditPolicy,
    setTableAuditPolicy,
    tableMutationPolicy,
    setTableMutationPolicy,
    disableDirectInsert,
    setDisableDirectInsert,
    fields,
    setFields,
    tableFields,
    setTableFields,
    hiddenFields: hiddenFlatFields,
    showColumns: showFlatViewColumns,
    forms,
    setForms,
    otherTables: props.otherTables,
    fieldsByTable: props.fieldsByTable,
    activeView: props.activeView,
    canEditActiveView: props.canEditActiveView,
    canManageTable: props.canManageTable,
    canManageBase: props.canManageBase,
    dateConfig: props.dateConfig,
    refetch: () => void refetch(),
    setViewDisplayConfig,
  });

  const hasOpenDetail = () => Boolean(selectedRecordId() || selectedGroup());

  // Barcode drawing code loads on demand. A view that shows barcodes warms it when the page is idle, or earlier when
  // the pointer or focus reaches the records, so a later page, a live row or an opened record draws without waiting.
  const showsBarcodes = createMemo(() =>
    props.fields.some((field) => fieldDisplayFormatForView(field, effectiveViewColumns())?.kind === "barcode"),
  );
  const warmBarcodes = () => {
    if (showsBarcodes()) preloadBarcodes();
  };
  createEffect(() => {
    if (!showsBarcodes()) return;
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(preloadBarcodes, { timeout: 2000 });
      onCleanup(() => cancelIdleCallback(id));
    } else {
      const id = setTimeout(preloadBarcodes, 200);
      onCleanup(() => clearTimeout(id));
    }
  });

  // ── Head and status row ────────────────────────────────────────────
  // "Save as view" acts on the toolbar's query; the toolbar hands it over and the head's "⋯" offers it (K6).
  const [saveViewAction, setSaveViewAction] = createSignal<GridToolbarSaveView | null>(null);
  // The head's search and "⋯" live in their own island (RecordsHeadActions); they reach this view through
  // records-head-bus, and this view tells them what it shows.
  createEffect(() =>
    publishRecordsHeadStatus(props.tableId, {
      busy: recordsBusy(),
      search: { q: search().q, fieldIds: search().fieldIds },
      searchableFields: searchableFields(),
      selectedCount: selectedBulkCount(),
      queueing: bulkQueueing(),
      refresh: { needed: needsManualRefresh(), running: liveRefreshing() },
      cardSize: renderMode() === "cards" ? cardSize() : null,
      saveView: saveViewAction()?.available() ? { saving: saveViewAction()!.saving() } : null,
    }),
  );
  onCleanup(() => forgetRecordsHeadStatus(props.tableId));
  onMount(() =>
    onCleanup(
      onRecordsHeadCommand(props.tableId, (command) => {
        if (command.kind === "search") onSearchChange({ q: command.q, fieldIds: command.fieldIds });
        else if (command.kind === "metadata") void openRecordMetaDialog();
        else if (command.kind === "export") openExportDialog();
        else if (command.kind === "audit") openCombinedAudit();
        else if (command.kind === "refresh") void applyLiveRefresh();
        else if (command.kind === "cardSize") onCardSizeChange(command.size);
        else if (command.kind === "saveView") saveViewAction()?.open();
        else {
          const launcher = props.bulkSelectionLaunchers.find((entry) => entry.id === command.launcherId);
          if (launcher) void queueBulkWorkflow(launcher);
        }
      }),
    ),
  );

  /** K6: the lead statement is what the page shows; in the trash it says the records are deleted ones. */
  // A failed first read says nothing about how many records there are (K6, K10): the lead keeps its place and names the
  // records without a number; the alert cell below says what went wrong.
  const statusLead = () =>
    queryFailure() && items().length === 0 ? t().records : props.trashMode ? `${t().deleted} ${recordCountText()}` : recordCountText();
  // K6: the status row holds filters and the selection's actions only. "Record info · n" is the active record-info
  // filter; refreshing, the card size, the way back from the trash, and the locked "Add record" stand in the head.
  const statusExtras = () => (
    <Show when={!props.trashMode && activeRecordMetaCount() > 0}>
      <Button variant="secondary" size="sm" aria-pressed="true" type="button" onClick={openRecordMetaDialog}>
        <i class="ti ti-user-search" />
        {t().recordInfo} · {activeRecordMetaCount()}
      </Button>
    </Show>
  );
  const statusSelection = () =>
    bulkSelectionEnabled() && selectedBulkCount() > 0
      ? {
          count: selectedBulkCount(),
          actions: (
            <Button variant="secondary" size="sm" type="button" onClick={clearBulkSelection}>
              <i class="ti ti-x" aria-hidden="true" />
              {t().clearSelection}
            </Button>
          ),
        }
      : undefined;

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <>
      <AppWorkspace.Main class={workspaceMainClass("records")} scroll={false}>
        <div
          class="flex flex-1 min-w-0 min-h-0 overflow-hidden"
          data-route-key={props.workspaceRouteKey}
          onPointerOver={warmBarcodes}
          onFocusIn={warmBarcodes}
        >
          {/* Records workbench splits into two zones:
          - header (search + toolbar) — fixed, never scrolls
          - body (records grid + pagination) — scrolls independently
            of the workspace detail panel.
          The column itself is `overflow-hidden` so neither zone leaks
          into the other; the inner body div is the single y-scroll
          container, paired with the table-head `position: sticky` in
          DataTable so the column headers stay pinned while rows scroll. */}
          <div
            class={
              "flex-1 min-w-0 min-h-0 overflow-hidden flex flex-col transition-opacity duration-150 " + (data.loading ? "opacity-60" : "")
            }
          >
            {/* K6: the status row names how many records the page shows; filters, sorting, and the query stand at its
            end, and a bulk selection takes their place. The head above holds the views, the search, and "Add record". */}
            <Show
              when={!props.viewMode && !props.trashMode}
              fallback={
                <StatusRow class="grids-records-status" lead={statusLead()} filters={statusExtras()} selection={statusSelection()} />
              }
            >
              <GridToolbar
                tableId={props.tableId}
                fields={fields()}
                initialFilter={toolbarFilterRows()}
                initialSort={toolbarSortRows()}
                initialGroupBy={toolbarGroupByRows()}
                initialAggregations={toolbarAggregationRows()}
                recordMeta={query().recordMeta}
                columns={effectiveViewColumns()}
                queryHref={queryWorkspaceHref()}
                onOpenQuery={openQueryPanel}
                onAddComputedColumn={openAddComputedColumn}
                onClearColumns={clearComputedColumns}
                currentSearch={search()}
                relationLabels={mergedRelationLabels()}
                canWrite={props.canWrite}
                onCommit={onToolbarCommit}
                saveView={(action) => setSaveViewAction(() => action)}
                dateConfig={props.dateConfig}
                frame={(chips, panels) => (
                  <>
                    <StatusRow
                      class="grids-records-status"
                      lead={statusLead()}
                      filters={
                        <>
                          {statusExtras()}
                          {chips}
                        </>
                      }
                      selection={statusSelection()}
                    />
                    {panels}
                  </>
                )}
              />
            </Show>
            <Show when={!props.trashMode}>
              <GridCreatePrimary
                param={NEW_RECORD_PARAM}
                baseId={props.baseId}
                tableId={props.tableId}
                tableName={tableName()}
                disableDirectInsert={disableDirectInsert()}
                fields={tableFields()}
                forms={forms()}
                canWrite={props.canWrite}
                canDirectWrite={canDirectWrite()}
                canSubmitForms={props.canWrite && mutationSourceAllowed("form")}
                onRecordCreated={onRecordCreated}
                onRecordsChanged={() => void refreshVisibleRecords({ force: true })}
                dateConfig={props.dateConfig}
              />
            </Show>

            <Show when={canUseEditMode() && adminMode()}>
              <div class="px-[var(--k2b-gutter)] py-2">
                <RecordsAdminToolbar
                  savedView={isSavedView()}
                  activeViewAvailable={!!props.activeView}
                  canEditActiveView={!!props.canEditActiveView}
                  hiddenViewColumnCount={hiddenViewColumnCount()}
                  allowForms={props.tableKind === "stored"}
                  formsButtonLabel={formsButtonLabel()}
                  tableFields={tableFields()}
                  onFieldSettings={props.canManageTable && (!props.activeView || setTableFields) ? openFieldSettings : undefined}
                  onOpenTableSettings={openTableSettings}
                  onAddField={() => void openAddField()}
                  onOpenForms={openForms}
                  onOpenTemplates={openTemplates}
                  onOpenViewSettings={openViewSettings}
                  onAddViewColumn={openAddViewColumnDialog}
                  onDone={() => setAdminModeAndUrl(false)}
                />
              </div>
            </Show>

            {/* K10: a failed read needs a person, so it is a tinted alert cell edge to edge whose button names the deed. */}
            <Show when={queryFailure()}>
              {(failure) => (
                <NoticeCard
                  tone="danger"
                  icon={true}
                  title={t().refreshFailed}
                  detail={failure().error.message}
                  actions={
                    <Button variant="secondary" size="sm" type="button" onClick={retryQuery}>
                      <i class="ti ti-refresh" aria-hidden="true" /> {t().loadRecordsAgain}
                    </Button>
                  }
                />
              )}
            </Show>

            <RecordsResultSurface
              grouped={isGrouped()}
              mode={renderMode()}
              trashMode={props.trashMode}
              loading={data.loading}
              cursor={cursor()}
              nextCursor={nextCursor()}
              tableId={props.tableId}
              viewId={props.viewId}
              baseId={props.baseId}
              fieldsByTable={props.fieldsByTable}
              fields={fields()}
              items={items() as GridRecord[]}
              buckets={buckets()}
              groupBy={groupBy()}
              aggregations={aggregations()}
              groupedExplode={props.groupedExplode}
              relationLabels={mergedRelationLabels()}
              selectedGroup={selectedGroup()}
              selectedRecordId={selectedRecordId()}
              highlightedRecordIds={highlightedRecordIds()}
              filePreviews={filePreviews()}
              displayConfig={displayConfig()}
              calendarState={calendarState()}
              cardSize={cardSize()}
              viewColumns={effectiveViewColumns()}
              aggregates={aggregates()}
              aggregationSpecs={tableAggregationSpecs()}
              groupedColumnOrder={visibleGroupedColumnOrder()}
              hiddenGroupedColumnIds={query().hiddenGroupedColumns}
              adminMode={adminMode()}
              canManageTable={props.canManageTable}
              savedView={isSavedView()}
              canEditView={!!props.canEditActiveView}
              resultNarrowed={resultNarrowed()}
              onClearResultNarrowing={clearResultNarrowing}
              readFailed={Boolean(queryFailure())}
              emptyAction={
                offersGridCreateActions({
                  canWrite: props.canWrite,
                  canDirectWrite: canDirectWrite(),
                  canSubmitForms: props.canWrite && mutationSourceAllowed("form"),
                  disableDirectInsert: disableDirectInsert(),
                  forms: forms(),
                }) ? (
                  <div class="flex flex-wrap items-center justify-center gap-2">
                    <GridCreateActions
                      variant="secondary"
                      baseId={props.baseId}
                      tableId={props.tableId}
                      tableName={tableName()}
                      disableDirectInsert={disableDirectInsert()}
                      fields={tableFields()}
                      forms={forms()}
                      canWrite={props.canWrite}
                      canDirectWrite={canDirectWrite()}
                      canSubmitForms={props.canWrite && mutationSourceAllowed("form")}
                      onRecordCreated={onRecordCreated}
                      onRecordsChanged={() => void refreshVisibleRecords({ force: true })}
                      dateConfig={props.dateConfig}
                    />
                  </div>
                ) : undefined
              }
              bulkSelection={
                bulkSelectionEnabled()
                  ? {
                      selectedIds: bulkSelectedRecordIds(),
                      onToggleRecord: toggleBulkRecordSelection,
                      onToggleVisible: toggleVisibleBulkRecords,
                    }
                  : undefined
              }
              dateConfig={props.dateConfig}
              onRecordClick={onSelectRecord}
              onCalendarChange={onCalendarChange}
              onGroupClick={onSelectGroup}
              onLoadMore={loadNextFlatPage}
              onFieldSettings={openFieldSettings}
              onViewColumnSettings={openViewColumnSettings}
              onViewColumnMove={moveViewColumnInline}
              onGroupedColumnSettings={openGroupedViewColumnSettings}
              onGroupedColumnMove={moveGroupedViewColumnInline}
            />
          </div>
        </div>
      </AppWorkspace.Main>

      <AppWorkspace.Detail
        id="record"
        open={hasOpenDetail()}
        onClose={() => (selectedGroup() ? onCloseGroupDetail() : onCloseDetail())}
        viewTransitionName="grids-record-detail"
      >
        <Show when={selectedRecordId() || selectedGroup()}>
          <RecordsDetailSurface
            baseId={props.baseId}
            tableId={props.tableId}
            tableName={tableName()}
            fields={fields()}
            tableFields={tableFields()}
            auditPolicy={tableAuditPolicy()}
            record={selectedRecord}
            detail={selectedRecordDetail}
            now={props.now}
            recordFailure={selectedRecordFailure()}
            selectedGroup={selectedGroup()}
            query={queryWithSearch()}
            groupBy={groupBy()}
            aggregations={aggregations()}
            documentTemplates={props.documentTemplates}
            mode={detailMode}
            canWrite={canDirectWrite()}
            canRunWorkflows={canRunWorkflows()}
            relationLabels={mergedRelationLabels()}
            fieldsByTable={props.fieldsByTable}
            viewColumns={effectiveViewColumns()}
            dateConfig={props.dateConfig}
            onCloseRecord={onCloseDetail}
            onRetryRecord={retrySelectedRecord}
            onRecordUpdated={onRecordUpdated}
            onRecordRemoved={onRecordRemoved}
            recordActionLaunchers={props.recordActionLaunchers}
            onOpenRecord={(recordId) => openRecordById(recordId, false)}
            onCloseGroup={onCloseGroupDetail}
            onOpenGroupedRecord={onOpenGroupedRecord}
            access={recordAccess}
            currentUserId={props.currentUserId}
          />
        </Show>
      </AppWorkspace.Detail>
    </>
  );
}
