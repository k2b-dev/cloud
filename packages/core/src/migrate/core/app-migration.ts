import { sql } from "@k2b/cloud";

export const migrateAppMigration = async (): Promise<void> => {
  await sql.begin(async (db) => {
    await db`SELECT pg_advisory_xact_lock(hashtextextended('auth.app_migration.install', 0))`;
    await db`CREATE TABLE IF NOT EXISTS auth.app_migration_observation (
    singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton), started_at TIMESTAMPTZ NOT NULL
  )`.simple();
    await db`CREATE TABLE IF NOT EXISTS auth.app_migration_legacy (
    path TEXT PRIMARY KEY CHECK (path IN ('bearer', 'broker-secret')), last_used_at TIMESTAMPTZ
  )`.simple();
    await db`INSERT INTO auth.app_migration_legacy (path) VALUES ('bearer'), ('broker-secret') ON CONFLICT (path) DO NOTHING`;
    // At most two receipts per enrolled key, replaced on each check; no request history.
    await db`CREATE TABLE IF NOT EXISTS auth.app_migration_probes (
    key_id UUID NOT NULL REFERENCES auth.service_account_credentials(id) ON DELETE CASCADE,
    scope TEXT NOT NULL CHECK (scope IN ('identity:invoke', 'oauth:issue')), nonce UUID NOT NULL,
    PRIMARY KEY (key_id, scope)
  )`.simple();
  });
};
