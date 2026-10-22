import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { sql } from "bun";
import { createDisposableDatabase, suiteFor, testInfra } from "../../../scripts/fixtures/test-infra";
import { migrate as migratePulse } from "./migrate";

const migrate = () => migratePulse("Europe/Berlin");

const enabled = testInfra.database !== undefined,
  databaseTest = enabled ? test : test.skip;
let database: Awaited<ReturnType<typeof createDisposableDatabase>> | undefined;
const base = "11111111-1111-4111-8111-111111111111",
  source = "22222222-2222-4222-8222-222222222222",
  account = "33333333-3333-4333-8333-333333333333",
  access = "44444444-4444-4444-8444-444444444444";
beforeAll(async () => {
  if (!enabled) return;
  database = await createDisposableDatabase("pulse_schema");
  process.env.DATABASE_URL = database.url;
  const [row] = await sql`SELECT current_database() AS name`;
  if (row?.name !== database.name) throw new Error("Schema tests need their own database; run this file in its own process");
});
afterAll(async () => {
  if (database) {
    await sql.close();
    await database.drop();
  }
});
const seedOld = async (ledger: boolean) => {
  await sql`DROP SCHEMA pulse CASCADE`.simple();
  await sql`CREATE SCHEMA pulse`.simple();
  await sql`CREATE TABLE pulse.bases(id UUID PRIMARY KEY,short_id TEXT)`.simple();
  await sql`CREATE TABLE pulse.sources(id UUID PRIMARY KEY,base_id UUID REFERENCES pulse.bases(id),short_id TEXT)`.simple();
  await sql`CREATE TABLE pulse.base_access(base_id UUID,access_id UUID REFERENCES auth.access(id))`.simple();
  await sql`INSERT INTO pulse.bases VALUES(${base}::uuid,'Old001')`;
  await sql`INSERT INTO pulse.sources VALUES(${source}::uuid,${base}::uuid,'Old002')`;
  await sql`INSERT INTO auth.access VALUES(${access}::uuid)`;
  await sql`INSERT INTO pulse.base_access VALUES(${base}::uuid,${access}::uuid)`;
  await sql`INSERT INTO auth.service_accounts(id,kind,app_id,resource_type,resource_id) VALUES(${account}::uuid,'resource_bound','pulse','pulse_source','Old002')`;
  await sql`INSERT INTO auth.service_account_credentials VALUES(${account}::uuid)`;
  if (ledger) {
    await sql`CREATE TABLE pulse.schema_migrations(version INT PRIMARY KEY,name TEXT NOT NULL UNIQUE,applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`.simple();
    await sql`INSERT INTO pulse.schema_migrations(version,name) VALUES(1,'baseline'),(2,'base_stores')`;
  } else await sql`CREATE TABLE pulse.installation(installed_at TIMESTAMPTZ)`.simple();
};
const removeOverviewMigration = async () => {
  await sql`DELETE FROM pulse.schema_migrations WHERE version=5`;
  await sql`DROP TABLE pulse.overview_state,pulse.alert_states,pulse.alert_rules,pulse.alert_rule_operations,pulse.base_activity`.simple();
  await sql`ALTER TABLE pulse.notification_outbox DROP CONSTRAINT pulse_notification_destination,
    DROP CONSTRAINT pulse_notification_event_recipient, DROP COLUMN base_id,DROP COLUMN event_id,
    DROP COLUMN recipient_after,DROP COLUMN dispatch_kind,ALTER COLUMN user_id SET NOT NULL`.simple();
  await sql`ALTER TABLE pulse.sources DROP CONSTRAINT pulse_source_expectation,
    DROP COLUMN expect_every_seconds,DROP COLUMN expect_daily_by,DROP COLUMN stale_since,
    DROP COLUMN revision,DROP COLUMN next_freshness_check_at`.simple();
  await sql`ALTER TABLE pulse.saved_queries DROP COLUMN pinned`.simple();
  await sql`ALTER TABLE pulse.base_stores DROP COLUMN max_alert_rules`.simple();
};
suiteFor("database")("#9 disposable Pulse ClickHouse baseline", () => {
  databaseTest(
    "fresh installation is atomic and creates no extension",
    async () => {
      await expect(migrate()).rejects.toThrow();
      const [absent] = await sql`SELECT to_regnamespace('pulse') IS NULL AS absent`;
      expect(absent?.absent).toBe(true);
      await sql`CREATE SCHEMA auth`.simple();
      await sql`CREATE TABLE auth.users(id UUID PRIMARY KEY)`.simple();
      await sql`CREATE TABLE auth.access(id UUID PRIMARY KEY)`.simple();
      await sql`CREATE TABLE auth.service_accounts(id UUID PRIMARY KEY,kind TEXT,app_id TEXT,resource_type TEXT,resource_id TEXT)`.simple();
      await sql`CREATE TABLE auth.service_account_credentials(service_account_id UUID REFERENCES auth.service_accounts(id) ON DELETE CASCADE)`.simple();
      const extensions = await sql`SELECT extname FROM pg_extension ORDER BY extname`;
      await Promise.all([migrate(), migrate()]);
      expect(await sql<{ version: number; name: string }[]>`SELECT version,name FROM pulse.schema_migrations`).toEqual([
        { version: 3, name: "clickhouse_baseline" },
        { version: 4, name: "sql_console" },
        { version: 5, name: "overview_alerts" },
        { version: 7, name: "sql_dashboards" },
      ]);
      expect(await sql`SELECT extname FROM pg_extension ORDER BY extname`).toEqual(extensions);
      const ddl = await readFile(`${import.meta.dir}/schema.ts`, "utf8");
      expect(ddl).not.toMatch(/CREATE\s+EXTENSION/i);
      const [installation] = await sql`SELECT to_regclass('pulse.installation') IS NULL AS absent`;
      expect(installation?.absent).toBe(true);
      const tables = await sql<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname='pulse' ORDER BY tablename`;
      expect(tables.map((t) => t.tablename)).toEqual([
        "alert_rule_operations",
        "alert_rules",
        "alert_states",
        "base_access",
        "base_activity",
        "base_internal_targets",
        "base_stores",
        "bases",
        "dashboard_operations",
        "dashboard_runs",
        "dashboards",
        "event_kinds",
        "ingest_idempotency",
        "metric_defs",
        "metric_hours",
        "metric_series",
        "notification_outbox",
        "overview_state",
        "saved_queries",
        "saved_query_operations",
        "schema_migrations",
        "source_scrapes",
        "sources",
        "state_keys",
        "state_variants",
        "store_instance",
      ]);
    },
    30000,
  );
  for (const ledger of [true, false])
    databaseTest(
      `resets ${ledger ? "slice-1/2 ledger" : "pre-ledger installation"} without copying or confirmation and restarts as a no-op`,
      async () => {
        await seedOld(ledger);
        await migrate();
        expect(await sql`SELECT id FROM pulse.bases`).toHaveLength(0);
        expect(await sql`SELECT id FROM pulse.sources`).toHaveLength(0);
        expect(await sql`SELECT id FROM auth.service_accounts WHERE id=${account}::uuid`).toHaveLength(0);
        expect(await sql`SELECT * FROM auth.service_account_credentials`).toHaveLength(0);
        expect(await sql`SELECT id FROM auth.access WHERE id=${access}::uuid`).toHaveLength(0);
        await sql`INSERT INTO pulse.bases(id,short_id,name) VALUES(${base}::uuid,'New001','Preserved')`;
        const before = await sql`SELECT * FROM pulse.schema_migrations`;
        await migrate();
        expect(await sql`SELECT * FROM pulse.schema_migrations`).toEqual(before);
        expect(await sql<{ name: string }[]>`SELECT name FROM pulse.bases WHERE id=${base}::uuid`).toEqual([{ name: "Preserved" }]);
      },
      30000,
    );
  databaseTest("migration 4 upgrades an existing baseline once under concurrent startup", async () => {
    await removeOverviewMigration();
    await sql`DELETE FROM pulse.schema_migrations WHERE version=4`;
    await sql`DROP TABLE pulse.saved_query_operations,pulse.saved_queries`.simple();
    await sql`ALTER TABLE pulse.bases DROP COLUMN icon,DROP COLUMN color,DROP COLUMN timezone`.simple();
    await sql`ALTER TABLE pulse.base_stores DROP COLUMN queries_per_hour`.simple();
    await Promise.all([migrate(), migrate(), migrate()]);
    expect(await sql`SELECT version FROM pulse.schema_migrations WHERE version=4`).toHaveLength(1);
    const [baseRow] = await sql`SELECT icon,color,timezone FROM pulse.bases WHERE id=${base}::uuid`;
    expect(baseRow).toEqual({ icon: "ti ti-chart-line", color: "blue", timezone: "Europe/Berlin" });
    const [quota] =
      await sql`SELECT column_default FROM information_schema.columns WHERE table_schema='pulse' AND table_name='base_stores' AND column_name='queries_per_hour'`;
    expect(quota?.column_default).toBe("600");
    await migrate();
    expect(await sql`SELECT version FROM pulse.schema_migrations WHERE version=4`).toHaveLength(1);
  });
  databaseTest("migration 5 preserves saved SQL and adds expectations once under concurrent startup", async () => {
    await removeOverviewMigration();
    await sql`INSERT INTO pulse.saved_queries(short_id,base_id,name,sql) VALUES('Query5',${base}::uuid,'Preserved SQL','SELECT 1')`;
    await Promise.all([migrate(), migrate(), migrate()]);
    expect(await sql`SELECT version FROM pulse.schema_migrations WHERE version=5`).toHaveLength(1);
    expect(
      await sql<{ name: string; sql: string; pinned: boolean }[]>`SELECT name,sql,pinned FROM pulse.saved_queries WHERE short_id='Query5'`,
    ).toEqual([{ name: "Preserved SQL", sql: "SELECT 1", pinned: false }]);
    const [budget] = await sql`SELECT column_default FROM information_schema.columns
      WHERE table_schema='pulse' AND table_name='base_stores' AND column_name='max_alert_rules'`;
    expect(budget?.column_default).toBe("20");
    await sql`INSERT INTO pulse.sources(id,short_id,base_id,name,kind) VALUES(${source}::uuid,'Push05',${base}::uuid,'Daily push','http_ingest')`;
    await sql`UPDATE pulse.sources SET expect_daily_by='04:00' WHERE id=${source}::uuid`;
    await expect(sql`UPDATE pulse.sources SET expect_every_seconds=60 WHERE id=${source}::uuid`.execute()).rejects.toThrow();
    await expect(sql`UPDATE pulse.sources SET expect_daily_by='24:00' WHERE id=${source}::uuid`.execute()).rejects.toThrow();
    await expect(sql`UPDATE pulse.sources SET kind='metrics' WHERE id=${source}::uuid`.execute()).rejects.toThrow();
    await migrate();
    expect(
      await sql<
        { expect_daily_by: string; stale_since: Date | null }[]
      >`SELECT expect_daily_by,stale_since FROM pulse.sources WHERE id=${source}::uuid`,
    ).toEqual([{ expect_daily_by: "04:00", stale_since: null }]);
  });
  databaseTest("refuses unknown newer versions before touching old data", async () => {
    await sql`INSERT INTO pulse.schema_migrations(version,name) VALUES(99,'future')`;
    const before = await sql`SELECT * FROM pulse.schema_migrations ORDER BY version`;
    await expect(migrate()).rejects.toThrow("image is older than the database");
    expect(await sql`SELECT * FROM pulse.schema_migrations ORDER BY version`).toEqual(before);
    expect(await sql<{ name: string }[]>`SELECT name FROM pulse.bases WHERE id=${base}::uuid`).toEqual([{ name: "Preserved" }]);
  });
});
