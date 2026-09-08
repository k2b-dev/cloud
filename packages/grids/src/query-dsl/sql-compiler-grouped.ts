import { sql } from "bun";
import { normalizeRefKey } from "../ref-syntax";
import { aggregateOutputKey } from "../service/aggregate-capabilities";
import { compileFilter, renderClause } from "../service/filter-compiler";
import { compileFormulaPredicateAstToSql, type FormulaSqlType } from "../service/formula-sql-compiler";
import { compileGroupQuery, type GroupHavingRef } from "../service/group-compiler";
import { compileDslKeyset, type DslKeysetColumn } from "../service/keyset-compiler";
import type { DslResolvedSqlAggregation, DslResolvedSqlGroupBy, DslResolvedSqlQueryPlan } from "./resolver";
import { aliveFields, fieldById } from "./sql-compiler-fields";
import { joinFragments } from "./sql-compiler-fragments";
import {
  aggregateExprForField,
  aggregateKey,
  compileFormulaAggregateColumn,
  compileGroupExtraWhere,
  formulaAggregateSqlType,
  groupColumnsFor,
  groupFieldProjection,
  hasGroupedShape,
  sqlGroupKey,
  toGroupAggregations,
} from "./sql-compiler-grouping";
import { compileRelationJoin } from "./sql-compiler-joins";
import { compileViewSourceRecordScope, recordDeletedCondition, scopedFormulaResolverForPlan } from "./sql-compiler-scope";
import { dslRecordRelation, dslRecordTableCondition, dslRelationValuesInRecordData } from "./sql-compiler-source";
import { type DslSqlCompileOptions, type DslSqlGroupCompileResult, type DslSqlGroupOutputColumn, dslSqlOffset } from "./sql-compiler-types";
import { compileWherePredicate } from "./sql-compiler-where";

const failGroup = (error: string): DslSqlGroupCompileResult => ({ ok: false, error });

const compileJoinedGroupedQueryPlanToSql = (plan: DslResolvedSqlQueryPlan, options: DslSqlCompileOptions): DslSqlGroupCompileResult => {
  if ((plan.query.columns?.length ?? 0) > 0 || (plan.outputColumns?.length ?? 0) > 0 || (plan.joinedColumns?.length ?? 0) > 0) {
    return failGroup("grouped DSL queries use group and aggregate output, not select columns");
  }

  const groupBy: DslResolvedSqlGroupBy[] =
    plan.sqlGroupBy ??
    (plan.query.groupBy ?? []).map((group) => ({
      ...group,
      tableId: plan.tableId,
    }));
  const aggregations: DslResolvedSqlAggregation[] =
    plan.sqlAggregations ??
    (plan.query.aggregations ?? []).map((aggregation) => ({
      ...aggregation,
      tableId: plan.tableId,
    }));
  const formulaAggregations = plan.formulaAggregations ?? [];
  if (groupBy.length === 0 && aggregations.length === 0 && formulaAggregations.length === 0) {
    return failGroup("grouped DSL query needs at least one group field or aggregate");
  }
  const fields = aliveFields(options.fieldsByTableId[plan.tableId] ?? []);
  const filter = compileFilter(plan.query.filter ?? null, fields, { timeZone: options.timeZone });
  if (!filter.ok) return failGroup(`filter: ${filter.error}`);

  const joinAliases = new Map<string, string>();
  const joinSql: unknown[] = [];
  for (const [index, join] of (plan.joins ?? []).entries()) {
    const compiled = compileRelationJoin(join, index, joinAliases, {
      joinFanoutLimit: options.joinFanoutLimit,
      recordSource: options.recordSource,
      recordSourcesByTableId: options.recordSourcesByTableId,
    });
    if (!compiled.ok) return failGroup(compiled.error);
    joinAliases.set(join.alias, compiled.recordAlias);
    joinSql.push(compiled.fragment);
  }
  const resolveFormulaField = scopedFormulaResolverForPlan(plan, fields, joinAliases, options);

  const selectParts: unknown[] = [];
  const groupColumns: DslSqlGroupOutputColumn[] = [];
  const groupExprs: unknown[] = [];
  for (const [index, group] of groupBy.entries()) {
    const tableFields = aliveFields(options.fieldsByTableId[group.tableId] ?? []);
    const field = fieldById(tableFields, group.fieldId);
    if (!field) return failGroup(`group field ${group.fieldId} is not available`);
    const recordAlias = group.joinAlias ? joinAliases.get(group.joinAlias) : "r";
    if (!recordAlias) return failGroup(`group field uses unknown join alias "${group.joinAlias}"`);
    const projected = groupFieldProjection(group, field, recordAlias, options, index, plan.readableTableIds);
    if (!projected.ok) return failGroup(projected.error);
    const key = sqlGroupKey(index);
    groupExprs.push(projected.expr);
    selectParts.push(sql`${projected.expr} AS ${sql.unsafe(key)}`);
    if (projected.joins) joinSql.push(...projected.joins);
    groupColumns.push({
      kind: "group",
      key,
      label: field.name,
      fieldId: field.id,
      tableId: group.tableId,
      type: field.type,
      sqlType: projected.sqlType,
    });
  }

  const aggregateColumns: DslSqlGroupOutputColumn[] = [];
  const aggregateExprsByKey = new Map<string, { expr: unknown; type: FormulaSqlType }>();
  for (const aggregation of aggregations) {
    const tableFields = aggregation.fieldId === "*" ? [] : aliveFields(options.fieldsByTableId[aggregation.tableId ?? plan.tableId] ?? []);
    const field = aggregation.fieldId === "*" ? null : fieldById(tableFields, aggregation.fieldId);
    const recordAlias = aggregation.joinAlias ? joinAliases.get(aggregation.joinAlias) : "r";
    if (!recordAlias) return failGroup(`aggregate uses unknown join alias "${aggregation.joinAlias}"`);
    const compiled = aggregateExprForField(aggregation, field, recordAlias, options, plan.readableTableIds);
    if (!compiled.ok) return failGroup(compiled.error);
    const key = aggregateOutputKey(aggregation.fieldId, aggregation.agg);
    aggregateExprsByKey.set(key, { expr: compiled.expr, type: compiled.sqlType });
    selectParts.push(sql`${compiled.expr} AS ${sql.unsafe(`"${key}"`)}`);
    aggregateColumns.push({
      kind: "aggregate",
      key,
      label: aggregation.label ?? key,
      fieldId: aggregation.fieldId,
      agg: aggregation.agg,
      sqlType: compiled.sqlType,
    });
  }
  for (const aggregation of formulaAggregations) {
    const compiled = compileFormulaAggregateColumn(aggregation, fields, options, resolveFormulaField);
    if (!compiled.ok) return failGroup(compiled.error);
    aggregateExprsByKey.set(compiled.key, { expr: compiled.expr, type: formulaAggregateSqlType(aggregation) });
    selectParts.push(sql`${compiled.expr} AS ${sql.unsafe(`"${compiled.key}"`)}`);
    aggregateColumns.push({
      kind: "aggregate",
      key: compiled.key,
      label: aggregation.id,
      fieldId: aggregation.id,
      agg: aggregation.agg,
      sqlType: formulaAggregateSqlType(aggregation),
    });
  }
  if (groupBy.length > 0 && aggregations.length === 0 && formulaAggregations.length === 0) {
    const key = aggregateOutputKey("*", "count");
    const expr = sql`COUNT(*)::bigint`;
    aggregateExprsByKey.set(key, { expr, type: "numeric" });
    selectParts.push(sql`${expr} AS ${sql.unsafe(`"${key}"`)}`);
    aggregateColumns.push({
      kind: "aggregate",
      key,
      label: key,
      fieldId: "*",
      agg: "count",
      sqlType: "numeric",
    });
  }

  const having =
    plan.formulaHaving && aggregateExprsByKey.size > 0
      ? compileFormulaPredicateAstToSql(plan.formulaHaving.expression, {
          fields: [],
          resolveField: (ref) => {
            const aggregate = plan.formulaHaving?.aggregateRefs.find((item) => normalizeRefKey(item.ref) === normalizeRefKey(ref));
            if (!aggregate) return null;
            const resolved = aggregateExprsByKey.get(aggregateKey(aggregate));
            return resolved ? { sql: resolved.expr, type: resolved.type } : null;
          },
        })
      : null;
  if (having && !having.ok) return failGroup(`having: ${having.error}`);

  const groupSort = plan.sqlGroupSort ?? plan.query.groupSort ?? [];
  for (const sort of groupSort) {
    const key = aggregateOutputKey(sort.fieldId, sort.agg);
    if (!aggregateExprsByKey.has(key)) return failGroup(`group sort references missing aggregate "${key}"`);
  }
  const aggregateOnly = groupBy.length === 0;
  if (aggregateOnly && groupSort.length > 0) return failGroup("aggregate-only DSL queries cannot sort");
  if (aggregateOnly && options.cursorValues) return failGroup("aggregate-only DSL queries do not accept a cursor");
  const groupCursorColumns: DslKeysetColumn[] = groupBy.map((group, index) => ({
    expression: sql`${sql.unsafe(`"${sqlGroupKey(index)}"`)}`,
    type: groupColumns[index]!.sqlType === "json" ? "unknown" : groupColumns[index]!.sqlType,
    direction: group.direction ?? "asc",
    nullsFirst: group.nullsFirst,
  }));
  const keyset = aggregateOnly
    ? null
    : compileDslKeyset(
        [
          ...groupSort.map((sort) => {
            const aggregate = aggregateExprsByKey.get(aggregateOutputKey(sort.fieldId, sort.agg))!;
            return {
              expression: sql`${sql.unsafe(`"${aggregateOutputKey(sort.fieldId, sort.agg)}"`)}`,
              type: aggregate.type,
              direction: sort.direction ?? "desc",
              nullsFirst: sort.nullsFirst,
            } satisfies DslKeysetColumn;
          }),
          ...groupCursorColumns,
        ],
        options.cursorValues,
      );
  if (keyset && !keyset.ok) return failGroup(keyset.error);

  const conditions: unknown[] = [
    dslRecordTableCondition(plan.tableId, options),
    recordDeletedCondition(plan),
    renderClause(filter.clause, { relationSource: dslRelationValuesInRecordData(options) ? "recordData" : "links" }),
  ];
  const viewScope = compileViewSourceRecordScope(plan, fields, options);
  if (!viewScope.ok) return failGroup(viewScope.error);
  if (viewScope.condition) conditions.push(viewScope.condition);
  if (plan.wherePredicate) {
    const extraWhere = compileWherePredicate(plan.wherePredicate, fields, {
      timeZone: options.timeZone,
      computedFieldSql: options.computedFieldSql,
      resolveField: resolveFormulaField,
      relationSource: dslRelationValuesInRecordData(options) ? "recordData" : "links",
    });
    if (!extraWhere.ok) return failGroup(`where: ${extraWhere.error}`);
    conditions.push(extraWhere.sql);
  }
  if (options.searchClause) conditions.push(options.searchClause);
  const where = conditions.reduce((acc, condition) => sql`${acc} AND ${condition}`);
  const groupBySql = groupExprs.map((_, index) => sql.unsafe(String(index + 1)));
  const groupByClause = groupBySql.length > 0 ? sql`GROUP BY ${joinFragments(groupBySql, sql`, `)}` : sql``;
  const limit = aggregateOnly ? 1 : options.limit === null ? null : Math.min(Math.max(options.limit ?? plan.query.limit ?? 100, 1), 10_001);
  const offset = aggregateOnly ? 0 : dslSqlOffset(options, plan.offset);
  const havingClause = having && having.ok ? sql`HAVING ${having.expression.sql}` : sql``;
  const groupedSql = sql`
    SELECT ${joinFragments(selectParts, sql`, `)}
    FROM ${dslRecordRelation(options)}
    JOIN grids.tables t ON t.id = r.table_id AND t.deleted_at IS NULL
    JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
    ${joinFragments(joinSql, sql` `)}
    WHERE ${where}
    ${groupByClause}
    ${havingClause}
  `;
  const pagedSql = keyset
    ? sql`
        SELECT grouped.*, ${keyset.select}
        FROM (${groupedSql}) grouped
        WHERE ${keyset.where}
        ORDER BY ${keyset.orderBy}
        LIMIT ${limit}
        OFFSET ${offset}
      `
    : sql`${groupedSql} LIMIT ${limit}`;

  return {
    ok: true,
    query: {
      sql: pagedSql,
      columns: [...groupColumns, ...aggregateColumns],
      limit,
      offset,
      cursorable: keyset !== null,
      ...(keyset ? { cursorValuesFromRow: keyset.valuesFromRow } : {}),
    },
  };
};

export const compileDslGroupedQueryPlanToSql = (plan: DslResolvedSqlQueryPlan, options: DslSqlCompileOptions): DslSqlGroupCompileResult => {
  if (!hasGroupedShape(plan)) return failGroup("query is not grouped");
  if (plan.sqlGroupBy !== undefined || (plan.joins?.length ?? 0) > 0 || options.recordSource) {
    return compileJoinedGroupedQueryPlanToSql(plan, options);
  }
  if ((plan.joinedColumns?.length ?? 0) > 0) {
    return failGroup("grouped DSL queries use group and aggregate output, not select columns");
  }
  if ((plan.query.columns?.length ?? 0) > 0) {
    return failGroup("grouped DSL queries use group and aggregate output, not select columns");
  }
  const groupBy = plan.query.groupBy ?? [];
  if (groupBy.length === 0) return failGroup("grouped DSL query needs at least one group field");

  const fields = aliveFields(options.fieldsByTableId[plan.tableId] ?? []);
  const resolveFormulaField = scopedFormulaResolverForPlan(plan, fields, new Map(), options);
  const extraWhere = compileGroupExtraWhere(plan, fields, options, resolveFormulaField);
  if (!extraWhere.ok) return failGroup(extraWhere.error);

  const aggregations = toGroupAggregations(plan);
  if (!aggregations.ok) return failGroup(aggregations.error);
  const compiled = compileGroupQuery({
    tableId: plan.tableId,
    fields,
    groupBy,
    aggregations: aggregations.aggregations,
    groupSort: [...(plan.query.groupSort ?? []), ...(plan.formulaGroupSort ?? [])],
    having: plan.formulaHaving?.expression,
    havingRefs: plan.formulaHaving?.aggregateRefs as GroupHavingRef[] | undefined,
    filter: plan.query.filter ?? null,
    searchClause: options.searchClause,
    extraWhere: extraWhere.where,
    limit: options.limit === null ? null : (options.limit ?? plan.query.limit),
    lookahead: false,
    offset: options.offset ?? plan.offset,
    cursorOffset: options.cursorOffset,
    cursor: options.cursorValues ? { keys: options.cursorValues } : null,
    includeDeleted: plan.query.includeDeleted,
    deletedOnly: plan.query.deletedOnly,
    timeZone: options.timeZone,
    dateConfig: options.timeZone ? { timeZone: options.timeZone } : undefined,
    computedFieldSql: options.computedFieldSql,
    resolveField: resolveFormulaField,
  });
  if (!compiled.ok) return failGroup(compiled.error);

  return {
    ok: true,
    query: {
      sql: compiled.query,
      columns: groupColumnsFor(plan, fields, aggregations.aggregations),
      limit: options.limit === null ? null : Math.min(Math.max(options.limit ?? plan.query.limit ?? 100, 1), 10_001),
      offset: dslSqlOffset(options, plan.offset),
      cursorable: compiled.cursorable,
      cursorValuesFromRow: compiled.cursorValuesFromRow,
    },
  };
};
