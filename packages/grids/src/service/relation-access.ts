import { sql } from "bun";
import type { SqlClient } from "./audit";
import { runBoundedQuery } from "./bounded-query";
import { hasAtLeast, loadBaseGrantsForSubject, resolveEffectivePermission } from "./permission-resolver";

export type ExpansionViewer = {
  userId: string | null;
  userGroups: string[];
  serviceAccountId?: string | null;
  isAdmin?: boolean;
  /** Restricts candidate tables; each candidate still needs Base Read access. */
  readableTableIds?: ReadonlySet<string>;
  /** Request-local cache shared by relation, lookup, and computed-field reads. */
  tableReadAccess?: Map<string, boolean>;
};

type RelationAccessReadOptions = { signal?: AbortSignal; queryTimeoutMs?: number };

export const resolveReadableTableIds = async (
  tableIds: Iterable<string>,
  viewer: ExpansionViewer,
  db: SqlClient = sql,
  options: RelationAccessReadOptions = {},
): Promise<Set<string>> => {
  const uniqueIds = [...new Set(tableIds)];
  if (viewer.isAdmin) return new Set(uniqueIds);
  if (uniqueIds.length === 0) return new Set();

  const candidateIds = viewer.readableTableIds ? uniqueIds.filter((tableId) => viewer.readableTableIds!.has(tableId)) : uniqueIds;
  const candidateIdSet = new Set(candidateIds);
  const cached = viewer.tableReadAccess ?? new Map<string, boolean>();
  viewer.tableReadAccess = cached;
  const unresolvedIds = candidateIds.filter((tableId) => !cached.has(tableId));
  for (const tableId of uniqueIds) {
    if (!candidateIdSet.has(tableId)) cached.set(tableId, false);
  }
  if (unresolvedIds.length === 0) {
    return new Set(candidateIds.filter((tableId) => cached.get(tableId)));
  }

  const tablesQuery = db<Array<{ id: string; base_id: string }>>`
    SELECT id::text, base_id::text
    FROM grids.tables
    WHERE id = ANY(${db.array(unresolvedIds, "UUID")}::uuid[])
      AND deleted_at IS NULL
  `;
  const tables =
    options.queryTimeoutMs !== undefined || options.signal
      ? await runBoundedQuery<{ id: string; base_id: string }>(tablesQuery, options.queryTimeoutMs ?? 5_000, options.signal)
      : await tablesQuery;
  options.signal?.throwIfAborted();
  const subject = viewer.userId
    ? { type: "user" as const, userId: viewer.userId }
    : viewer.serviceAccountId
      ? { type: "service_account" as const, serviceAccountId: viewer.serviceAccountId }
      : null;
  const readableBaseIds = new Set(
    await Promise.all(
      [...new Set(tables.map((table) => table.base_id))].map(async (baseId) => {
        const grants = await loadBaseGrantsForSubject({ baseId, subject }, db as typeof sql, options);
        return hasAtLeast(resolveEffectivePermission(grants, { baseId }), "read") ? baseId : null;
      }),
    ).then((baseIds) => baseIds.filter((baseId): baseId is string => baseId !== null)),
  );
  const existingIds = new Set(tables.map((table) => table.id));
  for (const tableId of unresolvedIds) {
    if (!existingIds.has(tableId)) cached.set(tableId, false);
  }
  for (const table of tables) {
    cached.set(table.id, readableBaseIds.has(table.base_id));
  }
  return new Set(candidateIds.filter((tableId) => cached.get(tableId)));
};

/**
 * Returns existing linked records only from tables the viewer can read.
 * This keeps relation UUIDs themselves from becoming a side channel when
 * labels or expansions are hidden.
 */
export const accessibleRecordIdsByTable = async (
  idsByTableId: ReadonlyMap<string, ReadonlySet<string>>,
  viewer: ExpansionViewer,
  db: SqlClient = sql,
  options: RelationAccessReadOptions = {},
): Promise<Map<string, Set<string>>> => {
  const readableTableIds = await resolveReadableTableIds(idsByTableId.keys(), viewer, db, options);
  options.signal?.throwIfAborted();
  const clauses = [...idsByTableId].flatMap(([tableId, ids]) => {
    if (!readableTableIds.has(tableId) || ids.size === 0) return [];
    return [
      db`(r.table_id = ${tableId}::uuid
      AND r.id = ANY(${db.array([...ids], "UUID")}::uuid[]))`,
    ];
  });
  if (clauses.length === 0) return new Map();
  const where = clauses.slice(1).reduce((combined, clause) => db`${combined} OR ${clause}`, clauses[0]!);
  const recordsQuery = db<Array<{ id: string; table_id: string }>>`
    SELECT r.id::text, r.table_id::text
    FROM grids.records r
    JOIN grids.tables t ON t.id = r.table_id AND t.deleted_at IS NULL
    JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
    WHERE r.deleted_at IS NULL AND (${where})
  `;
  const rows =
    options.queryTimeoutMs !== undefined || options.signal
      ? await runBoundedQuery<{ id: string; table_id: string }>(recordsQuery, options.queryTimeoutMs ?? 5_000, options.signal)
      : await recordsQuery;
  const result = new Map<string, Set<string>>();
  for (const row of rows) {
    const ids = result.get(row.table_id) ?? new Set<string>();
    ids.add(row.id);
    result.set(row.table_id, ids);
  }
  return result;
};
