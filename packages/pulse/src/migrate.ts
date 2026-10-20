import { ensureSchema } from "@k2b/cloud/services/postgres";
import { sql } from "bun";
import { installBaseline } from "./schema";
import { installBaseStores } from "./store/migration";

const MIGRATIONS = [
  { version: 1, name: "baseline", up: installBaseline },
  { version: 2, name: "base_stores", up: installBaseStores },
];

export const migrate = async (): Promise<void> => {
  await sql.begin(async (tx) => {
    // Shared with pre-ledger replicas during a rolling update.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('pulse.schema.install', 0))`;
    await ensureSchema(tx, "pulse");
    await tx`CREATE TABLE IF NOT EXISTS pulse.schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`.simple();
    const applied = await tx<{ version: number; name: string }[]>`SELECT version, name FROM pulse.schema_migrations ORDER BY version`;
    for (const row of applied) {
      if (!MIGRATIONS.some((migration) => migration.version === row.version && migration.name === row.name)) {
        throw new Error(`Pulse migration version ${row.version} is unknown: this image is older than the database.`);
      }
    }
    for (const migration of MIGRATIONS) {
      if (applied.some((row) => row.version === migration.version)) continue;
      await migration.up(tx);
      await tx`INSERT INTO pulse.schema_migrations (version, name) VALUES (${migration.version}, ${migration.name})`;
    }
  });
};
