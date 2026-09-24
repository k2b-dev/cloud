import { expect } from "bun:test";
import { sql } from "bun";
import { testFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { runRetentionBatch } from "./runtime";

const dbTest = testFor("database");

dbTest(
  "retention respects each base policy, lifecycle, sealed hours and sensitive fields",
  async () => {
    const bases = Array.from({ length: 4 }, () => crypto.randomUUID());
    // The retained hour sits one hour past the one-day cutoff hour, so the test still holds when the wall clock
    // crosses a full hour between setup and the second retention pass (the cutoff hour then moves up by one).
    // The hour directly at the cutoff is inherently racy against the clock and is not asserted here.
    const [times] = await sql`SELECT date_bin('1 hour',now()-interval '3 days','1970-01-01'::timestamptz) AS old,
    date_bin('1 hour',now()-interval '1 day','1970-01-01'::timestamptz)+interval '1 hour' AS boundary,
    now()-interval '2 hours' AS recent`;
    try {
      for (const [index, base] of bases.entries()) {
        await sql`INSERT INTO pulse.bases(id,short_id,name,retention_days,rollup_retention_days,sensitive_retention_hours,
        deletion_started_at,data_clear_started_at) VALUES(${base}::uuid,${newShortId()},'Retention proof',${index === 1 ? 30 : 1},
        ${index === 1 ? 30 : 2},${index === 1 ? 48 : 1},${index === 2 ? new Date() : null},${index === 3 ? new Date() : null})`;
        const [metric] = await sql`INSERT INTO pulse.metric_defs(base_id,name) VALUES(${base}::uuid,'retention') RETURNING id`;
        const [series] = await sql`INSERT INTO pulse.metric_series(base_id,metric_id,series_key,dimensions_hash)
        VALUES(${base}::uuid,${metric.id}::uuid,'retention','retention') RETURNING id`;
        await sql`INSERT INTO pulse.metric_hours(base_id,hour,state) VALUES(${base}::uuid,${times.old},'sealed'),
        (${base}::uuid,${times.old}::timestamptz+interval '1 hour','dirty'),(${base}::uuid,${times.boundary},'sealed')`;
        await sql`INSERT INTO pulse.metric_samples(base_id,series_id,ts,value) VALUES
        (${base}::uuid,${series.id}::uuid,${times.old},1),
        (${base}::uuid,${series.id}::uuid,${times.old}::timestamptz+interval '1 hour',2),
        (${base}::uuid,${series.id}::uuid,${times.boundary},3)`;
        await sql`INSERT INTO pulse.metric_rollups_hourly(base_id,series_id,bucket,sample_count,value_sum,value_min,value_max,last_value,last_ts)
        VALUES(${base}::uuid,${series.id}::uuid,${times.old},1,1,1,1,1,${times.old})`;
        await sql`INSERT INTO pulse.events(base_id,source_identity,dimensions_hash,kind,ts,sensitive) VALUES
        (${base}::uuid,${base}::uuid,'test','retention.old',${times.old},'{"secret":true}'::jsonb),
        (${base}::uuid,${base}::uuid,'test','retention.recent',${times.recent},'{"secret":true}'::jsonb),
        (${base}::uuid,${base}::uuid,'test','retention.empty',${times.recent},'{}'::jsonb)`;
      }
      const result = await runRetentionBatch(bases[0]);
      expect(result.metricSamples).toBe(1);
      expect(result.metricRollups).toBe(1);
      expect(result.events).toBe(1);
      expect(result.sensitiveEvents).toBe(2);
      // The global pass must retain the longer-lived base and skip both lifecycle states.
      await runRetentionBatch();
      for (const [index, base] of bases.entries()) {
        const samples = await sql<{ value: number }[]>`SELECT value FROM pulse.metric_samples WHERE base_id=${base}::uuid ORDER BY ts`;
        expect(samples.map((row) => Number(row.value))).toEqual(index === 0 ? [2, 3] : [1, 2, 3]);
        const [rollups] = await sql`SELECT count(*)::int AS count FROM pulse.metric_rollups_hourly WHERE base_id=${base}::uuid`;
        expect(rollups.count).toBe(index === 0 ? 0 : 1);
        const events = await sql<
          { kind: string; sensitive: Record<string, boolean> }[]
        >`SELECT kind,sensitive FROM pulse.events WHERE base_id=${base}::uuid ORDER BY kind`;
        expect(events.length).toBe(index === 0 ? 2 : 3);
        expect(events.find((row) => row.kind === "retention.recent")?.sensitive).toEqual(index === 0 ? {} : { secret: true });
        expect(events.find((row) => row.kind === "retention.empty")?.sensitive).toEqual({});
      }
    } finally {
      for (const base of bases) await sql`DELETE FROM pulse.bases WHERE id=${base}::uuid`;
    }
  },
  30_000,
);
