import { sql } from "bun";
import { type BoardColumn, orderBoardColumns } from "@/board-columns";
import type { CreateColumn, MutationResult, SpaceColumn, SpaceVirtualColumn, SpaceVirtualColumnKind, UpdateColumn } from "@/contracts";
import { withShortId } from "../lib/short-id";
import { rank } from "./rank";

// ==========================
// Columns Service
// ==========================

type DbColumn = {
  id: string;
  space_id: string;
  name: string;
  color: string | null;
  rank: string;
  is_done: boolean;
  created_at: Date;
};

/**
 * Converts one database column row into the public `SpaceColumn` shape.
 */
const mapToColumn = (row: DbColumn): SpaceColumn => ({
  id: row.id,
  spaceId: row.space_id,
  name: row.name,
  color: row.color,
  rank: row.rank,
  isDone: row.is_done,
});

const selectColumns = async (db: typeof sql, spaceId: string): Promise<SpaceColumn[]> => {
  const rows = await db<DbColumn[]>`
    SELECT id, space_id, name, color, rank::text AS rank, is_done, created_at
    FROM spaces.columns
    WHERE space_id = ${spaceId}
    ORDER BY rank
  `;
  return rows.map(mapToColumn);
};

/**
 * List columns for a space
 */
export const list = (params: { spaceId: string }): Promise<SpaceColumn[]> => selectColumns(sql, params.spaceId);

/**
 * Get a column by ID
 */
export const get = async (params: { id: string }): Promise<SpaceColumn | null> => {
  const [row] = await sql<DbColumn[]>`
    SELECT c.id, c.space_id, c.name, c.color, c.rank::text AS rank, c.is_done, c.created_at
    FROM spaces.columns c
    WHERE c.id = ${params.id}
  `;
  return row ? mapToColumn(row) : null;
};

/**
 * Create a new column at the very end of the board, after automatic columns too.
 */
export const create = async (params: { spaceId: string; data: CreateColumn }): Promise<MutationResult<SpaceColumn>> => {
  const { spaceId, data } = params;

  const row = await withShortId("column", (shortId) =>
    withBoardLock(spaceId, async (tx, { board }) => {
      const [created] = await tx<{ id: string }[]>`
        INSERT INTO spaces.columns (short_id, space_id, name, color, rank, is_done)
        VALUES (${shortId}, ${spaceId}, ${data.name}, ${data.color ?? null}, ${rank.toDb(rank.next(board.at(-1)?.rank))}::bigint, ${data.isDone})
        RETURNING id
      `;
      return created;
    }),
  );

  if (!row) {
    return { ok: false, error: "Failed to create column", status: 500 };
  }

  const created = await get({ id: row.id });
  if (!created) {
    return { ok: false, error: "Failed to load created column", status: 500 };
  }

  return { ok: true, data: created };
};

/**
 * Update a column
 */
export const update = async (params: { id: string; data: UpdateColumn }): Promise<MutationResult<SpaceColumn>> => {
  const { id, data } = params;

  const existing = await get({ id });
  if (!existing) {
    return { ok: false, error: "Column not found", status: 404 };
  }

  const name = data.name ?? existing.name;
  const color = data.color === undefined ? existing.color : data.color;
  const isDone = data.isDone ?? existing.isDone;

  const [row] = await sql<{ id: string }[]>`
    UPDATE spaces.columns
    SET name = ${name}, color = ${color}, is_done = ${isDone}
    WHERE id = ${id}
    RETURNING id
  `;

  if (!row) {
    return { ok: false, error: "Failed to update column", status: 500 };
  }

  const updated = await get({ id: row.id });
  if (!updated) {
    return { ok: false, error: "Failed to load updated column", status: 500 };
  }

  return { ok: true, data: updated };
};

/**
 * Delete a column (only if empty)
 */
export const remove = async (params: { id: string }): Promise<MutationResult<void>> => {
  // Check if column has items
  const [itemCount] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int as count FROM spaces.items WHERE column_id = ${params.id}
  `;

  if (itemCount && itemCount.count > 0) {
    return { ok: false, error: "Cannot delete column with items", status: 400 };
  }

  const result = await sql`
    DELETE FROM spaces.columns
    WHERE id = ${params.id}
  `;

  if (result.count === 0) {
    return { ok: false, error: "Column not found", status: 404 };
  }

  return { ok: true, data: undefined };
};

/** One entry of the board order: a column by its internal ID, or an automatic column by kind. */
export type BoardOrderEntry = { kind: "column"; id: string } | { kind: SpaceVirtualColumnKind };

const selectVirtual = (db: typeof sql, spaceId: string) =>
  db<SpaceVirtualColumn[]>`
    SELECT kind, rank::text AS rank
    FROM spaces.virtual_columns
    WHERE space_id = ${spaceId}
    ORDER BY rank, kind
  `;

/**
 * List the enabled automatic Kanban columns of a space by rank.
 */
export const listVirtual = (params: { spaceId: string }): Promise<SpaceVirtualColumn[]> => selectVirtual(sql, params.spaceId);

type BoardState = { columns: SpaceColumn[]; virtualColumns: SpaceVirtualColumn[]; board: BoardColumn[] };

/**
 * Runs one change of a Space's board order in a transaction that holds its Space row. Reorders, the
 * automatic-column switches, and new statuses then each read the order the previous change wrote, so a
 * reorder from a stale board can neither undo a switch nor tie with a new status.
 */
const withBoardLock = <T>(spaceId: string, change: (tx: typeof sql, state: BoardState) => Promise<T>) =>
  sql.begin(async (tx) => {
    // NO KEY UPDATE serializes board changes without blocking item and column inserts that reference the Space.
    await tx`SELECT 1 FROM spaces.spaces WHERE id = ${spaceId} FOR NO KEY UPDATE`;
    const columns = await selectColumns(tx, spaceId);
    const virtualColumns = await selectVirtual(tx, spaceId);
    return change(tx, { columns, virtualColumns, board: orderBoardColumns(columns, virtualColumns) });
  });

/** Renumbers the whole board. It only moves existing rows; enabling an automatic column inserts its row first. */
const writeBoardOrder = async (tx: typeof sql, spaceId: string, order: BoardOrderEntry[]) => {
  for (const [index, entry] of order.entries()) {
    const nextRank = rank.toDb(rank.atIndex(index));
    if (entry.kind === "column") {
      await tx`UPDATE spaces.columns SET rank = ${nextRank}::bigint WHERE id = ${entry.id} AND space_id = ${spaceId}`;
    } else {
      await tx`UPDATE spaces.virtual_columns SET rank = ${nextRank}::bigint WHERE space_id = ${spaceId} AND kind = ${entry.kind}`;
    }
  }
};

const boardOrder = (board: BoardColumn[]) =>
  board.map((entry): BoardOrderEntry => (entry.kind === "column" ? { kind: "column", id: entry.column.id } : { kind: entry.kind }));

/**
 * Enable an automatic Kanban column. It starts in front of the first done column, where open work ends;
 * enabling one that is already enabled keeps its place.
 */
export const enableVirtual = async (params: { spaceId: string; kind: SpaceVirtualColumnKind }): Promise<SpaceVirtualColumn[]> => {
  await withBoardLock(params.spaceId, async (tx, { board }) => {
    if (board.some((entry) => entry.kind === params.kind)) return;
    const order = boardOrder(board);
    const firstDone = board.findIndex((entry) => entry.kind === "column" && entry.column.isDone);
    order.splice(firstDone < 0 ? order.length : firstDone, 0, { kind: params.kind });
    await tx`INSERT INTO spaces.virtual_columns (space_id, kind, rank) VALUES (${params.spaceId}, ${params.kind}, 0)`;
    await writeBoardOrder(tx, params.spaceId, order);
  });
  return listVirtual({ spaceId: params.spaceId });
};

/**
 * Disable an automatic Kanban column. Its tasks show in their status columns again.
 */
export const disableVirtual = async (params: { spaceId: string; kind: SpaceVirtualColumnKind }): Promise<SpaceVirtualColumn[]> => {
  await withBoardLock(
    params.spaceId,
    (tx) => tx`DELETE FROM spaces.virtual_columns WHERE space_id = ${params.spaceId} AND kind = ${params.kind}`,
  );
  return listVirtual({ spaceId: params.spaceId });
};

/**
 * Reorder the board: every column, and any enabled automatic column by kind. An automatic column left
 * out keeps its place, so clients that only know statuses reorder them around it.
 */
export const reorder = (params: { spaceId: string; order: BoardOrderEntry[] }): Promise<MutationResult<void>> =>
  withBoardLock(params.spaceId, async (tx, { columns, virtualColumns, board }): Promise<MutationResult<void>> => {
    const columnIds = new Set(columns.map((column) => column.id));
    const enabled = new Set(virtualColumns.map((virtual) => virtual.kind));
    const seen = new Set<string>();

    for (const entry of params.order) {
      const key = entry.kind === "column" ? entry.id : entry.kind;
      if (seen.has(key)) return { ok: false, error: "Each column may appear only once in a reorder", status: 400 };
      seen.add(key);
      if (entry.kind === "column" && !columnIds.has(entry.id)) {
        return { ok: false, error: `Column ${entry.id} not found in space`, status: 400 };
      }
      if (entry.kind !== "column" && !enabled.has(entry.kind)) {
        return { ok: false, error: `Automatic column ${entry.kind} is not enabled`, status: 400 };
      }
    }
    if (params.order.filter((entry) => entry.kind === "column").length !== columns.length) {
      return { ok: false, error: "Must include all columns in reorder", status: 400 };
    }

    // Omitted automatic columns stay at their board index; the given order fills the other places.
    const pending = [...params.order];
    const order = board.map((entry): BoardOrderEntry => {
      if (entry.kind !== "column" && !seen.has(entry.kind)) return { kind: entry.kind };
      return pending.shift()!;
    });
    await writeBoardOrder(tx, params.spaceId, order);
    return { ok: true, data: undefined };
  });
