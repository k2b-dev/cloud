import { type SQL, sql } from "bun";

const targets = {
  "audit.events": { column: "metadata", timestamp: "created_at", id: "bigint" },
  "auth.deleted_accounts": { column: "meta", timestamp: "deleted_at", id: "uuid" },
} as const;

/** Upgrade only object-valued metadata. Keep unrecognizable originals intact. */
export async function repairEncodedMetadata(table: keyof typeof targets, database: SQL = sql, batchSize = 500) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error("Invalid metadata repair batch size");
  const { column, timestamp, id } = targets[table];
  const connection = await database.reserve();
  const totals = { inspected: 0, repaired: 0, preserved: 0 };
  let cursor: { id: string; at: string } | undefined;
  try {
    await connection`
      CREATE OR REPLACE FUNCTION pg_temp.cloud_metadata_object(payload jsonb) RETURNS jsonb
      LANGUAGE plpgsql IMMUTABLE STRICT AS $$
      BEGIN
        IF jsonb_typeof(payload) <> 'string' THEN RETURN NULL; END IF;
        payload := (payload #>> '{}')::jsonb;
        IF jsonb_typeof(payload) = 'object' THEN RETURN payload; END IF;
        RETURN NULL;
      EXCEPTION WHEN invalid_text_representation OR untranslatable_character OR numeric_value_out_of_range THEN
        RETURN NULL;
      END;
      $$
    `.simple();
    for (;;) {
      const batch = await connection.begin(async (tx) => {
        // Both tables already index the timestamp. Audit IDs alone are not indexed
        // and are not a unique key on a Timescale hypertable.
        const rows: { id: string; at: string }[] = await tx.unsafe(
          `SELECT id::text AS id, ${timestamp}::text AS at FROM ${table}
           WHERE jsonb_typeof(${column}) = 'string'
           ${cursor ? `AND (${timestamp}, id) > ($1::timestamptz, $2::${id})` : ""}
           ORDER BY ${timestamp}, id LIMIT ${batchSize} FOR UPDATE`,
          cursor ? [cursor.at, cursor.id] : [],
        );
        if (!rows.length) return { rows, repaired: 0 };
        const changed = await tx.unsafe(
          `UPDATE ${table} AS target SET ${column} = pg_temp.cloud_metadata_object(target.${column})
           FROM jsonb_to_recordset($1::text::jsonb) AS batch(id text, at text)
           WHERE target.id = batch.id::${id} AND target.${timestamp} = batch.at::timestamptz
             AND pg_temp.cloud_metadata_object(target.${column}) IS NOT NULL
           RETURNING target.id`,
          [JSON.stringify(rows)],
        );
        return { rows, repaired: changed.length };
      });
      if (!batch.rows.length) break;
      totals.inspected += batch.rows.length;
      totals.repaired += batch.repaired;
      totals.preserved += batch.rows.length - batch.repaired;
      cursor = batch.rows.at(-1);
    }
    if (totals.inspected) console.log(`[setup] ${table} JSON metadata: ${JSON.stringify(totals)}`);
    return totals;
  } finally {
    connection.release();
  }
}
