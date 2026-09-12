import type { Field } from "../service/types";
import type { DslResolvedSqlQueryPlan } from "./resolver";
import { isImplicitlySelectableField, relationTargetIsReadable } from "./sql-compiler-fields";

const walkStrings = (value: unknown, visit: (value: string) => void): void => {
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkStrings(item, visit);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const item of Object.values(value)) walkStrings(item, visit);
};

/** Fields whose configuration can change a resolved query, including computed
 * dependencies and implicit selections. Labels are a separate presentation concern. */
export const dslQueryReferencedFieldIds = (plan: DslResolvedSqlQueryPlan, fieldsByTableId: Record<string, Field[]>): Set<string> => {
  const byId = new Map(
    Object.values(fieldsByTableId)
      .flat()
      .map((field) => [field.id, field]),
  );
  const ids = new Set<string>();
  walkStrings(plan, (value) => {
    if (byId.has(value)) ids.add(value);
  });
  const hasRowOutput =
    (plan.query.aggregations?.length ?? 0) === 0 &&
    (plan.sqlAggregations?.length ?? 0) === 0 &&
    (plan.formulaAggregations?.length ?? 0) === 0 &&
    (plan.query.groupBy?.length ?? 0) === 0 &&
    (plan.sqlGroupBy?.length ?? 0) === 0;
  if (hasRowOutput && (plan.outputColumns?.length ?? 0) === 0 && (plan.query.columns?.length ?? 0) === 0) {
    for (const field of fieldsByTableId[plan.tableId] ?? []) {
      if (!field.deletedAt && isImplicitlySelectableField(field) && relationTargetIsReadable(field, plan.readableTableIds))
        ids.add(field.id);
    }
  }
  if (plan.query.search && !plan.query.search.fieldIds) {
    for (const field of fieldsByTableId[plan.tableId] ?? []) if (!field.deletedAt) ids.add(field.id);
  }
  let added = true;
  while (added) {
    added = false;
    for (const id of [...ids]) {
      const field = byId.get(id);
      if (!field) continue;
      walkStrings(field.config, (value) => {
        if (byId.has(value) && !ids.has(value)) {
          ids.add(value);
          added = true;
        }
      });
    }
  }
  return ids;
};
