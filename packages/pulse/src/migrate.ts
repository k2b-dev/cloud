import { deleteAccess } from "@k2b/cloud/server";
import { logger, get as settingsGet } from "@k2b/cloud/services";
import { ensureSchema } from "@k2b/cloud/services/postgres";
import { sql } from "bun";
import { BaseTimezoneSchema } from "./base-settings";
import { installAgentSourceOwnership, installBaseline, installOverviewAlerts, installSqlConsole } from "./schema";

const MIGRATIONS = [
  { version: 3, name: "clickhouse_baseline", up: installBaseline },
  { version: 4, name: "sql_console", up: installSqlConsole },
  { version: 5, name: "overview_alerts", up: installOverviewAlerts },
  { version: 6, name: "agent_source_ownership", up: installAgentSourceOwnership },
];
const log = logger("pulse:migrate");

export const migrate = async (timezone: string | undefined = undefined): Promise<void> => {
  // Resolve the setting outside the migration transaction to avoid waiting on a second pooled connection.
  const baseTimezone = BaseTimezoneSchema.parse(timezone ?? (await settingsGet<string>("app.timezone")));
  const removed = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('pulse.schema.install', 0))`;
    await ensureSchema(tx, "pulse");
    const ledger = () =>
      tx`CREATE TABLE IF NOT EXISTS pulse.schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`.simple();
    await ledger();
    let applied = await tx<{ version: number; name: string }[]>`SELECT version, name FROM pulse.schema_migrations ORDER BY version`;
    for (const row of applied) {
      if (row.version !== 1 && row.version !== 2 && !MIGRATIONS.some((m) => m.version === row.version && m.name === row.name))
        throw new Error(`Pulse migration version ${row.version} is unknown: this image is older than the database.`);
    }
    const [old] = await tx`SELECT to_regclass('pulse.installation') IS NOT NULL AS installed`;
    let counts: { bases: number; sources: number; tokens: number; accessRows: number } | undefined;
    if (old?.installed || applied.some((r) => r.version === 1 || r.version === 2)) {
      const [tables] =
        await tx`SELECT to_regclass('pulse.bases') IS NOT NULL AS bases, to_regclass('pulse.sources') IS NOT NULL AS sources, to_regclass('pulse.base_access') IS NOT NULL AS access`;
      const [bases] = tables?.bases ? await tx`SELECT count(*)::int AS n FROM pulse.bases` : [];
      const [sources] = tables?.sources ? await tx`SELECT count(*)::int AS n FROM pulse.sources` : [];
      const access = tables?.access ? await tx<{ access_id: string }[]>`SELECT DISTINCT access_id FROM pulse.base_access` : [];
      // The service-account deletion API uses the global connection, not this transaction.
      // Its SQL deletion (including credential cascades) is kept in the locked reset transaction.
      await tx`DROP SCHEMA pulse CASCADE`.simple();
      const tokens = await tx`DELETE FROM auth.service_accounts WHERE kind='resource_bound' AND app_id='pulse'`;
      const accessRows = access.length;
      for (const row of access) {
        await deleteAccess({ id: row.access_id }, tx);
      }
      counts = { bases: Number(bases?.n ?? 0), sources: Number(sources?.n ?? 0), tokens: tokens.count, accessRows };
      await ensureSchema(tx, "pulse");
      await ledger();
      applied = [];
    }
    for (const migration of MIGRATIONS) {
      if (applied.some((row) => row.version === migration.version)) continue;
      await migration.up(tx, baseTimezone);
      await tx`INSERT INTO pulse.schema_migrations(version,name) VALUES(${migration.version},${migration.name})`;
    }
    return counts;
  });
  if (removed) log.warn("Pulse ClickHouse baseline reset removed old data", removed);
};
