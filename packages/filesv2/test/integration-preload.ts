import { afterAll } from "bun:test";
import { createDisposableDatabase, initializeTestPlatform, ownTestDatabase, testInfra } from "../../../scripts/fixtures/test-infra";
import { closePlatformClients } from "../../cloud/src/runtime/clients";

/**
 * Filesv2 integration suites create stand-in `auth`/`settings`/`audit` tables
 * and truncate them, which is only safe in a database nobody else uses. The
 * platform `sql` handle is rebound here after selecting the private database,
 * before any test module loads. Run the suites with `bun test --isolate` so each file gets
 * its own fresh database.
 */
if (testInfra.database) {
  const database = await createDisposableDatabase("filesv2");
  process.env.DATABASE_URL = database.url;
  // Work an aborted test leaves running here ends after each test, instead of holding every later hook (#1797).
  ownTestDatabase(database.name);
  await initializeTestPlatform("filesv2");
  afterAll(async () => {
    await closePlatformClients();
    await database.drop();
  });
  // Real effects also record audit and logging data in this isolated database.
  const { migrate: migrateAudit } = await import("../../core/src/migrate/core/audit");
  const { migrate: migrateLogging } = await import("../../core/src/migrate/core/logging");
  await migrateAudit();
  await migrateLogging();
}
