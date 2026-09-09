import { parseGridsQueryDsl } from "./query-dsl/parser";

/** Return no link rather than a misleading empty editor when the transport cap is exceeded. */
export const queryCapabilityHref = (input: {
  baseId: string;
  query: string;
  currentTableId?: string;
  currentSource?: { kind: "table"; tableId: string } | { kind: "view"; viewId: string };
}): string | undefined => {
  const parsed = parseGridsQueryDsl(input.query);
  if (!parsed.ok) return undefined;
  let query = input.query;
  if (!parsed.ast.source) {
    const source = input.currentSource ?? (input.currentTableId ? { kind: "table" as const, tableId: input.currentTableId } : undefined);
    if (!source) return undefined;
    query = `from ${source.kind} {${source.kind === "table" ? source.tableId : source.viewId}}\n${query}`;
  }
  const href = `/app/grids/${input.baseId}/query?${new URLSearchParams({ q: query })}`;
  return href.length <= 2048 ? href : undefined;
};
