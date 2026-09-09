import { toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import type { SqlClient } from "./audit";
import { parseJsonbRow } from "./jsonb";
import type { Field } from "./types";

type DbRow = Record<string, unknown>;

export const mapFieldRow = (row: DbRow): Field => ({
  id: row.id as string,
  shortId: row.short_id as string,
  tableId: row.table_id as string,
  name: row.name as string,
  description: (row.description as string | null) ?? null,
  icon: (row.icon as string | null) ?? null,
  type: row.type as string,
  config: parseJsonbRow<Record<string, unknown>>(row.config, {}),
  position: row.position as number,
  required: row.required as boolean,
  presentable: (row.presentable as boolean | null) ?? false,
  hideInTable: (row.hide_in_table as boolean | null) ?? false,
  defaultValue: parseJsonbRow<unknown>(row.default_value, null),
  indexed: row.indexed as boolean,
  uniqueConstraint: row.unique_constraint as boolean,
  deletedAt: row.deleted_at ? (row.deleted_at as Date).toISOString() : null,
  createdAt: (row.created_at as Date).toISOString(),
  updatedAt: (row.updated_at as Date).toISOString(),
});

/**
 * Look up a field by (tableId, slug). Used by the formula evaluator
 * when resolving #slug references. Returns null for deleted fields,
 * AND for any field whose parent table or base is trashed (live-parent
 * invariant).
 */
export const getByShortIdForTable = async (tableId: string, shortId: string): Promise<Field | null> => {
  const [row] = await sql<DbRow[]>`
    SELECT f.*
    FROM grids.fields f
    JOIN grids.tables t ON t.id = f.table_id AND t.deleted_at IS NULL
    JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
    WHERE f.table_id = ${tableId}::uuid AND f.short_id = ${shortId} AND f.deleted_at IS NULL
  `;
  return row ? mapFieldRow(row) : null;
};

/** Resolves the only public field identifier to the internal resource. */
export const getByShortId = async (shortId: string): Promise<Field | null> => {
  const [row] = await sql<DbRow[]>`
    SELECT f.*
    FROM grids.fields f
    JOIN grids.tables t ON t.id = f.table_id AND t.deleted_at IS NULL
    JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
    WHERE f.short_id = ${shortId} AND f.deleted_at IS NULL
  `;
  return row ? mapFieldRow(row) : null;
};

export const listByTable = async (tableId: string, includeDeleted = false, client: SqlClient = sql): Promise<Field[]> => {
  // Live-parent invariant: fields under a trashed table or base never list.
  const rows = includeDeleted
    ? await client<DbRow[]>`
        SELECT f.*
        FROM grids.fields f
        JOIN grids.tables t ON t.id = f.table_id AND t.deleted_at IS NULL
        JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
        WHERE f.table_id = ${tableId}::uuid
        ORDER BY f.position, f.created_at
      `
    : await client<DbRow[]>`
        SELECT f.*
        FROM grids.fields f
        JOIN grids.tables t ON t.id = f.table_id AND t.deleted_at IS NULL
        JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
        WHERE f.table_id = ${tableId}::uuid AND f.deleted_at IS NULL
        ORDER BY f.position, f.created_at
      `;
  return rows.map(mapFieldRow);
};

/** Loads fields for several live tables in one round trip. Federation source
 * planning uses this to keep query preparation bounded at the 50-source cap. */
export const listByTables = async (tableIds: readonly string[], client: SqlClient = sql): Promise<Map<string, Field[]>> => {
  if (tableIds.length === 0) return new Map();
  const rows = await client<DbRow[]>`
    SELECT f.*
    FROM grids.fields f
    JOIN grids.tables t ON t.id = f.table_id AND t.deleted_at IS NULL
    JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
    WHERE f.table_id = ANY(${toPgUuidArray([...tableIds])}::uuid[])
      AND f.deleted_at IS NULL
    ORDER BY f.table_id, f.position, f.created_at
  `;
  const grouped = new Map<string, Field[]>();
  for (const row of rows) {
    const field = mapFieldRow(row);
    const fields = grouped.get(field.tableId) ?? [];
    fields.push(field);
    grouped.set(field.tableId, fields);
  }
  return grouped;
};

/**
 * Soft-deleted fields across all (live) tables of a base — for the
 * base-settings trash view. Fields whose parent table is itself
 * trashed are intentionally excluded; they'll come back when the
 * table restores.
 */
export const listTrashedByBase = async (baseId: string): Promise<Field[]> => {
  const rows = await sql<DbRow[]>`
    SELECT f.*
    FROM grids.fields f
    JOIN grids.tables t ON t.id = f.table_id
    JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
    WHERE t.base_id = ${baseId}::uuid
      AND t.deleted_at IS NULL
      AND f.deleted_at IS NOT NULL
    ORDER BY f.deleted_at DESC
  `;
  return rows.map(mapFieldRow);
};

/**
 * Reads a single field. Live-parent invariant: parent table AND base
 * must be alive. Soft-deleted fields ARE returned because restore /
 * trash flows need them; the caller decides whether to act on a
 * trashed field row by inspecting `field.deletedAt`.
 */
export const get = async (id: string, client: SqlClient = sql): Promise<Field | null> => {
  const [row] = await client<DbRow[]>`
    SELECT f.*
    FROM grids.fields f
    JOIN grids.tables t ON t.id = f.table_id AND t.deleted_at IS NULL
    JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
    WHERE f.id = ${id}::uuid
  `;
  return row ? mapFieldRow(row) : null;
};
