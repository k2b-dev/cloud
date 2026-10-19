import type { sql } from "bun";
import { recordInstanceDisk, recordStorageThreshold, recordStoreOutage } from "../service/store-health";
import { assertStoreName } from "./base-schema";
import { BaseOperationSuperseded, baseStore, loadStoreRow, type StoreRow } from "./base-store";
import { StoreQueryError } from "./client";

/** Verify before any new checkpoint. Never repairs or removes measurement data. */
export const verifyBaseCheckpoint = async (baseId: string, store = baseStore, restoreReader = false) => {
  let matched = false;
  await store.step(baseId, "reconcile", "verify_checkpoint", async (row, db) => {
    let reason: "database_missing" | "checkpoint_mismatch" | null = null;
    try {
      const [latest] = await store.query(
        `SELECT toString(id) AS id FROM ${assertStoreName(row.database_name, store.prefix)}._checkpoints ORDER BY at DESC LIMIT 1`,
      );
      const id = latest?.id ?? null;
      if (
        id === null
          ? row.checkpoint_id !== null || row.pending_checkpoint_id !== null
          : id !== row.checkpoint_id && id !== row.pending_checkpoint_id
      )
        reason = "checkpoint_mismatch";
    } catch (error) {
      if (error instanceof StoreQueryError && error.code === 81) reason = "database_missing";
      else if (error instanceof StoreQueryError && error.code === 60) reason = "checkpoint_mismatch";
      else throw error;
    }
    matched = reason === null;
    await db`UPDATE pulse.base_stores SET write_block_reason=${reason},write_blocked_at=CASE WHEN ${reason}::text IS NULL THEN NULL ELSE now() END,updated_at=now() WHERE base_id=${baseId}::uuid`;
    if (matched && restoreReader) {
      await store.reader(row);
      await store.grants(row);
    }
  });
  return matched;
};
export const prepareCheckpoint = async (row: StoreRow, db: typeof sql, id: string = crypto.randomUUID()) => {
  // Committed before the ClickHouse insert. A restart accepts either committed or pending id.
  if (!row.pending_checkpoint_id)
    await db`UPDATE pulse.base_stores SET pending_checkpoint_id=${id}::uuid WHERE base_id=${row.base_id}::uuid`;
};
export const insertCheckpoint = async (row: StoreRow, store = baseStore) => {
  if (!row.pending_checkpoint_id) throw new BaseOperationSuperseded();
  const database = assertStoreName(row.database_name, store.prefix);
  await store.query(
    `INSERT INTO ${database}._checkpoints SELECT {id:UUID}, greatest(fromUnixTimestamp64Milli({at:Int64}), max(at) + INTERVAL 1 MILLISECOND) FROM ${database}._checkpoints`,
    { id: row.pending_checkpoint_id, at: store.clock().getTime() },
  );
};
export const acceptCheckpoint = async (row: StoreRow, db: typeof sql, clock = () => new Date()) => {
  await db`UPDATE pulse.base_stores SET checkpoint_id=pending_checkpoint_id,pending_checkpoint_id=NULL,checkpoint_at=${clock()} WHERE base_id=${row.base_id}::uuid AND pending_checkpoint_id IS NOT NULL`;
};
export const writeBaseCheckpoint = async (baseId: string, id: string, store = baseStore) => {
  const row = await loadStoreRow(baseId);
  if (!row || row.write_block_reason) return;
  if (!(await verifyBaseCheckpoint(baseId, store))) return;
  await store.step(baseId, "reconcile", "checkpoint_pending", async (row, db) => {
    if (row.write_block_reason) throw new BaseOperationSuperseded();
    await prepareCheckpoint(row, db, id);
  });
  await store.step(baseId, "reconcile", "checkpoint_insert", async (row) => {
    if (row.write_block_reason) throw new BaseOperationSuperseded();
    await insertCheckpoint(row, store);
  });
  await store.step(baseId, "reconcile", "checkpoint_accept", async (row, db) => acceptCheckpoint(row, db, store.clock));
};
export const measureInstanceDisk = async (store = baseStore) => {
  try {
    const [disk] = await store.query("SELECT free_space, total_space FROM system.disks WHERE name='default'");
    if (!disk) throw new StoreQueryError("unreachable");
    await recordInstanceDisk(Number(disk.free_space), Number(disk.total_space), store.clock());
  } catch (error) {
    if (error instanceof StoreQueryError && error.kind === "unreachable") await recordStoreOutage(store.clock());
    throw error;
  }
};
export const measureBaseUsage = async (baseId: string, store = baseStore) => {
  await store.step(baseId, "reconcile", "usage", async (row, db) => {
    const [size] = await store.query(
      "SELECT sum(bytes_on_disk) AS bytes, sum(rows) AS rows FROM system.parts WHERE active AND database={database:String}",
      { database: row.database_name },
    );
    await recordStorageThreshold(baseId, Number(size?.bytes ?? 0), store.clock(), db);
    await db`UPDATE pulse.base_stores SET usage_bytes=${Number(size?.bytes ?? 0)},usage_rows=${Number(size?.rows ?? 0)},usage_measured_at=${store.clock()} WHERE base_id=${baseId}::uuid`;
  });
};

/** Caller holds the exclusive base row lock, excluding ingest and rollups during the drop. */
export const dropExpiredRawPartition = async ({
  baseId,
  databaseName,
  cutoff,
  store,
  db,
}: {
  baseId: string;
  databaseName: string;
  cutoff: Date;
  store: Pick<typeof baseStore, "prefix" | "query">;
  db: typeof sql;
}): Promise<boolean> => {
  const partitions = await store.query(
    `SELECT partition_id FROM system.parts WHERE active AND database={database:String} AND table='_samples'
    AND partition_id<formatDateTime(fromUnixTimestamp64Milli({cutoff:Int64}),'%Y%m%d','UTC') GROUP BY partition_id ORDER BY partition_id LIMIT 1`,
    { database: databaseName, cutoff: cutoff.getTime() },
  );
  const part = partitions[0]?.partition_id;
  if (typeof part !== "string") return false;
  if (!/^\d{8}$/.test(part)) throw new Error("Unexpected raw partition identity");
  const day = new Date(`${part.slice(0, 4)}-${part.slice(4, 6)}-${part.slice(6, 8)}T00:00:00Z`);
  const end = new Date(day.getTime() + 86_400_000);
  if (end > cutoff) return false;
  const [unsealed] =
    await db`SELECT 1 FROM pulse.metric_hours WHERE base_id=${baseId}::uuid AND hour>=${day} AND hour<${end} AND state<>'sealed' LIMIT 1`;
  if (unsealed) return false;
  await store.query(`ALTER TABLE ${assertStoreName(databaseName, store.prefix)}._samples DROP PARTITION ID '${part}'`);
  return true;
};
