import { expect } from "bun:test";
import { sql } from "bun";
import { connectTestNats, testFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import { installFixtureStore } from "../store/base-store.test-fixture";
import { createHourlyRollup } from "./metric-rollups";
import { assertWrite, writeFixture } from "./write.test-fixture";

testFor("database", "nats", "clickhouse")(
  "#3 NATS resubmits one-hour ClickHouse rollups until catch-up finishes",
  async () => {
    await installFixtureStore();
    const f = await writeFixture("runtime-rollup");
    const { createSync } = await import("@k2b/sync");
    const connection = await connectTestNats({ ignoreClusterUpdates: true });
    const sync = createSync({
      connection,
      namespace: testSyncNamespace("pulse-write-runtime"),
      application: "pulse",
      defaults: { replicas: 1 },
    });
    const job = sync.job<void>({ id: "pulse:rollup:hourly", delivery: { ackWaitMs: 60000, maxAttempts: 3, backoffMs: [100, 500] } });
    let runs = 0,
      finished = false;
    const run = createHourlyRollup({ store: f.store });
    const worker = await job.process({}, async (context) => {
      const result = await run(f.base.id);
      runs++;
      if (!result.done) context.resubmit();
      else finished = true;
    });
    try {
      assertWrite(
        await f.write({
          metrics: [
            { name: "load", value: 1, ts: "2026-10-17T09:00:00Z" },
            { name: "load", value: 2, ts: "2026-10-17T10:00:00Z" },
          ],
        }),
      );
      await sql`UPDATE pulse.metric_hours SET lease_until=${new Date(f.clock().getTime() - 1)} WHERE base_id=${f.base.id}::uuid`;
      await job.submit({ key: "frozen-slot", input: undefined });
      const deadline = performance.now() + 20000;
      while (!finished && performance.now() < deadline) await Bun.sleep(20);
      expect(finished).toBe(true);
      expect(runs).toBe(3);
      expect(Number((await f.read("rollups", "count() AS n"))[0]?.n)).toBe(2);
    } finally {
      await worker.drain();
      await sync.drain({ timeoutMs: 5000 });
      await connection.drain();
      await f.cleanup();
    }
  },
  60000,
);
