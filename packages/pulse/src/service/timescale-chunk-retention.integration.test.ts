import { expect, test } from "bun:test";
import { sql } from "bun";
import { newShortId } from "../lib/short-id";
import { runRetentionBatch } from "./runtime";
import { pruneEmptyTimescaleChunk } from "./timescale-chunk-retention";

const dbTest = process.env.PULSE_CHUNK_RETENTION_DB_TEST === "1" ? test : test.skip;

dbTest(
  "empty chunk maintenance preserves shared-base and dirty data and yields to writers",
  async () => {
    const target = new URL(process.env.DATABASE_URL ?? "");
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
      !["/pulse_analytics_test", "/pulse_schema_test"].includes(target.pathname)
    ) {
      throw new Error("Chunk retention tests require an explicit loopback disposable database");
    }
    const [database] = await sql`SELECT current_database() AS name`;
    if (!["pulse_analytics_test", "pulse_schema_test"].includes(database.name)) throw new Error("Wrong disposable database");
    const [extension] = await sql`SELECT 1 FROM pg_extension WHERE extname='timescaledb'`;
    if (!extension) {
      expect(await pruneEmptyTimescaleChunk()).toEqual({ dropped: 0, deferred: false });
      return;
    }
    // Drain pre-existing empty storage in this explicitly disposable database.
    const setupDeadline = performance.now() + 10_000;
    let removedBeforeSetup = 0;
    for (;;) {
      const cleanup = await pruneEmptyTimescaleChunk();
      removedBeforeSetup += cleanup.dropped;
      if (!cleanup.deferred && !cleanup.dropped) break;
      if (removedBeforeSetup >= 100) throw new Error("Unexpected empty-chunk backlog in test database");
      if (performance.now() >= setupDeadline) throw new Error("Disposable database stayed busy during chunk setup");
      // Autovacuum and prior test cleanup can transiently hold the same table locks.
      // Retry only setup; the deliberate writer-lock assertions below remain immediate.
      if (cleanup.deferred) await Bun.sleep(100);
    }
    const bases = [crypto.randomUUID(), crypto.randomUUID()];
    const series: string[] = [];
    try {
      for (let index = 0; index < bases.length; index++) {
        const base = bases[index]!;
        await sql`INSERT INTO pulse.bases(id,short_id,name,retention_days) VALUES(${base}::uuid,${newShortId()},'Chunk retention test',${index === 0 ? 1 : 365})`;
        const [metric] = await sql`INSERT INTO pulse.metric_defs(base_id,name) VALUES(${base}::uuid,'chunk.test') RETURNING id`;
        const [variant] =
          await sql`INSERT INTO pulse.metric_series(base_id,metric_id,series_key,dimensions_hash) VALUES(${base}::uuid,${metric.id}::uuid,'test','test') RETURNING id`;
        series.push(variant.id);
        await sql`INSERT INTO pulse.metric_hours(base_id,hour,state) VALUES(${base}::uuid,'1900-01-01'::timestamptz,'dirty')`;
        await sql`INSERT INTO pulse.metric_samples(base_id,series_id,ts,value) VALUES(${base}::uuid,${variant.id}::uuid,'1900-01-01'::timestamptz,1)`;
      }
      // An older nonempty chunk must not starve this later empty candidate.
      await sql`INSERT INTO pulse.metric_samples(base_id,series_id,ts,value) VALUES(${bases[0]}::uuid,${series[0]}::uuid,'1901-01-01'::timestamptz,2)`;
      const [candidate] =
        await sql`SELECT chunk_schema,chunk_name FROM timescaledb_information.chunks WHERE hypertable_schema='pulse' AND hypertable_name='metric_samples' AND range_start<='1901-01-01'::timestamptz AND range_end>'1901-01-01'::timestamptz`;
      const chunk = `"${candidate.chunk_schema}"."${candidate.chunk_name}"`;
      await sql`DELETE FROM pulse.metric_samples WHERE series_id=${series[0]}::uuid AND ts='1901-01-01'::timestamptz`;
      await sql.unsafe(`VACUUM (ANALYZE) ${chunk}`);
      const [size] = await sql`SELECT pg_relation_size(${chunk}::regclass) AS bytes`;
      expect(Number(size.bytes)).toBe(0);
      await sql`INSERT INTO pulse.metric_rollups_hourly(base_id,series_id,bucket,sample_count,value_sum,value_min,value_max,last_value,last_ts)
        VALUES(${bases[0]}::uuid,${series[0]}::uuid,'1901-01-01'::timestamptz,1,1,1,1,1,'1901-01-01'::timestamptz),
        (${bases[0]}::uuid,${series[0]}::uuid,'1902-01-01'::timestamptz,1,1,1,1,1,'1902-01-01'::timestamptz)`;
      await sql`DELETE FROM pulse.metric_rollups_hourly WHERE series_id=${series[0]}::uuid AND bucket IN ('1901-01-01'::timestamptz,'1902-01-01'::timestamptz)`;
      await sql`VACUUM (ANALYZE) pulse.metric_rollups_hourly`;
      await sql.begin(async (writer) => {
        await writer`LOCK TABLE ONLY pulse.metric_samples IN ROW EXCLUSIVE MODE`;
        expect(await pruneEmptyTimescaleChunk()).toEqual({ dropped: 1, deferred: true });
        // Vacuum may expose further empty chunks from this fixture or earlier tests.
        // Isolate the busy-only phase after proving that another table can progress.
        await writer`LOCK TABLE ONLY pulse.metric_rollups_hourly, ONLY pulse.events IN ROW EXCLUSIVE MODE`;
        expect(await pruneEmptyTimescaleChunk()).toEqual({ dropped: 0, deferred: true });
        const result = await runRetentionBatch(bases[0]);
        expect(result.emptyChunks).toBe(0);
        expect(result.chunkCleanupDeferred).toBe(true);
        expect(result.done).toBe(false);
        expect(result.phase).toBe("chunk_cleanup_deferred");
      });
      // A committed late writer makes the previously empty chunk ineligible.
      await sql`INSERT INTO pulse.metric_samples(base_id,series_id,ts,value) VALUES(${bases[1]}::uuid,${series[1]}::uuid,'1901-01-01'::timestamptz,3)`;
      await pruneEmptyTimescaleChunk();
      const [late] = await sql`SELECT value FROM pulse.metric_samples WHERE series_id=${series[1]}::uuid AND ts='1901-01-01'::timestamptz`;
      expect(late.value).toBe(3);
      await sql`DELETE FROM pulse.metric_samples WHERE series_id=${series[1]}::uuid AND ts='1901-01-01'::timestamptz`;
      await sql.unsafe(`VACUUM (ANALYZE) ${chunk}`);
      expect(await pruneEmptyTimescaleChunk()).toEqual({ dropped: 1, deferred: false });
      const [removed] = await sql`SELECT to_regclass(${chunk}) AS relation`;
      expect(removed.relation).toBeNull();
      for (const base of bases) {
        const [retained] =
          await sql`SELECT count(*) AS count FROM pulse.metric_samples WHERE base_id=${base}::uuid AND ts='1900-01-01'::timestamptz`;
        expect(Number(retained.count)).toBe(1);
        const [hour] = await sql`SELECT state FROM pulse.metric_hours WHERE base_id=${base}::uuid AND hour='1900-01-01'::timestamptz`;
        expect(hour.state).toBe("dirty");
      }
    } finally {
      for (const base of bases) await sql`DELETE FROM pulse.bases WHERE id=${base}::uuid`;
      await sql`VACUUM (ANALYZE) pulse.metric_samples`;
      // Release chunks created by the fixture after its rows have been removed.
      for (let pass = 0; pass < 10; pass++) if (!(await pruneEmptyTimescaleChunk()).dropped) break;
    }
  },
  30_000,
);
