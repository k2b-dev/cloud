/** The production migration path, shared by the target bootstrap and template builder. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { sql } from "bun";
import { appIds, workspaceRoot } from "../workspace";
import { initializeTestPlatform, requireInfra } from "./test-infra";

export const migrateIntegrationDatabase = async (): Promise<void> => {
  await initializeTestPlatform();
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
};

if (import.meta.main) {
  if (Bun.argv.includes("--help")) {
    console.log(
      "Usage: bun --no-env-file scripts/fixtures/integration-migrations.ts\n\nMigrate the configured CLOUD_TEST_DATABASE_URL through Core and every application.",
    );
  } else {
    await requireInfra("database");
    try {
      await migrateIntegrationDatabase();
    } finally {
      await sql.close();
    }
  }
}
