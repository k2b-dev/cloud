import type { GroupSortSpec, RecordQuery } from "../contracts";
import { normalizeRefKey } from "../ref-syntax";
import { derivedColumnByRef, type DslDerivedViewColumn } from "./resolver-derived-columns";
import { isGroupable } from "../service/group-compiler";
import type { Field } from "../service/types";
import { type DslFormulaAggregation, type DslResolvedSqlAggregation, groupAggForDsl } from "./resolver-aggregates";
import { type DslResolverDiagnostic, diagnostic, isResolverDiagnostic as isDiagnostic } from "./resolver-diagnostics";
import {
  fieldAliasId,
  fieldByRef,
  fieldByRefMap,
  isBaseScope,
  joinScopeByAlias,
  relationOutputDiagnostic,
  resolveScopedField,
  type Scope,
  setHasAlias,
} from "./resolver-scope";
import { isRecordScopedRef, recordMetaSortKeyForRef } from "./resolver-where";
import type { DslGroupItem, DslQualifiedRef, DslSortItem } from "./types";

export type DslResolvedSqlGroupBy = {
  fieldId: string;
  tableId: string;
  joinAlias?: string;
  label?: string;
  granularity?: "day" | "week" | "month" | "quarter" | "year";
  direction?: "asc" | "desc";
  nullsFirst?: boolean;
};

export type DslResolvedSqlGroupSort = GroupSortSpec & {
  nullsFirst?: boolean;
};

export type DslResolvedSqlSort =
  | { kind: "summary"; index: number; column: DslDerivedViewColumn; direction: "asc" | "desc"; nullsFirst?: boolean }
  | {
      kind: "record";
      key: "createdAt" | "updatedAt" | "deletedAt";
      direction: "asc" | "desc";
      nullsFirst?: boolean;
    }
  | {
      kind: "field";
      fieldId: string;
      direction: "asc" | "desc";
      nullsFirst?: boolean;
    }
  | {
      kind: "computed";
      alias: string;
      direction: "asc" | "desc";
      nullsFirst?: boolean;
    }
  | {
      kind: "joined";
      alias: string;
      direction: "asc" | "desc";
      nullsFirst?: boolean;
    }
  | {
      kind: "joinedField";
      joinAlias: string;
      tableId: string;
      fieldId: string;
      direction: "asc" | "desc";
      nullsFirst?: boolean;
    };

export const isAliasSortTarget = (target: DslSortItem["target"]): target is Extract<DslSortItem["target"], { kind: "alias" }> =>
  "kind" in target && target.kind === "alias";

export const isQualifiedSortTarget = (target: DslSortItem["target"]): target is DslQualifiedRef => !isAliasSortTarget(target);

const sortAlias = (target: DslSortItem["target"], scope: Scope): string | null => {
  if (isAliasSortTarget(target)) return target.alias;
  if (target.scope) return null;
  const ref = target.ref;
  if (fieldAliasId(scope, ref) || setHasAlias(scope.joinedAliases, ref) || setHasAlias(scope.computedAliases, ref)) return ref;
  return null;
};

export const resolveGroupBy = (
  items: DslGroupItem[],
  scope: Scope,
  options: { joinedQuery: boolean },
): { viewGroupBy: NonNullable<RecordQuery["groupBy"]>; sqlGroupBy: DslResolvedSqlGroupBy[] } | DslResolverDiagnostic => {
  const viewGroupBy: NonNullable<RecordQuery["groupBy"]> = [];
  const sqlGroupBy: DslResolvedSqlGroupBy[] = [];
  for (const item of items) {
    const resolved = resolveScopedField(scope, item.field);
    if (isDiagnostic(resolved)) return resolved;
    const { field } = resolved;
    const relationDiagnostic = relationOutputDiagnostic(field, scope);
    if (relationDiagnostic) return relationDiagnostic;
    const joinedComputedGroup =
      options.joinedQuery &&
      Boolean(resolved.joinAlias) &&
      (field.type === "formula" || field.type === "lookup" || field.type === "rollup");
    const baseComputedGroup = !resolved.joinAlias && (field.type === "formula" || field.type === "lookup" || field.type === "rollup");
    if (!joinedComputedGroup && !baseComputedGroup && !isGroupable(field))
      return diagnostic(`field "${field.name}" (type "${field.type}") is not groupable`, item.field.span ?? item.span);
    if (item.granularity && field.type !== "date") {
      return diagnostic(`granularity "${item.granularity}" is only valid on date fields, not "${field.type}"`, item.span);
    }
    if (!resolved.joinAlias && !baseComputedGroup) {
      viewGroupBy.push({ fieldId: field.id, ...(item.granularity ? { granularity: item.granularity } : {}) });
    }
    sqlGroupBy.push({
      fieldId: field.id,
      tableId: resolved.tableId,
      label: item.granularity ? `${field.name} (${item.granularity})` : field.name,
      ...(resolved.joinAlias ? { joinAlias: resolved.joinAlias } : {}),
      ...(item.granularity ? { granularity: item.granularity } : {}),
    });
  }
  return { viewGroupBy, sqlGroupBy };
};

export const resolveQueryPlanSort = (
  items: DslSortItem[],
  scope: Scope,
): { viewSort: NonNullable<RecordQuery["sort"]>; sqlSort: DslResolvedSqlSort[] } | DslResolverDiagnostic => {
  const viewSort: NonNullable<RecordQuery["sort"]> = [];
  const sqlSort: DslResolvedSqlSort[] = [];
  for (const item of items) {
    const nulls = item.nullsFirst === undefined ? {} : { nullsFirst: item.nullsFirst };
    const target = item.target;
    const alias = sortAlias(target, scope);
    if (alias) {
      const fieldId = fieldAliasId(scope, alias);
      if (fieldId) {
        viewSort.push({ fieldId, direction: item.direction, ...nulls });
        sqlSort.push({ kind: "field", fieldId, direction: item.direction, ...nulls });
        continue;
      }
      if (setHasAlias(scope.joinedAliases, alias)) {
        sqlSort.push({ kind: "joined", alias, direction: item.direction, ...nulls });
        continue;
      }
      if (setHasAlias(scope.computedAliases, alias)) {
        sqlSort.push({ kind: "computed", alias, direction: item.direction, ...nulls });
        continue;
      }
      return diagnostic(`unknown sort alias "${alias}"`, item.span);
    }
    if (!isQualifiedSortTarget(target)) return diagnostic(`unknown sort alias "${target.alias}"`, item.span);
    const recordSortKey = recordMetaSortKeyForRef(target);
    if (recordSortKey) {
      viewSort.push({ source: "record", key: recordSortKey, direction: item.direction, ...nulls });
      sqlSort.push({ kind: "record", key: recordSortKey, direction: item.direction, ...nulls });
      continue;
    }
    if (isRecordScopedRef(target)) {
      return diagnostic(`record.${target.ref} is not sortable; use record.createdAt, record.updatedAt, or record.deletedAt`, target.span);
    }
    if (isBaseScope(scope, target.scope)) {
      const field = fieldByRef(scope, target.ref, target.span);
      if (isDiagnostic(field)) return field;
      viewSort.push({ fieldId: field.id, direction: item.direction, ...nulls });
      sqlSort.push({ kind: "field", fieldId: field.id, direction: item.direction, ...nulls });
      continue;
    }
    if (target.scope) {
      const summary = scope.summaryJoins.get(normalizeRefKey(target.scope));
      if (summary) {
        const column = derivedColumnByRef(summary.columns, target.ref, target.span);
        if (isDiagnostic(column)) return column;
        sqlSort.push({ kind: "summary", index: [...scope.summaryJoins.values()].indexOf(summary), column, direction: item.direction, ...nulls });
        continue;
      }
      const join = joinScopeByAlias(scope, target.scope, target.span);
      if (isDiagnostic(join)) return join;
      const field = fieldByRefMap(join.byRef, target.ref, `${target.scope}."${target.ref}"`, target.span);
      if (isDiagnostic(field)) return field;
      sqlSort.push({
        kind: "joinedField",
        joinAlias: join.alias,
        tableId: join.tableId,
        fieldId: field.id,
        direction: item.direction,
        ...nulls,
      });
      continue;
    }
    const field = fieldByRef(scope, target.ref, target.span);
    if (isDiagnostic(field)) return field;
    viewSort.push({ fieldId: field.id, direction: item.direction, ...nulls });
    sqlSort.push({ kind: "field", fieldId: field.id, direction: item.direction, ...nulls });
  }
  return { viewSort, sqlSort };
};

type ResolvedGroupedSort = {
  groupBy: NonNullable<RecordQuery["groupBy"]>;
  groupSort: NonNullable<RecordQuery["groupSort"]>;
  formulaGroupSort: GroupSortSpec[];
};

export const resolveGroupedQueryPlanSort = (
  items: DslSortItem[],
  scope: Scope,
  groupBy: NonNullable<RecordQuery["groupBy"]>,
  aggregations: NonNullable<RecordQuery["aggregations"]>,
  formulaAggregations: DslFormulaAggregation[],
): ResolvedGroupedSort | DslResolverDiagnostic => {
  const nextGroupBy = groupBy.map((item) => ({ ...item }));
  const groupSort: NonNullable<RecordQuery["groupSort"]> = [];
  const formulaGroupSort: GroupSortSpec[] = [];

  for (const item of items) {
    const nulls = item.nullsFirst === undefined ? {} : { nullsFirst: item.nullsFirst };
    const target = item.target;
    const implicitAggregateAlias =
      isQualifiedSortTarget(target) && !target.scope
        ? aggregations.some((candidate) => candidate.label && normalizeRefKey(candidate.label) === normalizeRefKey(target.ref)) ||
          formulaAggregations.some((candidate) => normalizeRefKey(candidate.ref) === normalizeRefKey(target.ref))
          ? target.ref
          : null
        : null;
    const alias = sortAlias(target, scope) ?? implicitAggregateAlias;
    if (alias) {
      const key = normalizeRefKey(alias);
      const aggregate = aggregations.find((candidate) => candidate.label && normalizeRefKey(candidate.label) === key);
      if (aggregate) {
        const agg = groupAggForDsl(aggregate.agg);
        if (isDiagnostic(agg)) return agg;
        groupSort.push({ fieldId: aggregate.fieldId, agg, direction: item.direction, ...nulls });
        continue;
      }

      const formulaAggregate = formulaAggregations.find((candidate) => normalizeRefKey(candidate.ref) === key);
      if (formulaAggregate) {
        formulaGroupSort.push({ fieldId: formulaAggregate.id, agg: formulaAggregate.agg, direction: item.direction, ...nulls });
        continue;
      }
      if (fieldAliasId(scope, alias) || setHasAlias(scope.computedAliases, alias) || setHasAlias(scope.joinedAliases, alias)) {
        return diagnostic(`grouped sort alias "${alias}" must be a group field or aggregate alias`, item.span);
      }
      return diagnostic(`unknown sort alias "${alias}"`, item.span);
    }

    if (!isQualifiedSortTarget(target)) return diagnostic(`unknown sort alias "${target.alias}"`, item.span);
    if (target.scope && !isBaseScope(scope, target.scope))
      return diagnostic("scoped sort fields require join support", target.span ?? item.span);
    const field = fieldByRef(scope, target.ref, target.span);
    if (isDiagnostic(field)) return field;
    const groupItem = nextGroupBy.find((candidate) => candidate.fieldId === field.id);
    if (!groupItem) return diagnostic(`grouped sort field "${field.name}" must also be in group by`, target.span ?? item.span);
    groupItem.direction = item.direction;
    if (item.nullsFirst !== undefined) groupItem.nullsFirst = item.nullsFirst;
  }

  return { groupBy: nextGroupBy, groupSort, formulaGroupSort };
};

type ResolvedSqlGroupedSort = {
  sqlGroupBy: DslResolvedSqlGroupBy[];
  sqlGroupSort: DslResolvedSqlGroupSort[];
};

const sameResolvedSqlGroupField = (
  group: DslResolvedSqlGroupBy,
  resolved: { field: Field; tableId: string; joinAlias?: string },
): boolean =>
  group.fieldId === resolved.field.id &&
  group.tableId === resolved.tableId &&
  normalizeRefKey(group.joinAlias ?? "") === normalizeRefKey(resolved.joinAlias ?? "");

export const resolveSqlGroupedQueryPlanSort = (
  items: DslSortItem[],
  scope: Scope,
  groupBy: DslResolvedSqlGroupBy[],
  aggregations: DslResolvedSqlAggregation[],
  formulaAggregations: DslFormulaAggregation[],
): ResolvedSqlGroupedSort | DslResolverDiagnostic => {
  const nextGroupBy = groupBy.map((item) => ({ ...item }));
  const sqlGroupSort: DslResolvedSqlGroupSort[] = [];

  for (const item of items) {
    const target = item.target;
    const implicitAggregateAlias =
      isQualifiedSortTarget(target) && !target.scope
        ? aggregations.some((candidate) => candidate.label && normalizeRefKey(candidate.label) === normalizeRefKey(target.ref)) ||
          formulaAggregations.some((candidate) => normalizeRefKey(candidate.ref) === normalizeRefKey(target.ref))
          ? target.ref
          : null
        : null;
    const alias = sortAlias(target, scope) ?? implicitAggregateAlias;
    if (alias) {
      const key = normalizeRefKey(alias);
      const aggregate = aggregations.find((candidate) => candidate.label && normalizeRefKey(candidate.label) === key);
      if (aggregate) {
        const agg = groupAggForDsl(aggregate.agg);
        if (isDiagnostic(agg)) return agg;
        sqlGroupSort.push({
          fieldId: aggregate.fieldId,
          agg,
          direction: item.direction,
          ...(item.nullsFirst !== undefined ? { nullsFirst: item.nullsFirst } : {}),
        });
        continue;
      }
      const formulaAggregate = formulaAggregations.find((candidate) => normalizeRefKey(candidate.ref) === key);
      if (formulaAggregate) {
        sqlGroupSort.push({
          fieldId: formulaAggregate.id,
          agg: formulaAggregate.agg,
          direction: item.direction,
          ...(item.nullsFirst !== undefined ? { nullsFirst: item.nullsFirst } : {}),
        });
        continue;
      }
      if (fieldAliasId(scope, alias) || setHasAlias(scope.computedAliases, alias) || setHasAlias(scope.joinedAliases, alias)) {
        return diagnostic(`grouped sort alias "${alias}" must be a group field or aggregate alias`, item.span);
      }
      return diagnostic(`unknown sort alias "${alias}"`, item.span);
    }

    if (!isQualifiedSortTarget(target)) return diagnostic(`unknown sort alias "${target.alias}"`, item.span);
    const resolved = resolveScopedField(scope, target);
    if (isDiagnostic(resolved)) return resolved;
    const groupItem = nextGroupBy.find((candidate) => sameResolvedSqlGroupField(candidate, resolved));
    if (!groupItem) return diagnostic(`grouped sort field "${resolved.field.name}" must also be in group by`, target.span ?? item.span);
    groupItem.direction = item.direction;
    if (item.nullsFirst !== undefined) groupItem.nullsFirst = item.nullsFirst;
  }

  return { sqlGroupBy: nextGroupBy, sqlGroupSort };
};
