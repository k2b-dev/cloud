import type { SpaceColumn, SpaceVirtualColumn, SpaceVirtualColumnKind } from "./contracts";

/** One column of the Kanban board: a status, or an enabled automatic column. */
export type BoardColumn = { kind: "column"; column: SpaceColumn; rank: string } | { kind: SpaceVirtualColumnKind; rank: string };

const compareRanks = (a: string, b: string) => {
  const left = BigInt(a);
  const right = BigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
};

/**
 * The board order of a Space: statuses and enabled automatic columns share one rank order. On a tie
 * the status comes first, so a status-only reorder from an older client never lands between them unseen.
 */
export const orderBoardColumns = (columns: readonly SpaceColumn[], virtualColumns: readonly SpaceVirtualColumn[]): BoardColumn[] =>
  [
    ...columns.map((column) => ({ kind: "column" as const, column, rank: column.rank })),
    ...virtualColumns.map((virtual) => ({ kind: virtual.kind, rank: virtual.rank })),
  ].sort((a, b) => compareRanks(a.rank, b.rank));

/** The entry the reorder API takes for a board column: a column ID, or the kind of an automatic column. */
export const boardColumnOrderId = (entry: BoardColumn) => (entry.kind === "column" ? entry.column.id : entry.kind);
