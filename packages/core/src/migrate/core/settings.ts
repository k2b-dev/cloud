import { encryptValue } from "@valentinkolb/cloud/services/settings/crypto";
import { sql } from "bun";

export const migrate = async (db: typeof sql = sql): Promise<void> => {
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('core.settings.migrations', 0))`;
    const [before] = await tx<{ existing: boolean }[]>`SELECT to_regclass('settings.entries') IS NOT NULL AS existing`;
    await tx`CREATE SCHEMA IF NOT EXISTS settings`.simple();
    console.log("  ✓ settings schema");

    await tx`
    CREATE TABLE IF NOT EXISTS settings.entries (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();
    console.log("  ✓ settings.entries table");
    await tx`CREATE TABLE IF NOT EXISTS settings.migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`.simple();
    const applied =
      await tx`INSERT INTO settings.migrations(name) VALUES ('account-request-opt-in-v1') ON CONFLICT DO NOTHING RETURNING name`;
    // Preserve pre-opt-in installations once. A later reset to the false code
    // default must remain false across restarts; the receipt is not a setting.
    if (applied.length && before?.existing) {
      await tx`INSERT INTO settings.entries(key, value) VALUES ('user.account_requests.enabled', ${await encryptValue(true)}) ON CONFLICT DO NOTHING`;
    }
  });
};
