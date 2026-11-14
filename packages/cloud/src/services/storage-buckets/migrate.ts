import type { SQL } from "bun";
import { sql } from "../../runtime/clients";
import { ensureSchema } from "../postgres";

/** Core owns writes; applications and the gateway need SELECT on these platform tables. */
export const migrateStorageBuckets = async (db: SQL = sql): Promise<void> => {
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('core.storage_buckets.migrations', 0))`;
    await ensureSchema(tx, "platform");
    await tx`CREATE TABLE IF NOT EXISTS platform.storage_buckets (
      id UUID PRIMARY KEY, name TEXT NOT NULL, inherit_access BOOLEAN NOT NULL,
      endpoint TEXT, region TEXT, bucket TEXT NOT NULL, credentials_encrypted TEXT,
      removed_at TIMESTAMPTZ, revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_by TEXT,
      CHECK (inherit_access OR (endpoint IS NOT NULL AND region IS NOT NULL))
    )`.simple();
    await tx`CREATE UNIQUE INDEX IF NOT EXISTS storage_buckets_active_name
      ON platform.storage_buckets (lower(name)) WHERE removed_at IS NULL`.simple();
    await tx`CREATE TABLE IF NOT EXISTS platform.storage_bucket_checks (
      bucket_id TEXT PRIMARY KEY CHECK (bucket_id = 'default' OR bucket_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
      signature TEXT NOT NULL, ok BOOLEAN NOT NULL, step TEXT CHECK (step IN ('config','write','read','delete')),
      checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`.simple();
  });
};
