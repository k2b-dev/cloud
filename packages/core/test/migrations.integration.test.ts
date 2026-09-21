import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite, useFreshDatabase } from "../../../scripts/fixtures/test-infra";

const suite = databaseSuite();

/** Everything a fresh installation runs: Core setup plus every built-in application schema. */
const runAllMigrations = async (): Promise<void> => {
  const { runCoreSetup } = await import("../src/runtime-helpers");
  await runCoreSetup();
  const applications = [
    "contacts",
    "dashboard",
    "faq",
    "filesv2",
    "gateway-ops",
    "grids",
    "ipa-hosts",
    "mail",
    "notebooks",
    "oauth",
    "proxy-auth",
    "spaces",
    "tools",
    "venue",
  ];
  for (const application of applications) {
    const { migrate } = (await import(`../../${application}/src/migrate`)) as { migrate: () => Promise<void> };
    await migrate();
  }
  const { initializeSchema } = await import("../../pulse/src/schema");
  await initializeSchema();
};

/** Catalog snapshot of every non-system schema: tables, columns, constraints and indexes. */
const snapshot = async (): Promise<unknown> => {
  const columns = await sql`
    SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema NOT LIKE 'pg_%'
    ORDER BY 1, 2, 3
  `;
  const constraints = await sql`
    SELECT n.nspname AS schema, c.conrelid::regclass::text AS table, c.conname AS name, pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_%'
    ORDER BY 1, 2, 3
  `;
  const indexes = await sql`
    SELECT schemaname, tablename, indexname, indexdef
    FROM pg_indexes
    WHERE schemaname NOT IN ('pg_catalog', 'information_schema') AND schemaname NOT LIKE 'pg_%'
    ORDER BY 1, 2, 3
  `;
  return { columns, constraints, indexes };
};

suite("Cloud schema migrations", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>> | undefined;

  beforeAll(async () => {
    database = await useFreshDatabase("core_migrations");
  });
  afterAll(async () => {
    await database?.drop();
  });

  test("a fresh installation migrates and a second run is a no-op", async () => {
    await runAllMigrations();
    const first = await snapshot();
    expect((first as { columns: unknown[] }).columns.length).toBeGreaterThan(0);
    await runAllMigrations();
    expect(await snapshot()).toEqual(first);
  }, 120_000);
});
