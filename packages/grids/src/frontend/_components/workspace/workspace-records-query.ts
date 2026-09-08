import type { DateContext } from "@k2b/stdlib";
import type { ComputedColumnSpec, GroupSortSpec, RecordDisplayConfig, RecordQuery } from "../../../contracts";
import { parseGridsQueryDsl } from "../../../query-dsl/parser";
import {
  type DslResolvedSqlQueryPlan,
  type DslResolverContext,
  type DslResolverDiagnostic,
  type DslTableSource,
  type DslViewSource,
  isDslAggregateOnlyPlan,
  projectDslPlanToRecordQuery,
  resolveDslQueryToQueryPlan,
} from "../../../query-dsl/resolver";
import { collectDslFieldTableIds } from "../../../query-dsl/source-plan";
import type { DslQueryAst } from "../../../query-dsl/types";
import type { Field, GridRecord, Table, View } from "../../../service";
import { gridsService } from "../../../service";
import { buildPrincipalLabelCache, principalReferencesFromRecords } from "../../../service/principal-values";
import { calendarQueryFilter, cardImageFieldIds } from "../records-view/display-mode";
import { resolveEffectiveQuery } from "../records-view/effective-query";
import type { RecordsState } from "../records-view/query-url";
import { nextCursorWithinLimit } from "../records-view/records-pagination";
import { buildViewer } from "./workspace-state-helpers";
import type { AuthUser, RuntimeView, WorkspaceCatalog, WorkspaceGroupBucket } from "./workspace-state-model";

type GroupByRaw = {
  fieldId: string;
  direction?: "asc" | "desc";
  granularity?: "day" | "week" | "month" | "quarter" | "year";
};

const queryResultFieldIds = (plan: DslResolvedSqlQueryPlan): string[] => {
  const fieldIds = new Set<string>();
  for (const column of plan.outputColumns ?? []) {
    if (column.kind === "field") fieldIds.add(column.fieldId);
  }
  for (const group of plan.query.groupBy ?? []) fieldIds.add(group.fieldId);
  for (const group of plan.sqlGroupBy ?? []) {
    if (group.tableId === plan.tableId) fieldIds.add(group.fieldId);
  }
  for (const aggregation of plan.query.aggregations ?? []) {
    if (aggregation.fieldId !== "*") fieldIds.add(aggregation.fieldId);
  }
  for (const aggregation of plan.sqlAggregations ?? []) {
    if (aggregation.fieldId !== "*" && (!aggregation.tableId || aggregation.tableId === plan.tableId)) {
      fieldIds.add(aggregation.fieldId);
    }
  }
  return [...fieldIds];
};

type AggregationRaw = {
  fieldId: string | "*";
  agg: "count" | "countEmpty" | "countUnique" | "sum" | "avg" | "min" | "max";
  label?: string;
};

export const isComputedColumn = (column: NonNullable<RecordQuery["columns"]>[number]): column is ComputedColumnSpec =>
  "kind" in column && column.kind === "computed";

const withViewPresentation = (query: RecordQuery, presentation: View["ui"] | undefined): RecordQuery => {
  if (!presentation) return query;
  return {
    ...query,
    ...(presentation.columns ? { columns: presentation.columns } : {}),
    ...(presentation.groupedColumnOrder ? { groupedColumnOrder: presentation.groupedColumnOrder } : {}),
    ...(presentation.hiddenGroupedColumns ? { hiddenGroupedColumns: presentation.hiddenGroupedColumns } : {}),
  };
};

const buildResolverContext = (catalog: WorkspaceCatalog, currentTableId: string, ast: DslQueryAst): DslResolverContext => {
  const tables: DslTableSource[] = catalog.tables.map((table) => ({
    kind: "table",
    id: table.id,
    shortId: table.shortId,
    name: table.name,
  }));
  const views: DslViewSource[] = Object.values(catalog.viewsByTable)
    .flat()
    .map((view) => ({
      kind: "view" as const,
      id: view.id,
      shortId: view.shortId,
      name: view.name,
      tableId: view.tableId,
      source: view.source,
      query: {},
    }));
  const fieldTableIds = collectDslFieldTableIds({ ast, currentTableId, tables, views });
  const fieldsByTableId = Object.fromEntries(fieldTableIds.map((tableId) => [tableId, catalog.fieldsByTable[tableId] ?? []])) as Record<
    string,
    Field[]
  >;
  const currentTable = tables.find((table) => table.id === currentTableId);
  return {
    ...(currentTable ? { currentTable } : {}),
    tables,
    views,
    fieldsByTableId,
  };
};

export const compileViewSource = (
  catalog: WorkspaceCatalog,
  activeTable: Table,
  view: View,
):
  | { ok: true; kind: "records"; query: RecordQuery }
  | { ok: true; kind: "queryResult"; fieldIds: string[] }
  | { ok: false; diagnostics: Array<Pick<DslResolverDiagnostic, "message">> } => {
  const parsed = parseGridsQueryDsl(view.source);
  if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics };
  const context = buildResolverContext(catalog, activeTable.id, parsed.ast);
  const queryPlan = resolveDslQueryToQueryPlan(parsed.ast, context);
  if (!queryPlan.ok) return { ok: false, diagnostics: queryPlan.diagnostics };
  if (isDslAggregateOnlyPlan(queryPlan.plan)) {
    return { ok: true, kind: "queryResult", fieldIds: queryResultFieldIds(queryPlan.plan) };
  }
  const resolved = projectDslPlanToRecordQuery(queryPlan.plan, parsed.ast);
  if (!resolved.ok) return { ok: true, kind: "queryResult", fieldIds: queryResultFieldIds(queryPlan.plan) };
  return { ok: true, kind: "records", query: withViewPresentation(resolved.plan.query, view.ui) };
};

export const outputFieldsForQuery = (fields: Field[], query: RecordQuery): Field[] => {
  const ids = new Set<string>();
  for (const column of query.columns ?? []) {
    if ("fieldId" in column) ids.add(column.fieldId);
  }
  for (const group of query.groupBy ?? []) ids.add(group.fieldId);
  return ids.size === 0 ? fields : fields.filter((field) => ids.has(field.id));
};

type InitialRecordsArgs = {
  activeTable: Table;
  fields: Field[];
  recordsState: RecordsState;
  activeView: RuntimeView | null;
  strictViewScope?: boolean;
  displayConfig: RecordDisplayConfig;
  trashMode: boolean;
  user: AuthUser;
  dateConfig?: DateContext;
};

const exactViewState = (state: RecordsState): RecordsState => ({
  ...state,
  query: {},
  search: { q: "", fieldIds: [], override: false },
});

const resolveInitialQuery = (recordsState: RecordsState, activeView: RuntimeView | null) => {
  const effective = resolveEffectiveQuery(recordsState, activeView);
  const effectiveFilter = effective.filter ?? null;
  const effectiveSort = effective.sort ?? [];
  const effectiveRecordMeta = effective.recordMeta ?? null;
  const effectiveIncludeDeleted = effective.includeDeleted ?? false;
  const effectiveSearch = effective.search
    ? { q: effective.search.q, fieldIds: effective.search.fieldIds ?? [], override: recordsState.search.override }
    : { q: "", fieldIds: [], override: recordsState.search.override };
  const effectiveGroupBy = (effective.groupBy ?? []) as GroupByRaw[];
  const effectiveGroupSort = (effective.groupSort ?? []) as GroupSortSpec[];
  const effectiveAggregations = (effective.aggregations ?? []).filter(
    (aggregation): aggregation is AggregationRaw =>
      aggregation.agg !== "median" && aggregation.agg !== "earliest" && aggregation.agg !== "latest",
  );
  const searchSpec = effective.search ?? null;
  const viewLimit = effective.limit;
  const effectiveLimit = viewLimit !== undefined ? Math.min(100, viewLimit) : 100;
  return {
    effective,
    effectiveFilter,
    effectiveSort,
    effectiveRecordMeta,
    effectiveIncludeDeleted,
    effectiveSearch,
    effectiveGroupBy,
    effectiveGroupSort,
    effectiveAggregations,
    searchSpec,
    viewLimit,
    effectiveLimit,
  };
};

const emptyInitialRecords = () => ({
  records: { items: [] as GridRecord[], nextCursor: null as string | null } as {
    items: GridRecord[];
    nextCursor: string | null;
    aggregates?: Record<string, unknown>;
    filePreviews?: Record<
      string,
      Record<string, { fileId: string; fieldId: string; recordId: string; filename: string; mimeType: string; sizeBytes: number }>
    >;
  },
  aggregates: {} as Record<string, unknown>,
  groupedBuckets: [] as WorkspaceGroupBucket[],
  groupedExplode: false,
  relationLabels: {} as Record<string, string>,
});

const loadGroupedInitialRecords = async (
  args: InitialRecordsArgs,
  query: ReturnType<typeof resolveInitialQuery>,
  viewer: ReturnType<typeof buildViewer>,
) => {
  const data = emptyInitialRecords();
  const groupResult = await gridsService.record.group({
    tableId: args.activeTable.id,
    groupBy: query.effectiveGroupBy,
    aggregations: query.effectiveAggregations,
    groupSort: query.effectiveGroupSort,
    filter: query.effectiveFilter,
    recordMeta: query.effectiveRecordMeta,
    search: query.effectiveSearch.q ? { q: query.effectiveSearch.q, fieldIds: query.effectiveSearch.fieldIds } : null,
    cursor: args.recordsState.cursor,
    limit: query.effectiveLimit,
    viewer,
    dateConfig: args.dateConfig,
  });
  if (!groupResult.ok) return data;

  data.groupedBuckets = groupResult.data.buckets as WorkspaceGroupBucket[];
  data.groupedExplode = groupResult.data.explode;
  data.records.nextCursor = nextCursorWithinLimit(groupResult.data.nextCursor, data.groupedBuckets.length, query.viewLimit);
  data.relationLabels = await gridsService.relations.buildLabelCacheForGroupedKeys(
    data.groupedBuckets,
    query.effectiveGroupBy.map((group) => group.fieldId),
    args.fields,
    viewer,
  );
  return data;
};

const loadListedInitialRecords = async (
  args: InitialRecordsArgs,
  query: ReturnType<typeof resolveInitialQuery>,
  viewer: ReturnType<typeof buildViewer>,
) => {
  const data = emptyInitialRecords();
  const listResult = await gridsService.record.list({
    tableId: args.activeTable.id,
    limit: query.effectiveLimit,
    includeDeleted: query.effectiveIncludeDeleted,
    deletedOnly: args.trashMode,
    filter: query.effectiveFilter,
    search: query.searchSpec,
    recordMeta: query.effectiveRecordMeta,
    sort: query.effectiveSort,
    cursor: args.recordsState.cursor,
    includeRelations: true,
    viewer,
    dateConfig: args.dateConfig,
    computedColumns: query.effective.columns?.filter(isComputedColumn),
    filePreviewFieldIds: cardImageFieldIds(args.displayConfig),
  });
  if (listResult.ok) {
    data.records = {
      ...listResult.data,
      nextCursor: nextCursorWithinLimit(listResult.data.nextCursor, listResult.data.items.length, query.viewLimit),
    };
    data.aggregates = data.records.aggregates ?? {};
  }
  data.relationLabels = {
    ...(await gridsService.relations.buildLabelCache(data.records.items, args.fields, viewer)),
    ...(await buildPrincipalLabelCache(principalReferencesFromRecords(data.records.items, args.fields), viewer.userId)),
  };
  if (args.trashMode || args.fields.length === 0 || query.effectiveAggregations.length === 0) return data;

  const aggregateResult = await gridsService.record.aggregate({
    tableId: args.activeTable.id,
    filter: query.effectiveFilter,
    search: query.searchSpec,
    recordMeta: query.effectiveRecordMeta,
    includeDeleted: query.effectiveIncludeDeleted,
    deletedOnly: args.trashMode,
    requests: query.effectiveAggregations.map((aggregation) => ({ fieldId: aggregation.fieldId, agg: aggregation.agg })),
    viewer,
    dateConfig: args.dateConfig,
  });
  if (aggregateResult.ok) data.aggregates = { ...data.aggregates, ...aggregateResult.data };
  return data;
};

export const loadInitialRecords = async (args: InitialRecordsArgs) => {
  const queryState = args.strictViewScope ? exactViewState(args.recordsState) : args.recordsState;
  const query = resolveInitialQuery(queryState, args.activeView);
  query.effectiveFilter =
    calendarQueryFilter({
      baseFilter: query.effectiveFilter ?? undefined,
      fields: args.fields,
      displayConfig: args.displayConfig,
      calendar: args.recordsState.calendar,
      dateConfig: args.dateConfig,
    }) ?? null;
  query.effective.filter = query.effectiveFilter ?? undefined;
  const viewer = buildViewer(args.user);
  const data =
    query.effectiveGroupBy.length > 0 && !args.trashMode
      ? await loadGroupedInitialRecords(args, query, viewer)
      : await loadListedInitialRecords(args, query, viewer);
  return { ...query, ...data };
};
