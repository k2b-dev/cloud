import { afterAll, beforeAll, expect } from "bun:test";
import { getProcessSync } from "@k2b/cloud";
import { testFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate";
import { startGridsTestSync } from "../sync-test-utils";
import { FIELD_INDEX_MAINTENANCE_LOCK, runFieldIndexMaintenanceBatch } from "./field-indexes";

const maintenanceTest = testFor("database", "nats");
let stopSync: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (!testInfra.database || !testInfra.nats) return;
  await migrate();
  stopSync = await startGridsTestSync();
});
afterAll(async () => {
  await stopSync?.();
});

/** Another Grids process holding the maintenance lease with a short TTL. */
const otherProcess = () => getProcessSync().mutex({ id: "grids:field-index-maintenance", ttlMs: 1_000, retry: { maxAttempts: 1 } });

maintenanceTest("one process at a time maintains field indexes", async () => {
  const held = await otherProcess().acquire({ resource: FIELD_INDEX_MAINTENANCE_LOCK });
  expect(held).not.toBeNull();
  try {
    expect(await runFieldIndexMaintenanceBatch({ maxFields: 1, maxOrphans: 1 })).toEqual({ claimed: false, changed: 0, hasMore: true });
  } finally {
    expect(await otherProcess().release(held!)).toBe(true);
  }
  expect((await runFieldIndexMaintenanceBatch({ maxFields: 1, maxOrphans: 1 })).claimed).toBe(true);
  expect((await runFieldIndexMaintenanceBatch({ maxFields: 1, maxOrphans: 1 })).claimed).toBe(true);
});

maintenanceTest("a crashed holder is replaced once its lease expires", async () => {
  expect(await otherProcess().acquire({ resource: FIELD_INDEX_MAINTENANCE_LOCK })).not.toBeNull();
  expect((await runFieldIndexMaintenanceBatch({ maxFields: 1, maxOrphans: 1 })).claimed).toBe(false);
  const deadline = Date.now() + 10_000;
  let claimed = false;
  while (!claimed && Date.now() < deadline) {
    await Bun.sleep(250);
    claimed = (await runFieldIndexMaintenanceBatch({ maxFields: 1, maxOrphans: 1 })).claimed;
  }
  expect(claimed).toBe(true);
});
