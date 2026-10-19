/**
 * Creates the target integration database if missing and prepares it once per `bun run test --integration`.
 *
 * Runs the real production migration path: Core setup first, then every
 * application `migrate()`. All of them are
 * idempotent, so re-running against an already prepared database is a no-op.
 *
 *   CLOUD_TEST_DATABASE_URL=postgres://…/<name>_test bun scripts/fixtures/integration-bootstrap.ts
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { appIds, workspaceRoot } from "../workspace";
import { requireDatabaseUrl, requireInfra } from "./test-infra";

// The fixture validates the expanded _test name on import; its target probe
// must wait until creation through the server's maintenance database.
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
      await admin.unsafe(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
    } catch (error) {
      // Concurrent creators can report duplicate_database or a catalog unique violation.
      if (!(error instanceof SQL.PostgresError) || !["42P04", "23505"].includes(error.errno ?? "") || !(await exists())) throw error;
    }
  }
} finally {
  await admin.close();
}

await requireInfra("database");

const { runCoreSetup } = await import("../../packages/core/src/runtime-helpers");
await runCoreSetup();

/** Applications whose schema setup does not live in `src/migrate.ts`. */
const migrationModules: Record<string, { path: string; export: string }> = {
  assistant: { path: "src/artifacts/migrate.ts", export: "migrateArtifacts" },
};

for (const appId of appIds()) {
  if (appId === "core" || appId === "gateway") continue;
  const special = migrationModules[appId];
  if (special) {
    const module = (await import(join(workspaceRoot, "packages", appId, special.path))) as Record<string, () => Promise<void>>;
    await module[special.export]!();
    continue;
  }
  const migratePath = join(workspaceRoot, "packages", appId, "src", "migrate.ts");
  if (existsSync(migratePath)) {
    const module = (await import(migratePath)) as { migrate?: () => Promise<void> };
    if (module.migrate) await module.migrate();
  }
}

console.log(`integration database prepared: ${new URL(process.env.DATABASE_URL ?? "").pathname.slice(1)}`);
