import { beforeAll, expect, test } from "bun:test";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { createBaseLifecycle } from "../service/base-lifecycle";
import { parsePrometheusMetrics } from "../service/metrics-scraper";
import { cleanupFixtureBase, fixtureBase, fixtureConnection, fixtureStore, installFixtureStore } from "./base-store.test-fixture";
import { clickhouseQuery, StoreQueryError } from "./client";
import { createSqlRunner } from "./sql-run";
import { quoteIdentifier as q } from "./validation";

suiteFor("database", "clickhouse")("Pulse per-base SQL helpers", () => {
  beforeAll(installFixtureStore, 30_000);
  const setup = async () => {
    const base = await fixtureBase(),
      store = fixtureStore();
    await createBaseLifecycle(store)(base.id);
    // ClickHouse has its own clock. Preserve fixed historical rollup fixtures
    // even when this suite runs after their production retention would expire.
    await store.query(`ALTER TABLE ${q(base.database)}._rollups REMOVE TTL`);
    const credentials = await store.readUserCredentials(base.id);
    const read = (query: string) => clickhouseQuery({ ...fixtureConnection(), ...credentials, query, timeoutMs: 12_000 });
    const addSeries = async (id: string, metric: string, dimensions = "{}") => {
      await store.query(
        `INSERT INTO ${q(base.database)}._series(series_id,metric,type,unit,dimensions,version)
        VALUES({id:UUID},{metric:String},'counter','',{dimensions:String},1)`,
        { id, metric, dimensions },
      );
    };
    const addSample = async (id: string, ts: string, value: number) => {
      await store.query(
        `INSERT INTO ${q(base.database)}._samples(row_id,series_id,ts,value,version)
        VALUES(generateUUIDv4(),{id:UUID},parseDateTime64BestEffort({ts:String},3),{value:Float64},1)`,
        { id, ts, value },
      );
    };
    const runner = createSqlRunner({ store, connection: async () => fixtureConnection() });
    const run = (sql: string) =>
      runner.run({
        baseId: base.id,
        database: base.database,
        profile: "normal",
        timezone: "UTC",
        sql,
        runId: "44444444-4444-4444-8444-444444444444",
      });
    return { base, store, read, run, addSeries, addSample };
  };
  test("increase and rate cross raw/hourly retention without double counting and handle resets", async () => {
    const f = await setup(),
      id = "11111111-1111-4111-8111-111111111111";
    try {
      await f.addSeries(id, "requests");
      await f.store.query(
        `INSERT INTO ${q(f.base.database)}._rollups
        VALUES({id:UUID},toDateTime('2026-10-20 10:00:00','UTC'),2,110,10,100,10,toDateTime64('2026-10-20 10:59:00',3,'UTC'),20,3600,1)`,
        { id },
      );
      await f.addSample(id, "2026-10-20T11:00:00Z", 15);
      await f.addSample(id, "2026-10-20T11:30:00Z", 3);
      await f.addSample(id, "2026-10-20T11:59:00Z", 8);
      for (const name of ["increase", "rate"]) {
        const [row] = await f.read(
          `SELECT * FROM ${q(f.base.database)}.${name}(metric='requests',from=toDateTime64('2026-10-20 10:00:00',3,'UTC'),to=toDateTime64('2026-10-20 12:00:00',3,'UTC'))`,
        );
        expect(Number(row?.increase)).toBe(33); // 20 hourly + (15-10) + reset 3 + (8-3)
        expect(Number(row?.seconds)).toBe(7200);
        if (name === "rate") expect(Number(row?.rate)).toBeCloseTo(33 / 7200, 10);
      }
      // Partial expired hours have no exact answer; refusing is better than inventing a prorated increase.
      await expect(
        f.read(
          `SELECT * FROM ${q(f.base.database)}.increase(metric='requests',from=toDateTime64('2026-10-20 10:30:00',3,'UTC'),to=toDateTime64('2026-10-20 12:00:00',3,'UTC'))`,
        ),
      ).rejects.toBeInstanceOf(StoreQueryError);
    } finally {
      await cleanupFixtureBase(f.base);
    }
  });
  test("Traefik histogram quantiles use bucket increases and refuse a changed boundary set", async () => {
    const f = await setup();
    try {
      const buckets = parsePrometheusMetrics(
        await Bun.file(`${import.meta.dir}/../service/fixtures/traefik-v3.prom`).text(),
      ).metrics.filter((m) => m.name === "traefik_entrypoint_request_duration_seconds_bucket");
      expect(buckets).toHaveLength(5);
      for (const [index, bucket] of buckets.entries()) {
        const id = `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`;
        await f.addSeries(id, bucket.name, JSON.stringify(bucket.dimensions));
        await f.store.query(
          `INSERT INTO ${q(f.base.database)}._rollups
          VALUES({id:UUID},toDateTime('2026-10-20 09:00:00','UTC'),2,15,0,15,15,toDateTime64('2026-10-20 09:59:00',3,'UTC'),15,3600,1)`,
          { id },
        );
        await f.addSample(id, "2026-10-20T10:00:00Z", 0);
        await f.addSample(id, "2026-10-20T10:01:00Z", bucket.value);
      }
      const query = `SELECT * FROM ${q(f.base.database)}.histogram_quantile(metric='traefik_entrypoint_request_duration_seconds',from=toDateTime64('2026-10-20 09:00:00',3,'UTC'),to=toDateTime64('2026-10-20 11:00:00',3,'UTC'),quantile=0.95)`;
      const [row] = await f.read(query);
      expect(Number(row?.quantile)).toBeCloseTo(0.095, 8);
      const changedId = "33333333-3333-4333-8333-333333333333";
      await f.addSeries(changedId, buckets[0]!.name, JSON.stringify({ ...buckets[0]!.dimensions, le: "0.2" }));
      await f.addSample(changedId, "2026-10-20T10:02:00Z", 20);
      await expect(f.run(query)).rejects.toMatchObject({
        code: "SQL_ERROR",
        message: expect.stringContaining("Histogram bucket bounds changed at 2026-10-20 10:02:00"),
      });
    } finally {
      await cleanupFixtureBase(f.base);
    }
  });
  test("calendar day buckets use Europe/Berlin across the 25 October 2026 DST change", async () => {
    const f = await setup();
    try {
      const [row] =
        await f.read(`SELECT dateDiff('second',toStartOfDay(toDateTime('2026-10-25 12:00:00','Europe/Berlin')),toStartOfDay(toDateTime('2026-10-26 12:00:00','Europe/Berlin'))) AS seconds,
        toString(toStartOfInterval(toDateTime('2026-10-25 02:30:00','Europe/Berlin'),INTERVAL 1 DAY,'Europe/Berlin')) AS day`);
      expect(Number(row?.seconds)).toBe(90_000);
      expect(row?.day).toBe("2026-10-25 00:00:00");
    } finally {
      await cleanupFixtureBase(f.base);
    }
  });
});
