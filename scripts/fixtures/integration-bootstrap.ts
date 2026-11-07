/**
 * Creates the target integration database if missing and prepares it once per `bun run test --integration`.
 *
 * Runs the real production migration path: Core setup first, then every
 * application `migrate()`. All of them are
 * idempotent, so re-running against an already prepared database is a no-op.
 *
 *   CLOUD_TEST_DATABASE_URL=postgres://…/<name>_test bun scripts/fixtures/integration-bootstrap.ts
 */
import { SQL } from "bun";
import { closeMigratedDatabaseTemplate, migratedDatabaseTemplate, quoteTestDatabase } from "./test-database-template";
import { requireDatabaseUrl, requireInfra } from "./test-infra";

// The fixture validates the expanded _test name on import; its target probe
// must wait until creation through the server's maintenance database.
if (Bun.argv.includes("--help")) {
  console.log(
    "Usage: bun --no-env-file scripts/fixtures/integration-bootstrap.ts\n\nPrepare the configured CLOUD_TEST_DATABASE_URL and a source-keyed migration template.",
  );
  process.exit(0);
}

const maintenanceUrl = new URL(requireDatabaseUrl());
const name = decodeURIComponent(maintenanceUrl.pathname.slice(1));
maintenanceUrl.pathname = "/postgres";
const admin = new SQL(maintenanceUrl.toString());
try {
  const exists = async (): Promise<boolean> => {
    const [row] = await admin<{ found: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${name}) AS found`;
    return row!.found;
  };
  if (!(await exists())) {
    try {
      await admin.unsafe(`CREATE DATABASE ${quoteTestDatabase(name)}`);
    } catch (error) {
      // Concurrent creators can report duplicate_database or a catalog unique violation.
      if (!(error instanceof SQL.PostgresError) || !["42P04", "23505"].includes(error.errno ?? "") || !(await exists())) throw error;
    }
  }
} finally {
  await admin.close();
}

await requireInfra("database");

try {
  await migratedDatabaseTemplate(requireDatabaseUrl());
  const { migrateIntegrationDatabase } = await import("./integration-migrations");
  await migrateIntegrationDatabase();
  console.log(`integration database prepared: ${new URL(process.env.DATABASE_URL ?? "").pathname.slice(1)}`);
} finally {
  await closeMigratedDatabaseTemplate();
}
