import type { SqlClient } from "./audit";
export type AtomicRecordRef = { tableId: string; recordId: string; required: "read" | "write" };
const atomicLockError = (code: string, message: string) => ({ code, message, status: 409 });

/**
 * Lock every coordination and update target in one stable order before any
 * assertion is evaluated. A check that currently matches no rows cannot lock
 * the absence itself; the explicit coordination record closes that race.
 */
export const lockAtomicRecords = async (
  client: SqlClient,
  records: AtomicRecordRef[],
  requireAccess: (record: AtomicRecordRef) => Promise<void>,
  additionalTableIds: readonly string[] = [],
): Promise<void> => {
  const requiredByRecord = new Map<string, AtomicRecordRef>();
  for (const record of records) {
    const key = `${record.tableId}:${record.recordId}`;
    const existing = requiredByRecord.get(key);
    if (!existing || record.required === "write") requiredByRecord.set(key, record);
  }

  const ordered = [...requiredByRecord.values()].sort((left, right) =>
    left.tableId === right.tableId ? left.recordId.localeCompare(right.recordId) : left.tableId.localeCompare(right.tableId),
  );
  for (const record of ordered) await requireAccess(record);
  // Match ordinary writers: parent locks precede row locks. Acquire every
  // table in one order, including create-only targets, before any change runs.
  const tableIds = [...new Set([...ordered.map((record) => record.tableId), ...additionalTableIds])].sort();
  const baseIds = new Set<string>();
  for (const tableId of tableIds) {
    const [table] = await client<Array<{ base_id: string }>>`
      SELECT base_id::text FROM grids.tables WHERE id = ${tableId}::uuid AND deleted_at IS NULL
    `;
    if (!table) throw atomicLockError("ATOMIC_LOCK_UNAVAILABLE", "A table required by the atomic change is no longer available");
    baseIds.add(table.base_id);
  }
  for (const baseId of [...baseIds].sort()) {
    const [base] = await client<Array<{ id: string }>>`
      SELECT id::text FROM grids.bases WHERE id = ${baseId}::uuid AND deleted_at IS NULL FOR SHARE
    `;
    if (!base) throw atomicLockError("ATOMIC_LOCK_UNAVAILABLE", "The base required by the atomic change is no longer available");
  }
  for (const tableId of tableIds) {
    const [table] = await client<Array<{ id: string }>>`
      SELECT id::text FROM grids.tables WHERE id = ${tableId}::uuid AND deleted_at IS NULL FOR SHARE
    `;
    if (!table) throw atomicLockError("ATOMIC_LOCK_UNAVAILABLE", "A table required by the atomic change is no longer available");
  }
  for (const record of ordered) {
    const [locked] = await client<Array<{ id: string }>>`
      SELECT r.id::text AS id
      FROM grids.records r
      WHERE r.table_id = ${record.tableId}::uuid
        AND r.id = ${record.recordId}::uuid
        AND r.deleted_at IS NULL
      FOR UPDATE OF r
    `;
    if (!locked) throw atomicLockError("ATOMIC_LOCK_UNAVAILABLE", "A record required by the atomic change is no longer available");
  }
};
