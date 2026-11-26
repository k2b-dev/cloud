import { cloudIdMessages, useCloudIdCopy } from "@k2b/cloud/browser/cloud-id";
import { publishPageContext } from "@k2b/cloud/browser/panel";
import type { DateContext } from "@k2b/stdlib";
import { dialogCore, prompts, useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Canvas,
  Empty,
  Input,
  Menu,
  type MenuEntry,
  type MenuItem,
  Notice,
  Pane,
  Path,
  StatusRow,
  Tabs,
  Text,
} from "@k2b/ui/v2";
import { createEffect, createMemo, createRenderEffect, createSignal, Match, on, onCleanup, Show, Switch } from "solid-js";
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
import { filterSearchableFields } from "../../../searchable-fields";
import type { WorkspaceRevision } from "../../../service/workspace-revision";
import { defaultTableAggregations } from "../../../table-defaults";
import { gridsPageScope } from "../../page-context";
import type { PublicDocumentTemplateSummary } from "../documents/public-document-types";
import { fieldTypeIcon } from "../fields/field-type-meta";
import GridsFrame, { LiveNotice } from "../frame/GridsFrame";
import { v2Icon } from "../frame/grids-nav";
import { openCombinedAuditDialog } from "../records/CombinedAuditDialog";
import { openExportRecordsDialog } from "../records/ExportRecordsDialog";
import { recordMessages } from "../records/messages";
import { createRecordAccess } from "../records/record-access";
import { fieldDisplayFormatForView } from "../records/record-display";
import { formatFieldValueText } from "../table/field-value-format";
import type { GroupBucket } from "../table/GroupedTable";
import GroupedTable from "../table/GroupedTable";
import type { NavigationState } from "../workspace/navigation-catalog";
import type {
  PublicWorkspaceBulkLauncher as WorkspaceBulkLauncher,
  PublicWorkspaceRecordDetail as WorkspaceRecordDetail,
  PublicWorkspaceRecordLauncher as WorkspaceRecordLauncher,
} from "../workspace/workspace-public-state-model";
import { bulkWorkflowActionLabel } from "./bulk-selection";
import { activeDisplayConfig, calendarQueryFilter, cardImageFieldIds, removeCalendarQueryFilter } from "./display-mode";
import { recordsViewMessages } from "./messages";
import { buildRecordsUrl, type CardSize, type RecordsState, recordsPath } from "./query-url";
import { RecordCalendarView } from "./RecordCalendarView";
import { RecordCardsView } from "./RecordCardsView";
import { cleanRecordMetaQuery, openRecordMetadataDialog, recordMetaActiveCount } from "./RecordMetadataDialog";
import RecordsDetailSurface from "./RecordsDetailSurface";
import RecordsQueryDialog from "./RecordsQueryDialog";
import RecordsTable from "./RecordsTable";
import { recordCountText as formatRecordCount } from "./record-count";
import { createRecordCreate } from "./record-create";
import { createRecordsAdminController } from "./records-admin-controller";
import { createRecordsBulkController } from "./records-bulk-controller";
import { createRecordsDataController } from "./records-data-controller";
import { createRecordsSelectionController } from "./records-selection-controller";
import { createRecordsUrlController } from "./records-url-controller";
import { createRecordsViewColumnController, isFieldColumn } from "./records-view-columns";
import SaveViewDialog from "./SaveViewDialog";
import { recordsScreenMessages } from "./screen-messages";
import { applyToolbarQueryPatch, filterRowsFromQuery, type ToolbarQueryPatch } from "./toolbar-query";

/**
 * The records page of a table or view on v2. It owns presentation state and delegates URL, query/live data, columns,
 * and admin mutations to focused controllers.
 */

type RuntimeView = View & {
  query: RecordQuery;
  displayConfig: RecordDisplayConfig;
};

type Props = {
  /** The base's places for the v2 frame: sidebar, phone menu and live state. */
  frame: NavigationState;
  revision?: WorkspaceRevision;
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

  // Barcode drawing code loads on demand. A view that shows barcodes warms it when the page is idle, so a later page, a
  // live row or an opened record draws without waiting.
  const showsBarcodes = createMemo(() =>
    props.fields.some((field) => fieldDisplayFormatForView(field, effectiveViewColumns())?.kind === "barcode"),
  );
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

  // ── v2 head, status and result ──────────────────────────────────────
  const words = () => recordsScreenMessages.resolve([locale()]).t;
  const cloudId = useCloudIdCopy();
  const cloudIdText = () => cloudIdMessages.resolve([locale()]).t;
  const create = createRecordCreate({
    baseId: () => props.baseId,
    tableId: () => props.tableId,
    tableName,
    fields,
    forms,
    canWrite: () => props.canWrite,
    canDirectWrite,
    canSubmitForms: () => props.canWrite && mutationSourceAllowed("form"),
    disableDirectInsert,
    onRecordCreated,
    onRecordsChanged: () => void refreshVisibleRecords({ force: true }),
    dateConfig: props.dateConfig,
  });
  const [queryOpen, setQueryOpen] = createSignal(false);
  const [saveViewOpen, setSaveViewOpen] = createSignal(false);
  const path = () => ({ baseId: props.baseId, tableId: props.tableId, viewId: props.viewId });
  const editSuffix = (href: string) => (adminMode() ? `${href}${href.includes("?") ? "&" : "?"}edit=true` : href);
  const recordHref = (record: GridRecord) =>
    editSuffix(
      buildRecordsUrl(
        path(),
        {
          query: queryForUrl(),
          cursor: null,
          selectedRecordId: record.id,
          search: search(),
          calendar: calendarState(),
          cardSize: cardSize(),
        },
        props.activeRecordQuery,
      ),
    );
  const listHref = () =>
    editSuffix(
      buildRecordsUrl(
        path(),
        { query: queryForUrl(), cursor: null, selectedRecordId: null, search: search(), calendar: calendarState(), cardSize: cardSize() },
        props.activeRecordQuery,
      ),
    );
  const tableHref = (viewId: string | null) => editSuffix(recordsPath({ baseId: props.baseId, tableId: props.tableId, viewId }));

  /** The table's views as tabs: the table itself, then its saved views. */
  const viewTabs = () => [
    { label: words().all, icon: v2Icon(tableIcon(), "table"), href: tableHref(null), current: !props.viewId && !props.trashMode },
    ...(props.viewsByTable[props.tableId] ?? []).map((view) => ({
      label: view.name,
      icon: v2Icon(view.icon, "table-spark"),
      href: tableHref(view.id),
      current: props.viewId === view.id,
    })),
  ];

  const filterCount = () => toolbarFilterRows().length;
  const sortCount = () => toolbarSortRows().length;
  const searchKey = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    const input = event.currentTarget as HTMLInputElement;
    if (event.key === "Enter") onSearchChange({ q: input.value, fieldIds: search().fieldIds });
    if (event.key === "Escape" && input.value) {
      input.value = "";
      onSearchChange({ q: "", fieldIds: search().fieldIds });
    }
  };
  /** Where the search looks: every searchable field, or the chosen ones. */
  const searchScope = (): MenuEntry[] => [
    {
      title: words().searchIn,
      items: [
        {
          label: words().allFields,
          checked: search().fieldIds.length === 0,
          onClick: () => onSearchChange({ q: search().q, fieldIds: [] }),
        },
        ...searchableFields().map((field) => {
          const on = search().fieldIds.includes(field.id);
          return {
            label: field.name,
            checked: on,
            onClick: () =>
              onSearchChange({
                q: search().q,
                fieldIds: on ? search().fieldIds.filter((id) => id !== field.id) : [...search().fieldIds, field.id],
              }),
          };
        }),
      ],
    },
  ];

  const moreMenu = (): MenuEntry[] => [
    {
      title: words().recordsSection,
      items: [
        { label: words().recordMetadata, icon: "user-search", onClick: () => void openRecordMetaDialog() },
        { label: words().exportRecords, icon: "download", onClick: openExportDialog },
        ...(!props.viewMode && !props.trashMode
          ? [{ label: words().saveAsView, icon: "bookmark-plus", onClick: () => setSaveViewOpen(true) }]
          : []),
      ],
    },
    ...(renderMode() === "cards"
      ? [
          {
            title: words().cardSize,
            choice: cardSize(),
            onChoose: (value: string) => onCardSizeChange(value as CardSize),
            items: [
              { value: "small", label: words().cardSmall },
              { value: "medium", label: words().cardMedium },
              { value: "large", label: words().cardLarge },
            ],
          },
        ]
      : []),
    {
      title: words().explore,
      items: [
        { label: words().openQuery, icon: "code", href: queryWorkspaceHref() },
        ...(props.tableKind === "federated" && props.canReadTable
          ? [{ label: words().auditTrail, icon: "history", onClick: openCombinedAudit }]
          : []),
        ...(props.canReadTable
          ? props.trashMode
            ? [{ label: words().backToLive, icon: "arrow-back-up", href: tableHref(null) }]
            : [{ label: words().showDeleted, icon: "archive", href: `${tableHref(null)}${adminMode() ? "&" : "?"}trash=1` }]
          : []),
        ...(cloudId.available()
          ? [{ label: cloudIdText().copy, icon: "link", onClick: () => cloudId.copy({ type: "grids.table", id: props.tableId }) }]
          : []),
      ],
    },
  ];

  /** The deeds of edit mode: the table's or the view's settings, fields and columns. */
  const editMenu = (): MenuEntry[] => {
    const fieldItems =
      props.canManageTable && (!props.activeView || setTableFields)
        ? tableFields().map((field) => ({
            label: field.name,
            icon: v2Icon(fieldTypeIcon(field.type, field.icon), "forms"),
            onClick: () => openFieldSettings(field),
          }))
        : [];
    return [
      ...(isSavedView()
        ? [
            {
              label: words().viewSettings,
              icon: "table-spark",
              onClick: openViewSettings,
              disabled: !props.activeView || !props.canEditActiveView,
            },
          ]
        : [
            { label: words().tableSettings, icon: "settings", onClick: openTableSettings },
            { label: words().addField, icon: "plus", onClick: () => void openAddField() },
            ...(props.tableKind === "stored"
              ? [{ label: words().forms, icon: "forms", meta: formsButtonLabel(), onClick: openForms }]
              : []),
            { label: words().templates, icon: "file-type-pdf", onClick: openTemplates },
          ]),
      ...(fieldItems.length ? [{ label: words().fields, icon: "columns", items: fieldItems }] : []),
      ...(hiddenViewColumnCount() > 0 ? [{ label: words().addColumn, icon: "column-insert-right", onClick: openAddViewColumnDialog }] : []),
      ...(!props.viewMode && !props.trashMode
        ? [{ label: words().computedColumn, icon: "calculator", onClick: openAddComputedColumn }]
        : []),
      ...(columnItems().length ? [{ label: words().columns, icon: "layout-columns", items: columnItems() }] : []),
      "separator" as const,
      { label: words().doneEditing, icon: "check", onClick: () => setAdminModeAndUrl(false) },
    ];
  };
  /** Each shown column's settings and place, as the column heads offered them in v1. */
  const columnItems = (): MenuItem[] => {
    const canMove = isSavedView() ? !!props.canEditActiveView : props.canManageTable;
    if (!canMove || renderMode() !== "table" || isGrouped()) return [];
    const byId = new Map(fields().map((field) => [field.id, field]));
    const columns: ColumnSpec[] =
      effectiveViewColumns() ??
      tableFields()
        .filter((field) => !field.deletedAt && !field.hideInTable)
        .map((field) => ({ fieldId: field.id }));
    return columns.map((column, index) => {
      const field = "kind" in column ? null : (byId.get(column.fieldId) ?? null);
      const label = ("label" in column && column.label?.trim()) || field?.name || ("kind" in column ? column.label : column.fieldId);
      return {
        label,
        items: [
          {
            label: words().columnSettings,
            icon: "settings",
            onClick: () => {
              if (isSavedView()) void openViewColumnSettings(column, field);
              else if (field) openFieldSettings(field);
            },
          },
          { label: words().moveLeft, icon: "arrow-left", disabled: index === 0, onClick: () => moveViewColumnInline(column, -1) },
          {
            label: words().moveRight,
            icon: "arrow-right",
            disabled: index === columns.length - 1,
            onClick: () => moveViewColumnInline(column, 1),
          },
        ],
      };
    });
  };

  const formEntries = (): MenuEntry[] =>
    create.activeForms().map((form) => ({ label: form.name, icon: "forms", onClick: () => void create.submitForm(form) }));
  const primaryAction = () =>
    props.trashMode || !create.direct() ? undefined : { label: words().newRecord, icon: "plus", onClick: () => void create.addRecord() };

  const head = (
    <Bar
      start={
        props.trashMode ? (
          <Path label={words().views} items={[{ label: tableName(), href: tableHref(null) }, { label: words().deletedRecords }]} />
        ) : (
          <Tabs label={words().views} items={viewTabs()} />
        )
      }
      end={
        <>
          <Show when={searchableFields().length > 0}>
            <Input
              type="search"
              icon="search"
              label={words().search}
              placeholder={words().search}
              value={search().q}
              onKeyDown={searchKey}
              end={<Menu icon="adjustments-horizontal" label={words().searchIn} items={searchScope()} />}
            />
          </Show>
          <Menu label={words().more} items={moreMenu()} />
          <Show when={canUseEditMode() && adminMode()}>
            <Menu icon="tool" items={editMenu()}>
              {words().edit}
            </Menu>
          </Show>
          <Show when={!props.trashMode && formEntries().length > 0}>
            <Menu icon="forms" variant={create.direct() ? undefined : "primary"} items={formEntries()}>
              {words().submitForm}
            </Menu>
          </Show>
          <Show when={!props.trashMode && create.direct()}>
            <Button variant="primary" icon="plus" busy={create.creating()} onClick={() => void create.addRecord()}>
              {words().newRecord}
            </Button>
          </Show>
          <Show when={!props.trashMode && create.blocked()}>
            {(reason) => (
              <Button icon="lock" disabled title={reason()}>
                {words().newRecord}
              </Button>
            )}
          </Show>
        </>
      }
    />
  );

  /** Key figures of the result: the table's aggregates under the count. */
  const aggregateFacts = () =>
    tableAggregationSpecs()
      .filter((spec) => spec.fieldId !== "*")
      .flatMap((spec) => {
        const value = aggregates()[`${spec.fieldId}__${spec.agg}`];
        const field = fields().find((each) => each.id === spec.fieldId);
        if (value === undefined || value === null || !field) return [];
        return [
          {
            before: spec.label?.trim() || field.name,
            value: formatFieldValueText({
              field,
              value,
              fieldsByTable: props.fieldsByTable,
              dateConfig: props.dateConfig,
              locale: locale(),
            }),
          },
        ];
      })
      .slice(0, 3);
  const status = () => (
    <StatusRow
      lead={recordCountText()}
      loading={recordsBusy() || liveRefreshing()}
      facts={[
        ...(activeRecordMetaCount() > 0 ? [{ value: words().metadataActive({ count: activeRecordMetaCount() }) }] : []),
        ...aggregateFacts(),
      ]}
      filters={
        <Show when={!props.viewMode && !props.trashMode}>
          <Button variant="ghost" icon="filter" onClick={() => setQueryOpen(true)}>
            {filterCount() + sortCount() > 0 ? words().filterCount({ count: filterCount() + sortCount() }) : words().filter}
          </Button>
        </Show>
      }
      selection={
        selectedBulkCount() > 0
          ? {
              count: words().selected({ count: new Intl.NumberFormat(locale()).format(selectedBulkCount()) }),
              actions: props.bulkSelectionLaunchers.map((launcher) => ({
                label: bulkWorkflowActionLabel(
                  launcher.name,
                  selectedBulkCount(),
                  launcher.config.kind === "bulk" && "profile" in launcher.config && launcher.config.profile === "closeSelection",
                  locale(),
                ),
                icon: "route",
                disabled: bulkQueueing(),
                onClick: () => void queueBulkWorkflow(launcher),
              })),
              clear: { label: words().clearSelection, icon: "x", onClick: clearBulkSelection },
            }
          : undefined
      }
    />
  );

  const hasMore = () => !props.trashMode && Boolean(nextCursor());
  // Empty states follow the last finished read: a reload keeps them instead of flashing an empty grid until its result
  // arrives, and a failed read says nothing about the table, so it shows neither.
  const resultEmpty = () => (isGrouped() ? buckets().length === 0 : items().length === 0);
  const [settled, setSettled] = createSignal(
    { empty: !props.initialError && resultEmpty(), narrowed: resultNarrowed() },
    { equals: (a, b) => a.empty === b.empty && a.narrowed === b.narrowed },
  );
  createRenderEffect(() => {
    if (queryFailure()) setSettled({ empty: false, narrowed: false });
    else if (!data.loading) setSettled({ empty: resultEmpty(), narrowed: resultNarrowed() });
  });
  const emptyResult = () => settled().empty;
  const emptyState = () =>
    settled().narrowed
      ? {
          icon: "filter-off",
          text: words().noMatches,
          action: { label: words().clearSearchFilters, icon: "filter-off", onClick: clearResultNarrowing },
        }
      : { icon: "table", text: words().noRecordsYet, ...(primaryAction() ? { action: primaryAction() } : {}) };
  const allFieldsByTable = () => ({ ...props.fieldsByTable, [props.tableId]: fields() });

  const detailLabel = () => (selectedGroup() ? words().groups : words().openRecord);

  return (
    <GridsFrame
      state={props.frame}
      activeKeys={[`table:${props.tableId}`, ...(props.viewId ? [`view:${props.viewId}`] : [])]}
      revision={props.revision}
      head={head}
      primary={primaryAction()}
    >
      <Pane.Split>
        <Pane label={tableName()} scrollKey={`grids-records-${props.tableId}-${props.viewId ?? "default"}`} status={status()}>
          <LiveNotice />
          <Show when={needsManualRefresh()}>
            <Notice
              tone="note"
              title={words().updatesAvailable}
              actions={[{ label: words().refresh, icon: "refresh", onClick: () => void applyLiveRefresh() }]}
            >
              {words().updatesAvailableDetail}
            </Notice>
          </Show>
          <Show when={queryFailure()}>
            {(failure) => (
              <Notice tone="bad" title={words().refreshFailed} actions={[{ label: words().retry, icon: "refresh", onClick: retryQuery }]}>
                {failure().error.message}
              </Notice>
            )}
          </Show>
          <Switch
            fallback={
              <RecordsTable
                items={items() as GridRecord[]}
                fields={fields()}
                baseId={props.baseId}
                fieldsByTable={allFieldsByTable()}
                relationLabels={mergedRelationLabels()}
                viewColumns={effectiveViewColumns()}
                selectedRecordId={selectedRecordId()}
                recordHref={recordHref}
                onOpenRecord={onSelectRecord}
                sort={query().sort}
                onSort={
                  props.viewMode || props.trashMode
                    ? undefined
                    : (fieldId, direction) =>
                        onToolbarCommit({
                          filter: query().filter,
                          sort: [{ fieldId, direction }],
                          groupBy: query().groupBy,
                          aggregations: query().aggregations,
                        })
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
                empty={emptyResult() ? emptyState() : undefined}
                dateConfig={props.dateConfig}
              />
            }
          >
            <Match when={emptyResult()}>
              <Empty {...emptyState()} />
            </Match>
            {/* k2b-ui gap: grouped buckets, cards with cover images and the calendar have no v2 primitive yet; they keep their
                own drawing (and behaviour) inside a Canvas until the grouped table, image tiles (lane Y2) and calendar land. */}
            <Match when={isGrouped()}>
              <Canvas label={words().groups}>
                <GroupedTable
                  baseId={props.baseId}
                  fields={fields()}
                  groupBy={groupBy()}
                  aggregations={aggregations()}
                  buckets={buckets()}
                  explode={props.groupedExplode}
                  relationLabels={mergedRelationLabels()}
                  selectedBucketKey={selectedGroup() ? JSON.stringify(selectedGroup()?.keys) : null}
                  onBucketClick={onSelectGroup}
                  adminMode={adminMode() && isSavedView() && !!props.canEditActiveView}
                  columnOrder={visibleGroupedColumnOrder()}
                  hiddenColumnIds={query().hiddenGroupedColumns}
                  scrollPreserveKey={`grids-groups-${props.tableId}-${props.viewId ?? "default"}`}
                  onColumnSettings={openGroupedViewColumnSettings}
                  onColumnMove={moveGroupedViewColumnInline}
                  dateConfig={props.dateConfig}
                  hasMore={false}
                  loadingMore={false}
                  onLoadMore={loadNextFlatPage}
                />
              </Canvas>
            </Match>
            <Match when={renderMode() === "cards"}>
              <Canvas label={words().cards}>
                <RecordCardsView
                  items={items() as GridRecord[]}
                  fields={fields()}
                  displayConfig={displayConfig()}
                  filePreviews={filePreviews()}
                  baseId={props.baseId}
                  tableId={props.tableId}
                  fieldsByTable={allFieldsByTable()}
                  relationLabels={mergedRelationLabels()}
                  selectedId={selectedRecordId()}
                  highlightedIds={highlightedRecordIds()}
                  onRecordClick={onSelectRecord}
                  cardSize={cardSize()}
                  hasMore={false}
                  loadingMore={false}
                  onLoadMore={loadNextFlatPage}
                  dateConfig={props.dateConfig}
                />
              </Canvas>
            </Match>
            <Match when={renderMode() === "calendar"}>
              <Canvas label={words().calendar}>
                <RecordCalendarView
                  items={items() as GridRecord[]}
                  fields={fields()}
                  displayConfig={displayConfig()}
                  calendarState={calendarState()}
                  onCalendarChange={onCalendarChange}
                  selectedRecordId={selectedRecordId()}
                  onRecordClick={onSelectRecord}
                  dateConfig={props.dateConfig}
                  fieldsByTable={allFieldsByTable()}
                  hasMore={false}
                  loadingMore={false}
                  onLoadMore={loadNextFlatPage}
                />
              </Canvas>
            </Match>
          </Switch>
          <Show when={hasMore()}>
            <Bar
              start={<Text type="meta">{recordCountText()}</Text>}
              end={
                <Button icon="chevrons-down" busy={data.loading && Boolean(cursor())} onClick={loadNextFlatPage}>
                  {words().loadMore}
                </Button>
              }
            />
          </Show>
        </Pane>
        <Show when={hasOpenDetail()}>
          <Pane detail label={detailLabel()} width={{ min: 400, default: 480 }} back={{ label: tableName(), href: listHref() }}>
            {/* The record's own detail is rebuilt on v2 in its own part; until then its v1 surface keeps every deed. */}
            <Canvas label={detailLabel()}>
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
            </Canvas>
          </Pane>
        </Show>
      </Pane.Split>
      <RecordsQueryDialog
        open={queryOpen()}
        onOpenChange={setQueryOpen}
        fields={fields()}
        filter={toolbarFilterRows()}
        sort={toolbarSortRows()}
        groupBy={query().groupBy}
        aggregations={query().aggregations}
        relationLabels={mergedRelationLabels()}
        dateConfig={props.dateConfig}
        onCommit={onToolbarCommit}
        onClear={() => {
          onToolbarCommit({});
          clearComputedColumns();
        }}
      />
      <SaveViewDialog
        open={saveViewOpen()}
        onOpenChange={setSaveViewOpen}
        tableId={props.tableId}
        query={queryWithSearch}
        columns={effectiveViewColumns}
        canShare={props.canWrite}
      />
    </GridsFrame>
  );
}
