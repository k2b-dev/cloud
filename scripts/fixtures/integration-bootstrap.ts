/**
 * Prepares the shared integration database once per `bun run test --integration`.
 *
 * Runs the real production migration path: Core setup first, then every
 * application `migrate()` (or `initializeSchema()` for Pulse). All of them are
 * idempotent, so re-running against an already prepared database is a no-op.
 *
 *   CLOUD_TEST_DATABASE_URL=postgres://…/<name>_test bun scripts/fixtures/integration-bootstrap.ts
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { appIds, workspaceRoot } from "../workspace";
import { requireInfra } from "./test-infra";

await requireInfra("database");

const { runCoreSetup } = await import("../../packages/core/src/runtime-helpers");
await runCoreSetup();

/** Applications whose schema setup does not live in `src/migrate.ts`. */
const migrationModules: Record<string, { path: string; export: string }> = {
  assistant: { path: "src/artifacts/migrate.ts", export: "migrateArtifacts" },
  pulse: { path: "src/schema.ts", export: "initializeSchema" },
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
