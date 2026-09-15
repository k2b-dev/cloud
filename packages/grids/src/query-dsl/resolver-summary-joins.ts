import { normalizeRefKey } from "../ref-syntax";
import type { DslResolverContext, DslViewSource } from "./resolver-context";
import { type DslDerivedViewColumn, derivedColumnByRef, derivedViewColumns } from "./resolver-derived-columns";
import { type DslResolverDiagnostic, diagnostic, isResolverDiagnostic } from "./resolver-diagnostics";
import { aliveFields, hasAnyOutputAlias, isBaseScope, type Scope } from "./resolver-scope";
import { type ResolvedSource, resolveSource } from "./resolver-source";
import type { DslJoin } from "./types";

/** One row per parent, never an independent child-row fanout. */
export type DslSummaryJoin = {
  alias: string;
  source: DslViewSource;
  tableId: string;
  parentTableId: string;
  group: DslDerivedViewColumn;
  columns: DslDerivedViewColumn[];
};

export function resolveSummaryJoin(
  join: DslJoin,
  parent: ResolvedSource,
  scope: Scope,
  ctx: DslResolverContext,
): DslSummaryJoin | DslResolverDiagnostic {
  if (join.mode !== "left") return diagnostic("grouped views support left join only", join.span);
  if (hasAnyOutputAlias(scope, join.alias)) return diagnostic(`duplicate join alias "${join.alias}"`, join.span);
  const resolved = resolveSource(join.source, ctx);
  if (isResolverDiagnostic(resolved)) return resolved;
  const source = resolved.source;
  if (source.kind !== "view") return diagnostic("summary join requires a grouped view", join.span);
  const query = source.query;
  if (query.groupBy?.length !== 1 || !(query.aggregations?.length || source.summaryFormulaAggregations?.length))
    return diagnostic("joined view must group by exactly one relation and declare its aggregates", join.span);
  if (query.limit !== undefined || query.search !== undefined || (query.groupSort?.length ?? 0) > 0)
    return diagnostic("joined grouped views must not have a limit, search, or group-sort window", join.span);
  if (!ctx.tables.some((table) => table.id === source.tableId)) return diagnostic("joined view table is not available", join.span);
  const columns = derivedViewColumns(query, aliveFields(ctx.fieldsByTableId[source.tableId] ?? []), source.summaryFormulaAggregations);
  if (isResolverDiagnostic(columns)) return columns;
  const group = columns[0]!;
  if (group.kind !== "group" || group.type !== "relation" || group.targetTableId !== parent.tableId)
    return diagnostic("joined view must group by a relation to the source table", join.span);
  const leftIsChild = normalizeRefKey(join.on.left.scope ?? "") === normalizeRefKey(join.alias);
  const child = leftIsChild ? join.on.left : join.on.right;
  const target = leftIsChild ? join.on.right : join.on.left;
  if (
    normalizeRefKey(child.scope ?? "") !== normalizeRefKey(join.alias) ||
    normalizeRefKey(target.ref) !== "id" ||
    (target.scope && !isBaseScope(scope, target.scope))
  )
    return diagnostic("join the grouped relation column to the source record id", join.span);
  const selected = derivedColumnByRef(columns, child.ref, child.span);
  if (isResolverDiagnostic(selected)) return selected;
  if (selected.key !== group.key) return diagnostic("join must use the view's relation group column", join.span);
  return { alias: join.alias, source, tableId: source.tableId, parentTableId: parent.tableId, group, columns };
}
