import { expect } from "bun:test";
import { sql } from "bun";
import { connectTestNats, testFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import { cleanupFixtureBase, fixtureBase, fixtureStore, installFixtureStore } from "../store/base-store.test-fixture";
import { createBaseLifecycle, startPulseBaseJobs, stopPulseBaseJobs, submitBaseLifecycleJob } from "./base-lifecycle";

const syncTest = testFor("database", "nats", "clickhouse");
syncTest(
  "coalesced recovery runs the lifecycle over NATS",
  async () => {
    await installFixtureStore();
    const { createSync } = await import("@k2b/sync"),
      { bindProcessSync, unbindProcessSync } = await import("@k2b/cloud");
    const connection = await connectTestNats({ ignoreClusterUpdates: true });
    const sync = createSync({
      connection,
      namespace: testSyncNamespace("pulse-lifecycle"),
      application: "pulse",
      defaults: { replicas: 1 },
    });
    const base = await fixtureBase();
    bindProcessSync(sync);
    try {
      await submitBaseLifecycleJob(base.id, base.shortId);
      await submitBaseLifecycleJob(base.id, base.shortId);
      await startPulseBaseJobs(createBaseLifecycle(fixtureStore()));
      const end = Date.now() + 20000;
      let done = false;
      while (Date.now() < end) {
        const rows = await sql`SELECT state FROM pulse.base_stores WHERE base_id=${base.id}::uuid`;
        if (rows[0]?.state === "active") {
          done = true;
          break;
        }
        await Bun.sleep(50);
      }
      expect(done).toBe(true);
    } finally {
      await stopPulseBaseJobs();
      await sync.drain({ timeoutMs: 5000 });
      unbindProcessSync();
      await connection.drain();
      await cleanupFixtureBase(base);
    }
  },
  60_000,
);
