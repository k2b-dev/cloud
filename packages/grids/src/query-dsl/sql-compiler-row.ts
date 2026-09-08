import { sql } from "bun";
import type { RecordQuery } from "../contracts";
import { normalizeRefKey, parseQualifiedIdentifierRef } from "../ref-syntax";
import { compileFilter, renderClause } from "../service/filter-compiler";
import type { FormulaSqlExpression } from "../service/formula-sql-compiler";
import { compileDslKeyset, type DslKeysetColumn } from "../service/keyset-compiler";
import { compileRecordMetaFilter } from "../service/record-metadata";
import type { Field } from "../service/types";
import type { DslOutputColumn, DslResolvedRelationJoin, DslResolvedSqlQueryPlan, DslResolvedSqlSort } from "./resolver";
import {
  aliveFields,
  compileBaseFieldColumn,
  compileFormulaColumn,
  compileJoinedColumn,
  computedFieldSqlForScope,
  fieldById,
  isImplicitlySelectableField,
  relationTargetIsReadable,
  sortProjectionForField,
} from "./sql-compiler-fields";
import { joinFragments } from "./sql-compiler-fragments";
import { compileRelationJoin } from "./sql-compiler-joins";
import { compileViewSourceRecordScope, recordDeletedCondition, scopedFormulaResolverForPlan } from "./sql-compiler-scope";
import { dslRecordRelation, dslRecordTableCondition, dslRelationValuesInRecordData } from "./sql-compiler-source";
import {
  type DslSqlCompiledQuery,
  type DslSqlCompileOptions,
  type DslSqlCompileResult,
  type DslSqlOutputColumn,
  dslSqlOffset,
} from "./sql-compiler-types";
import { compileWherePredicate } from "./sql-compiler-where";

type RecordQueryColumn = NonNullable<RecordQuery["columns"]>[number];
type RecordQueryComputedColumn = Extract<RecordQueryColumn, { kind: "computed" }>;

/** SQL execution needs bound identities, not the source's authoring label. */
type RowPlan = Omit<DslResolvedSqlQueryPlan, "source" | "readableTableIds"> & { readableTableIds?: readonly string[] };

const ok = (query: DslSqlCompiledQuery): DslSqlCompileResult => ({ ok: true, query });
const fail = (error: string): DslSqlCompileResult => ({ ok: false, error });

const isComputedColumn = (column: RecordQueryColumn): column is RecordQueryComputedColumn =>
  (column as { kind?: unknown }).kind === "computed";

const sortsForPlan = (plan: RowPlan): DslResolvedSqlSort[] =>
  plan.sqlSort ??
  (plan.query.sort ?? []).map((sort) =>
    sort.source === "record"
      ? { kind: "record", key: sort.key, direction: sort.direction, nullsFirst: sort.nullsFirst }
      : { kind: "field", fieldId: sort.fieldId, direction: sort.direction, nullsFirst: sort.nullsFirst },
  );

const joinCanFanOut = (join: DslResolvedRelationJoin, fieldsByTableId: Record<string, Field[]>): boolean => {
  if (join.direction === "reverse") return true;
  const relationField = fieldsByTableId[join.fromTableId]?.find((field) => field.id === join.relationFieldId);
  return (relationField?.config as { cardinality?: unknown } | undefined)?.cardinality !== "single";
};

const valueUsesJoinAlias = (value: unknown, aliases: ReadonlySet<string>): boolean => {
  if (Array.isArray(value)) return value.some((item) => valueUsesJoinAlias(item, aliases));
  if (!value || typeof value !== "object") return false;
  const node = value as Record<string, unknown>;
  if (node.kind === "field" && typeof node.fieldId === "string") {
    const scope = parseQualifiedIdentifierRef(node.fieldId)?.scope;
    if (scope && aliases.has(normalizeRefKey(scope))) return true;
  }
  return Object.values(node).some((item) => valueUsesJoinAlias(item, aliases));
};

const canCorrelateBoundedSingleJoins = (
  plan: RowPlan,
  fieldsByTableId: Record<string, Field[]>,
  joinFanoutLimit: number | undefined,
): boolean => {
  const joins = plan.joins ?? [];
  if (!joinFanoutLimit || joins.length === 0 || joins.some((join) => joinCanFanOut(join, fieldsByTableId))) return false;
  const aliases = new Set(joins.map((join) => normalizeRefKey(join.alias)));
  if ((plan.sqlSearch?.length ?? 0) > 0 || valueUsesJoinAlias(plan.wherePredicate, aliases)) return false;
  return !(plan.sqlSort ?? []).some((sort) => sort.kind === "joined" || sort.kind === "joinedField" || sort.kind === "computed");
};

const outputColumnsForPlan = (plan: RowPlan, baseFields: Field[]): DslOutputColumn[] => {
  if (plan.outputColumns && plan.outputColumns.length > 0) return plan.outputColumns;
  const baseColumns: NonNullable<RecordQuery["columns"]> = plan.query.columns?.length
    ? plan.query.columns
    : baseFields
        .filter((field) => isImplicitlySelectableField(field) && relationTargetIsReadable(field, plan.readableTableIds))
        .map((field) => ({ fieldId: field.id }));
  return [
    ...baseColumns.map((column) => {
      if (isComputedColumn(column)) {
        return {
          kind: "computed",
          id: column.id,
          label: column.label,
          expression: column.expression,
        } satisfies DslOutputColumn;
      }
      return {
        kind: "field",
        fieldId: column.fieldId,
        ...(column.label ? { label: column.label } : {}),
      } satisfies DslOutputColumn;
    }),
    ...(plan.joinedColumns ?? []).map((joined) => ({ kind: "joined" as const, ...joined })),
  ];
};

const compileSqlSort = (
  sorts: DslResolvedSqlSort[],
  fields: Field[],
  outputProjections: Map<string, { projection: unknown; sqlType: DslSqlOutputColumn["sqlType"] }>,
  options: {
    fieldsByTableId: Record<string, Field[]>;
    joinAliases: Map<string, string>;
    timeZone?: string;
    readableTableIds?: readonly string[];
    computedFieldSql?: Map<string, FormulaSqlExpression>;
    computedFieldSqlByJoinAlias?: Map<string, Map<string, FormulaSqlExpression>>;
    cursorValues?: unknown[];
    recordSource?: DslSqlCompileOptions["recordSource"];
    joins?: DslResolvedRelationJoin[];
  },
): { ok: true; keyset: ReturnType<typeof compileDslKeyset> & { ok: true } } | { ok: false; error: string } => {
  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  const cursorColumns: DslKeysetColumn[] = [];

  for (const sort of sorts) {
    if (sort.kind === "record") {
      const expression = sort.key === "createdAt" ? sql`r.created_at` : sort.key === "updatedAt" ? sql`r.updated_at` : sql`r.deleted_at`;
      cursorColumns.push({ expression, type: "datetime", direction: sort.direction, nullsFirst: sort.nullsFirst });
      continue;
    }
    if (sort.kind === "computed") {
      const output = outputProjections.get(sort.alias);
      if (!output) return { ok: false, error: `computed sort alias "${sort.alias}" is not selected` };
      cursorColumns.push({
        expression: output.projection,
        type: output.sqlType === "json" ? "unknown" : output.sqlType,
        direction: sort.direction,
        nullsFirst: sort.nullsFirst,
      });
      continue;
    }
    if (sort.kind === "joined") {
      const output = outputProjections.get(sort.alias);
      if (!output) return { ok: false, error: `joined sort alias "${sort.alias}" is not selected` };
      cursorColumns.push({
        expression: output.projection,
        type: output.sqlType === "json" ? "unknown" : output.sqlType,
        direction: sort.direction,
        nullsFirst: sort.nullsFirst,
      });
      continue;
    }
    if (sort.kind === "joinedField") {
      const recordAlias = options.joinAliases.get(sort.joinAlias);
      if (!recordAlias) return { ok: false, error: `joined sort uses unknown join alias "${sort.joinAlias}"` };
      const joinedFields = aliveFields(options.fieldsByTableId[sort.tableId] ?? []);
      const field = fieldById(joinedFields, sort.fieldId);
      if (!field) return { ok: false, error: `joined sort field ${sort.fieldId} is not available` };
      if (!relationTargetIsReadable(field, options.readableTableIds)) {
        return { ok: false, error: `relation field "${field.name}" target table is not available` };
      }
      const projection = sortProjectionForField(field, recordAlias, {
        fields: joinedFields,
        timeZone: options.timeZone,
        computedFieldSql: computedFieldSqlForScope(options, sort.joinAlias),
      });
      if (!projection.ok) return projection;
      cursorColumns.push({
        expression: projection.projection,
        type: projection.sqlType,
        direction: sort.direction,
        nullsFirst: sort.nullsFirst,
      });
      continue;
    }
    const field = fieldsById.get(sort.fieldId);
    if (!field) return { ok: false, error: "unknown sort field" };
    if (field.deletedAt) return { ok: false, error: `sort field "${field.name}" is deleted` };
    if (!relationTargetIsReadable(field, options.readableTableIds)) {
      return { ok: false, error: `relation field "${field.name}" target table is not available` };
    }
    const projection = sortProjectionForField(field, "r", {
      fields,
      timeZone: options.timeZone,
      computedFieldSql: options.computedFieldSql,
    });
    if (!projection.ok) return projection;
    cursorColumns.push({
      expression: projection.projection,
      type: projection.sqlType,
      direction: sort.direction,
      nullsFirst: sort.nullsFirst,
    });
  }

  const tieDirection = sorts[0]?.direction ?? "asc";
  cursorColumns.push({ expression: sql`r.id`, type: "uuid", direction: tieDirection });
  for (const join of options.joins ?? []) {
    if (!joinCanFanOut(join, options.fieldsByTableId)) continue;
    const recordAlias = options.joinAliases.get(join.alias);
    if (!recordAlias) continue;
    cursorColumns.push({ expression: sql`${sql.unsafe(recordAlias)}.id`, type: "uuid", direction: tieDirection, nullsFirst: false });
  }
  const keyset = compileDslKeyset(cursorColumns, options.cursorValues);
  return keyset.ok ? { ok: true, keyset } : keyset;
};

export const compileDslQueryPlanToSql = (
  plan: RowPlan,
  options: DslSqlCompileOptions & {
    /** Editable stored records retain their full persistence shape and existing
     * hydration. This replaces only SELECT, never predicates or ordering. */
    recordProjection?: unknown;
  },
): DslSqlCompileResult => {
  if (
    (plan.query.groupBy?.length ?? 0) > 0 ||
    (plan.query.aggregations?.length ?? 0) > 0 ||
    plan.formulaAggregations ||
    plan.formulaHaving
  ) {
    return fail("grouped DSL query execution is not compiled by the row-query compiler yet");
  }
  if (
    options.recordProjection !== undefined &&
    ((plan.joins?.length ?? 0) > 0 || plan.derivedViewSource || options.recordSource?.kind === "federated")
  ) {
    return fail("editable record projection requires a stored table without joins or derived rows");
  }

  const baseFields = aliveFields(options.fieldsByTableId[plan.tableId] ?? []);
  const filter = compileFilter(plan.query.filter ?? null, baseFields, { timeZone: options.timeZone });
  if (!filter.ok) return fail(`filter: ${filter.error}`);

  const joinAliases = new Map<string, string>();
  const joinSql: unknown[] = [];
  const correlateBoundedSingleJoins = canCorrelateBoundedSingleJoins(plan, options.fieldsByTableId, options.joinFanoutLimit);
  for (const [index, join] of (plan.joins ?? []).entries()) {
    const compiled = compileRelationJoin(join, index, joinAliases, {
      joinFanoutLimit: correlateBoundedSingleJoins ? 1 : options.joinFanoutLimit,
      recordSource: options.recordSource,
      recordSourcesByTableId: options.recordSourcesByTableId,
      correlateTarget: correlateBoundedSingleJoins,
    });
    if (!compiled.ok) return fail(compiled.error);
    joinAliases.set(join.alias, compiled.recordAlias);
    joinSql.push(compiled.fragment);
  }
  const resolveFormulaField = scopedFormulaResolverForPlan(plan, baseFields, joinAliases, options);

  const selectFragments: unknown[] =
    options.recordProjection !== undefined
      ? [options.recordProjection]
      : [
          sql`r.id::text AS __record_id`,
          sql`r.table_id::text AS __table_id`,
          sql`r.version AS __record_version`,
          sql`r.finalized_at AS __record_finalized_at`,
          sql`r.finalized_by::text AS __record_finalized_by`,
          sql`r.deleted_at AS __record_deleted_at`,
          sql`r.created_by::text AS __record_created_by`,
          sql`r.updated_by::text AS __record_updated_by`,
          sql`r.created_at AS __record_created_at`,
          sql`r.updated_at AS __record_updated_at`,
          ...(options.recordSource?.kind === "federated"
            ? [sql`r.source_table_id::text AS __source_table_id`, sql`r.source_base_id::text AS __source_base_id`]
            : []),
        ];
  const columns: DslSqlOutputColumn[] = [];
  const outputProjections = new Map<string, { projection: unknown; sqlType: DslSqlOutputColumn["sqlType"] }>();
  const outputColumns = options.recordProjection !== undefined ? [] : outputColumnsForPlan(plan, baseFields);
  let index = 0;

  for (const column of outputColumns) {
    if (column.kind === "computed") {
      const compiled = compileFormulaColumn({
        expression: column.expression,
        label: column.label,
        fields: baseFields,
        recordAlias: "r",
        index,
        timeZone: options.timeZone,
        computedFieldSql: options.computedFieldSql,
        resolveField: resolveFormulaField,
      });
      if (!compiled.ok) return fail(`select "${column.label}": ${compiled.error}`);
      selectFragments.push(compiled.fragment);
      columns.push(compiled.column);
      outputProjections.set(compiled.column.label, { projection: compiled.projection, sqlType: compiled.column.sqlType });
      index += 1;
      continue;
    }
    if (column.kind === "joined") {
      const recordAlias = joinAliases.get(column.joinAlias);
      if (!recordAlias) return fail(`joined column uses unknown join alias "${column.joinAlias}"`);
      const compiled = compileJoinedColumn({
        joinedColumn: column,
        fieldsByTableId: options.fieldsByTableId,
        recordAlias,
        index,
        timeZone: options.timeZone,
        readableTableIds: plan.readableTableIds,
        computedFieldSql: computedFieldSqlForScope(options, column.joinAlias),
      });
      if (!compiled.ok) return fail(compiled.error);
      selectFragments.push(compiled.fragment);
      columns.push(compiled.column);
      outputProjections.set(compiled.column.label, { projection: compiled.projection, sqlType: compiled.column.sqlType });
      index += 1;
      continue;
    }
    const field = fieldById(baseFields, column.fieldId);
    if (!field) return fail(`field ${column.fieldId} is not available`);
    const compiled = compileBaseFieldColumn({
      field,
      fields: baseFields,
      label: column.label,
      recordAlias: "r",
      index,
      tableId: plan.tableId,
      timeZone: options.timeZone,
      readableTableIds: plan.readableTableIds,
      computedFieldSql: options.computedFieldSql,
      resolveField: resolveFormulaField,
    });
    if (!compiled.ok) return fail(compiled.error);
    selectFragments.push(compiled.fragment);
    columns.push(compiled.column);
    outputProjections.set(compiled.column.label, { projection: compiled.projection, sqlType: compiled.column.sqlType });
    index += 1;
  }

  const sqlSort = sortsForPlan(plan);
  const sort = compileSqlSort(sqlSort, baseFields, outputProjections, {
    fieldsByTableId: options.fieldsByTableId,
    joinAliases,
    timeZone: options.timeZone,
    readableTableIds: plan.readableTableIds,
    computedFieldSql: options.computedFieldSql,
    computedFieldSqlByJoinAlias: options.computedFieldSqlByJoinAlias,
    cursorValues: options.cursorValues,
    recordSource: options.recordSource,
    joins: plan.joins,
  });
  if (!sort.ok) return fail(`sort: ${sort.error}`);
  selectFragments.push(sort.keyset.select);

  const conditions: unknown[] = [
    dslRecordTableCondition(plan.tableId, options),
    recordDeletedCondition(plan),
    renderClause(filter.clause, { relationSource: dslRelationValuesInRecordData(options) ? "recordData" : "links" }),
    compileRecordMetaFilter(plan.query.recordMeta ?? null),
  ];
  const viewScope = compileViewSourceRecordScope(plan, baseFields, options);
  if (!viewScope.ok) return fail(viewScope.error);
  if (viewScope.condition) conditions.push(viewScope.condition);
  if (plan.wherePredicate) {
    const compiled = compileWherePredicate(plan.wherePredicate, baseFields, {
      timeZone: options.timeZone,
      computedFieldSql: options.computedFieldSql,
      resolveField: resolveFormulaField,
      relationSource: dslRelationValuesInRecordData(options) ? "recordData" : "links",
    });
    if (!compiled.ok) return fail(`where: ${compiled.error}`);
    conditions.push(compiled.sql);
  }
  if (options.searchClause) conditions.push(options.searchClause);
  conditions.push(sort.keyset.where);
  const where = conditions.reduce((acc, condition) => sql`${acc} AND ${condition}`);
  const limit = Math.min(Math.max(options.limit ?? plan.query.limit ?? 100, 1), 10_000);
  const offset = dslSqlOffset(options, plan.offset);

  return ok({
    sql: sql`
      SELECT ${joinFragments(selectFragments, sql`, `)}
      FROM ${dslRecordRelation(options)}
      JOIN grids.tables t ON t.id = r.table_id AND t.deleted_at IS NULL
      JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
      ${joinFragments(joinSql, sql` `)}
      WHERE ${where}
      ORDER BY ${sort.keyset.orderBy}
      LIMIT ${limit}
      OFFSET ${offset}
    `,
    columns,
    joinAliases: Object.fromEntries(joinAliases),
    limit,
    offset,
    cursorValuesFromRow: sort.keyset.valuesFromRow,
  });
};
