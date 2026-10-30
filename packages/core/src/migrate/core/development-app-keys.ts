import { env } from "@k2b/cloud/config";
import { DEVELOPMENT_APP_KEYS, DEVELOPMENT_INSTALLATION_ID } from "@k2b/cloud/services/app-keys";
import type { SQL } from "bun";

/** Only the explicitly opted-in, isolated dev installation uses deterministic identities. */
export const enrollDevelopmentAppKeys = async (db: SQL, { enabled = env.CLOUD_DEV_APP_KEYS, mode = env.NODE_ENV } = {}): Promise<void> => {
  if (!enabled) return;
  if (mode !== "development") throw new Error("CLOUD_DEV_APP_KEYS requires NODE_ENV=development");
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('auth.app_keys.install', 0))`;
    const [installation] = await tx<{ id: string }[]>`SELECT id FROM auth.installation WHERE singleton = true FOR UPDATE`;
    if (!installation) throw new Error("Core migrations must run before development enrollment");
    if (installation.id !== DEVELOPMENT_INSTALLATION_ID) {
      const [enrolled] = await tx<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM auth.service_account_credentials WHERE kind = 'app_key'`;
      if (enrolled?.count)
        throw new Error("Refusing to change an installation identity that already has app keys; use a separate dev database");
      await tx`UPDATE auth.installation SET id = ${DEVELOPMENT_INSTALLATION_ID}::uuid WHERE singleton = true`;
    }
    for (const key of DEVELOPMENT_APP_KEYS) {
      // Idempotent enrollment preserves disabled accounts and revoked keys.
      let [account] = await tx<{ id: string }[]>`SELECT id FROM auth.service_accounts
        WHERE kind = 'resource_bound' AND app_id = ${key.appId} AND resource_type = 'cloud.app' AND resource_id = ${key.appId}
        ORDER BY created_at LIMIT 1`;
      if (!account)
        [account] = await tx<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
        VALUES (${`${key.appId} development workload`}, 'resource_bound', ${key.appId}, 'cloud.app', ${key.appId}) RETURNING id`;
      if (!account) throw new Error("Development account creation failed");
      await tx`INSERT INTO auth.service_account_credentials (id, service_account_id, name, kind, public_key, fingerprint)
        VALUES (${key.keyId}::uuid, ${account.id}::uuid, 'PUBLIC DEVELOPMENT FIXTURE', 'app_key', ${key.publicKey}, ${key.fingerprint})
        ON CONFLICT (id) DO NOTHING`;
    }
  });
};
