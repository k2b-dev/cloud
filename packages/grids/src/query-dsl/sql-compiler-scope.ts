import { sql } from "bun";
import type { RecordQuery } from "../contracts";
import { compileFilter, renderClause } from "../service/filter-compiler";
import type { FormulaSqlFieldResolver } from "../service/formula-sql-compiler";
import { compileRecordMetaFilter, recordMetaRequiresDeletedRows } from "../service/record-metadata";
import { compileSort } from "../service/sort-compiler";
import type { Field } from "../service/types";
import type { DslResolvedSqlQueryPlan } from "./resolver";
import { createDslScopedFormulaFieldResolver } from "./scoped-formula";
import { aliveFields } from "./sql-compiler-fields";
import { dslRecordRelation, dslRecordTableCondition, dslRelationValuesInRecordData } from "./sql-compiler-source";
import type { DslSqlCompileOptions } from "./sql-compiler-types";

export const scopedFormulaResolverForPlan = (
  plan: Pick<DslResolvedSqlQueryPlan, "sourceAlias" | "joins">,
  baseFields: Field[],
  joinAliases: Map<string, string>,
  options: DslSqlCompileOptions,
): FormulaSqlFieldResolver =>
  createDslScopedFormulaFieldResolver({
    base: {
      ...(plan.sourceAlias ? { alias: plan.sourceAlias } : {}),
      fields: baseFields,
      recordAlias: "r",
      computedFieldSql: options.computedFieldSql,
    },
    joins: (plan.joins ?? []).map((join) => ({
      alias: join.alias,
      fields: aliveFields(options.fieldsByTableId[join.tableId] ?? []),
      recordAlias: joinAliases.get(join.alias) ?? join.alias,
      computedFieldSql: options.computedFieldSqlByJoinAlias?.get(join.alias),
    })),
    dateConfig: options.timeZone ? { timeZone: options.timeZone } : undefined,
  });

/** Soft-delete predicate on the base record alias `r`: live-only by default,
 * trash-only for `deleted only`, both for `include deleted`. Parent-table and
 * base liveness joins remain active in every mode. */
export const recordDeletedCondition = (plan: Pick<DslResolvedSqlQueryPlan, "query">): unknown =>
  plan.query.deletedOnly ? sql`r.deleted_at IS NOT NULL` : plan.query.includeDeleted ? sql`TRUE` : sql`r.deleted_at IS NULL`;

const queryDeletedCondition = (query: RecordQuery): unknown =>
  query.deletedOnly || recordMetaRequiresDeletedRows(query.recordMeta)
    ? sql`r.deleted_at IS NOT NULL`
    : query.includeDeleted
      ? sql`TRUE`
      : sql`r.deleted_at IS NULL`;

export const compileViewSourceRecordScope = (
  plan: Pick<DslResolvedSqlQueryPlan, "tableId" | "viewSourceQuery">,
  fields: Field[],
  options: Pick<DslSqlCompileOptions, "timeZone" | "viewSourceSearchClause" | "recordSource">,
): { ok: true; condition?: unknown } | { ok: false; error: string } => {
  const source = plan.viewSourceQuery;
  if (!source) return { ok: true };
  const filter = compileFilter(source.filter ?? null, fields, { timeZone: options.timeZone });
  if (!filter.ok) return { ok: false, error: `view source filter: ${filter.error}` };
  const sort = compileSort(source.sort ?? [], fields, null);
  if (!sort.ok) return { ok: false, error: `view source sort: ${sort.error}` };
  if (source.search && options.viewSourceSearchClause === undefined) {
    return { ok: false, error: "view source search was not compiled" };
  }
  const orderBy = sort.result.orderBy;
  const limit = Math.min(Math.max(source.limit ?? 10_000, 1), 10_000);
  const conditions = [
    dslRecordTableCondition(plan.tableId, options),
    queryDeletedCondition(source),
    renderClause(filter.clause, { relationSource: dslRelationValuesInRecordData(options) ? "recordData" : "links" }),
    options.viewSourceSearchClause ?? sql`TRUE`,
    compileRecordMetaFilter(source.recordMeta ?? null),
  ];
  const where = conditions.reduce((acc, condition) => sql`${acc} AND ${condition}`);
  return {
    ok: true,
    condition: sql`r.id IN (
      SELECT r.id
      FROM ${dslRecordRelation(options)}
      JOIN grids.tables t ON t.id = r.table_id AND t.deleted_at IS NULL
      JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
      WHERE ${where}
      ORDER BY ${orderBy}
      LIMIT ${limit}
    )`,
  };
};
