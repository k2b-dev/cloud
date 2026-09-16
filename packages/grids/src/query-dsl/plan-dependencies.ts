import { collectFieldRefs, parseFormula } from "../formula/parser";
import { normalizeRefKey, parseQualifiedIdentifierRef } from "../ref-syntax";
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
export const dslQueryReferencedFieldIds = (
  plan: DslResolvedSqlQueryPlan,
  fieldsByTableId: Record<string, Field[]>,
  additionalFieldIds: Iterable<string> = [],
): Set<string> => {
  const byId = new Map(
    Object.values(fieldsByTableId)
      .flat()
      .map((field) => [field.id, field]),
  );
  const ids = new Set(additionalFieldIds);
  const addFormulaRefs = (expression: Parameters<typeof collectFieldRefs>[0], tableId: string) => {
    const refs = new Set([...collectFieldRefs(expression)].map(normalizeRefKey));
    for (const field of fieldsByTableId[tableId] ?? []) {
      if (!field.deletedAt && [field.id, field.shortId, field.name].some((key) => refs.has(normalizeRefKey(key)))) ids.add(field.id);
    }
  };
  for (const aggregation of plan.formulaAggregations ?? []) addFormulaRefs(aggregation.expression, plan.tableId);
  for (const join of plan.summaryJoins ?? [])
    for (const aggregation of join.source.summaryFormulaAggregations ?? []) addFormulaRefs(aggregation.expression, join.tableId);
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
      // Counting linked records never evaluates the retained target field.
      const dependencyConfig =
        field.type === "rollup" && field.config.agg === "count" ? { relationFieldId: field.config.relationFieldId } : field.config;
      walkStrings(dependencyConfig, (value) => {
        if (byId.has(value) && !ids.has(value)) {
          ids.add(value);
          added = true;
        }
      });
      if (field.type === "formula" && typeof field.config.expression === "string") {
        const parsed = parseFormula(field.config.expression);
        if (!parsed.ok) continue;
        const refs = new Set([...collectFieldRefs(parsed.ast)].map(normalizeRefKey));
        for (const dependency of fieldsByTableId[field.tableId] ?? []) {
          if (dependency.deletedAt || ids.has(dependency.id)) continue;
          if (![dependency.shortId, dependency.name].some((key) => refs.has(normalizeRefKey(key)))) continue;
          ids.add(dependency.id);
          added = true;
        }
      }
    }
  }
  return ids;
};

/** Runtime preparation also needs author-written formula refs in predicates and
 * computed columns. Keep this separate from published query fingerprints. Names
 * are matched conservatively across scopes: homonyms may prepare extra fields,
 * but cannot remove a dependency from a joined or nested source. */
export const dslQueryCalculationFieldIds = (plan: DslResolvedSqlQueryPlan, fieldsByTableId: Record<string, Field[]>): Set<string> => {
  const refs = new Set<string>();
  const addRef = (ref: string) => {
    refs.add(normalizeRefKey(ref));
    const qualified = parseQualifiedIdentifierRef(ref);
    if (qualified) refs.add(normalizeRefKey(qualified.ref));
  };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (key === "fieldId" && typeof item === "string") addRef(item);
        if (key === "expression" && typeof item === "string") {
          const parsed = parseFormula(item, { scopedRefs: true });
          if (parsed.ok) for (const ref of collectFieldRefs(parsed.ast)) addRef(ref);
        }
        visit(item);
      }
    }
  };
  visit(plan);
  const referenced = Object.values(fieldsByTableId)
    .flat()
    .filter((field) => !field.deletedAt && [field.id, field.shortId, field.name].some((key) => refs.has(normalizeRefKey(key))))
    .map((field) => field.id);
  return dslQueryReferencedFieldIds(plan, fieldsByTableId, referenced);
};
