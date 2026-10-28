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
    "pulse",
    "spaces",
    "tools",
    "venue",
  ];
  for (const application of applications) {
    const { migrate } = (await import(`../../${application}/src/migrate`)) as { migrate: () => Promise<void> };
    await migrate();
  }
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
  test("Core startup does not scan application JSON or classify historical candidates", async () => {
    const id = crypto.randomUUID();
    const owner = crypto.randomUUID();
    await sql`INSERT INTO auth.groups(id,cn,provider,name,gid_number) VALUES(${id}::uuid,'local:startup_history','local','startup_history',890001)`;
    await sql`INSERT INTO auth.posix_allocations(kind,number,owner_id) VALUES('gid',890001,${id}::uuid),('uid',890001,${owner}::uuid)`;
    await sql`INSERT INTO audit.events(action,outcome,target_type,target_id,metadata)
      VALUES('accounts.linux.provision','allowed','user',${owner},${JSON.stringify({ primaryGroupId: id, uidNumber: 890001, gidNumber: 890001 })}::text::jsonb)`;
    await sql`CREATE TABLE grids.startup_history_probe(data JSONB)`.simple();
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const writer = sql.begin(async (tx) => {
      await tx`LOCK TABLE grids.startup_history_probe IN ACCESS EXCLUSIVE MODE`.simple();
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const { runCoreSetup } = await import("../src/runtime-helpers");
    const setup = runCoreSetup();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        setup,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Core startup inspected application JSON")), 5000);
        }),
      ]);
      expect(await sql`SELECT id FROM auth.groups WHERE id=${id}::uuid`).toHaveLength(1);
      expect(await sql`SELECT * FROM auth.personal_group_review WHERE group_id=${id}::uuid`).toHaveLength(0);
    } finally {
      clearTimeout(timer);
      release.resolve();
      await writer;
      await setup;
      await sql`DROP TABLE grids.startup_history_probe`.simple();
    }
  }, 30_000);
});
