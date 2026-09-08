import type { DateContext } from "@k2b/stdlib";
import { sql } from "bun";
import type { FilterTree, GroupBySpec, GroupSortSpec } from "../contracts";
import type { Expr } from "../formula/types";
import { normalizeRefKey } from "../ref-syntax";
import {
  type AggregateKind,
  aggregateOutputKey,
  aggregateOutputKeyFor,
  aggregateSqlTypeForField,
  aggregateSqlTypeForFormula,
  isFieldAggregatable,
  isFormulaAggregatable,
} from "./aggregate-capabilities";
import { isMultiSelectField, storageOf } from "./field-storage";
import { compileFilter, renderClause } from "./filter-compiler";
import {
  compileFormulaAstToSql,
  compileFormulaPredicateAstToSql,
  type FormulaSqlExpression,
  type FormulaSqlFieldResolver,
  type FormulaSqlType,
} from "./formula-sql-compiler";
import { compileDslKeyset, type DslKeysetType } from "./keyset-compiler";
import { assertSqlIdentifier } from "./sql-ident";
import type { Field } from "./types";

// =============================================================================
// Group-by + aggregations compiler
// =============================================================================
// Classic SQL semantics — when groupBy is set, the result is one row
// per (groupBy-key) tuple containing the requested aggregations. No
// sub-records are returned (that's the user's intentional model:
// "summary view" replaces the rows view, it doesn't decorate it).
//
// Multi-level grouping: composite key, max 3 levels. Flat result
// (no GROUPING SETS subtotals — those are a future extension).
//
// Date granularity: server-side via `date_trunc(<gran>, value)`. The
// granularity is part of the group key, so buckets match the values
// the UI shows in the header column.
//
// Relation and multi-select grouping use explode-semantics. A record
// with [TagA, TagB] contributes to BOTH buckets. The total count across
// buckets can exceed the total record count — caller documents this as
// "explode-mode" so the UI can warn.
//
// Lookup / rollup grouping: RecordQuery grouping rejects these. GQL
// preview/execution routes SQL-projectable computed group keys through
// query-dsl/sql-compiler.ts instead, where the grouped query can own the CTE.
//
// Cursor pagination: keyset on the group-key tuple. Same shape as
// the records-list cursor (sortValues + id), except `id` is unused
// (group rows have no id; the tuple itself is the unique identifier).

type AggKindForGroup = AggregateKind;

export type GroupAggregationSpec =
  | {
      /** "*" is shorthand for COUNT(*). */
      fieldId: string | "*";
      agg: AggKindForGroup;
    }
  | {
      kind: "formula";
      /** Stable result key prefix. Query DSL uses the aggregate alias here. */
      id: string;
      expression: Expr;
      agg: AggKindForGroup;
    };

export type GroupHavingRef = GroupAggregationSpec & {
  ref: string;
};

export type GroupBucket = {
  /** Tuple of group keys, parallel to the GroupBySpec[] order. Values are
   *  the raw projected SQL values (string for text/select, number for
   *  numeric, ISO string for dates, UUID string for relation explode). */
  keys: unknown[];
  /** Aggregation results keyed `${fieldId}__${agg}` (or `*__count` for
   *  COUNT(*)). Values are JS numbers for numeric aggs, raw text for
   *  text aggs, null when no rows in the bucket. */
  values: Record<string, unknown>;
};

// ──────────────────────────────────────────────────────────────────
// Type helpers — every capability check + SQL projection goes through
// the storage descriptor (field-storage.ts) so this compiler stops
// re-spelling rules already encoded once. The descriptor knows that
// numeric/percent/duration cast through canonical_numeric,
// and that system fields are real columns not JSONB. Touching the
// descriptor adds the new shape in one place instead of n compilers.
// ──────────────────────────────────────────────────────────────────

/** Field-types that can appear in groupBy.
 *
 *  Routes through the descriptor's `groupable` flag, so adding a new
 *  field type only requires registering it in field-storage.ts. */
export const isGroupable = (field: Field): boolean => {
  if (field.deletedAt) return false;
  return storageOf(field).groupable;
};

/** Returns whether `agg` makes sense over `field`. count* always do for
 *  any non-deleted field. Routes the type→aggregate compatibility through
 *  the descriptor's projection kind; previously this had its own
 *  NUMERIC_TYPES set that could drift from the aggregate-compiler's. */
export const isAggregatable = (field: Field | null, agg: AggKindForGroup, isStarField: boolean): boolean => {
  return isFieldAggregatable(field, agg, isStarField);
};

// ──────────────────────────────────────────────────────────────────
// Compiler
// ──────────────────────────────────────────────────────────────────

type ResolvedGroup = {
  spec: GroupBySpec;
  field: Field;
  /** Alias used in SELECT / GROUP BY / ORDER BY. */
  alias: string;
  /** SQL fragment that produces the group-key value. Embedded as a
   *  bare expression (no AS-alias) so it can be reused in GROUP BY. */
  expr: any;
  /** Whether this group requires joining `record_links` (relation field).
   *  When set, the join alias is `rl_<index>`. */
  relationJoinIndex?: number;
  /** Whether this group explodes a select JSONB array via a
   *  LATERAL join. When set, the join alias is `ms_<index>`. */
  selectJoinIndex?: number;
};

const groupAlias = (i: number) => `gk_${i}`;
// Formula aggregate ids become SQL identifiers after appending "__<agg>".
// Keep the id short enough for PostgreSQL's 63-byte identifier limit even
// with the longest supported suffix: "__countUnique".
const FORMULA_AGG_ID = /^[A-Za-z_][A-Za-z0-9_]{0,49}$/;
const isFormulaAggregation = (req: GroupAggregationSpec): req is Extract<GroupAggregationSpec, { kind: "formula" }> =>
  "kind" in req && req.kind === "formula";

const aggAliasFor = (req: GroupAggregationSpec): string => aggregateOutputKeyFor(req);

const resolveGroupProjection = (
  spec: GroupBySpec,
  field: Field,
  index: number,
  timeZone: string,
  nextJoinIndex: () => number,
): ResolvedGroup | { error: string } => {
  const alias = groupAlias(index);
  const descriptor = storageOf(field);
  if (descriptor.kind === "relationLink") {
    const joinIndex = nextJoinIndex();
    return {
      spec,
      field,
      alias,
      expr: sql`rl_${sql.unsafe(String(joinIndex))}.to_record_id::text`,
      relationJoinIndex: joinIndex,
    };
  }
  if (descriptor.kind === "jsonbArray" && isMultiSelectField(field)) {
    const joinIndex = nextJoinIndex();
    return {
      spec,
      field,
      alias,
      expr: sql`ms_${sql.unsafe(String(joinIndex))}.value`,
      selectJoinIndex: joinIndex,
    };
  }
  if (descriptor.kind === "jsonbArray") {
    return { spec, field, alias, expr: sql`r.data->${field.id}->>0` };
  }
  if (field.type === "date" && spec.granularity) {
    const value = (field.config as { includeTime?: boolean }).includeTime
      ? sql`grids.canonical_timestamptz(r.data->>${field.id}) AT TIME ZONE ${timeZone}`
      : sql`grids.canonical_date(r.data->>${field.id})::timestamp`;
    return { spec, field, alias, expr: sql`date_trunc(${spec.granularity}, ${value})::date` };
  }

  const projection = descriptor.project(field, "r");
  if (!projection) return { error: `field "${field.name}" (type "${field.type}") has no group projection` };
  return { spec, field, alias, expr: projection as any };
};

const resolveGroupBy = (
  specs: GroupBySpec[],
  fields: Field[],
  timeZone = "UTC",
): { ok: true; resolved: ResolvedGroup[] } | { ok: false; error: string } => {
  const fieldsById = new Map(fields.map((f) => [f.id, f]));
  const resolved: ResolvedGroup[] = [];
  let relationJoinCounter = 0;
  const nextJoinIndex = (): number => relationJoinCounter++;

  for (const [index, spec] of specs.entries()) {
    const field = fieldsById.get(spec.fieldId);
    if (!field) return { ok: false, error: "unknown group-by field" };
    if (!isGroupable(field)) {
      return { ok: false, error: `field "${field.name}" (type "${field.type}") is not groupable` };
    }
    if (spec.granularity && field.type !== "date") {
      return { ok: false, error: `granularity "${spec.granularity}" is only valid on date fields, not "${field.type}"` };
    }
    const projection = resolveGroupProjection(spec, field, index, timeZone, nextJoinIndex);
    if ("error" in projection) return { ok: false, error: projection.error };
    resolved.push(projection);
  }

  return { ok: true, resolved };
};

const buildFormulaAggExpr = (
  req: Extract<GroupAggregationSpec, { kind: "formula" }>,
  fields: Field[],
  dateConfig?: DateContext,
  computedFieldSql?: Map<string, FormulaSqlExpression>,
  resolveField?: FormulaSqlFieldResolver,
): { ok: true; expr: any; type: FormulaSqlType } | { ok: false; error: string } => {
  const compiled = compileFormulaAstToSql(req.expression, { fields, recordAlias: "r", dateConfig, computedFieldSql, resolveField });
  if (!compiled.ok) return { ok: false, error: `formula aggregate "${req.id}": ${compiled.error}` };
  if (!isFormulaAggregatable(compiled.expression.type, req.agg)) {
    return { ok: false, error: `agg "${req.agg}" not compatible with formula type "${compiled.expression.type}"` };
  }

  const expr = compiled.expression.sql;
  switch (req.agg) {
    case "count":
      return { ok: true, expr: sql`count(${expr}) FILTER (WHERE ${expr} IS NOT NULL AND (${expr})::text <> '')::bigint`, type: "numeric" };
    case "countEmpty":
      return { ok: true, expr: sql`count(*) FILTER (WHERE ${expr} IS NULL OR (${expr})::text = '')::bigint`, type: "numeric" };
    case "countUnique":
      return {
        ok: true,
        expr: sql`count(DISTINCT ${expr}) FILTER (WHERE ${expr} IS NOT NULL AND (${expr})::text <> '')::bigint`,
        type: "numeric",
      };
    case "sum":
      return { ok: true, expr: sql`SUM((${expr})::numeric)`, type: "numeric" };
    case "avg":
      return { ok: true, expr: sql`AVG((${expr})::numeric)`, type: "numeric" };
    case "median":
      return { ok: true, expr: sql`PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY (${expr})::numeric)`, type: "numeric" };
    case "min":
    case "earliest":
      return { ok: true, expr: sql`MIN(${expr})`, type: aggregateSqlTypeForFormula(compiled.expression.type, req.agg) };
    case "max":
    case "latest":
      return { ok: true, expr: sql`MAX(${expr})`, type: aggregateSqlTypeForFormula(compiled.expression.type, req.agg) };
  }
};

type FieldAggregationSpec = Exclude<GroupAggregationSpec, { kind: "formula" }>;
type BuiltAggregation = { ok: true; expr: any; type: FormulaSqlType } | { ok: false; error: string };

const buildExistenceAggExpr = (req: FieldAggregationSpec, existsRef: any, system: boolean): BuiltAggregation | null => {
  switch (req.agg) {
    case "count":
      return {
        ok: true,
        expr: system
          ? sql`count(${existsRef}) FILTER (WHERE ${existsRef} IS NOT NULL)::bigint`
          : sql`count(${existsRef}) FILTER (WHERE ${existsRef} IS NOT NULL AND ${existsRef} <> '')::bigint`,
        type: "numeric",
      };
    case "countEmpty":
      return {
        ok: true,
        expr: system
          ? sql`count(*) FILTER (WHERE ${existsRef} IS NULL)::bigint`
          : sql`count(*) FILTER (WHERE ${existsRef} IS NULL OR ${existsRef} = '')::bigint`,
        type: "numeric",
      };
    case "countUnique":
      return {
        ok: true,
        expr: system
          ? sql`count(DISTINCT ${existsRef}) FILTER (WHERE ${existsRef} IS NOT NULL)::bigint`
          : sql`count(DISTINCT ${existsRef}) FILTER (WHERE ${existsRef} IS NOT NULL AND ${existsRef} <> '')::bigint`,
        type: "numeric",
      };
    default:
      return null;
  }
};

const buildFieldAggExpr = (req: FieldAggregationSpec, field: Field | null): BuiltAggregation => {
  if (req.fieldId === "*") {
    if (req.agg !== "count") {
      return { ok: false, error: `agg "${req.agg}" requires a fieldId (only count works on "*")` };
    }
    return { ok: true, expr: sql`count(*)::bigint`, type: "numeric" };
  }
  if (!field) return { ok: false, error: "unknown aggregate field" };
  if (!isAggregatable(field, req.agg, false)) {
    return { ok: false, error: `agg "${req.agg}" not compatible with field type "${field.type}"` };
  }

  // Typed projection from the storage descriptor: numerics cast through
  // canonical_numeric, dates through canonical_date, system columns reference the
  // column directly.
  // count* still operate on the raw "is this slot populated" text
  // because we want to count rows where the user wrote ANYTHING (even
  // an unparseable number), not rows where the typed projection
  // happens to be non-null.
  const desc = storageOf(field);
  const typedProj = desc.project(field, "r") as any;
  // Existence-shaped reference used by count*. For JSONB-backed kinds
  // we read the raw text; for system kinds we use the column itself
  // (no '' check — columns are typed, "" is meaningless).
  const existsRef = desc.kind === "system" ? typedProj : sql`r.data->>${field.id}`;
  const isSystem = desc.kind === "system";
  const existenceAggregate = buildExistenceAggExpr(req, existsRef, isSystem);
  if (existenceAggregate) return existenceAggregate;

  switch (req.agg) {
    case "sum":
      return { ok: true, expr: sql`SUM(${typedProj})`, type: "numeric" };
    case "avg":
      return { ok: true, expr: sql`AVG(${typedProj})`, type: "numeric" };
    case "median":
      // Linear-interpolated 50th percentile per bucket — matches the flat
      // aggregate-compiler's median.
      return { ok: true, expr: sql`PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${typedProj})`, type: "numeric" };
    case "min":
    case "max": {
      const fn = req.agg === "min" ? sql`MIN` : sql`MAX`;
      // min/max routes through the typed projection for every
      // kind. For text fields the descriptor projection IS `data->>id`
      // so min/max gives lexicographic order on raw text — identical
      // to what the old hard-coded fallback emitted.
      return { ok: true, expr: sql`${fn}(${typedProj})`, type: formulaTypeForAggregate(req, field) };
    }
    case "earliest":
    case "latest": {
      // Date-only: earliest = MIN, latest = MAX over the typed date projection.
      const fn = req.agg === "earliest" ? sql`MIN` : sql`MAX`;
      return { ok: true, expr: sql`${fn}(${typedProj})`, type: formulaTypeForAggregate(req, field) };
    }
    default:
      return { ok: false, error: `unsupported aggregate "${req.agg}"` };
  }
};

const buildAggExpr = (
  req: GroupAggregationSpec,
  field: Field | null,
  fields: Field[],
  dateConfig?: DateContext,
  computedFieldSql?: Map<string, FormulaSqlExpression>,
  resolveField?: FormulaSqlFieldResolver,
): { ok: true; expr: any; type: FormulaSqlType } | { ok: false; error: string } =>
  isFormulaAggregation(req) ? buildFormulaAggExpr(req, fields, dateConfig, computedFieldSql, resolveField) : buildFieldAggExpr(req, field);

type ResolvedAggregations = {
  aggKeys: string[];
  aggExprs: Array<{ key: string; expr: any; type: FormulaSqlType }>;
  seenKeys: Set<string>;
};

const formulaTypeForAggregate = (req: GroupAggregationSpec, field: Field | null): FormulaSqlType => {
  if (isFormulaAggregation(req)) return "unknown";
  return aggregateSqlTypeForField(field, req.agg, req.fieldId === "*");
};

const resolveAggregations = (
  aggregations: GroupAggregationSpec[],
  fieldsById: Map<string, Field>,
  fields: Field[],
  dateConfig?: DateContext,
  computedFieldSql?: Map<string, FormulaSqlExpression>,
  resolveField?: FormulaSqlFieldResolver,
): { ok: true; resolved: ResolvedAggregations } | { ok: false; error: string } => {
  const aggKeys: string[] = [];
  const aggExprs: Array<{ key: string; expr: any; type: FormulaSqlType }> = [];
  const seenKeys = new Set<string>();

  for (const req of aggregations) {
    if (isFormulaAggregation(req) && !FORMULA_AGG_ID.test(req.id)) {
      return { ok: false, error: `invalid formula aggregate id "${req.id}"` };
    }

    const field = isFormulaAggregation(req) || req.fieldId === "*" ? null : (fieldsById.get(req.fieldId) ?? null);
    if (!isFormulaAggregation(req) && req.fieldId !== "*" && !field) return { ok: false, error: "unknown aggregate field" };

    const built = buildAggExpr(req, field, fields, dateConfig, computedFieldSql, resolveField);
    if (!built.ok) return built;

    const key = aggAliasFor(req);
    // Reject duplicate (field, agg) requests rather than silently dropping the
    // second — mirrors the flat aggregate-compiler so both paths behave the
    // same. (The auto `*__count` below is injected once and is not a dup.)
    if (seenKeys.has(key)) return { ok: false, error: `duplicate aggregate "${req.agg}" on the same field` };
    seenKeys.add(key);
    aggKeys.push(key);
    aggExprs.push({ key, expr: built.expr, type: built.type });
  }

  const countKey = aggregateOutputKey("*", "count");
  if (!seenKeys.has(countKey)) {
    seenKeys.add(countKey);
    aggKeys.unshift(countKey);
    aggExprs.unshift({ key: countKey, expr: sql`count(*)::bigint`, type: "numeric" });
  }

  return { ok: true, resolved: { aggKeys, aggExprs, seenKeys } };
};

const validateGroupSort = (groupSort: GroupSortSpec[], seenAggKeys: Set<string>): { ok: true } | { ok: false; error: string } => {
  for (const sort of groupSort) {
    const key = aggAliasFor(sort);
    if (!seenAggKeys.has(key)) return { ok: false, error: `groupSort references missing aggregate "${key}"` };
    if (sort.fieldId === "*" && sort.agg !== "count") {
      return { ok: false, error: `groupSort agg "${sort.agg}" requires a fieldId (only count works on "*")` };
    }
  }
  return { ok: true };
};

const buildHavingRefResolver = (
  refs: GroupHavingRef[] | undefined,
  aggExprs: Array<{ key: string; expr: any; type: FormulaSqlType }>,
  fieldsById: Map<string, Field>,
): ((ref: string) => FormulaSqlExpression | null) => {
  const byKey = new Map(aggExprs.map((item) => [item.key, item]));
  const byRef = new Map<string, FormulaSqlExpression>();
  for (const item of refs ?? []) {
    const key = aggAliasFor(item);
    const resolved = byKey.get(key);
    if (!resolved) continue;
    byRef.set(normalizeRefKey(item.ref), {
      sql: resolved.expr,
      type:
        resolved.type === "unknown" && !isFormulaAggregation(item)
          ? formulaTypeForAggregate(item, item.fieldId === "*" ? null : (fieldsById.get(item.fieldId) ?? null))
          : resolved.type,
    });
  }
  return (ref) => byRef.get(normalizeRefKey(ref)) ?? null;
};

const buildUserHavingClause = (
  having: Expr | undefined,
  refs: GroupHavingRef[] | undefined,
  aggExprs: Array<{ key: string; expr: any; type: FormulaSqlType }>,
  fieldsById: Map<string, Field>,
): { ok: true; clause: any } | { ok: false; error: string } => {
  if (!having) return { ok: true, clause: sql`TRUE` };
  const compiled = compileFormulaPredicateAstToSql(having, {
    fields: [],
    resolveField: buildHavingRefResolver(refs, aggExprs, fieldsById),
  });
  if (!compiled.ok) return { ok: false, error: `having: ${compiled.error}` };
  return { ok: true, clause: compiled.expression.sql };
};

const joinSql = (parts: any[]): any => parts.reduce((acc, cur) => sql`${acc}, ${cur}`);

const buildSelectList = (groups: ResolvedGroup[], aggExprs: Array<{ key: string; expr: any; type: FormulaSqlType }>): any => {
  const selectParts = [
    ...groups.map((g) => sql`${g.expr} AS ${sql.unsafe(assertSqlIdentifier(g.alias))}`),
    ...aggExprs.map((a) => sql`${a.expr} AS ${sql.unsafe(`"${assertSqlIdentifier(a.key)}"`)}`),
  ];
  return joinSql(selectParts);
};

const buildFromClause = (groups: ResolvedGroup[]): any => {
  let from: any = sql`grids.records r
    JOIN grids.tables _t ON _t.id = r.table_id AND _t.deleted_at IS NULL
    JOIN grids.bases _b ON _b.id = _t.base_id AND _b.deleted_at IS NULL`;

  for (const g of groups) {
    if (g.relationJoinIndex === undefined) continue;
    const alias = `rl_${g.relationJoinIndex}`;
    from = sql`${from} JOIN grids.record_links ${sql.unsafe(alias)}
      ON ${sql.unsafe(alias)}.from_record_id = r.id
     AND ${sql.unsafe(alias)}.from_field_id = ${g.field.id}::uuid`;
  }

  for (const g of groups) {
    if (g.selectJoinIndex === undefined) continue;
    const alias = `ms_${g.selectJoinIndex}`;
    from = sql`${from} CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE
        WHEN jsonb_typeof(r.data->${g.field.id}) = 'array'
        THEN r.data->${g.field.id}
        ELSE '[]'::jsonb
      END
    ) AS ${sql.unsafe(alias)}(value)`;
  }

  return from;
};

const buildWhereClause = (params: CompileGroupParams): { ok: true; where: any } | { ok: false; error: string } => {
  const filterCompiled = compileFilter(params.filter ?? null, params.fields, { timeZone: params.timeZone });
  if (!filterCompiled.ok) return { ok: false, error: `filter: ${filterCompiled.error}` };

  const whereParts: any[] = [sql`r.table_id = ${params.tableId}::uuid`];
  if (params.deletedOnly) whereParts.push(sql`r.deleted_at IS NOT NULL`);
  else if (!params.includeDeleted) whereParts.push(sql`r.deleted_at IS NULL`);
  whereParts.push(renderClause(filterCompiled.clause));
  if (params.searchClause) whereParts.push(params.searchClause);
  if (params.extraWhere) whereParts.push(params.extraWhere);

  return { ok: true, where: whereParts.reduce((acc, cur) => sql`${acc} AND ${cur}`) };
};

const groupOrderPart = (g: ResolvedGroup, index: number, reverse: boolean): any => {
  const desc = g.spec.direction === "desc";
  const dir = reverse ? (desc ? sql`ASC` : sql`DESC`) : desc ? sql`DESC` : sql`ASC`;
  const nullsFirst = reverse ? !g.spec.nullsFirst : g.spec.nullsFirst;
  const nulls = nullsFirst ? sql`NULLS FIRST` : sql`NULLS LAST`;
  return sql`${sql.unsafe(String(index + 1))} ${dir} ${nulls}`;
};

const aggregateOrderPart = (sort: GroupSortSpec, reverse: boolean): any => {
  const asc = sort.direction === "asc";
  const dir = reverse ? (asc ? sql`DESC` : sql`ASC`) : asc ? sql`ASC` : sql`DESC`;
  const nullsFirst = reverse ? !sort.nullsFirst : sort.nullsFirst;
  const nulls = nullsFirst ? sql`NULLS FIRST` : sql`NULLS LAST`;
  return sql`${sql.unsafe(`"${assertSqlIdentifier(aggAliasFor(sort))}"`)} ${dir} ${nulls}`;
};

const buildOrderBy = (groups: ResolvedGroup[], groupSort: GroupSortSpec[], reverse = false): any => {
  const parts = [
    ...groupSort.map((sort) => aggregateOrderPart(sort, reverse)),
    ...groups.map((group, index) => groupOrderPart(group, index, reverse)),
  ];
  return joinSql(parts);
};

type CompileGroupParams = {
  tableId: string;
  groupBy: GroupBySpec[];
  aggregations: GroupAggregationSpec[];
  groupSort?: GroupSortSpec[];
  having?: Expr;
  havingRefs?: GroupHavingRef[];
  filter?: FilterTree | null;
  searchClause?: any;
  extraWhere?: any;
  fields: Field[];
  cursor?: { keys: unknown[] } | null;
  /** Null leaves a nested source unbounded; its outer query owns pagination. */
  limit?: number | null;
  /** Callers that already request one lookahead row disable the service-level lookahead. */
  lookahead?: boolean;
  offset?: number;
  /** Server-signed fallback offset for oversized GQL keyset cursors. */
  cursorOffset?: number;
  /** When true, returns the last N buckets by the requested group order. */
  fromEnd?: boolean;
  /** When true, soft-deleted records are included in the aggregation. */
  includeDeleted?: boolean;
  /** When true, only soft-deleted records are included. */
  deletedOnly?: boolean;
  timeZone?: string;
  dateConfig?: DateContext;
  computedFieldSql?: Map<string, FormulaSqlExpression>;
  resolveField?: FormulaSqlFieldResolver;
};

type CompileGroupResult =
  | {
      ok: true;
      query: any;
      resolvedGroups: ResolvedGroup[];
      aggKeys: string[];
      cursorable: boolean;
      cursorValuesFromRow: (row: Record<string, unknown>) => unknown[];
    }
  | { ok: false; error: string };

const validateGroupShape = (params: CompileGroupParams): { ok: true } | { ok: false; error: string } => {
  if (params.groupBy.length === 0) return { ok: false, error: "groupBy is empty — use the regular records list for ungrouped queries" };
  if (params.groupBy.length > 3) return { ok: false, error: "groupBy supports at most 3 levels" };
  return { ok: true };
};

const validateGroupPaging = (params: CompileGroupParams, groupSort: GroupSortSpec[]): { ok: true } | { ok: false; error: string } => {
  if (params.cursor && params.fromEnd) return { ok: false, error: "cursor pagination is not supported for tail-window grouped queries" };
  if ((params.offset ?? 0) > 0 && params.cursor) {
    return { ok: false, error: "offset pagination is not supported together with grouped cursors" };
  }
  if ((params.offset ?? 0) > 0 && params.fromEnd) {
    return { ok: false, error: "offset pagination is not supported for tail-window grouped queries" };
  }
  return { ok: true };
};

const buildGroupedSql = (
  params: CompileGroupParams,
  groups: ResolvedGroup[],
  aggregations: ResolvedAggregations,
  groupSort: GroupSortSpec[],
  userHaving: any,
):
  | { ok: true; query: any; cursorable: boolean; cursorValuesFromRow: (row: Record<string, unknown>) => unknown[] }
  | { ok: false; error: string } => {
  const where = buildWhereClause(params);
  if (!where.ok) return where;

  const selectList = buildSelectList(groups, aggregations.aggExprs);
  const from = buildFromClause(groups);
  const groupByPositions = joinSql(groups.map((_, index) => sql`${sql.unsafe(String(index + 1))}`));
  const orderBy = buildOrderBy(groups, groupSort);
  const reverseOrderBy = buildOrderBy(groups, groupSort, true);
  // Public callers bound their page size; GQL can request 10,000 rows plus
  // its own sentinel (lookahead=false). Preserve that internal fetch budget.
  const limit = params.limit === null ? null : Math.min(Math.max(params.limit ?? 100, 1), 10_001);
  const offset = params.cursor
    ? 0
    : params.cursorOffset !== undefined
      ? Math.max(params.cursorOffset, 0)
      : Math.min(Math.max(params.offset ?? 0, 0), 10_000);
  const fetchLimit = limit === null ? null : limit + (params.lookahead === false ? 0 : 1);
  const groupedQuery = sql`
    SELECT ${selectList}
    FROM ${from}
    WHERE ${where.where}
    GROUP BY ${groupByPositions}
    HAVING ${userHaving}
  `;
  const aggregateByKey = new Map(aggregations.aggExprs.map((aggregate) => [aggregate.key, aggregate]));
  const groupType = (group: ResolvedGroup): DslKeysetType => {
    const kind = storageOf(group.field).kind;
    if (kind === "numeric") return "numeric";
    if (kind === "date") return "date";
    if (kind === "datetime") return "datetime";
    if (kind === "boolean") return "boolean";
    // Relation groups project `to_record_id::text`; cursor casts must match
    // the projected SQL type rather than the logical field type.
    if (kind === "relationLink") return "text";
    return "text";
  };
  const keyset = compileDslKeyset(
    [
      ...groupSort.map((sort) => {
        const key = aggAliasFor(sort);
        return {
          expression: sql`${sql.unsafe(`"${assertSqlIdentifier(key)}"`)}`,
          type: aggregateByKey.get(key)?.type ?? "unknown",
          direction: sort.direction ?? "desc",
          nullsFirst: sort.nullsFirst,
        } as const;
      }),
      ...groups.map((group) => ({
        expression: sql`${sql.unsafe(`"${assertSqlIdentifier(group.alias)}"`)}`,
        type: groupType(group),
        direction: group.spec.direction ?? "asc",
        nullsFirst: group.spec.nullsFirst,
      })),
    ],
    params.cursor?.keys,
  );
  if (!keyset.ok) return keyset;

  const query = params.fromEnd
    ? sql`
        SELECT *
        FROM (
          SELECT *, ${keyset.select}
          FROM (${groupedQuery}) grouped_tail
          WHERE TRUE
          ORDER BY ${reverseOrderBy}
          LIMIT ${fetchLimit}
        ) grouped_tail_window
        ORDER BY ${orderBy}
      `
    : sql`
        SELECT *, ${keyset.select}
        FROM (${groupedQuery}) grouped
        WHERE ${keyset.where}
        ORDER BY ${keyset.orderBy}
        LIMIT ${fetchLimit}
        OFFSET ${offset}
      `;
  return { ok: true, query, cursorable: !params.fromEnd, cursorValuesFromRow: keyset.valuesFromRow };
};

export const compileGroupQuery = (params: CompileGroupParams): CompileGroupResult => {
  const shape = validateGroupShape(params);
  if (!shape.ok) return shape;

  const groups = resolveGroupBy(params.groupBy, params.fields, params.timeZone ?? "UTC");
  if (!groups.ok) return groups;

  const fieldsById = new Map(params.fields.map((f) => [f.id, f]));
  const groupSort = params.groupSort ?? [];
  const paging = validateGroupPaging(params, groupSort);
  if (!paging.ok) return paging;

  const aggregations = resolveAggregations(
    params.aggregations,
    fieldsById,
    params.fields,
    params.dateConfig,
    params.computedFieldSql,
    params.resolveField,
  );
  if (!aggregations.ok) return aggregations;

  const sortCheck = validateGroupSort(groupSort, aggregations.resolved.seenKeys);
  if (!sortCheck.ok) return sortCheck;
  const userHaving = buildUserHavingClause(params.having, params.havingRefs, aggregations.resolved.aggExprs, fieldsById);
  if (!userHaving.ok) return userHaving;
  const sqlQuery = buildGroupedSql(params, groups.resolved, aggregations.resolved, groupSort, userHaving.clause);
  if (!sqlQuery.ok) return sqlQuery;

  return {
    ok: true,
    query: sqlQuery.query,
    resolvedGroups: groups.resolved,
    aggKeys: aggregations.resolved.aggKeys,
    cursorable: sqlQuery.cursorable,
    cursorValuesFromRow: sqlQuery.cursorValuesFromRow,
  };
};
