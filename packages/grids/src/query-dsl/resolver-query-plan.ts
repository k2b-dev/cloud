import { type FilterTree, type RecordMetaQuery, type RecordQuery, RecordQuerySchema } from "../contracts";
import type { Field } from "../service/types";
import { resolveHavingPredicate, resolveSqlAggregations } from "./resolver-aggregates";
import type { DslResolverContext } from "./resolver-context";
import { resolveDerivedViewSourcePlan } from "./resolver-derived-source";
import {
  type DslResolverDiagnostic,
  diagnostic,
  diagnosticSpansForAst,
  isResolverDiagnostic as isDiagnostic,
} from "./resolver-diagnostics";
import { resolveGroupBy, resolveGroupedQueryPlanSort, resolveQueryPlanSort, resolveSqlGroupedQueryPlanSort } from "./resolver-group-sort";
import { resolveJoins } from "./resolver-joins";
import { resolveQueryPlanSelect } from "./resolver-output";
import type { DslQueryPlanResolveResult, DslResolvedSqlQueryPlan } from "./resolver-plan-types";
import { aliveFields, createScope, isDefaultSelectableField, type Scope } from "./resolver-scope";
import { resolveSearch } from "./resolver-search";
import { isDerivedViewSource, type ResolvedSource, resolveSource, validateViewSource, viewSourceNeedsRecordScope } from "./resolver-source";
import { type DslWherePredicate, mergeRecordMeta, resolveWhere } from "./resolver-where";
import type { DslQueryAst } from "./types";

type ResolvedSelect = Exclude<ReturnType<typeof resolveQueryPlanSelect>, DslResolverDiagnostic>;
type ResolvedGroupBy = Exclude<ReturnType<typeof resolveGroupBy>, DslResolverDiagnostic>;
type ResolvedGroupedSort = Exclude<ReturnType<typeof resolveGroupedQueryPlanSort>, DslResolverDiagnostic>;
type ResolvedSqlGroupedSort = Exclude<ReturnType<typeof resolveSqlGroupedQueryPlanSort>, DslResolverDiagnostic>;
type ResolvedSort = Exclude<ReturnType<typeof resolveQueryPlanSort>, DslResolverDiagnostic>;
type ResolvedAggregations = ReturnType<typeof resolveSqlAggregations>;
type ResolvedJoins = ReturnType<typeof resolveJoins>;
type ResolvedSearch = ReturnType<typeof resolveSearch>;

type WhereClauses = {
  filter?: FilterTree;
  recordMeta?: RecordMetaQuery;
  predicate?: DslWherePredicate;
};

type RowClausesResult =
  | {
      ok: true;
      diagnostics: [];
      joins: ResolvedJoins;
      search: ResolvedSearch;
      select: ResolvedSelect;
      where: WhereClauses;
    }
  | {
      ok: false;
      diagnostics: DslResolverDiagnostic[];
      joins: ResolvedJoins;
      search: ResolvedSearch;
      where: WhereClauses;
    };

type GroupingResult =
  | {
      ok: true;
      diagnostics: [];
      formulaHaving?: Exclude<ReturnType<typeof resolveHavingPredicate>, DslResolverDiagnostic>;
      groupBy: ResolvedGroupBy;
      sqlAggregations: ResolvedAggregations;
    }
  | {
      ok: false;
      diagnostics: DslResolverDiagnostic[];
      groupBy?: ResolvedGroupBy;
      sqlAggregations: ResolvedAggregations;
    };

type SortsResult =
  | {
      ok: true;
      diagnostics: [];
      groupedSort?: ResolvedGroupedSort;
      sort?: ResolvedSort;
      sqlGroupedSort?: ResolvedSqlGroupedSort;
      usesSqlGroupedPlan: boolean;
    }
  | {
      ok: false;
      diagnostics: DslResolverDiagnostic[];
      usesSqlGroupedPlan: boolean;
    };

const hasGroupedDslShape = (ast: DslQueryAst): boolean => ast.groupBy.length > 0 || ast.aggregations.length > 0 || Boolean(ast.having);

const mergeScopedFilter = (baseFilter: RecordQuery["filter"], dslFilter: RecordQuery["filter"]): RecordQuery["filter"] => {
  if (!baseFilter) return dslFilter;
  if (!dslFilter) return baseFilter;
  return { op: "AND", filters: [baseFilter, dslFilter] };
};

const resolveWhereClauses = (ast: DslQueryAst, scope: Scope): { diagnostics: DslResolverDiagnostic[]; where: WhereClauses } => {
  if (!ast.where) return { diagnostics: [], where: {} };

  const resolved = resolveWhere(ast.where, scope);
  if (resolved.kind === "error") return { diagnostics: [resolved.diagnostic], where: {} };
  if (resolved.kind === "predicate") return { diagnostics: [], where: { predicate: resolved.node } };
  return {
    diagnostics: [],
    where: {
      ...(resolved.tree ? { filter: resolved.tree } : {}),
      ...(resolved.recordMeta ? { recordMeta: resolved.recordMeta } : {}),
    },
  };
};

const resolveRowClauses = (ast: DslQueryAst, source: ResolvedSource, scope: Scope, ctx: DslResolverContext): RowClausesResult => {
  const diagnostics: DslResolverDiagnostic[] = [];
  const joins = resolveJoins(ast.joins, source, scope, ctx);
  diagnostics.push(...joins.diagnostics);
  if (joins.summaryJoins.length > 0 && hasGroupedDslShape(ast))
    diagnostics.push(diagnostic("grouped-view joins produce parent rows; use select formulas rather than grouping the joined result"));

  const select = resolveQueryPlanSelect(ast.select, scope);
  if (isDiagnostic(select)) diagnostics.push(select);

  const where = resolveWhereClauses(ast, scope);
  diagnostics.push(...where.diagnostics);

  const search = resolveSearch(ast.search, scope);
  diagnostics.push(...search.diagnostics);

  if (diagnostics.length > 0 || isDiagnostic(select)) {
    return { ok: false, diagnostics, joins, search, where: where.where };
  }
  return { ok: true, diagnostics: [], joins, search, select, where: where.where };
};

const resolveGrouping = (ast: DslQueryAst, source: ResolvedSource, scope: Scope, joinedGrouped: boolean): GroupingResult => {
  const diagnostics: DslResolverDiagnostic[] = [];
  const groupBy = resolveGroupBy(ast.groupBy, scope, { joinedQuery: joinedGrouped });
  if (isDiagnostic(groupBy)) diagnostics.push(groupBy);

  const effectiveGroupCount = isDiagnostic(groupBy) ? 0 : groupBy.sqlGroupBy.length;
  if (ast.having && !isDiagnostic(groupBy) && effectiveGroupCount === 0 && (source.baseQuery.groupBy?.length ?? 0) === 0) {
    diagnostics.push(diagnostic("having requires a grouped query", ast.having.span));
  }

  const aggregateOnly = !isDiagnostic(groupBy) && ast.aggregations.length > 0 && effectiveGroupCount === 0;
  const sqlAggregations = resolveSqlAggregations(ast.aggregations, scope, {
    grouped: !aggregateOnly,
    joinedQuery: joinedGrouped,
    groupLabels: isDiagnostic(groupBy) ? [] : groupBy.sqlGroupBy.map((group) => group.label ?? group.fieldId),
  });
  diagnostics.push(...sqlAggregations.diagnostics);
  if (aggregateOnly) {
    if (ast.select.length > 0) diagnostics.push(diagnostic("aggregate-only DSL queries cannot select row fields", ast.select[0]?.span));
    if (ast.sort.length > 0) diagnostics.push(diagnostic("aggregate-only DSL queries cannot sort", ast.sort[0]?.span));
  }

  const formulaHaving = ast.having ? resolveHavingPredicate(ast.having, ast.aggregations, scope) : undefined;
  if (isDiagnostic(formulaHaving)) diagnostics.push(formulaHaving);

  if (diagnostics.length > 0 || isDiagnostic(groupBy) || isDiagnostic(formulaHaving)) {
    return {
      ok: false,
      diagnostics,
      ...(!isDiagnostic(groupBy) ? { groupBy } : {}),
      sqlAggregations,
    };
  }
  return { ok: true, diagnostics: [], groupBy, sqlAggregations, ...(formulaHaving ? { formulaHaving } : {}) };
};

const resolveSorts = (
  ast: DslQueryAst,
  scope: Scope,
  joinedGrouped: boolean,
  grouping: Pick<GroupingResult, "groupBy" | "sqlAggregations">,
): SortsResult => {
  const diagnostics: DslResolverDiagnostic[] = [];
  const { groupBy, sqlAggregations } = grouping;
  const sqlOnlyGroupedPlan = Boolean(groupBy && groupBy.sqlGroupBy.length !== groupBy.viewGroupBy.length);
  const usesSqlGroupedPlan = Boolean(groupBy && (joinedGrouped || sqlOnlyGroupedPlan));

  const groupedSort =
    !usesSqlGroupedPlan && groupBy && groupBy.viewGroupBy.length > 0
      ? resolveGroupedQueryPlanSort(ast.sort, scope, groupBy.viewGroupBy, sqlAggregations.aggregations, sqlAggregations.formulaAggregations)
      : undefined;
  if (isDiagnostic(groupedSort)) diagnostics.push(groupedSort);

  const sqlGroupedSort =
    usesSqlGroupedPlan && groupBy
      ? resolveSqlGroupedQueryPlanSort(
          ast.sort,
          scope,
          groupBy.sqlGroupBy,
          sqlAggregations.sqlAggregations,
          sqlAggregations.formulaAggregations,
        )
      : undefined;
  if (isDiagnostic(sqlGroupedSort)) diagnostics.push(sqlGroupedSort);

  const sort = groupedSort === undefined && sqlGroupedSort === undefined ? resolveQueryPlanSort(ast.sort, scope) : undefined;
  if (isDiagnostic(sort)) diagnostics.push(sort);

  if (diagnostics.length > 0 || isDiagnostic(groupedSort) || isDiagnostic(sqlGroupedSort) || isDiagnostic(sort)) {
    return { ok: false, diagnostics, usesSqlGroupedPlan };
  }
  return {
    ok: true,
    diagnostics: [],
    usesSqlGroupedPlan,
    ...(groupedSort ? { groupedSort } : {}),
    ...(sqlGroupedSort ? { sqlGroupedSort } : {}),
    ...(sort ? { sort } : {}),
  };
};

const buildRecordQuery = (options: {
  ast: DslQueryAst;
  fields: Field[];
  grouping: Extract<GroupingResult, { ok: true }>;
  row: Extract<RowClausesResult, { ok: true }>;
  scope: Scope;
  sorts: Extract<SortsResult, { ok: true }>;
  source: ResolvedSource;
}): { query: RecordQuery; wherePredicate?: DslWherePredicate } | DslResolverDiagnostic => {
  const { ast, fields, grouping, row, scope, sorts, source } = options;
  const scopedViewSource = viewSourceNeedsRecordScope(source);
  const { filter: baseFilter, ...baseQueryRestWithSourceScope } = source.baseQuery;
  let baseQueryRest: Omit<RecordQuery, "filter"> = baseQueryRestWithSourceScope;
  if (scopedViewSource) {
    const { search: _search, recordMeta: _recordMeta, ...rest } = baseQueryRest;
    baseQueryRest = rest;
  }
  if (hasGroupedDslShape(ast)) {
    const { columns: _columns, sort: _sort, limit: _limit, ...rest } = baseQueryRest;
    baseQueryRest = rest;
  }

  let wherePredicate = row.where.predicate;
  if (wherePredicate && baseFilter) {
    wherePredicate = { kind: "and", parts: [{ kind: "tree", tree: baseFilter }, wherePredicate] };
  }
  const scopedFilter = wherePredicate ? undefined : mergeScopedFilter(baseFilter, row.where.filter);
  const scopedRecordMeta = mergeRecordMeta(baseQueryRest.recordMeta, row.where.recordMeta);
  const resolvedGroupBy = sorts.usesSqlGroupedPlan ? [] : sorts.groupedSort ? sorts.groupedSort.groupBy : grouping.groupBy.viewGroupBy;
  const defaultColumns =
    ast.select.length === 0 && grouping.groupBy.sqlGroupBy.length === 0 && ast.aggregations.length === 0 && !ast.having
      ? fields.filter((field) => isDefaultSelectableField(field, scope)).map((field) => ({ fieldId: field.id }))
      : undefined;
  const query: RecordQuery = {
    ...baseQueryRest,
    ...(scopedFilter !== undefined ? { filter: scopedFilter } : {}),
    ...(scopedRecordMeta ? { recordMeta: scopedRecordMeta } : {}),
    ...(row.select.columns !== undefined
      ? { columns: row.select.columns }
      : defaultColumns !== undefined
        ? { columns: defaultColumns }
        : {}),
    ...(resolvedGroupBy.length > 0 ? { groupBy: resolvedGroupBy } : {}),
    ...(grouping.sqlAggregations.aggregations.length > 0 ? { aggregations: grouping.sqlAggregations.aggregations } : {}),
    ...(sorts.groupedSort && sorts.groupedSort.groupSort.length > 0 ? { groupSort: sorts.groupedSort.groupSort } : {}),
    ...(row.search.searchSpec ? { search: row.search.searchSpec } : {}),
    ...(sorts.sort && sorts.sort.viewSort.length > 0 ? { sort: sorts.sort.viewSort } : {}),
    ...(ast.limit !== undefined ? { limit: ast.limit } : {}),
    ...(ast.deletedOnly ? { deletedOnly: true } : ast.includeDeleted ? { includeDeleted: true } : {}),
  };

  const parsed = RecordQuerySchema.safeParse(query);
  return parsed.success
    ? { query: parsed.data, ...(wherePredicate ? { wherePredicate } : {}) }
    : diagnostic("resolved query does not match the RecordQuery contract");
};

const buildSqlPlan = (options: {
  ast: DslQueryAst;
  grouping: Extract<GroupingResult, { ok: true }>;
  query: RecordQuery;
  row: Extract<RowClausesResult, { ok: true }>;
  scope: Scope;
  sorts: Extract<SortsResult, { ok: true }>;
  source: ResolvedSource;
  wherePredicate?: DslWherePredicate;
}): DslResolvedSqlQueryPlan => {
  const { ast, grouping, query, row, scope, sorts, source, wherePredicate } = options;
  const { groupedSort, sort, sqlGroupedSort } = sorts;
  return {
    source: source.source,
    tableId: source.tableId,
    ...(ast.sourceAlias ? { sourceAlias: ast.sourceAlias } : {}),
    query,
    readableTableIds: [...scope.readableTableIds],
    diagnosticSpans: diagnosticSpansForAst(
      ast,
      grouping.groupBy.sqlGroupBy.map((group) => group.label ?? group.fieldId),
    ),
    ...(viewSourceNeedsRecordScope(source) ? { viewSourceQuery: source.baseQuery } : {}),
    ...(ast.offset !== undefined ? { offset: ast.offset } : {}),
    ...(row.joins.joins.length > 0 ? { joins: row.joins.joins } : {}),
    ...(row.joins.summaryJoins.length > 0 ? { summaryJoins: row.joins.summaryJoins } : {}),
    ...(row.select.outputColumns.length > 0 ? { outputColumns: row.select.outputColumns } : {}),
    ...(row.select.joinedColumns.length > 0 ? { joinedColumns: row.select.joinedColumns } : {}),
    ...(sort && sort.sqlSort.length > 0 ? { sqlSort: sort.sqlSort } : {}),
    ...(sorts.usesSqlGroupedPlan
      ? {
          sqlGroupBy: sqlGroupedSort ? sqlGroupedSort.sqlGroupBy : grouping.groupBy.sqlGroupBy,
          ...(sqlGroupedSort && sqlGroupedSort.sqlGroupSort.length > 0 ? { sqlGroupSort: sqlGroupedSort.sqlGroupSort } : {}),
          sqlAggregations: grouping.sqlAggregations.sqlAggregations,
        }
      : {}),
    ...(row.search.sqlSearch.length > 0 ? { sqlSearch: row.search.sqlSearch } : {}),
    ...(groupedSort && groupedSort.formulaGroupSort.length > 0 ? { formulaGroupSort: groupedSort.formulaGroupSort } : {}),
    ...(grouping.sqlAggregations.formulaAggregations.length > 0
      ? { formulaAggregations: grouping.sqlAggregations.formulaAggregations }
      : {}),
    ...(wherePredicate ? { wherePredicate } : {}),
    ...(grouping.formulaHaving ? { formulaHaving: grouping.formulaHaving } : {}),
  };
};

export const resolveDslQueryToQueryPlan = (ast: DslQueryAst, ctx: DslResolverContext): DslQueryPlanResolveResult => {
  const source = resolveSource(ast.source, ctx);
  if (isDiagnostic(source)) return { ok: false, diagnostics: [source] };
  if (source.source.kind === "view" && source.source.summaryFormulaAggregations?.length)
    return {
      ok: false,
      diagnostics: [diagnostic("this grouped formula view is available through left join view, not from view", ast.source?.span)],
    };
  if (isDerivedViewSource(source)) return resolveDerivedViewSourcePlan(ast, source, ctx);

  const sourceCompatibility = validateViewSource(source);
  if (sourceCompatibility) return { ok: false, diagnostics: [sourceCompatibility] };

  const fields = aliveFields(ctx.fieldsByTableId[source.tableId] ?? []);
  const scope = createScope(fields, ctx, source.tableId, ast.sourceAlias);
  const joinedGrouped = ast.joins.length > 0 && hasGroupedDslShape(ast);
  const row = resolveRowClauses(ast, source, scope, ctx);
  const grouping = resolveGrouping(ast, source, scope, joinedGrouped);
  const sorts = resolveSorts(ast, scope, joinedGrouped, grouping);
  if (!row.ok || !grouping.ok || !sorts.ok) {
    return { ok: false, diagnostics: [...row.diagnostics, ...grouping.diagnostics, ...sorts.diagnostics] };
  }

  const built = buildRecordQuery({ ast, fields, grouping, row, scope, sorts, source });
  if (isDiagnostic(built)) return { ok: false, diagnostics: [built] };
  return {
    ok: true,
    plan: buildSqlPlan({ ast, grouping, query: built.query, row, scope, sorts, source, wherePredicate: built.wherePredicate }),
  };
};
