import type { RecordQuery, SearchSpec, SortSpec } from "../contracts";
import { filterToGqlWhere, recordMetaToGqlWhere } from "./record-query-source-filters";
import { type ConvertResult, unsupported } from "./record-query-source-types";
import { gqlAliasKey, gqlFieldRef, gqlSourceRef, gqlStringLiteral, isGqlAlias } from "./source-format";

const computedRef = (expression: string) => `formula(${expression.trim()})`;

const computedColumnAlias = (column: NonNullable<RecordQuery["columns"]>[number], index: number, used: Set<string>): string => {
  const source = "id" in column ? column.id : `computed_${index}`;
  const base = `__${source}`.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 64);
  const candidates = [base, `__computed_${index}`];
  for (const candidate of candidates) {
    if (isGqlAlias(candidate) && !used.has(gqlAliasKey(candidate))) {
      used.add(gqlAliasKey(candidate));
      return candidate;
    }
  }
  let suffix = 1;
  while (true) {
    const candidate = `__computed_${index}_${suffix}`;
    if (isGqlAlias(candidate) && !used.has(gqlAliasKey(candidate))) {
      used.add(gqlAliasKey(candidate));
      return candidate;
    }
    suffix++;
  }
};

const recordSortRef = (key: "createdAt" | "updatedAt" | "deletedAt") => `record.${key}`;

const sortTarget = (sort: SortSpec): string | null => ("fieldId" in sort ? gqlFieldRef(sort.fieldId) : recordSortRef(sort.key));

const sortToGql = (sort: RecordQuery["sort"]): ConvertResult | undefined => {
  if (!sort || sort.length === 0) return undefined;
  const parts: string[] = [];
  for (const item of sort) {
    const target = sortTarget(item);
    if (!target) return unsupported("record metadata sorting is only available in direct GQL for now");
    const nulls = item.nullsFirst === undefined ? "" : item.nullsFirst ? " nulls first" : " nulls last";
    parts.push(`${target} ${item.direction ?? "asc"}${nulls}`);
  }
  return { ok: true, source: parts.join(", ") };
};

const columnsToGql = (columns: RecordQuery["columns"]): ConvertResult | undefined => {
  if (!columns || columns.length === 0) return undefined;
  const parts: string[] = [];
  const usedComputedAliases = new Set<string>();
  for (const [index, column] of columns.entries()) {
    if (!("fieldId" in column)) {
      const alias = computedColumnAlias(column, index, usedComputedAliases);
      parts.push(`${computedRef(column.expression)} as ${alias}`);
      continue;
    }
    parts.push(gqlFieldRef(column.fieldId));
  }
  return { ok: true, source: parts.join(", ") };
};

const groupByToGql = (groupBy: RecordQuery["groupBy"]): ConvertResult | undefined => {
  if (!groupBy || groupBy.length === 0) return undefined;
  const parts = groupBy.map((group) => `${gqlFieldRef(group.fieldId)}${group.granularity ? ` by ${group.granularity}` : ""}`);
  return { ok: true, source: parts.join(", ") };
};

const aggregationAlias = (aggregation: NonNullable<RecordQuery["aggregations"]>[number]): ConvertResult => {
  const label =
    aggregation.label?.trim() ??
    (aggregation.fieldId === "*" && aggregation.agg === "count"
      ? "rows"
      : `${aggregation.agg}_${aggregation.fieldId.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 24)}`);
  if (!isGqlAlias(label)) return unsupported(`aggregation label "${label}" is not a valid GQL alias`);
  return { ok: true, source: label };
};

const aggregationsToGql = (aggregations: RecordQuery["aggregations"]): ConvertResult | undefined => {
  if (!aggregations || aggregations.length === 0) return undefined;
  const parts: string[] = [];
  for (const aggregation of aggregations) {
    const alias = aggregationAlias(aggregation);
    if (!alias.ok) return alias;
    const arg = aggregation.fieldId === "*" ? "*" : gqlFieldRef(aggregation.fieldId);
    parts.push(`${aggregation.agg}(${arg}) as ${alias.source}`);
  }
  return { ok: true, source: parts.join(", ") };
};

const groupedSortToGql = (query: RecordQuery): ConvertResult | undefined => {
  const parts: string[] = [];
  for (const item of query.groupSort ?? []) {
    const match = (query.aggregations ?? []).find((aggregation) => aggregation.fieldId === item.fieldId && aggregation.agg === item.agg);
    if (!match) return unsupported(`group sort ${item.agg}(${item.fieldId}) needs a matching aggregation`);
    const alias = aggregationAlias(match);
    if (!alias.ok) return alias;
    const nulls = item.nullsFirst === undefined ? "" : item.nullsFirst ? " nulls first" : " nulls last";
    parts.push(`${alias.source} ${item.direction ?? "asc"}${nulls}`);
  }
  for (const group of query.groupBy ?? []) {
    if (group.direction || group.nullsFirst !== undefined) {
      const nulls = group.nullsFirst === undefined ? "" : group.nullsFirst ? " nulls first" : " nulls last";
      parts.push(`${gqlFieldRef(group.fieldId)} ${group.direction ?? "asc"}${nulls}`);
    }
  }
  const rowSort = sortToGql(query.sort);
  if (rowSort) {
    if (!rowSort.ok) return rowSort;
    parts.push(rowSort.source);
  }
  return parts.length > 0 ? { ok: true, source: parts.join(", ") } : undefined;
};

const searchToGql = (search: SearchSpec | undefined): string | undefined => {
  if (!search?.q.trim()) return undefined;
  const fields = search.fieldIds?.length ? ` in ${search.fieldIds.map(gqlFieldRef).join(", ")}` : "";
  return `${gqlStringLiteral(search.q.trim())}${fields}`;
};

export const simpleQueryToGqlSource = (args: { tableId: string; query: RecordQuery }): ConvertResult => {
  if ((args.query.aggregations?.length ?? 0) > 0 && (args.query.groupBy?.length ?? 0) === 0) {
    return unsupported("table footer aggregations are not part of row GQL source; use a direct GQL aggregate query");
  }

  const lines = [`from ${gqlSourceRef("table", args.tableId)}`];
  const columns = columnsToGql(args.query.columns);
  if (columns) {
    if (!columns.ok) return columns;
    lines.push(`select ${columns.source}`);
  }
  const fieldWhere = filterToGqlWhere(args.query.filter);
  const recordWhere = recordMetaToGqlWhere(args.query.recordMeta);
  const whereParts: string[] = [];
  for (const where of [fieldWhere, recordWhere]) {
    if (where) {
      if (!where.ok) return where;
      whereParts.push(where.source);
    }
  }
  if (whereParts.length > 0)
    lines.push(`where ${whereParts.length === 1 ? whereParts[0] : whereParts.map((part) => `(${part})`).join(" and ")}`);
  const groupBy = groupByToGql(args.query.groupBy);
  if (groupBy) {
    if (!groupBy.ok) return groupBy;
    lines.push(`group by ${groupBy.source}`);
  }
  const aggregations = aggregationsToGql(args.query.aggregations);
  if (aggregations) {
    if (!aggregations.ok) return aggregations;
    lines.push(`aggregate ${aggregations.source}`);
  }
  const sort = groupedSortToGql(args.query);
  if (sort) {
    if (!sort.ok) return sort;
    lines.push(`sort ${sort.source}`);
  }
  const search = searchToGql(args.query.search);
  if (search) lines.push(`search ${search}`);
  if (args.query.deletedOnly) lines.push("deleted only");
  else if (args.query.includeDeleted) lines.push("include deleted");
  if (args.query.limit) lines.push(`limit ${args.query.limit}`);
  return { ok: true, source: lines.join("\n") };
};

export { filterToGqlWhere };
