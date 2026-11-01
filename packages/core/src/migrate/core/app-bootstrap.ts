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
        -- Compatibility for built-in issuer keys enrolled before the grant existed.
        UPDATE auth.service_account_credentials c SET oauth_issue_allowed = true
        FROM auth.service_accounts sa
        WHERE c.service_account_id = sa.id AND c.kind = 'app_key'
          AND sa.kind = 'resource_bound' AND sa.app_id = 'oauth'
          AND sa.resource_type = 'cloud.app' AND sa.resource_id = sa.app_id;
      END IF;
    END $$`.simple();
  });
  await sql`
    CREATE TABLE IF NOT EXISTS auth.app_proof_replays (
      key_id UUID NOT NULL REFERENCES auth.service_account_credentials(id) ON DELETE CASCADE,
      jti TEXT NOT NULL CHECK (length(jti) BETWEEN 1 AND 64),
      retain_until TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (key_id, jti)
    )
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS auth.app_start_rejections (
      app_id TEXT PRIMARY KEY,
      rejected_at TIMESTAMPTZ NOT NULL,
      reason TEXT NOT NULL,
      key_id UUID NULL
    )
  `.simple();
  await sql`CREATE INDEX IF NOT EXISTS app_proof_replays_retention ON auth.app_proof_replays (retain_until)`.simple();
};
