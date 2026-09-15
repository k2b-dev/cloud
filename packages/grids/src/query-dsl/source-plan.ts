import { normalizeRefKey } from "../ref-syntax";
import type { Field } from "../service/types";
import { dslQueryReferencedFieldIds } from "./plan-dependencies";
import type { DslResolvedSqlQueryPlan, DslTableSource, DslViewSource } from "./resolver";
import type { DslQueryAst, DslSourceRef } from "./types";

export const needsDslViewCatalog = (ast: DslQueryAst): boolean =>
  ast.source?.kind === "view" || ast.joins.some((join) => join.source.kind !== "table");

const matchingTables = (tables: DslTableSource[], source: DslSourceRef): DslTableSource[] => {
  if (source.kind === "view") return [];
  const ref = normalizeRefKey(source.ref);
  return tables.filter((table) => [table.shortId, table.id, table.name].some((value) => normalizeRefKey(value) === ref));
};

const matchingViewTableIds = (views: DslViewSource[], source: DslSourceRef): string[] => {
  if (source.kind === "table") return [];
  const ref = normalizeRefKey(source.ref);
  return views
    .filter((view) => [view.shortId, view.id, view.name].some((value) => normalizeRefKey(value) === ref))
    .map((view) => view.tableId);
};

export const collectDslFieldTableIds = (params: {
  ast: DslQueryAst;
  currentTableId?: string;
  tables: DslTableSource[];
  views?: DslViewSource[];
}): string[] => {
  const tableIds = new Set<string>();
  const views = params.views ?? [];
  const addSource = (source: DslSourceRef | undefined) => {
    if (!source) return;
    for (const table of matchingTables(params.tables, source)) tableIds.add(table.id);
    for (const tableId of matchingViewTableIds(views, source)) tableIds.add(tableId);
  };

  if (params.ast.source) addSource(params.ast.source);
  else if (params.currentTableId && params.tables.some((table) => table.id === params.currentTableId)) tableIds.add(params.currentTableId);

  for (const join of params.ast.joins) addSource(join.source);

  return [...tableIds];
};

export const collectDslPlanExtraFieldTableIds = (plan: DslResolvedSqlQueryPlan): string[] => {
  const tableIds = new Set<string>();
  const derived = plan.derivedViewSource;
  if (!derived?.search) return [];
  const readableTableIds = new Set(plan.readableTableIds);

  for (const column of derived.search.columns) {
    if (column.type === "relation" && column.targetTableId && readableTableIds.has(column.targetTableId)) {
      tableIds.add(column.targetTableId);
    }
  }

  return [...tableIds];
};

/** Returns every table read by the SQL plan, including computed values. Relation label and search
 * dependencies are loaded separately once the resolver has identified them. */
export const collectDslPlanTableIds = (plan: DslResolvedSqlQueryPlan, fieldsByTableId: Record<string, Field[]>): string[] => {
  const tableIds = new Set<string>([
    plan.tableId,
    ...(plan.summaryJoins ?? []).map((join) => join.tableId),
    ...(plan.joins ?? []).flatMap((join) => [join.fromTableId, join.tableId]),
    ...(plan.derivedViewSource?.joins ?? []).map((join) => join.tableId),
    ...(plan.derivedViewSource?.relationJoins ?? []).flatMap((join) => [join.fromTableId, join.tableId]),
  ]);
  const fields = new Map(
    Object.values(fieldsByTableId)
      .flat()
      .map((field) => [field.id, field]),
  );
  for (const fieldId of dslQueryReferencedFieldIds(plan, fieldsByTableId)) {
    const field = fields.get(fieldId);
    if (!field) continue;
    tableIds.add(field.tableId);
    if (field.type !== "lookup" && field.type !== "rollup") continue;
    const relationFieldId = field.config.relationFieldId;
    const relation = typeof relationFieldId === "string" ? fields.get(relationFieldId) : undefined;
    const targetTableId = relation?.type === "relation" ? relation.config.targetTableId : undefined;
    if (typeof targetTableId === "string") tableIds.add(targetTableId);
  }
  return [...tableIds];
};
