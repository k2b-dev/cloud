import type { RetentionPreviewItem } from "./admin-contracts";
import { assertStoreName } from "./base-schema";
import { baseStore, loadStoreRow } from "./base-store";
export class RetentionStoreUnavailable extends Error {
  constructor() {
    super("STORE_UNAVAILABLE");
  }
}
export const retentionPreview = async (
  baseId: string,
  old: { retention_days: number; rollup_retention_days: number; sensitive_retention_hours: number },
  next: { rawRetentionDays: number; rollupRetentionDays: number; sensitiveRetentionHours: number },
  clock = () => new Date(),
  store = baseStore,
): Promise<RetentionPreviewItem[]> => {
  const changes = [
    {
      kind: "raw",
      retention: next.rawRetentionDays,
      previous: old.retention_days,
      hours: 24,
      tables: [
        { table: "_events", time: "ts" },
        { table: "_state_changes", time: "changed_at" },
        { table: "_samples", time: "ts" },
      ],
    },
    {
      kind: "rollup",
      retention: next.rollupRetentionDays,
      previous: old.rollup_retention_days,
      hours: 24,
      tables: [{ table: "_rollups", time: "bucket" }],
    },
    {
      kind: "sensitive",
      retention: next.sensitiveRetentionHours,
      previous: old.sensitive_retention_hours,
      hours: 1,
      tables: [{ table: "_events", time: "ts" }],
    },
  ] as const;
  const shorter = changes.filter((change) => change.retention < change.previous);
  if (!shorter.length) return [];
  const row = await loadStoreRow(baseId);
  if (!row) throw new RetentionStoreUnavailable();
  const database = assertStoreName(row.database_name, store.prefix),
    now = clock().getTime();
  const preview: RetentionPreviewItem[] = [];
  for (const change of shorter) {
    const cutoff = new Date(now - change.retention * change.hours * 3600000).toISOString();
    let rows = 0,
      bytes = 0;
    for (const table of change.tables) {
      if (change.kind === "sensitive") {
        // Sensitive erasure clears the field and keeps the row: count the non-empty fields and their own size.
        const [fields] = await store.query(
          `SELECT count() AS rows, sum(length(sensitive)) AS bytes FROM ${database}.${table.table} WHERE ${table.time} < parseDateTime64BestEffort({cutoff:String}) AND sensitive != ''`,
          { cutoff },
        );
        rows += Number(fields?.rows ?? 0);
        bytes += Number(fields?.bytes ?? 0);
        continue;
      }
      const [count] = await store.query(
        `SELECT count() AS rows FROM ${database}.${table.table} WHERE ${table.time} < parseDateTime64BestEffort({cutoff:String})`,
        { cutoff },
      );
      const [size] = await store.query(
        "SELECT sum(bytes_on_disk) AS bytes, sum(rows) AS rows FROM system.parts WHERE active AND database={database:String} AND table={table:String}",
        { database: row.database_name, table: table.table },
      );
      const affected = Number(count?.rows ?? 0);
      rows += affected;
      bytes += Number(size?.rows ?? 0) > 0 ? Math.round((affected * Number(size?.bytes ?? 0)) / Number(size?.rows)) : 0;
    }
    preview.push({ kind: change.kind, retention: change.retention, cutoff, rows, bytes });
  }
  return preview;
};
