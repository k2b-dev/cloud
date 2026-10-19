import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { adminFixtureIdentity } from "../store/admin-identity.test-fixture";
import { installFixtureStore } from "../store/base-store.test-fixture";
import { quoteIdentifier as q } from "../store/validation";
import { listAdminBases } from "./base-admin";
import { createHourlyRollup } from "./metric-rollups";
import { createRetention } from "./retention";
import { assertWrite, writeFixture } from "./write.test-fixture";

suiteFor(
  "database",
  "valkey",
  "clickhouse",
)("Pulse ClickHouse hourly values", () => {
  beforeAll(installFixtureStore, 30000);
  test("clean history uses its rollup predecessor without scanning old raw samples", async () => {
    const f = await writeFixture("rollup-bounded-history"),
      run = createHourlyRollup({ store: f.store });
    const expire = () => sql`UPDATE pulse.metric_hours SET lease_until=${f.clock()} WHERE base_id=${f.base.id}::uuid`;
    try {
      await f.stopMerges();
      const historySize = 12_000;
      await sql`UPDATE pulse.base_stores SET values_per_minute=${historySize * 2} WHERE base_id=${f.base.id}::uuid`;
      assertWrite(
        await f.write({
          metrics: Array.from({ length: historySize }, (_, i) => ({
            name: "requests",
            type: "counter",
            value: i,
            ts: new Date(Date.parse("2026-10-15T00:00:00Z") + Math.floor(i / 1000) * 3_600_000 + (i % 1000) * 1000).toISOString(),
          })),
        }),
      );
      await expire();
      for (let i = 0; i < 12; i++) expect(await run(f.base.id)).toEqual({ buckets: 1, done: false });
      expect(await run(f.base.id)).toEqual({ buckets: 0, done: true });
      await f.store.query(`INSERT INTO ${q(f.base.database)}._samples(row_id,series_id,ts,value,version)
        SELECT generateUUIDv4(),series_id,toDateTime64('2026-10-15 11:59:00',3,'UTC'),12500,1 FROM ${q(f.base.database)}.series`);
      assertWrite(await f.write({ metrics: [{ name: "requests", type: "counter", value: 13000, ts: "2026-10-17T10:05:00Z" }] }));
      await expire();
      const comment = `bounded-rollup-${f.base.id}`;
      let queryLog = false;
      try {
        await f.store.query("SELECT 1 SETTINGS log_queries=1,log_queries_probability=1,log_comment={comment:String}", { comment });
        await f.store.query("SYSTEM FLUSH LOGS");
        queryLog =
          (
            await f.store.query("SELECT read_rows FROM system.query_log WHERE log_comment={comment:String} AND type='QueryFinish'", {
              comment,
            })
          ).length > 0;
      } catch {
        // The fixture service user normally cannot flush or read the system query log.
      }
      if (queryLog) {
        const query = f.store.query;
        f.store.query = (statement, params) =>
          query(
            statement.startsWith("INSERT INTO") && statement.includes("._rollups")
              ? `${statement} SETTINGS log_queries=1,log_queries_probability=1,log_comment={rollupComment:String}`
              : statement,
            { ...params, rollupComment: `${comment}-insert` },
          );
      } else console.info("Skipping rollup read_rows assertion: fixture user cannot flush/read query logs or query logging is disabled.");
      expect(await run(f.base.id)).toEqual({ buckets: 1, done: false });
      expect(await f.read("rollups", "increase", "ORDER BY bucket DESC LIMIT 1")).toEqual([{ increase: 1001 }]);
      if (queryLog) {
        await f.store.query("SYSTEM FLUSH LOGS");
        const [logged] = await f.store.query(
          "SELECT read_rows FROM system.query_log WHERE log_comment={comment:String} AND type='QueryFinish'",
          { comment: `${comment}-insert` },
        );
        expect(logged).toBeDefined();
        expect(Number(logged?.read_rows)).toBeLessThan(historySize);
      }
    } finally {
      await f.cleanup();
    }
  }, 120000);
  test("a failed older base hour is deferred while the next base proceeds and lag remains visible", async () => {
    const a = await writeFixture("rollup-failure-a"),
      b = await writeFixture("rollup-failure-b");
    const run = createHourlyRollup({ store: a.store });
    try {
      assertWrite(await a.write({ metrics: [{ name: "load", value: 1, ts: "2026-10-17T07:05:00Z" }] }));
      assertWrite(await b.write({ metrics: [{ name: "load", value: 2, ts: "2026-10-17T08:05:00Z" }] }));
      await sql`UPDATE pulse.metric_hours SET lease_until=${a.clock()} WHERE base_id IN (${a.base.id}::uuid,${b.base.id}::uuid)`;
      a.failInsert(1);
      await expect(run()).rejects.toThrow();
      const [deferred] = await sql<
        { state: string; lease_until: Date }[]
      >`SELECT state,lease_until FROM pulse.metric_hours WHERE base_id=${a.base.id}::uuid`;
      expect(deferred?.state).toBe("dirty");
      expect(deferred?.lease_until.toISOString()).toBe("2026-10-17T13:00:00.000Z");
      a.recover();
      expect(await run()).toEqual({ buckets: 1, done: false });
      expect(await b.read("rollups", "last_value")).toEqual([{ last_value: 2 }]);
      expect(await a.read("rollups", "count() AS n")).toEqual([{ n: 0 }]);
      expect((await listAdminBases(adminFixtureIdentity(), { q: a.base.shortId }, a.clock)).items[0]?.rollupLag).toBe(true);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  }, 60000);
  test("a lost advisory claim ends the tick without spinning", async () => {
    const f = await writeFixture("rollup-lost-claim"),
      run = createHourlyRollup({ store: f.store });
    try {
      assertWrite(await f.write({ metrics: [{ name: "load", value: 1, ts: "2026-10-17T10:05:00Z" }] }));
      await sql`UPDATE pulse.metric_hours SET lease_until=${f.clock()} WHERE base_id=${f.base.id}::uuid`;
      await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`pulse.rollup:${f.base.id}:2026-10-17T10:00:00.000Z`},0))`;
        expect(await run(f.base.id)).toEqual({ buckets: 0, done: true });
      });
      expect(await run(f.base.id)).toEqual({ buckets: 1, done: false });
    } finally {
      await f.cleanup();
    }
  }, 60000);
  test("a partial write preserves the watermark so an earlier counter dirties and repairs its successor hour", async () => {
    const f = await writeFixture("partial-counter"),
      run = createHourlyRollup({ store: f.store });
    const expire = () =>
      sql`UPDATE pulse.metric_hours SET lease_until=${new Date(f.clock().getTime() - 1)} WHERE base_id=${f.base.id}::uuid`;
    try {
      await f.stopMerges();
      // _series and _samples succeed; _events fails and rolls back T2 only.
      f.failInsert(3);
      expect(
        await f.write({
          metrics: [{ name: "requests", type: "counter", value: 30, ts: "2026-10-17T10:05:00Z" }],
          events: [{ kind: "failed" }],
        }),
      ).toMatchObject({ ok: false, error: { status: 503 } });
      expect(await f.read("samples", "value")).toEqual([{ value: 30 }]);
      f.recover();
      await expire();
      await run(f.base.id);
      expect(await f.read("rollups", "increase")).toEqual([{ increase: 0 }]);
      f.setTime("2026-10-17T12:00:00.001Z");
      assertWrite(await f.writeB({ metrics: [{ name: "requests", type: "counter", value: 10, ts: "2026-10-17T08:05:00Z" }] }));
      const dirty = await sql<
        { hour: Date }[]
      >`SELECT hour FROM pulse.metric_hours WHERE base_id=${f.base.id}::uuid AND state='dirty' ORDER BY hour`;
      expect(dirty.map((r) => r.hour.toISOString())).toEqual(["2026-10-17T08:00:00.000Z", "2026-10-17T10:00:00.000Z"]);
      await expire();
      await run(f.base.id);
      await run(f.base.id);
      expect(await f.read("rollups", "increase,increase_seconds", "ORDER BY bucket DESC LIMIT 1")).toEqual([
        { increase: 20, increase_seconds: 7200 },
      ]);
    } finally {
      await f.cleanup();
    }
  }, 60000);
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
      expect(dirty.map((r) => r.hour.toISOString())).toEqual([
        "2026-10-15T00:00:00.000Z",
        "2026-10-15T02:00:00.000Z",
        "2026-10-15T05:00:00.000Z",
      ]);
      await expire();
      await run(f.base.id);
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
