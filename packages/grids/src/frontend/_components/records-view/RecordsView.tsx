import type { DateContext } from "@k2b/stdlib";
import {
  AppWorkspace,
  Button,
  ButtonLink,
  dialogCore,
  PanelDialog,
  Placeholder,
  panelDialogWideOptions,
  prompts,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, Show } from "solid-js";
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
import { defaultTableAggregations } from "../../../table-defaults";
import type { PublicDocumentTemplateSummary } from "../documents/public-document-types";
import QueryWorkspace from "../query/QueryWorkspace";
import type { QueryWorkspaceCurrentSource } from "../query/query-workspace-model";
import { openCombinedAuditDialog } from "../records/CombinedAuditDialog";
import { openExportRecordsDialog } from "../records/ExportRecordsDialog";
import type { GroupBucket } from "../table/GroupedTable";
import GridToolbar from "../toolbar/GridToolbar";
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
import RecordsPrimaryToolbar from "./RecordsPrimaryToolbar";
import RecordsResultSurface from "./RecordsResultSurface";
import { recordCountText as formatRecordCount } from "./record-count";
import { createRecordsAdminController } from "./records-admin-controller";
import { createRecordsBulkController } from "./records-bulk-controller";
import { createRecordsDataController } from "./records-data-controller";
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
  cloudUrl: string;
  /** UUID of the base — for API calls. */
  baseId: string;
  /** UUID of the active table — for API calls (POST /api/grids/.../by-table/<uuid>). */
  tableId: string;
  tableKind: "stored" | "federated";
  /** Human table name for record-write dialog context. */
  tableName: string;
  tableDescription: string | null;
  tableIcon?: string | null;
  tableColumns: FieldColumnSpec[];
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
  initialEventCursor: string | null;
  /** Selected-record payload from SSR — non-null when the URL had
   *  ?record=<id> at initial render. Lets the panel show immediately
   *  on deep-link without a client-side fetch. */
  initialSelectedRecord: GridRecord | null;
  initialSelectedRecordDetail: WorkspaceRecordDetail | null;
  documentTemplates: PublicDocumentTemplateSummary[];
  relationLabels: Record<string, string>;
  viewColumns: ColumnSpec[] | undefined;
  searchableFields: Field[];
  groupedExplode: boolean;
  /** Stored query of the active path-based view, used as the base for URL overrides. */
  activeRecordQuery: RecordQuery | null;
  displayConfig: RecordDisplayConfig;
  bulkSelectionLaunchers: WorkspaceBulkLauncher[];
  recordActionLaunchers: WorkspaceRecordLauncher[];
  dateConfig?: DateContext;
  workspaceRouteKey: string;
};

export default function RecordsView(props: Props) {
  const locale = useLocale();
  const t = () => recordsViewMessages.resolve([locale()]).t;
  // ── Canonical state ────────────────────────────────────────────────
  const [tableName, setTableName] = createSignal(props.tableName);
  const [tableDescription, setTableDescription] = createSignal(props.tableDescription);
  const [tableIcon, setTableIcon] = createSignal(props.tableIcon ?? null);
  const [tableColumns, setTableColumns] = createSignal<FieldColumnSpec[]>(props.tableColumns);
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
    initialEventCursor: props.initialEventCursor,
    locale: locale(),
    cursor,
    setCursor,
    isGrouped,
    hasBlockingDialog: () => dialogCore.isOpen(),
    onOptimisticDelete: (recordId) => {
      if (recordId === selectedRecordId()) selectionController?.close();
    },
    onRefreshed: (result) => selectionController?.verifyAfterRefresh(result),
    onRevoked: (error) => prompts.error(error.message || t().accessChanged),
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
    livePending,
    liveRefreshing,
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
      setSearch(resolvedSearchState(restored.search));
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

  // Relation labels: SSR seeded a static prop, the API endpoint now
  // also emits `relationLabels` for group-mode bucket keys. Merge both
  // so GroupedTable / DatabaseTable see one consistent UUID→label
  // map regardless of which data path filled it. Server-side labels
  // take precedence (newer ground truth).
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

  /** SearchBar's onSearchChange. Mirror semantics to onToolbarCommit. */
  const onSearchChange = (next: { q: string; fieldIds: string[] }) => {
    invalidateLiveRefreshes();
    setSearch({ ...next, override: true });
    setSelectedGroup(null);
    setCursor(null);
    syncUrl({ replace: true });
  };

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
    forms,
    setForms,
    otherTables: props.otherTables,
    fieldsByTable: props.fieldsByTable,
    activeView: props.activeView,
    canEditActiveView: props.canEditActiveView,
    canManageTable: props.canManageTable,
    canManageBase: props.canManageBase,
    dateConfig: props.dateConfig,
    fieldCreatedDisplayFailed: t().fieldCreatedDisplayFailed,
    refetch: () => void refetch(),
    setViewDisplayConfig,
  });

  const {
    effectiveViewColumns,
    visibleGroupedColumnOrder,
    hiddenViewColumnCount,
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
    tableColumns,
    setTableColumns,
    query,
    setQuery,
    viewColumns,
    setViewColumns,
    groupBy,
    aggregations,
    isGrouped,
    isSavedView,
    syncUrl,
    locale,
  });

  const hasOpenDetail = () => Boolean(selectedRecordId() || selectedGroup());

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <>
      <AppWorkspace.Main class={workspaceMainClass("records")} scroll={false}>
        <div class="flex flex-1 min-w-0 min-h-0 overflow-hidden" data-route-key={props.workspaceRouteKey}>
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
              "flex-1 min-w-0 min-h-0 overflow-hidden flex flex-col gap-2 transition-opacity duration-150 " +
              (data.loading ? "opacity-60" : "")
            }
          >
            <RecordsPrimaryToolbar
              searchableFields={props.searchableFields}
              search={search()}
              trashMode={props.trashMode}
              canReadTable={props.canReadTable}
              tableKind={props.tableKind}
              baseId={props.baseId}
              tableId={props.tableId}
              recordCountText={recordCountText()}
              livePending={livePending()}
              liveRefreshing={liveRefreshing()}
              cardsMode={renderMode() === "cards"}
              viewMode={props.viewMode}
              cardSize={cardSize()}
              recordMetaCount={activeRecordMetaCount()}
              bulkSelectionEnabled={bulkSelectionEnabled()}
              selectedBulkCount={selectedBulkCount()}
              bulkQueueing={bulkQueueing()}
              bulkLaunchers={props.bulkSelectionLaunchers}
              queryHref={queryWorkspaceHref()}
              onSearchChange={onSearchChange}
              onRefresh={() => void applyLiveRefresh()}
              onCardSizeChange={onCardSizeChange}
              onOpenRecordMetadata={openRecordMetaDialog}
              onClearBulkSelection={clearBulkSelection}
              onQueueBulkWorkflow={queueBulkWorkflow}
              onExport={openExportDialog}
              onOpenCombinedAudit={openCombinedAudit}
            />

            {/* Saved views use their settings dialog; trash mode only exposes recovery actions. */}
            <Show when={!props.viewMode && !props.trashMode}>
              <div class="shrink-0">
                <GridToolbar
                  baseId={props.baseId}
                  tableId={props.tableId}
                  tableName={tableName()}
                  disableDirectInsert={disableDirectInsert()}
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
                  forms={forms()}
                  canWrite={props.canWrite}
                  canDirectWrite={canDirectWrite()}
                  canSubmitForms={props.canWrite && mutationSourceAllowed("form")}
                  onCommit={onToolbarCommit}
                  onRecordCreated={onRecordCreated}
                  onRecordsChanged={() => void refreshVisibleRecords({ force: true })}
                  dateConfig={props.dateConfig}
                  showCardSize={renderMode() === "cards"}
                  cardSize={cardSize()}
                  onCardSizeChange={onCardSizeChange}
                />
              </div>
            </Show>

            <Show when={canUseEditMode() && adminMode()}>
              <RecordsAdminToolbar
                savedView={isSavedView()}
                activeViewAvailable={!!props.activeView}
                canEditActiveView={!!props.canEditActiveView}
                hiddenViewColumnCount={hiddenViewColumnCount()}
                allowForms={props.tableKind === "stored"}
                formsButtonLabel={formsButtonLabel()}
                onOpenTableSettings={openTableSettings}
                onAddField={() => void openAddField()}
                onOpenForms={openForms}
                onOpenTemplates={openTemplates}
                onOpenViewSettings={openViewSettings}
                onAddViewColumn={openAddViewColumnDialog}
                onDone={() => setAdminModeAndUrl(false)}
              />
            </Show>

            <Show when={queryFailure()}>
              {(failure) => (
                <Placeholder
                  state="error"
                  surface="paper"
                  align="left"
                  title={t().refreshFailed}
                  description={failure().error.message}
                  class="shrink-0 py-2"
                  action={
                    <Button variant="secondary" size="sm" type="button" onClick={retryQuery}>
                      <i class="ti ti-refresh" aria-hidden="true" /> {t().retry}
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

      <AppWorkspace.Detail id="record" open={hasOpenDetail()} width="lg" viewTransitionName="grids-record-detail">
        <Show when={selectedRecordId() || selectedGroup()}>
          <RecordsDetailSurface
            cloudUrl={props.cloudUrl}
            baseId={props.baseId}
            tableId={props.tableId}
            tableName={tableName()}
            fields={fields()}
            auditPolicy={tableAuditPolicy()}
            record={selectedRecord}
            detail={selectedRecordDetail}
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
          />
        </Show>
      </AppWorkspace.Detail>
    </>
  );
}
