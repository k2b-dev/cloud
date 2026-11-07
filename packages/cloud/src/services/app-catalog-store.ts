import type { SQL, TransactionSQL } from "bun";
import type { AppRegistryEntry } from "../contracts/registry";
import { sql } from "../runtime/clients";
import { logger } from "./logging";

export type AppCatalogTable = "help.corpora" | "ai.app_skill_catalogs";

export const APP_CATALOG_RETENTION_MS = 24 * 60 * 60 * 1_000;

export type AppCatalogRegistration = Pick<AppRegistryEntry, "id" | "help" | "skills">;

const legacyCatalogTables = new Set<AppCatalogTable>();
export const usesLegacyCatalogRenewal = (table: AppCatalogTable): boolean => legacyCatalogTables.has(table);

const sqlState = (error: unknown): unknown =>
  error && typeof error === "object" ? (Reflect.get(error, "errno") ?? Reflect.get(error, "code")) : null;

/** New publishers cancel a pending removal in the same transaction as publication.
 * Older Core schemas keep lease renewals until a later publication detects the new column.
 */
export const clearCatalogRemoval = async (tx: TransactionSQL, table: AppCatalogTable, appId: string, hash: string): Promise<void> => {
  try {
    await tx.savepoint(async (attempt) => {
      await attempt.unsafe(
        `UPDATE ${table} SET unregistered_at=NULL
        WHERE app_id=$1 AND manifest_hash=$2 AND unregistered_at IS NOT NULL`,
        [appId, hash],
      );
    });
    legacyCatalogTables.delete(table);
  } catch (error) {
    if (sqlState(error) !== "42703") throw error;
    if (legacyCatalogTables.has(table)) return;
    legacyCatalogTables.add(table);
    logger("app-catalogs").warn("Core lacks registry-based catalog retention; using legacy catalog renewals until Core upgrades", {
      appId,
      table,
    });
  }
};

/** One indexed, read-only existence check per advertised catalog on its publisher's heartbeat. */
export const appCatalogExists = async (table: AppCatalogTable, appId: string, hash: string, db: SQL = sql): Promise<boolean> => {
  const query = db.unsafe(`SELECT 1 FROM ${table} WHERE app_id=$1 AND manifest_hash=$2`, [appId, hash]);
  const timer = setTimeout(() => void query.cancel().catch(() => undefined), 10_000);
  try {
    return (await query).length > 0;
  } catch (error) {
    if (["42P01", "3F000"].includes(String(sqlState(error)))) return false;
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

/** Retain only advertised app/hash pairs indefinitely. Other sources get one day of grace.
 * One row per table per pass keeps deletion bounded; an overdue result schedules the next pass.
 */
export const cleanupAppCatalogs = async (
  apps: readonly AppCatalogRegistration[],
  db: SQL = sql,
  now = new Date(),
  tables: readonly AppCatalogTable[] = ["help.corpora", "ai.app_skill_catalogs"],
): Promise<number | null> => {
  return db.begin(async (tx) => {
    await tx`SET LOCAL statement_timeout = '10s'`.simple();
    let next: number | null = null;
    for (const table of tables) {
      const active = JSON.stringify(
        apps.flatMap((app) => {
          const manifestHash = (table === "help.corpora" ? app.help : app.skills)?.manifestHash;
          return manifestHash ? [{ app_id: app.id, manifest_hash: manifestHash }] : [];
        }),
      );
      const matches = "EXISTS (SELECT 1 FROM active WHERE active.app_id=catalog.app_id AND active.manifest_hash=catalog.manifest_hash)";
      await tx.unsafe(
        `WITH active AS (SELECT * FROM jsonb_to_recordset(($1::text)::jsonb) AS entry(app_id text, manifest_hash text))
        UPDATE ${table} catalog SET unregistered_at = CASE WHEN ${matches} THEN NULL ELSE $2::timestamptz END
        WHERE (unregistered_at IS NULL AND NOT ${matches}) OR (unregistered_at IS NOT NULL AND ${matches})`,
        [active, now],
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
