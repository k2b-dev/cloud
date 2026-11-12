import { sql } from "@k2b/cloud";
import type { SQL } from "bun";

/** Run after auth and audit migrations, before any Core routes or workers start. */
export const retireAppWorkloads = async (database: SQL = sql): Promise<void> => {
  await database.begin(async (db) => {
    await db`SELECT pg_advisory_xact_lock(hashtextextended('auth.app_key_cutover', 0))`;
    // UPDATE RETURNING makes revocation and its system audit atomic and idempotent.
    await db`
      WITH retired AS (
        UPDATE auth.service_account_credentials c
        SET status = 'revoked', revoked_at = now(), revoked_by = NULL
        FROM auth.service_accounts sa
        WHERE c.service_account_id = sa.id AND sa.kind = 'resource_bound'
          AND sa.resource_type = 'cloud.app' AND c.kind = 'api_token' AND c.status = 'active'
          AND c.scopes && ARRAY['identity:invoke', 'identity:oauth-issue']::text[]
        RETURNING c.id, c.name, c.service_account_id, sa.app_id
      )
      INSERT INTO audit.events (action, outcome, target_type, target_id, target_label, reason, metadata)
      SELECT 'service_account_credential.revoke', 'allowed', 'service_account_credential', id::text, name,
        'app_key_cutover', jsonb_build_object('provenance', 'system', 'service', 'core',
          'reason', 'app_key_cutover', 'serviceAccountId', service_account_id::text, 'appId', app_id)
      FROM retired
    `;
    await db`DROP TABLE IF EXISTS auth.app_workload_instances`.simple();
    await db`DROP TABLE IF EXISTS auth.app_migration_legacy`.simple();
    await db`DROP TABLE IF EXISTS auth.app_migration_observation`.simple();
  });
};
