import type { SQL } from "bun";
import { sql } from "../runtime/clients";
import { toPgTextArray } from "./postgres";

export type AppCatalogTable = "help.corpora" | "ai.app_skill_catalogs";

export const APP_CATALOG_RETENTION_MS = 24 * 60 * 60 * 1_000;

/** Keep all versions while any replica is live, including older publishers during a rolling update.
 * `last_seen_at` stays writable for published 0.55.0 clients, but never decides retention.
 * One row per table per pass keeps deletion bounded; an overdue result schedules the next pass.
 */
export const cleanupAppCatalogs = async (
  liveIds: readonly string[],
  db: SQL = sql,
  now = new Date(),
  tables: readonly AppCatalogTable[] = ["help.corpora", "ai.app_skill_catalogs"],
): Promise<number | null> => {
  return db.begin(async (tx) => {
    await tx`SET LOCAL statement_timeout = '10s'`.simple();
    const ids = toPgTextArray([...liveIds]);
    let next: number | null = null;
    for (const table of tables) {
      await tx.unsafe(
        `UPDATE ${table} SET unregistered_at = CASE WHEN app_id=ANY($1::text[]) THEN NULL ELSE $2::timestamptz END
        WHERE (app_id=ANY($1::text[]) AND unregistered_at IS NOT NULL)
           OR (NOT(app_id=ANY($1::text[])) AND unregistered_at IS NULL)`,
        [ids, now],
      );
      await tx.unsafe(
        `DELETE FROM ${table} WHERE (app_id, manifest_hash) IN (
        SELECT app_id, manifest_hash FROM ${table} WHERE unregistered_at <= $1::timestamptz
        ORDER BY unregistered_at LIMIT 1 FOR UPDATE SKIP LOCKED)`,
        [new Date(now.getTime() - APP_CATALOG_RETENTION_MS)],
      );
      const [row] = await tx.unsafe<{ oldest: Date | null }[]>(`SELECT min(unregistered_at) AS oldest FROM ${table}`);
      if (row?.oldest) next = Math.min(next ?? Infinity, row.oldest.getTime() + APP_CATALOG_RETENTION_MS);
    }
    return next;
  });
};
