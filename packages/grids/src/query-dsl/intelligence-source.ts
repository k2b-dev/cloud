import type { DslQueryCompletionItem, DslQueryTextRange } from "../contracts";
import { formatIdentifierRef, normalizeRefKey, parseIdentifierRef, parseQualifiedIdentifierRef } from "../ref-syntax";
import { type AggregateKind, isFieldAggregatable } from "../service/aggregate-capabilities";
import { isGroupable } from "../service/group-compiler";
import { filterSearchableFields } from "../service/search";
import type { Field } from "../service/types";
import { type CompletionPurpose, type CompletionRequest, completionItem, isDiagnostic, rankItems, uniqueItems } from "./intelligence-core";
import { QUALIFIED_REF_RE, SOURCE_REF_RE } from "./intelligence-grammar";
import { type DslDerivedViewColumn, type DslResolverContext, type DslViewSource, derivedViewColumns } from "./resolver";

type SourceScope = {
  alias?: string;
  tableId: string;
  fields: Field[];
  derivedColumns?: DslDerivedViewColumn[];
};

type JoinScope = {
  alias: string;
  tableId: string;
  fields: Field[];
  derivedColumns?: DslDerivedViewColumn[];
};

type ResolvedSource = SourceScope & {
  sourceKind: "table" | "view" | "current";
};

const aliveFields = (fields: Field[]): Field[] => fields.filter((field) => !field.deletedAt).sort((a, b) => a.position - b.position);

export const parseSourceReference = (raw: string): string | null => parseIdentifierRef(raw.trim());

const sourceMatches = (source: { id: string; shortId: string; name: string }, ref: string): boolean => {
  const key = normalizeRefKey(ref);
  return normalizeRefKey(source.shortId) === key || normalizeRefKey(source.name) === key;
};

const resolveView = (ctx: DslResolverContext, ref: string): DslViewSource | undefined =>
  (ctx.views ?? []).find((view) => sourceMatches(view, ref));

const viewIsDerived = (view: DslViewSource): boolean => (view.query.groupBy?.length ?? 0) > 0 || (view.query.aggregations?.length ?? 0) > 0;

const derivedColumnsForView = (ctx: DslResolverContext, view: DslViewSource): DslDerivedViewColumn[] | undefined => {
  if (!viewIsDerived(view)) return undefined;
  const columns = derivedViewColumns(view.query, aliveFields(ctx.fieldsByTableId[view.tableId] ?? []), view.summaryFormulaAggregations);
  if (isDiagnostic(columns)) return undefined;
  return columns;
};

const explicitSource = (query: string): { kind: "table" | "view"; ref: string; alias?: string } | undefined => {
  const re = new RegExp(String.raw`\bfrom\s+(table|view)\s+(${SOURCE_REF_RE})(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?`, "gi");
  let found: { kind: "table" | "view"; ref: string; alias?: string } | undefined;
  for (const match of query.matchAll(re)) {
    const ref = match[2] ? parseSourceReference(match[2]) : null;
    if (!ref) continue;
    found = {
      kind: match[1]!.toLowerCase() as "table" | "view",
      ref,
      ...(match[3] ? { alias: match[3] } : {}),
    };
  }
  return found;
};

const sourceFromCurrentSource = (
  ctx: DslResolverContext,
  currentSource: CompletionRequest["currentSource"],
): ResolvedSource | undefined => {
  if (currentSource?.kind === "table") {
    const table = ctx.tables.find((item) => item.id === currentSource.tableId);
    if (!table) return undefined;
    return {
      sourceKind: "current",
      tableId: table.id,
      fields: aliveFields(ctx.fieldsByTableId[table.id] ?? []),
    };
  }
  if (currentSource?.kind === "view") {
    const view = (ctx.views ?? []).find((item) => item.id === currentSource.viewId);
    if (!view) return undefined;
    const derivedColumns = derivedColumnsForView(ctx, view);
    return {
      sourceKind: "view",
      tableId: view.tableId,
      fields: aliveFields(ctx.fieldsByTableId[view.tableId] ?? []),
      ...(derivedColumns ? { derivedColumns } : {}),
    };
  }
  return undefined;
};

const resolveSource = (
  ctx: DslResolverContext,
  query: string,
  currentSource: CompletionRequest["currentSource"],
): ResolvedSource | undefined => {
  const from = explicitSource(query);
  if (from?.kind === "table") {
    const table = ctx.tables.find((item) => sourceMatches(item, from.ref));
    if (!table) return undefined;
    return {
      sourceKind: "table",
      tableId: table.id,
      fields: aliveFields(ctx.fieldsByTableId[table.id] ?? []),
      ...(from.alias ? { alias: from.alias } : {}),
    };
  }
  if (from?.kind === "view") {
    const view = resolveView(ctx, from.ref);
    if (!view) return undefined;
    const derivedColumns = derivedColumnsForView(ctx, view);
    return {
      sourceKind: "view",
      tableId: view.tableId,
      fields: aliveFields(ctx.fieldsByTableId[view.tableId] ?? []),
      ...(from.alias ? { alias: from.alias } : {}),
      ...(derivedColumns ? { derivedColumns } : {}),
    };
  }
  const current = sourceFromCurrentSource(ctx, currentSource);
  if (current) return current;
  if (!ctx.currentTable) return undefined;
  return {
    sourceKind: "current",
    tableId: ctx.currentTable.id,
    fields: aliveFields(ctx.fieldsByTableId[ctx.currentTable.id] ?? []),
  };
};

const collectJoinScopes = (ctx: DslResolverContext, query: string): JoinScope[] => {
  const re = new RegExp(String.raw`\b(?:left\s+)?join\s+(table|view)\s+(${SOURCE_REF_RE})\s+as\s+([A-Za-z_][A-Za-z0-9_]*)`, "gi");
  const joins: JoinScope[] = [];
  const seen = new Set<string>();
  for (const match of query.matchAll(re)) {
    const ref = match[2] ? parseSourceReference(match[2]) : null;
    const alias = match[3];
    if (!ref || !alias) continue;
    if (match[1]!.toLowerCase() === "view") {
      const view = resolveView(ctx, ref);
      const derivedColumns = view && derivedColumnsForView(ctx, view);
      if (!view || !derivedColumns || !ctx.tables.some((table) => table.id === view.tableId)) continue;
      const key = normalizeRefKey(alias);
      if (seen.has(key)) continue;
      seen.add(key);
      joins.push({ alias, tableId: view.tableId, fields: [], derivedColumns });
      continue;
    }
    const table = ctx.tables.find((item) => sourceMatches(item, ref));
    if (!table) continue;
    const key = normalizeRefKey(alias);
    if (seen.has(key)) continue;
    seen.add(key);
    joins.push({ alias, tableId: table.id, fields: aliveFields(ctx.fieldsByTableId[table.id] ?? []) });
  }
  return joins;
};

const relationTargetReadable = (ctx: DslResolverContext, field: Field): boolean => {
  if (field.type !== "relation") return true;
  const targetTableId = (field.config as { targetTableId?: string }).targetTableId;
  return !targetTableId || ctx.tables.some((table) => table.id === targetTableId);
};

const fieldAllowedForPurpose = (ctx: DslResolverContext, field: Field, purpose: CompletionPurpose, aggregate?: AggregateKind): boolean => {
  if (field.deletedAt) return false;
  if ((purpose === "output" || purpose === "search") && !relationTargetReadable(ctx, field)) return false;
  if (purpose === "group") return isGroupable(field);
  if (purpose === "search") return filterSearchableFields([field]).length > 0;
  if (purpose === "aggregate") return aggregate ? isFieldAggregatable(field, aggregate, false) : true;
  return true;
};

const fieldItem = (range: DslQueryTextRange, field: Field, insertText: string, detailPrefix?: string): DslQueryCompletionItem =>
  completionItem(range, "field", field.name, insertText, `${detailPrefix ? `${detailPrefix} · ` : ""}${field.type} · ${field.shortId}`);

const pseudoIdItem = (range: DslQueryTextRange, insertText: string): DslQueryCompletionItem =>
  completionItem(range, "field", "id", insertText, "record id");

const columnAllowedForPurpose = (column: DslDerivedViewColumn, purpose: CompletionPurpose, aggregate?: AggregateKind): boolean => {
  if (purpose === "search") return column.sqlType !== "json";
  if (purpose === "aggregate") {
    if (!aggregate) return true;
    if (aggregate === "count" || aggregate === "countEmpty" || aggregate === "countUnique") return true;
    if (aggregate === "sum" || aggregate === "avg" || aggregate === "median") return column.sqlType === "numeric";
    if (aggregate === "earliest" || aggregate === "latest") return column.sqlType === "date" || column.sqlType === "datetime";
    return column.sqlType === "numeric" || column.sqlType === "date" || column.sqlType === "datetime" || column.sqlType === "text";
  }
  return column.sqlType !== "json";
};

const derivedColumnItem = (range: DslQueryTextRange, column: DslDerivedViewColumn, insertText?: string): DslQueryCompletionItem =>
  completionItem(range, "column", column.label, insertText ?? formatIdentifierRef(column.label), `${column.kind} · ${column.sqlType}`);

export const scopeBeforeToken = (query: string, range: DslQueryTextRange): string | undefined => {
  const before = query.slice(0, range.start);
  const match = before.match(/([A-Za-z_][A-Za-z0-9_]*)\.$/);
  return match?.[1];
};

export const fieldReferenceSuggestions = (
  ctx: DslResolverContext,
  query: string,
  range: DslQueryTextRange,
  purpose: CompletionPurpose,
  aggregate?: AggregateKind,
  currentSource?: CompletionRequest["currentSource"],
): DslQueryCompletionItem[] => {
  const source = resolveSource(ctx, query, currentSource);
  const joins = collectJoinScopes(ctx, query);
  const scope = scopeBeforeToken(query, range);
  const items: DslQueryCompletionItem[] = [];

  const pushFields = (fields: Field[], prefix?: string) => {
    for (const field of fields) {
      if (!fieldAllowedForPurpose(ctx, field, purpose, aggregate)) continue;
      const ref = formatIdentifierRef(field.name);
      items.push(fieldItem(range, field, prefix ? `${prefix}.${ref}` : ref, prefix));
    }
  };

  if (scope) {
    const join = joins.find((item) => normalizeRefKey(item.alias) === normalizeRefKey(scope));
    if (join) {
      if (join.derivedColumns)
        return rankItems(
          query,
          range,
          join.derivedColumns
            .filter((column) => (purpose === "join" ? column.kind === "group" : columnAllowedForPurpose(column, purpose, aggregate)))
            .map((column) => derivedColumnItem(range, column)),
        );
      if (purpose === "join") items.push(pseudoIdItem(range, "id"));
      pushFields(join.fields);
      return rankItems(query, range, uniqueItems(items));
    }
    if (source?.alias && normalizeRefKey(source.alias) === normalizeRefKey(scope) && !source.derivedColumns) {
      if (purpose === "join") items.push(pseudoIdItem(range, "id"));
      pushFields(source.fields);
      return rankItems(query, range, uniqueItems(items));
    }
    return [];
  }

  if (purpose === "join") items.push(pseudoIdItem(range, "id"));
  if (source?.derivedColumns) {
    for (const column of source.derivedColumns) {
      if (columnAllowedForPurpose(column, purpose, aggregate)) items.push(derivedColumnItem(range, column));
    }
  } else if (source) {
    pushFields(source.fields);
  }

  for (const join of joins) {
    if (join.derivedColumns) {
      for (const column of join.derivedColumns) {
        if (purpose === "join" ? column.kind === "group" : columnAllowedForPurpose(column, purpose, aggregate))
          items.push(derivedColumnItem(range, column, `${join.alias}.${formatIdentifierRef(column.label)}`));
      }
      continue;
    }
    for (const field of join.fields) {
      if (!fieldAllowedForPurpose(ctx, field, purpose, aggregate)) continue;
      const ref = `${join.alias}.${formatIdentifierRef(field.name)}`;
      items.push(fieldItem(range, field, ref, join.alias));
    }
  }

  return rankItems(query, range, uniqueItems(items));
};

export const sourceSuggestions = (
  ctx: DslResolverContext,
  query: string,
  range: DslQueryTextRange,
  kind: "table" | "view",
): DslQueryCompletionItem[] => {
  const items =
    kind === "table"
      ? ctx.tables.map((table) =>
          completionItem(range, "source", table.name, formatIdentifierRef(table.name), `table · ${table.shortId}`, [" "]),
        )
      : (ctx.views ?? []).map((view) =>
          completionItem(range, "source", view.name, formatIdentifierRef(view.name), `view · ${view.shortId}`, [" "]),
        );
  return rankItems(query, range, items);
};

export const sourceRefExists = (ctx: DslResolverContext, kind: "table" | "view", ref: string): boolean =>
  kind === "table" ? ctx.tables.some((table) => sourceMatches(table, ref)) : (ctx.views ?? []).some((view) => sourceMatches(view, ref));

export const defaultAliasForRef = (ref: string): string => {
  const alias = normalizeRefKey(ref)
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!alias) return "joined";
  return /^[a-z_]/.test(alias) ? alias : `joined_${alias}`;
};

export const defaultAggregateAlias = (fn: string, arg: string): string => {
  if (arg.trim() === "*") return `${fn.toLowerCase()}_rows`;
  return `${fn.toLowerCase()}_${defaultAliasForRef(arg)}`;
};

export const completedQualifiedRef = (input: string): { ref: string; tail: string } | null => {
  const match = input.match(new RegExp(String.raw`^\s*(${QUALIFIED_REF_RE})([\s\S]*)$`, "i"));
  const ref = match?.[1];
  if (!ref || !parseQualifiedIdentifierRef(ref)) return null;
  return { ref, tail: match[2] ?? "" };
};

export const groupRefSupportsGranularity = (
  ctx: DslResolverContext,
  query: string,
  rawRef: string,
  currentSource?: CompletionRequest["currentSource"],
): boolean => {
  const parsed = parseQualifiedIdentifierRef(rawRef.trim());
  if (!parsed) return false;

  const source = resolveSource(ctx, query, currentSource);
  const joins = collectJoinScopes(ctx, query);
  const isDateLike = (type: string | undefined, sqlType?: string) =>
    type === "date" || type === "datetime" || sqlType === "date" || sqlType === "datetime";

  if (parsed.scope) {
    const join = joins.find((item) => normalizeRefKey(item.alias) === normalizeRefKey(parsed.scope!));
    if (join) return isDateLike(join.fields.find((field) => sourceMatches(field, parsed.ref))?.type);
    if (source?.alias && normalizeRefKey(source.alias) === normalizeRefKey(parsed.scope) && !source.derivedColumns) {
      return isDateLike(source.fields.find((field) => sourceMatches(field, parsed.ref))?.type);
    }
    return false;
  }

  if (source?.derivedColumns) {
    const column = source.derivedColumns.find((item) =>
      [item.key, item.label, ...item.refs].some((ref) => normalizeRefKey(ref) === normalizeRefKey(parsed.ref)),
    );
    return isDateLike(column?.type, column?.sqlType);
  }
  return isDateLike(source?.fields.find((field) => sourceMatches(field, parsed.ref))?.type);
};

export const completedFromSource = (
  ctx: DslResolverContext,
  segment: string,
): { kind: "table" | "view"; ref: string; tail: string; tailStart: number } | null => {
  const leading = segment.match(/^\s*/)?.[0].length ?? 0;
  const sourceMatch = segment
    .slice(leading)
    .match(new RegExp(String.raw`^from\s+(table|view)\s+(${SOURCE_REF_RE})(?:\s+as\s+[A-Za-z_][A-Za-z0-9_]*)?`, "i"));
  if (!sourceMatch) return null;
  const kind = sourceMatch[1]!.toLowerCase() as "table" | "view";
  const ref = sourceMatch[2] ? parseSourceReference(sourceMatch[2]) : null;
  if (!ref || !sourceRefExists(ctx, kind, ref)) return null;
  const tailStart = leading + sourceMatch[0].length;
  return { kind, ref, tail: segment.slice(tailStart), tailStart };
};
