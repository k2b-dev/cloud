import { sql } from "@k2b/cloud";

export const migrateAppBootstrap = async (): Promise<void> => {
  // Probe before ALTER so repeated setup does not lock active credential traffic.
  await sql.begin(async (db) => {
    await db`SELECT pg_advisory_xact_lock(hashtextextended('auth.app_bootstrap.install', 0))`;
    await db`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'auth.service_account_credentials'::regclass
        AND attname = 'connections_allowed' AND NOT attisdropped) THEN
        ALTER TABLE auth.service_account_credentials ADD COLUMN connections_allowed BOOLEAN NOT NULL DEFAULT true;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'auth.service_account_credentials'::regclass
        AND attname = 'oauth_issue_allowed' AND NOT attisdropped) THEN
        ALTER TABLE auth.service_account_credentials ADD COLUMN oauth_issue_allowed BOOLEAN NOT NULL DEFAULT false;
      END IF;
    END $$`.simple();
  });
  // All Core replicas must use Valkey replay claims before serving signed traffic.
  await sql`DROP TABLE IF EXISTS auth.app_proof_replays`.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS auth.app_start_rejections (
      app_id TEXT PRIMARY KEY,
      rejected_at TIMESTAMPTZ NOT NULL,
      reason TEXT NOT NULL,
      key_id UUID NULL
    )
  `.simple();
};
