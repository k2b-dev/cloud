import { sql } from "bun";
import type { RecordQuery } from "../contracts";
import {
  aggregateOutputKey,
  aggregateOutputKeyFor,
  aggregateSqlTypeForField,
  aggregateSqlTypeForFormula,
  isAggregateKind,
  isFieldAggregatable,
  isFormulaAggregatable,
} from "../service/aggregate-capabilities";
import { groupSqlTypeForField, isMultiSelectField, storageOf } from "../service/field-storage";
import { compileFormulaAstToSql, type FormulaSqlFieldResolver, type FormulaSqlType } from "../service/formula-sql-compiler";
import type { GroupAggregationSpec } from "../service/group-compiler";
import type { Field } from "../service/types";
import type { DslFormulaAggregation, DslResolvedSqlAggregation, DslResolvedSqlGroupBy, DslResolvedSqlQueryPlan } from "./resolver";
import { aliveFields, computedFieldSqlForScope, fieldProjection, outputTypeFor } from "./sql-compiler-fields";
import { compileViewSourceRecordScope } from "./sql-compiler-scope";
import type { DslSqlCompileOptions, DslSqlGroupOutputColumn, DslSqlOutputColumn } from "./sql-compiler-types";
import { compileWherePredicate } from "./sql-compiler-where";

type GroupAggKind = GroupAggregationSpec["agg"];
type GroupFieldAggregation = Extract<GroupAggregationSpec, { fieldId: string | "*" }>;

const groupKey = (index: number): string => `gk_${index}`;

const isFormulaGroupAggregation = (aggregation: GroupAggregationSpec): aggregation is Extract<GroupAggregationSpec, { kind: "formula" }> =>
  "kind" in aggregation && aggregation.kind === "formula";

export const aggregateKey = (aggregation: GroupAggregationSpec): string => aggregateOutputKeyFor(aggregation);

const isGroupAggKind = (agg: string): agg is GroupAggKind => isAggregateKind(agg);

const aggregateSqlType = (aggregation: GroupAggregationSpec, fieldsById: Map<string, Field>): FormulaSqlType => {
  if (isFormulaGroupAggregation(aggregation)) {
    const formulaAggregation = aggregation as DslFormulaAggregation;
    return aggregateSqlTypeForFormula(formulaAggregation.sqlType, formulaAggregation.agg);
  }
  if (aggregation.fieldId === "*") return aggregateSqlTypeForField(null, aggregation.agg, true);
  const field = fieldsById.get(aggregation.fieldId);
  return aggregateSqlTypeForField(field ?? null, aggregation.agg, false);
};

export const formulaAggregateSqlType = (aggregation: DslFormulaAggregation): FormulaSqlType =>
  aggregateSqlTypeForFormula(aggregation.sqlType, aggregation.agg);

export const viewAggregateSqlType = (
  aggregation: NonNullable<RecordQuery["aggregations"]>[number],
  fieldsById: Map<string, Field>,
): FormulaSqlType => {
  if (aggregation.fieldId === "*") return aggregateSqlTypeForField(null, aggregation.agg, true);
  const field = fieldsById.get(aggregation.fieldId);
  return aggregateSqlTypeForField(field ?? null, aggregation.agg, false);
};

export const hasGroupedShape = (plan: DslResolvedSqlQueryPlan): boolean =>
  (plan.query.groupBy?.length ?? 0) > 0 ||
  (plan.sqlGroupBy?.length ?? 0) > 0 ||
  (plan.query.aggregations?.length ?? 0) > 0 ||
  (plan.sqlAggregations?.length ?? 0) > 0 ||
  (plan.formulaAggregations?.length ?? 0) > 0 ||
  Boolean(plan.formulaHaving);

export const compileGroupExtraWhere = (
  plan: DslResolvedSqlQueryPlan,
  fields: Field[],
  options: DslSqlCompileOptions,
  resolveField?: FormulaSqlFieldResolver,
): { ok: true; where?: unknown } | { ok: false; error: string } => {
  const parts: unknown[] = [];
  const viewScope = compileViewSourceRecordScope(plan, fields, options);
  if (!viewScope.ok) return viewScope;
  if (viewScope.condition) parts.push(viewScope.condition);
  if (plan.wherePredicate) {
    const compiled = compileWherePredicate(plan.wherePredicate, fields, {
      timeZone: options.timeZone,
      computedFieldSql: options.computedFieldSql,
      resolveField,
    });
    if (!compiled.ok) return { ok: false, error: `where: ${compiled.error}` };
    parts.push(compiled.sql);
  }
  if (parts.length === 0) return { ok: true };
  return { ok: true, where: parts.reduce((acc, part) => sql`${acc} AND ${part}`) };
};

export const compileFormulaAggregateColumn = (
  aggregation: DslFormulaAggregation,
  fields: Field[],
  options: DslSqlCompileOptions,
  resolveField?: FormulaSqlFieldResolver,
): { ok: true; key: string; expr: unknown } | { ok: false; error: string } => {
  const compiled = compileFormulaAstToSql(aggregation.expression, {
    fields,
    recordAlias: "r",
    dateConfig: options.timeZone ? { timeZone: options.timeZone } : undefined,
    computedFieldSql: options.computedFieldSql,
    resolveField,
  });
  if (!compiled.ok) return { ok: false, error: `formula aggregate "${aggregation.id}": ${compiled.error}` };
  if (!isFormulaAggregatable(compiled.expression.type, aggregation.agg)) {
    return {
      ok: false,
      error: `formula aggregate "${aggregation.id}": agg "${aggregation.agg}" not compatible with SQL type "${compiled.expression.type}"`,
    };
  }
  const expression = compiled.expression.sql;
  const key = aggregateKey(aggregation);

  switch (aggregation.agg) {
    case "count":
      return {
        ok: true,
        key,
        expr: sql`COUNT(${expression}) FILTER (WHERE ${expression} IS NOT NULL AND (${expression})::text <> '')`,
      };
    case "countEmpty":
      return { ok: true, key, expr: sql`COUNT(*) FILTER (WHERE ${expression} IS NULL OR (${expression})::text = '')` };
    case "countUnique":
      return {
        ok: true,
        key,
        expr: sql`COUNT(DISTINCT ${expression}) FILTER (WHERE ${expression} IS NOT NULL AND (${expression})::text <> '')`,
      };
    case "sum":
      return { ok: true, key, expr: sql`SUM((${expression})::numeric)` };
    case "avg":
      return { ok: true, key, expr: sql`AVG((${expression})::numeric)` };
    case "median":
      return { ok: true, key, expr: sql`PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY (${expression})::numeric)` };
    case "min":
    case "earliest":
      return { ok: true, key, expr: sql`MIN(${expression})` };
    case "max":
    case "latest":
      return { ok: true, key, expr: sql`MAX(${expression})` };
  }
};

export const groupColumnsFor = (
  plan: DslResolvedSqlQueryPlan,
  fields: Field[],
  aggregations: GroupAggregationSpec[],
): DslSqlGroupOutputColumn[] => {
  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  const groups = (plan.query.groupBy ?? []).map((group, index): DslSqlGroupOutputColumn => {
    const field = fieldsById.get(group.fieldId);
    return {
      kind: "group",
      key: groupKey(index),
      label: group.label ?? field?.name ?? group.fieldId,
      fieldId: group.fieldId,
      tableId: plan.tableId,
      type: field?.type ?? "unknown",
      sqlType: field ? groupSqlTypeForField(field) : "json",
    };
  });
  const aggregateLabels = new Map<string, string>();
  for (const aggregation of plan.query.aggregations ?? []) {
    aggregateLabels.set(
      aggregateOutputKey(aggregation.fieldId, aggregation.agg),
      aggregation.label ?? `${aggregation.agg} ${aggregation.fieldId}`,
    );
  }
  for (const aggregation of plan.formulaAggregations ?? []) {
    aggregateLabels.set(aggregateKey(aggregation), aggregation.id);
  }
  const aggregateColumns = aggregations.map(
    (aggregation): DslSqlGroupOutputColumn => ({
      kind: "aggregate",
      key: aggregateKey(aggregation),
      label: aggregateLabels.get(aggregateKey(aggregation)) ?? aggregateKey(aggregation),
      fieldId: isFormulaGroupAggregation(aggregation) ? aggregation.id : aggregation.fieldId,
      agg: aggregation.agg,
      sqlType: aggregateSqlType(aggregation, fieldsById),
    }),
  );
  return [...groups, ...aggregateColumns];
};

export const toGroupAggregations = (
  plan: DslResolvedSqlQueryPlan,
): { ok: true; aggregations: GroupAggregationSpec[] } | { ok: false; error: string } => {
  const aggregations: GroupAggregationSpec[] = [];
  for (const aggregation of plan.query.aggregations ?? []) {
    if (!isGroupAggKind(aggregation.agg)) return { ok: false, error: `group aggregate "${aggregation.agg}" is not supported` };
    aggregations.push({ fieldId: aggregation.fieldId, agg: aggregation.agg } satisfies GroupFieldAggregation);
  }
  aggregations.push(...((plan.formulaAggregations ?? []) as DslFormulaAggregation[]));
  return { ok: true, aggregations };
};

export const sqlGroupKey = (index: number): string => groupKey(index);

export const groupFieldProjection = (
  group: DslResolvedSqlGroupBy,
  field: Field,
  recordAlias: string,
  options: DslSqlCompileOptions,
  index: number,
  readableTableIds?: readonly string[],
): { ok: true; expr: unknown; sqlType: DslSqlOutputColumn["sqlType"]; joins?: unknown[] } | { ok: false; error: string } => {
  const descriptor = storageOf(field);
  if (descriptor.kind === "relationLink") {
    const alias = `jg_rl_${index}`;
    if (options.recordSourcesByTableId?.has(group.tableId) || (options.recordSource && recordAlias === "r")) {
      return {
        ok: true,
        expr: sql`${sql.unsafe(alias)}.value`,
        sqlType: "text",
        joins: [
          sql`CROSS JOIN LATERAL jsonb_array_elements_text(
            CASE
              WHEN jsonb_typeof(${sql.unsafe(recordAlias)}.data->${field.id}) = 'array'
              THEN ${sql.unsafe(recordAlias)}.data->${field.id}
              ELSE '[]'::jsonb
            END
          ) AS ${sql.unsafe(alias)}(value)`,
        ],
      };
    }
    return {
      ok: true,
      expr: sql`${sql.unsafe(alias)}.to_record_id::text`,
      sqlType: "text",
      joins: [
        sql`JOIN grids.record_links ${sql.unsafe(alias)}
          ON ${sql.unsafe(alias)}.from_record_id = ${sql.unsafe(recordAlias)}.id
         AND ${sql.unsafe(alias)}.from_field_id = ${field.id}::uuid`,
      ],
    };
  }
  if (descriptor.kind === "jsonbArray" && isMultiSelectField(field)) {
    const alias = `jg_ms_${index}`;
    return {
      ok: true,
      expr: sql`${sql.unsafe(alias)}.value`,
      sqlType: "text",
      joins: [
        sql`CROSS JOIN LATERAL jsonb_array_elements_text(
          CASE
            WHEN jsonb_typeof(${sql.unsafe(recordAlias)}.data->${field.id}) = 'array'
            THEN ${sql.unsafe(recordAlias)}.data->${field.id}
            ELSE '[]'::jsonb
          END
        ) AS ${sql.unsafe(alias)}(value)`,
      ],
    };
  }
  if (descriptor.kind === "jsonbArray") {
    return {
      ok: true,
      expr: sql`${sql.unsafe(recordAlias)}.data->${field.id}->>0`,
      sqlType: "text",
    };
  }
  if (field.type === "date" && group.granularity) {
    const expr = (field.config as { includeTime?: boolean }).includeTime
      ? sql`grids.canonical_timestamptz(${sql.unsafe(recordAlias)}.data->>${field.id}) AT TIME ZONE ${options.timeZone ?? "UTC"}`
      : sql`grids.canonical_date(${sql.unsafe(recordAlias)}.data->>${field.id})::timestamp`;
    return { ok: true, expr: sql`date_trunc(${group.granularity}, ${expr})::date`, sqlType: "date" };
  }
  const projection = fieldProjection(field, recordAlias, {
    fields: aliveFields(options.fieldsByTableId[group.tableId] ?? []),
    timeZone: options.timeZone,
    readableTableIds,
    computedFieldSql: computedFieldSqlForScope(options, group.joinAlias),
  });
  if (!projection.ok) return projection;
  return { ok: true, expr: projection.projection, sqlType: projection.sqlType ?? outputTypeFor(field) };
};

export const aggregateExprForField = (
  aggregation: DslResolvedSqlAggregation,
  field: Field | null,
  recordAlias: string,
  options: DslSqlCompileOptions,
  readableTableIds?: readonly string[],
): { ok: true; expr: unknown; sqlType: FormulaSqlType } | { ok: false; error: string } => {
  if (aggregation.fieldId === "*") {
    if (aggregation.agg !== "count") return { ok: false, error: `agg "${aggregation.agg}" requires a field; only count works on "*"` };
    return { ok: true, expr: sql`COUNT(*)::bigint`, sqlType: "numeric" };
  }
  if (!field) return { ok: false, error: "unknown aggregate field" };
  if (!isFieldAggregatable(field, aggregation.agg)) {
    return { ok: false, error: `agg "${aggregation.agg}" not compatible with field type "${field.type}"` };
  }
  const projection = fieldProjection(field, recordAlias, {
    fields: aliveFields(options.fieldsByTableId[aggregation.tableId ?? field.tableId] ?? []),
    timeZone: options.timeZone,
    readableTableIds,
    computedFieldSql: computedFieldSqlForScope(options, aggregation.joinAlias),
  });
  if (!projection.ok) return projection;
  const typedProjection = projection.projection;
  const rawValue = sql`(${typedProjection})::text`;
  const sqlType = aggregateSqlTypeForField(field, aggregation.agg, false);

  switch (aggregation.agg) {
    case "count":
      return {
        ok: true,
        expr: sql`COUNT(${typedProjection}) FILTER (WHERE ${typedProjection} IS NOT NULL AND ${rawValue} <> '')::bigint`,
        sqlType: "numeric",
      };
    case "countEmpty":
      return {
        ok: true,
        expr: sql`COUNT(*) FILTER (WHERE ${typedProjection} IS NULL OR ${rawValue} = '')::bigint`,
        sqlType: "numeric",
      };
    case "countUnique":
      return {
        ok: true,
        expr: sql`COUNT(DISTINCT ${typedProjection}) FILTER (WHERE ${typedProjection} IS NOT NULL AND ${rawValue} <> '')::bigint`,
        sqlType: "numeric",
      };
    case "sum":
      if (!typedProjection) return { ok: false, error: `field "${field.name}" cannot be aggregated` };
      return { ok: true, expr: sql`SUM(${typedProjection})`, sqlType: "numeric" };
    case "avg":
      if (!typedProjection) return { ok: false, error: `field "${field.name}" cannot be aggregated` };
      return { ok: true, expr: sql`AVG(${typedProjection})`, sqlType: "numeric" };
    case "median":
      if (!typedProjection) return { ok: false, error: `field "${field.name}" cannot be aggregated` };
      return { ok: true, expr: sql`PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${typedProjection})`, sqlType: "numeric" };
    case "min":
    case "max": {
      if (!typedProjection) return { ok: false, error: `field "${field.name}" cannot be aggregated` };
      const fn = aggregation.agg === "min" ? sql`MIN` : sql`MAX`;
      return { ok: true, expr: sql`${fn}(${typedProjection})`, sqlType };
    }
    case "earliest":
    case "latest": {
      if (!typedProjection) return { ok: false, error: `field "${field.name}" cannot be aggregated` };
      const fn = aggregation.agg === "earliest" ? sql`MIN` : sql`MAX`;
      return { ok: true, expr: sql`${fn}(${typedProjection})`, sqlType };
    }
  }
};
