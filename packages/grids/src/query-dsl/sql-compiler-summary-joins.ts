import { sql } from "bun";
import { compileGroupQuery } from "../service/group-compiler";
import { compileRecordMetaFilter } from "../service/record-metadata";
import type { DslSummaryJoin } from "./resolver-summary-joins";
import type { DslSqlCompileOptions } from "./sql-compiler-types";

export function compileSummaryJoin(
  join: DslSummaryJoin,
  index: number,
  options: DslSqlCompileOptions,
): { ok: true; sql: unknown } | { ok: false; error: string } {
  // Combined-table projection has a distinct relation identity contract. Do not
  // silently apply physical record/link SQL to those virtual rows.
  if (options.recordSource?.kind === "federated" || options.recordSourcesByTableId?.has(join.tableId))
    return { ok: false, error: "grouped-view joins currently require stored tables" };
  const query = join.source.query;
  const grouped = compileGroupQuery({
    tableId: join.tableId,
    fields: options.fieldsByTableId[join.tableId] ?? [],
    groupBy: query.groupBy ?? [],
    aggregations: [...(query.aggregations ?? []), ...(join.source.summaryFormulaAggregations ?? [])],
    filter: query.filter,
    extraWhere: compileRecordMetaFilter(query.recordMeta ?? null),
    includeDeleted: query.includeDeleted,
    deletedOnly: query.deletedOnly,
    timeZone: options.timeZone,
    dateConfig: options.timeZone ? { timeZone: options.timeZone } : undefined,
    computedFieldSql: options.computedFieldSqlByJoinAlias?.get(join.alias),
    summaryOnly: true,
  });
  if (!grouped.ok) return grouped;
  const alias = sql.unsafe(`summary_${index}`);
  return { ok: true, sql: sql`LEFT JOIN (${grouped.query}) ${alias} ON ${alias}.gk_0 = r.id::text` };
}
