import type { RecordQuery } from "../contracts";
import { normalizeRefKey } from "../ref-syntax";
import type { DslResolverContext, DslTableSource, DslViewSource } from "./resolver-context";
import { type DslResolverDiagnostic, diagnostic } from "./resolver-diagnostics";
import type { DslSourceRef, DslSourceSpan } from "./types";

export type ResolvedSource = {
  source: DslTableSource | DslViewSource;
  tableId: string;
  baseQuery: RecordQuery;
  span?: DslSourceSpan;
};

export const resolveSource = (astSource: DslSourceRef | undefined, ctx: DslResolverContext): ResolvedSource | DslResolverDiagnostic => {
  if (!astSource) {
    if (!ctx.currentTable) return diagnostic("query needs a source table or view");
    return { source: ctx.currentTable, tableId: ctx.currentTable.id, baseQuery: {} };
  }

  const sourceMatches = (source: { id: string; shortId: string; name: string }) => {
    const ref = normalizeRefKey(astSource.ref);
    return normalizeRefKey(source.shortId) === ref || normalizeRefKey(source.name) === ref;
  };
  const tables = ctx.tables.filter(sourceMatches);
  const views = (ctx.views ?? []).filter(sourceMatches);
  const matches = astSource.kind === "table" ? tables : views;

  if (matches.length === 0) return diagnostic(`source "${astSource.ref}" is not available`, astSource.span);
  if (matches.length > 1) return diagnostic(`source "${astSource.ref}" is ambiguous; use table or view`, astSource.span);

  const source = matches[0]!;
  if (source.kind === "view" && source.unavailableReason)
    return diagnostic(
      `view "${source.name}" uses ${source.unavailableReason.toUpperCase()}, which is not supported in a nested view source; use a view without that clause`,
      astSource.span,
    );
  if (source.kind === "view") return { source, tableId: source.tableId, baseQuery: source.query, span: astSource.span };
  return { source, tableId: source.id, baseQuery: {}, span: astSource.span };
};

const unsupportedViewSourceKeys = (query: RecordQuery): string[] => {
  const keys: string[] = [];
  if ((query.groupBy?.length ?? 0) > 0) keys.push("group by");
  if ((query.groupSort?.length ?? 0) > 0) keys.push("group sort");
  if ((query.aggregations?.length ?? 0) > 0) keys.push("aggregations");
  if ((query.groupedColumnOrder?.length ?? 0) > 0) keys.push("grouped column order");
  if ((query.hiddenGroupedColumns?.length ?? 0) > 0) keys.push("hidden grouped columns");
  return keys;
};

export const validateViewSource = (source: ResolvedSource): DslResolverDiagnostic | null => {
  if (source.source.kind !== "view") return null;
  const unsupported = unsupportedViewSourceKeys(source.baseQuery);
  if (unsupported.length === 0) return null;
  return diagnostic(`view source uses ${unsupported.join(", ")}, but DSL view sources support only row-shaped saved views`, source.span);
};

export const isDerivedViewSource = (source: ResolvedSource): boolean =>
  source.source.kind === "view" && ((source.baseQuery.groupBy?.length ?? 0) > 0 || (source.baseQuery.aggregations?.length ?? 0) > 0);

export const viewSourceNeedsRecordScope = (source: ResolvedSource): boolean =>
  source.source.kind === "view" &&
  (source.baseQuery.limit !== undefined || source.baseQuery.search !== undefined || source.baseQuery.recordMeta !== undefined);
