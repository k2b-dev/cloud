import type { RecordMetaQuery, RecordQuery } from "../contracts";
import { type ConvertResult, unsupported } from "./record-query-source-types";
import { gqlFieldRef, gqlLiteralFromUnknown, gqlLiteralListFromUnknown } from "./source-format";

const recordMetaRef = (key: "createdBy" | "updatedBy" | "deletedBy") => `record.${key}`;

export const recordMetaToGqlWhere = (meta: RecordMetaQuery | undefined): ConvertResult | undefined => {
  const parts: string[] = [];
  const recordIds = [...new Set(meta?.ids ?? [])].filter(Boolean);
  if (recordIds.length > 0) {
    const values = recordIds.map(gqlLiteralFromUnknown);
    if (!values.every((item): item is string => item !== null)) return unsupported("record.id needs literal record ids");
    parts.push(values.length === 1 ? `record.id = ${values[0]}` : `oneof(record.id, ${values.join(", ")})`);
  }
  const finalizationStates = [...new Set(meta?.finalizationStates ?? [])];
  if (finalizationStates.length > 0) {
    const values = finalizationStates.map(gqlLiteralFromUnknown);
    if (!values.every((item): item is string => item !== null)) return unsupported("record.finalizationState needs literal states");
    parts.push(values.length === 1 ? `record.finalizationState = ${values[0]}` : `oneof(record.finalizationState, ${values.join(", ")})`);
  }
  for (const key of ["createdBy", "updatedBy", "deletedBy"] as const) {
    const ids = [...new Set(meta?.users?.[key] ?? [])].filter(Boolean);
    if (ids.length === 0) continue;
    const values = ids.map(gqlLiteralFromUnknown);
    if (!values.every((item): item is string => item !== null)) return unsupported(`record.${key} needs literal user ids`);
    parts.push(values.length === 1 ? `${recordMetaRef(key)} = ${values[0]}` : `oneof(${recordMetaRef(key)}, ${values.join(", ")})`);
  }
  return parts.length > 0 ? { ok: true, source: parts.length === 1 ? parts[0]! : `(${parts.join(" and ")})` } : undefined;
};

const filterLeafToGql = (leaf: { fieldId: string; op: string; value?: unknown; caseInsensitive?: boolean }): ConvertResult => {
  const ref = gqlFieldRef(leaf.fieldId);
  if (leaf.op === "isEmpty") return { ok: true, source: `${ref} = null` };
  if (leaf.op === "isNotEmpty") return { ok: true, source: `${ref} != null` };
  return listPredicateToGql(leaf, ref) ?? scalarPredicateToGql(leaf, ref) ?? textPredicateToGql(leaf, ref) ?? datePredicateToGql(leaf, ref);
};

const listPredicateToGql = (leaf: { op: string; value?: unknown }, ref: string): ConvertResult | undefined => {
  if (leaf.op === "containsAny" || leaf.op === "notContainsAny" || leaf.op === "isAnyOf" || leaf.op === "isNoneOf") {
    const values = gqlLiteralListFromUnknown(leaf.value);
    if (!values) return unsupported(`operator ${leaf.op} needs at least one literal value`);
    const fn = leaf.op === "notContainsAny" || leaf.op === "isNoneOf" ? "noneof" : "oneof";
    return { ok: true, source: `${fn}(${ref}, ${values.join(", ")})` };
  }
  return undefined;
};

const scalarPredicateToGql = (leaf: { op: string; value?: unknown }, ref: string): ConvertResult | undefined => {
  if (leaf.op === "is" || leaf.op === "isNot") {
    const value = gqlLiteralFromUnknown(leaf.value);
    if (value === null) return unsupported(`operator ${leaf.op} needs a literal value`);
    return { ok: true, source: `${ref} ${leaf.op === "is" ? "=" : "!="} ${value}` };
  }

  if (["=", "!=", "<", "<=", ">", ">=", "equals", "notEquals", "before", "after", "onOrBefore", "onOrAfter"].includes(leaf.op)) {
    const value = gqlLiteralFromUnknown(leaf.value);
    if (value === null) return unsupported(`operator ${leaf.op} needs a literal value`);
    const op =
      leaf.op === "equals"
        ? "="
        : leaf.op === "notEquals"
          ? "!="
          : leaf.op === "before"
            ? "<"
            : leaf.op === "after"
              ? ">"
              : leaf.op === "onOrBefore"
                ? "<="
                : leaf.op === "onOrAfter"
                  ? ">="
                  : leaf.op;
    return { ok: true, source: `${ref} ${op} ${value}` };
  }

  if (leaf.op === "between") {
    if (!Array.isArray(leaf.value) || leaf.value.length !== 2) return unsupported("between needs exactly two literal values");
    const lower = gqlLiteralFromUnknown(leaf.value[0]);
    const upper = gqlLiteralFromUnknown(leaf.value[1]);
    if (lower === null || upper === null) return unsupported("between bounds must be literals");
    return { ok: true, source: `(${ref} >= ${lower} and ${ref} <= ${upper})` };
  }
  return undefined;
};

const textPredicateToGql = (leaf: { op: string; value?: unknown; caseInsensitive?: boolean }, ref: string): ConvertResult | undefined => {
  if (leaf.op === "contains" || leaf.op === "startsWith" || leaf.op === "endsWith") {
    const value = gqlLiteralFromUnknown(leaf.value);
    if (value === null) return unsupported(`operator ${leaf.op} needs a text value`);
    const fn =
      leaf.caseInsensitive && leaf.op === "contains"
        ? "icontains"
        : leaf.caseInsensitive && leaf.op === "startsWith"
          ? "istartswith"
          : leaf.caseInsensitive && leaf.op === "endsWith"
            ? "iendswith"
            : leaf.op === "startsWith"
              ? "startswith"
              : leaf.op === "endsWith"
                ? "endswith"
                : "contains";
    return { ok: true, source: `${fn}(${ref}, ${value})` };
  }

  if (leaf.op === "notContains") {
    const value = gqlLiteralFromUnknown(leaf.value);
    if (value === null) return unsupported("notContains needs a text value");
    return { ok: true, source: `not contains(${ref}, ${value})` };
  }
  return undefined;
};

const datePredicateToGql = (leaf: { op: string; value?: unknown }, ref: string): ConvertResult => {
  if (leaf.op === "today") return { ok: true, source: `${ref} = TODAY()` };
  if (leaf.op === "lastNDays") {
    const value = gqlLiteralFromUnknown(typeof leaf.value === "number" ? -leaf.value : null);
    if (value === null) return unsupported("lastNDays needs a number");
    return { ok: true, source: `${ref} >= DATEADD(TODAY(), ${value}, 'days')` };
  }

  return unsupported(`operator ${leaf.op} is only available in direct GQL`);
};

export const filterToGqlWhere = (filter: RecordQuery["filter"]): ConvertResult | undefined => {
  if (!filter) return undefined;
  if ("filters" in filter && Array.isArray((filter as { filters?: unknown }).filters)) {
    const group = filter as { op: "AND" | "OR"; filters: NonNullable<RecordQuery["filter"]>[] };
    if (group.filters.length === 0) return undefined;
    const parts: string[] = [];
    for (const item of group.filters) {
      const converted = filterToGqlWhere(item);
      if (!converted) continue;
      if (!converted.ok) return converted;
      parts.push(converted.source);
    }
    if (parts.length === 0) return undefined;
    const joiner = group.op === "OR" ? " or " : " and ";
    return { ok: true, source: parts.length === 1 ? parts[0]! : `(${parts.join(joiner)})` };
  }
  return filterLeafToGql(filter as { fieldId: string; op: string; value?: unknown; caseInsensitive?: boolean });
};
