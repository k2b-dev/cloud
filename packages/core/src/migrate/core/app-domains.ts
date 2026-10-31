import { sql } from "@k2b/cloud";
import { APP_DOMAINS_DDL } from "@k2b/cloud/contracts/app-domains";
import { ensureSchema } from "@k2b/cloud/services/postgres";
import type { SQL } from "bun";

/** Core owns durable assignments and the last observed domain check, independently of registry leases. */
export const migrate = async (db: SQL = sql): Promise<void> => {
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('core.settings.migrations', 0))`;
    await ensureSchema(tx, "settings");
    await tx.unsafe(APP_DOMAINS_DDL);
    await tx`CREATE INDEX IF NOT EXISTS app_domains_app_id ON settings.app_domains(app_id)`;
    await tx`ALTER TABLE settings.app_domains ADD COLUMN IF NOT EXISTS status JSONB`;
    await tx`ALTER TABLE settings.app_domains ADD COLUMN IF NOT EXISTS check_started_at TIMESTAMPTZ`;
  });
};
