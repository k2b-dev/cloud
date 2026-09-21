// Reference app helper: create ledger_rows during app setup with a unique
// import_key (text) and payload (text). Actual spreadsheet parsing stays local.
export type ImportRow = { import_key: string; payload: string };
export type ImportDatabase = {
  query: (sql: string, params: string[]) => Promise<{ data: ImportRow[] }>;
  table: (name: string) => { insert: (rows: ImportRow[]) => Promise<unknown> };
};
export async function importRows(db: ImportDatabase, rows: ImportRow[], checkpoint: () => Promise<void>) {
  let inserted = 0,
    skipped = 0;
  for (let offset = 0; offset < rows.length; offset += 200) {
    await checkpoint();
    const batch = rows.slice(offset, offset + 200);
    if (new Set(batch.map((row) => row.import_key)).size !== batch.length) throw new Error("Duplicate import keys in batch");
    const known = await db.query(
      `SELECT import_key,payload FROM ledger_rows WHERE import_key IN (${batch.map(() => "?").join(",")})`,
      batch.map((row) => row.import_key),
    );
    const existing = new Map(known.data.map((row) => [row.import_key, row.payload]));
    for (const row of batch)
      if (existing.has(row.import_key) && existing.get(row.import_key) !== row.payload)
        throw new Error(`Previously imported row changed: ${row.import_key}. Resolve the change explicitly.`);
    const fresh = batch.filter((row) => !existing.has(row.import_key));
    // Studio inserts this batch atomically. A unique key protects concurrent
    // imports; a conflict fails the batch. Inspect, then deliberately retry.
    if (fresh.length) await db.table("ledger_rows").insert(fresh);
    inserted += fresh.length;
    skipped += batch.length - fresh.length;
  }
  return { inserted, skipped };
}
