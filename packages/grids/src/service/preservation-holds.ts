import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import type { PreservationHold, PreservationHoldInput } from "../preservation-hold-contracts";
import { logAudit, type SqlClient } from "./audit";
import { newShortId } from "./short-id";

type HoldRow = {
  id: string;
  short_id: string;
  base_short_id: string;
  scope_type: "base" | "table";
  table_short_id: string | null;
  table_name: string | null;
  reason: string;
  created_by_display_name: string | null;
  created_at: Date | string;
  release_reason: string | null;
  released_by_display_name: string | null;
  released_at: Date | string | null;
};

const toHold = (row: HoldRow): PreservationHold => {
  let scope: PreservationHold["scope"] = { type: "base" };
  if (row.scope_type === "table") {
    const tableId = row.table_short_id;
    const tableName = row.table_name;
    if (!tableId || !tableName) throw new Error(`Table preservation hold ${row.short_id} has an incomplete scope`);
    scope = { type: "table", tableId, tableName };
  }
  return {
    id: row.short_id,
    baseId: row.base_short_id,
    scope,
    reason: row.reason,
    status: row.released_at === null ? "active" : "released",
    createdByDisplayName: row.created_by_display_name,
    createdAt: new Date(row.created_at).toISOString(),
    releaseReason: row.release_reason,
    releasedByDisplayName: row.released_by_display_name,
    releasedAt: row.released_at === null ? null : new Date(row.released_at).toISOString(),
  };
};

const projection = sql`
  hold.id, hold.short_id, base.short_id AS base_short_id, hold.scope_type,
  hold.table_short_id, hold.table_name, hold.reason,
  hold.created_by_display_name, hold.created_at, hold.release_reason,
  hold.released_by_display_name, hold.released_at
`;

export const list = async (
  baseId: string,
  input: {
    status: "active" | "released" | "all";
    scope: "base" | "table" | "all";
    tablePublicId: string | null;
    perPage: number;
    offset: number;
  },
): Promise<{ items: PreservationHold[]; total: number }> => {
  const [count] = await sql<Array<{ total: number }>>`
    SELECT count(*)::int AS total
    FROM grids.preservation_holds hold
    WHERE hold.base_id = ${baseId}::uuid
      AND (${input.status} = 'all'
        OR (${input.status} = 'active' AND hold.released_at IS NULL)
        OR (${input.status} = 'released' AND hold.released_at IS NOT NULL))
      AND (${input.scope} = 'all' OR hold.scope_type = ${input.scope})
      AND (${input.tablePublicId}::text IS NULL OR hold.table_short_id = ${input.tablePublicId})
  `;
  const rows = await sql<HoldRow[]>`
    SELECT ${projection}
    FROM grids.preservation_holds hold
    JOIN grids.bases base ON base.id = hold.base_id
    WHERE hold.base_id = ${baseId}::uuid
      AND (${input.status} = 'all'
        OR (${input.status} = 'active' AND hold.released_at IS NULL)
        OR (${input.status} = 'released' AND hold.released_at IS NOT NULL))
      AND (${input.scope} = 'all' OR hold.scope_type = ${input.scope})
      AND (${input.tablePublicId}::text IS NULL OR hold.table_short_id = ${input.tablePublicId})
    ORDER BY hold.created_at DESC, hold.id DESC
    LIMIT ${input.perPage} OFFSET ${input.offset}
  `;
  return { items: rows.map(toHold), total: Number(count?.total ?? 0) };
};

export const create = async (
  baseId: string,
  input: PreservationHoldInput & { scope: { type: "base" } | { type: "table"; tableId: string } },
  actor: { id: string | null; displayName: string | null },
): Promise<Result<PreservationHold>> =>
  sql.begin(async (tx) => {
    const [base] = await tx<Array<{ id: string }>>`
      SELECT id FROM grids.bases WHERE id = ${baseId}::uuid AND deleted_at IS NULL FOR UPDATE
    `;
    if (!base) return fail(err.notFound("Base not found"));
    let tableScope: { id: string; shortId: string; name: string } | null = null;
    if (input.scope.type === "table") {
      const [table] = await tx<Array<{ id: string; short_id: string; name: string }>>`
        SELECT id, short_id, name FROM grids.tables
        WHERE id = ${input.scope.tableId}::uuid AND base_id = ${baseId}::uuid AND deleted_at IS NULL
        FOR SHARE
      `;
      if (!table) return fail(err.notFound("Table not found"));
      tableScope = { id: table.id, shortId: table.short_id, name: table.name };
    }
    const shortId = newShortId();
    const [row] = await tx<HoldRow[]>`
      INSERT INTO grids.preservation_holds (
        short_id, base_id, scope_type, table_id, table_short_id, table_name, reason, created_by, created_by_display_name
      )
      SELECT ${shortId}, base.id, ${input.scope.type}, ${tableScope?.id ?? null}::uuid,
        ${tableScope?.shortId ?? null}, ${tableScope?.name ?? null}, ${input.reason}, ${actor.id}::uuid, ${actor.displayName}
      FROM grids.bases base WHERE base.id = ${baseId}::uuid
      RETURNING id, short_id, (SELECT short_id FROM grids.bases WHERE id = base_id) AS base_short_id, scope_type,
        table_short_id, table_name, reason, created_by_display_name, created_at, release_reason,
        released_by_display_name, released_at
    `;
    if (!row) throw new Error("Preservation hold creation returned no row");
    await logAudit(
      {
        baseId,
        userId: actor.id,
        action: "preservation_hold.created",
        diff: {
          holdId: { old: null, new: row.short_id },
          scope: { old: null, new: row.scope_type },
          tableId: { old: null, new: row.table_short_id },
          reason: { old: null, new: row.reason },
        },
      },
      tx,
    );
    return ok(toHold(row));
  });

export const release = async (
  baseId: string,
  holdPublicId: string,
  input: PreservationHoldInput,
  actor: { id: string | null; displayName: string | null },
): Promise<Result<PreservationHold>> =>
  sql.begin(async (tx) => {
    await tx`SELECT id FROM grids.bases WHERE id = ${baseId}::uuid FOR UPDATE`;
    const [current] = await tx<Array<{ released_at: Date | string | null }>>`
      SELECT released_at FROM grids.preservation_holds
      WHERE base_id = ${baseId}::uuid AND short_id = ${holdPublicId}
      FOR UPDATE
    `;
    if (!current) return fail(err.notFound("Preservation hold not found"));
    if (current.released_at !== null) return fail(err.conflict("Preservation hold is already released"));
    const [row] = await tx<HoldRow[]>`
      UPDATE grids.preservation_holds hold
      SET release_reason = ${input.reason}, released_by = ${actor.id}::uuid,
        released_by_display_name = ${actor.displayName}, released_at = now()
      FROM grids.bases base
      WHERE hold.short_id = ${holdPublicId} AND hold.base_id = ${baseId}::uuid
        AND hold.released_at IS NULL AND base.id = hold.base_id
      RETURNING hold.id, hold.short_id, base.short_id AS base_short_id, hold.reason,
        hold.scope_type, hold.table_short_id, hold.table_name,
        hold.created_by_display_name, hold.created_at, hold.release_reason,
        hold.released_by_display_name, hold.released_at
    `;
    if (!row) throw new Error("Preservation hold release returned no row");
    await logAudit(
      {
        baseId,
        userId: actor.id,
        action: "preservation_hold.released",
        diff: { holdId: { old: row.short_id, new: null }, releaseReason: { old: null, new: row.release_reason } },
      },
      tx,
    );
    return ok(toHold(row));
  });

export type PreservationDestructionTarget = { type: "base"; baseId: string } | { type: "table"; baseId: string; tableId: string };

/** Call inside the same transaction that would destroy evidence in this exact scope. */
export const admitDestruction = async (target: PreservationDestructionTarget, client: SqlClient): Promise<Result<void>> => {
  await client`SELECT id FROM grids.bases WHERE id = ${target.baseId}::uuid FOR UPDATE`;
  let tableId: string | null = null;
  if (target.type === "table") {
    const [table] = await client<Array<{ base_id: string }>>`
      SELECT base_id FROM grids.tables WHERE id = ${target.tableId}::uuid FOR SHARE
    `;
    if (!table || table.base_id !== target.baseId) return fail(err.notFound("Table not found in Base"));
    tableId = target.tableId;
  }
  const [hold] = await client<Array<{ short_id: string }>>`
    SELECT short_id FROM grids.preservation_holds
    WHERE base_id = ${target.baseId}::uuid AND released_at IS NULL
      AND (${target.type} = 'base' OR scope_type = 'base' OR table_id = ${tableId}::uuid)
    ORDER BY created_at, id LIMIT 1
  `;
  return hold ? fail(err.conflict(`Controlled destruction is blocked by active preservation hold ${hold.short_id}`)) : ok(undefined);
};
