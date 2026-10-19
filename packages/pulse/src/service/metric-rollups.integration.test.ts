import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { installFixtureStore } from "../store/base-store.test-fixture";
import { createHourlyRollup } from "./metric-rollups";
import { createRetention } from "./retention";
import { assertWrite, writeFixture } from "./write.test-fixture";

suiteFor("database", "clickhouse")("Pulse ClickHouse hourly values", () => {
  beforeAll(installFixtureStore, 30000);
  test("#3 sparse counters, resets, late corrections, empty hours, and a predecessor after the raw partition is dropped", async () => {
    const f = await writeFixture("rollups"),
      run = createHourlyRollup({ store: f.store });
    const expire = () =>
      sql`UPDATE pulse.metric_hours SET lease_until=${new Date(f.clock().getTime() - 1)} WHERE base_id=${f.base.id}::uuid`;
    const samples = [
      { ts: "2026-10-15T00:05:00Z", value: 10 },
      { ts: "2026-10-15T02:05:00Z", value: 25 },
      { ts: "2026-10-15T02:15:00Z", value: 3 },
      { ts: "2026-10-15T05:05:00Z", value: 9 },
    ];
    try {
      await f.stopMerges();
      assertWrite(await f.write({ metrics: samples.map((s) => ({ name: "requests", type: "counter", ...s })) }));
      await expire();
      expect(await run(f.base.id)).toEqual({ buckets: 1, done: false });
      const [clean] = await sql`SELECT count(*)::int AS n FROM pulse.metric_hours WHERE base_id=${f.base.id}::uuid AND state='clean'`;
      expect(clean?.n).toBe(1);
      expect(await run(f.base.id)).toEqual({ buckets: 1, done: false });
      expect(await run(f.base.id)).toEqual({ buckets: 1, done: false });
      expect(await run(f.base.id)).toEqual({ buckets: 0, done: true });
      let rows = await f.read("rollups", "sample_count,increase,increase_seconds", "ORDER BY bucket");
      expect(rows.map((r) => [Number(r.sample_count), Number(r.increase), Number(r.increase_seconds)])).toEqual([
        [1, 0, 0],
        [2, 18, 7800],
        [1, 6, 10200],
      ]);
      f.setTime("2026-10-17T12:00:00.001Z");
      assertWrite(await f.writeB({ metrics: [{ name: "requests", type: "counter", ...samples[0]!, value: 12 }] }));
      const dirty = await sql<
        { hour: Date }[]
      >`SELECT hour FROM pulse.metric_hours WHERE base_id=${f.base.id}::uuid AND state='dirty' ORDER BY hour`;
      expect(dirty.map((r) => r.hour.toISOString())).toEqual(["2026-10-15T00:00:00.000Z", "2026-10-15T02:00:00.000Z"]);
      await expire();
      await run(f.base.id);
      await run(f.base.id);
      rows = await f.read("rollups", "increase,increase_seconds", "ORDER BY bucket");
      expect(rows.map((r) => Number(r.increase))).toEqual([0, 16, 6]);
      // Seal and drop one full raw day. The next hour must use the previous hourly value as its counter base.
      await sql`UPDATE pulse.bases SET retention_days=1 WHERE id=${f.base.id}::uuid`;
      expect((await createRetention({ store: f.store })(f.base.id)).rawPartitions).toBe(1);
      expect(await f.read("samples", "count() AS n").then((r) => Number(r[0]?.n))).toBe(0);
      assertWrite(await f.write({ metrics: [{ name: "requests", type: "counter", value: 20, ts: "2026-10-17T10:05:00Z" }] }));
      await expire();
      await run(f.base.id);
      const [latest] = await f.read("rollups", "increase,increase_seconds", "ORDER BY bucket DESC LIMIT 1");
      expect(Number(latest?.increase)).toBe(11);
      expect(Number(latest?.increase_seconds)).toBe(190800);
    } finally {
      await f.cleanup();
    }
  }, 120000);
  test("#3 gauges have no increase and an empty dirty hour emits no hourly value", async () => {
    const f = await writeFixture("rollup-empty"),
      run = createHourlyRollup({ store: f.store });
    try {
      assertWrite(
        await f.write({
          metrics: [
            { name: "temperature", value: 5, ts: "2026-10-17T08:10:00Z" },
            { name: "temperature", value: 2, ts: "2026-10-17T10:10:00Z" },
            { name: "temperature", value: 8, ts: "2026-10-17T10:20:00Z" },
          ],
        }),
      );
      await sql`INSERT INTO pulse.metric_hours(base_id,hour,state,lease_until,updated_at)
        VALUES(${f.base.id}::uuid,${new Date("2026-10-17T09:00:00Z")},'dirty',${f.clock()},${f.clock()})`;
      await sql`UPDATE pulse.metric_hours SET lease_until=${new Date(f.clock().getTime() - 1)} WHERE base_id=${f.base.id}::uuid`;
      for (let i = 0; i < 3; i++) expect(await run(f.base.id)).toEqual({ buckets: 1, done: false });
      expect(await run(f.base.id)).toEqual({ buckets: 0, done: true });
      const rows = await f.read(
        "rollups",
        "sample_count,value_sum,value_min,value_max,last_value,increase,increase_seconds",
        "ORDER BY bucket",
      );
      expect(rows.map((r) => Object.fromEntries(Object.entries(r).map(([key, value]) => [key, Number(value)])))).toEqual([
        { sample_count: 1, value_sum: 5, value_min: 5, value_max: 5, last_value: 5, increase: 0, increase_seconds: 0 },
        { sample_count: 2, value_sum: 10, value_min: 2, value_max: 8, last_value: 8, increase: 0, increase_seconds: 0 },
      ]);
    } finally {
      await f.cleanup();
    }
  }, 60000);
  test("#3 a revision changed during recomputation stays dirty; dirty leases defer work", async () => {
    const f = await writeFixture("rollup-cas");
    try {
      const metric = { name: "load", value: 1, ts: "2026-10-17T10:00:00Z" };
      assertWrite(await f.write({ metrics: [metric] }));
      const run = createHourlyRollup({ store: f.store });
      expect(await run(f.base.id)).toEqual({ buckets: 0, done: true });
      await sql`UPDATE pulse.metric_hours SET lease_until=${new Date(f.clock().getTime() - 1)} WHERE base_id=${f.base.id}::uuid`;
      const query = f.store.query;
      let corrected = false;
      f.store.query = async (statement, params) => {
        const result = await query(statement, params);
        if (!corrected && statement.startsWith("INSERT INTO") && statement.includes("._rollups")) {
          corrected = true;
          f.setTime("2026-10-17T12:00:00.001Z");
          assertWrite(await f.writeB({ metrics: [{ ...metric, value: 5 }] }));
        }
        return result;
      };
      await run(f.base.id);
      const [row] = await sql`SELECT state,revision FROM pulse.metric_hours WHERE base_id=${f.base.id}::uuid`;
      expect(row?.state).toBe("dirty");
      expect(Number(row?.revision)).toBe(2);
      await sql`UPDATE pulse.metric_hours SET lease_until=${new Date(f.clock().getTime() - 1)} WHERE base_id=${f.base.id}::uuid`;
      await run(f.base.id);
      expect(await f.read("rollups", "last_value")).toEqual([{ last_value: 5 }]);
    } finally {
      await f.cleanup();
    }
  }, 60000);
});
