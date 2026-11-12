import { sql } from "@k2b/cloud";
import type { SQL } from "bun";

/** Core owns only the facts every OAuth verifier needs. Optional issuer data is copied once. */
export const migrate = async (db: SQL = sql): Promise<void> => {
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('core.oauth_clients.migrations',0))`;
    const [previous] = await tx<{ installed: boolean }[]>`SELECT to_regclass('auth.oauth_clients') IS NOT NULL AS installed`;
    if (previous?.installed) return;
    await tx`CREATE TABLE IF NOT EXISTS auth.oauth_clients (
    client_id TEXT PRIMARY KEY, issuer_app_id TEXT NOT NULL,
    service_account_id UUID REFERENCES auth.service_accounts(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK (status IN ('active','disabled','deleted')), name TEXT NOT NULL
  )`.simple();
    // Existing terminal evidence belongs to the built-in issuer; retain it without runtime schema probes.
    await tx`DO $$ BEGIN
    IF to_regclass('oauth.clients') IS NOT NULL THEN
      INSERT INTO auth.oauth_clients (client_id, issuer_app_id, service_account_id, status, name)
        SELECT client_id, 'oauth', service_account_id, 'active', name FROM oauth.clients
        ON CONFLICT (client_id) DO NOTHING;
      UPDATE auth.app_logins l SET oauth_issuer_app_id='oauth', oauth_client_name=c.name
        FROM oauth.clients c WHERE l.kind='terminal' AND l.client_id=c.client_id AND l.oauth_issuer_app_id IS NULL;
    END IF;
    IF to_regclass('oauth.device_authorizations') IS NOT NULL THEN
      UPDATE auth.app_logins l SET oauth_grant_expires_at=date_trunc('milliseconds',d.expires_at)
        FROM oauth.device_authorizations d WHERE l.kind='terminal' AND l.device_authorization_id=d.id
          AND l.oauth_issuer_app_id='oauth' AND l.oauth_grant_expires_at IS NULL;
    END IF;
  END $$`.simple();
  });
};
