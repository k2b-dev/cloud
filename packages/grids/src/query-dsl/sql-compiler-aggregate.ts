import { sql } from "bun";
import { aggregateOutputKey } from "../service/aggregate-capabilities";
import { compileFilter, renderClause } from "../service/filter-compiler";
import { compileRecordScopeFilter } from "../service/record-metadata";
import type { DslResolvedSqlQueryPlan } from "./resolver";
import { aliveFields } from "./sql-compiler-fields";
import { joinFragments } from "./sql-compiler-fragments";
import {
  aggregateExprForField,
  aggregateKey,
  compileFormulaAggregateColumn,
  compileGroupExtraWhere,
  formulaAggregateSqlType,
  viewAggregateSqlType,
} from "./sql-compiler-grouping";
import { recordDeletedCondition, scopedFormulaResolverForPlan } from "./sql-compiler-scope";
import { dslRecordRelation, dslRelationValuesInRecordData } from "./sql-compiler-source";
import type { DslSqlAggregateCompileResult, DslSqlAggregateOutputColumn, DslSqlCompileOptions } from "./sql-compiler-types";

const failAggregate = (error: string): DslSqlAggregateCompileResult => ({ ok: false, error });

export const compileDslAggregateQueryPlanToSql = (
  plan: DslResolvedSqlQueryPlan,
  options: DslSqlCompileOptions,
): DslSqlAggregateCompileResult => {
  const aggregations = plan.query.aggregations ?? [];
  const formulaAggregations = plan.formulaAggregations ?? [];
  if (aggregations.length === 0 && formulaAggregations.length === 0) return failAggregate("query has no aggregate output");
  if ((plan.query.groupBy?.length ?? 0) > 0 || plan.formulaHaving) {
    return failAggregate("grouped DSL query execution belongs to the grouped compiler");
  }
  if ((plan.query.columns?.length ?? 0) > 0 || (plan.joinedColumns?.length ?? 0) > 0) {
    return failAggregate("aggregate-only DSL queries cannot select row columns");
  }
  if ((plan.joins?.length ?? 0) > 0) {
    return failAggregate("aggregate-only relation joins are compiled by the grouped SQL compiler");
  }
  if ((plan.query.sort?.length ?? 0) > 0 || (plan.sqlSort?.length ?? 0) > 0 || (plan.query.groupSort?.length ?? 0) > 0) {
    return failAggregate("aggregate-only DSL queries cannot sort");
  }

  const fields = aliveFields(options.fieldsByTableId[plan.tableId] ?? []);
  const resolveFormulaField = scopedFormulaResolverForPlan(plan, fields, new Map(), options);
  const filter = compileFilter(plan.query.filter ?? null, fields, { timeZone: options.timeZone });
  if (!filter.ok) return failAggregate(`filter: ${filter.error}`);
  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  const aggregateColumns: Array<{ key: string; expr: unknown }> = [];
  for (const aggregation of aggregations) {
    const field = aggregation.fieldId === "*" ? null : (fieldsById.get(aggregation.fieldId) ?? null);
    const compiled = aggregateExprForField({ ...aggregation, tableId: plan.tableId }, field, "r", options, plan.readableTableIds);
    if (!compiled.ok) return failAggregate(`aggregate: ${compiled.error}`);
    aggregateColumns.push({ key: aggregateOutputKey(aggregation.fieldId, aggregation.agg), expr: compiled.expr });
  }
  const extraWhere = compileGroupExtraWhere(plan, fields, options, resolveFormulaField);
  if (!extraWhere.ok) return failAggregate(extraWhere.error);
  const formulaColumns: Array<{ key: string; expr: unknown }> = [];
  for (const aggregation of formulaAggregations) {
    const compiled = compileFormulaAggregateColumn(aggregation, fields, options, resolveFormulaField);
    if (!compiled.ok) return failAggregate(compiled.error);
    formulaColumns.push(compiled);
  }
  const allAggregateColumns = [...aggregateColumns, ...formulaColumns];
  if (allAggregateColumns.length === 0) return failAggregate("query has no aggregate output");
  const columns: DslSqlAggregateOutputColumn[] = aggregations.map(
    (aggregation): DslSqlAggregateOutputColumn => ({
      key: aggregateOutputKey(aggregation.fieldId, aggregation.agg),
      label: aggregation.label ?? `${aggregation.agg} ${fieldsById.get(aggregation.fieldId)?.name ?? "*"}`,
      fieldId: aggregation.fieldId,
      agg: aggregation.agg,
      sqlType: viewAggregateSqlType(aggregation, fieldsById),
    }),
  );
  for (const aggregation of formulaAggregations) {
    columns.push({
      key: aggregateKey(aggregation),
      label: aggregation.id,
      fieldId: aggregation.id,
      agg: aggregation.agg,
      sqlType: formulaAggregateSqlType(aggregation),
    });
  }
  const columnsByKey = new Map(columns.map((column) => [column.key, column]));
  // JSON numeric values are parsed as JavaScript numbers before preview normalization.
  // Serialize exact numeric results as strings, just like numeric row/group projections.
  // Counts retain their existing integer transport shape.
  const jsonPairs = allAggregateColumns.map((column) => {
    const output = columnsByKey.get(column.key);
    const count = output?.agg === "count" || output?.agg === "countEmpty" || output?.agg === "countUnique";
    const value = output?.sqlType === "numeric" && !count ? sql`(${column.expr})::text` : column.expr;
    return sql`${column.key}::text, ${value}`;
  });

  const where = sql`${compileRecordScopeFilter(plan.tableId)}
    AND ${recordDeletedCondition(plan)}
    AND ${renderClause(filter.clause, { computedFieldSql: options.computedFieldSql, relationSource: dslRelationValuesInRecordData(options) ? "recordData" : "links" })}
    AND ${extraWhere.where ?? sql`TRUE`}
    AND ${options.searchClause ?? sql`TRUE`}`;
  return {
    ok: true,
    query: {
      sql: sql`
        SELECT jsonb_build_object(${joinFragments(jsonPairs, sql`, `)}) AS result
        FROM ${dslRecordRelation(options)}
        WHERE ${where}
      `,
      columns,
      limit: 1,
      offset: 0,
    },
  };
};
