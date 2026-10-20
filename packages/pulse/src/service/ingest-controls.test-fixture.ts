import { afterAll } from "bun:test";
import { sql } from "bun";
import { useFreshDatabase } from "../../../../scripts/fixtures/test-infra";

/** Instance-wide health transitions need their own database, never the other suites' singleton. */
export const installIngestControlsFixture = async () => {
  const database = await useFreshDatabase("pulse_ingest_controls");
  afterAll(async () => {
    (await import("./ingest-quota")).ingestQuota.close();
    await sql.close();
    await database.drop();
  });
  const { runCoreSetup } = await import("../../../core/src/runtime-helpers");
  await runCoreSetup();
  await (await import("../store/base-store.test-fixture")).installFixtureStore();
  // Tests control measurements explicitly; host disk utilization is not a test fixture.
  await (await import("./store-health")).recordInstanceDisk(50, 100, new Date("2026-10-17T12:00:00Z"));
};
