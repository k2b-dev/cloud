import type { Worker } from "@k2b/sync";
import { lazySync } from "@valentinkolb/cloud";
import { trace } from "@valentinkolb/cloud/services";
import { sql } from "bun";
import {
  resumePulseBaseDataClearJobs,
  resumePulseBaseDeletionJobs,
  startPulseBaseJobs,
  stopPulseBaseDataClearJob,
  stopPulseBaseDeletionJob,
} from "./base-lifecycle";
import { scrapeMetricsSource } from "./index";

type ScrapeInput = {
  baseId: string;
  publicBaseId: string;
  sourceId: string;
  publicSourceId: string;
};

const RETENTION_DELETE_BATCH_SIZE = 50_000;

type RetentionResult = {
  phase: string;
  sensitiveEvents: number;
  metricSamples: number;
  metricRollups: number;
  events: number;
  stateChanges: number;
  idempotencyRecords: number;
  done: boolean;
};

const clearExpiredEventSensitiveChunk = async (baseId?: string): Promise<number> => {
  const scopedBaseId = baseId ?? null;
  const result = await sql`
    WITH victim AS (
      SELECT e.id, e.ts
      FROM pulse.events e
      JOIN pulse.bases b ON b.id = e.base_id
      WHERE e.ts < now() - (b.sensitive_retention_hours * interval '1 hour')
        AND e.sensitive <> '{}'::jsonb
        AND b.deletion_started_at IS NULL
        AND (
          b.data_clear_started_at IS NULL
          OR b.data_clear_completed_at IS NOT NULL
          OR b.data_clear_failed_at IS NOT NULL
        )
        AND (${scopedBaseId}::uuid IS NULL OR b.id = ${scopedBaseId}::uuid)
      LIMIT ${RETENTION_DELETE_BATCH_SIZE}
    )
    UPDATE pulse.events item
    SET sensitive = '{}'::jsonb
    FROM victim
    WHERE item.id = victim.id
      AND item.ts = victim.ts
  `;
  return result.count ?? 0;
};

/** The scrape ran and failed for a reason already recorded on `pulse.sources.last_error`. */
class ScrapeOutcomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScrapeOutcomeError";
  }
}

const scrapeJob = lazySync((sync) =>
  sync.job<ScrapeInput>({
    id: "pulse:metrics:scrape",
    delivery: { ackWaitMs: 60_000, maxAttempts: 3, backoffMs: [30_000, 60_000] },
  }),
);

const deleteExpiredMetricSamplesChunk = async (baseId?: string): Promise<number> => {
  const scopedBaseId = baseId ?? null;
  const result = await sql`
    WITH victim AS (
      SELECT ms.series_id, ms.ts
      FROM pulse.metric_samples ms
      JOIN pulse.bases b ON b.id = ms.base_id
      WHERE ms.ts < now() - (b.retention_days * interval '1 day')
        AND b.deletion_started_at IS NULL
        AND (
          b.data_clear_started_at IS NULL
          OR b.data_clear_completed_at IS NOT NULL
          OR b.data_clear_failed_at IS NOT NULL
        )
        AND (${scopedBaseId}::uuid IS NULL OR b.id = ${scopedBaseId}::uuid)
      LIMIT ${RETENTION_DELETE_BATCH_SIZE}
    )
    DELETE FROM pulse.metric_samples item
    USING victim
    WHERE item.series_id = victim.series_id
      AND item.ts = victim.ts
  `;
  return result.count ?? 0;
};

const deleteExpiredMetricRollupsChunk = async (baseId?: string): Promise<number> => {
  const scopedBaseId = baseId ?? null;
  const result = await sql`
    WITH victim AS (
      SELECT mr.series_id, mr.bucket
      FROM pulse.metric_rollups_hourly mr
      JOIN pulse.bases b ON b.id = mr.base_id
      WHERE mr.bucket < now() - (b.rollup_retention_days * interval '1 day')
        AND b.deletion_started_at IS NULL
        AND (
          b.data_clear_started_at IS NULL
          OR b.data_clear_completed_at IS NOT NULL
          OR b.data_clear_failed_at IS NOT NULL
        )
        AND (${scopedBaseId}::uuid IS NULL OR b.id = ${scopedBaseId}::uuid)
      LIMIT ${RETENTION_DELETE_BATCH_SIZE}
    )
    DELETE FROM pulse.metric_rollups_hourly item
    USING victim
    WHERE item.series_id = victim.series_id
      AND item.bucket = victim.bucket
  `;
  return result.count ?? 0;
};

const deleteExpiredEventsChunk = async (baseId?: string): Promise<number> => {
  const scopedBaseId = baseId ?? null;
  const result = await sql`
    WITH victim AS (
      SELECT e.id, e.ts
      FROM pulse.events e
      JOIN pulse.bases b ON b.id = e.base_id
      WHERE e.ts < now() - (b.retention_days * interval '1 day')
        AND b.deletion_started_at IS NULL
        AND (
          b.data_clear_started_at IS NULL
          OR b.data_clear_completed_at IS NOT NULL
          OR b.data_clear_failed_at IS NOT NULL
        )
        AND (${scopedBaseId}::uuid IS NULL OR b.id = ${scopedBaseId}::uuid)
      LIMIT ${RETENTION_DELETE_BATCH_SIZE}
    )
    DELETE FROM pulse.events item
    USING victim
    WHERE item.id = victim.id
      AND item.ts = victim.ts
  `;
  return result.count ?? 0;
};

const deleteExpiredStateChangesChunk = async (baseId?: string): Promise<number> => {
  const scopedBaseId = baseId ?? null;
  const result = await sql`
    WITH victim AS (
      SELECT sc.id
      FROM pulse.state_changes sc
      JOIN pulse.bases b ON b.id = sc.base_id
      WHERE sc.changed_at < now() - (b.retention_days * interval '1 day')
        AND b.deletion_started_at IS NULL
        AND (
          b.data_clear_started_at IS NULL
          OR b.data_clear_completed_at IS NOT NULL
          OR b.data_clear_failed_at IS NOT NULL
        )
        AND (${scopedBaseId}::uuid IS NULL OR b.id = ${scopedBaseId}::uuid)
      LIMIT ${RETENTION_DELETE_BATCH_SIZE}
    )
    DELETE FROM pulse.state_changes item
    USING victim
    WHERE item.id = victim.id
  `;
  return result.count ?? 0;
};

const deleteExpiredIdempotencyChunk = async (baseId?: string): Promise<number> => {
  const scopedBaseId = baseId ?? null;
  const result = await sql`
    WITH victim AS (
      SELECT item.source_id, item.idempotency_key
      FROM pulse.ingest_idempotency item
      JOIN pulse.sources source ON source.id = item.source_id
      WHERE item.expires_at <= now()
        AND (${scopedBaseId}::uuid IS NULL OR source.base_id = ${scopedBaseId}::uuid)
      LIMIT ${RETENTION_DELETE_BATCH_SIZE}
    )
    DELETE FROM pulse.ingest_idempotency item
    USING victim
    WHERE item.source_id = victim.source_id
      AND item.idempotency_key = victim.idempotency_key
  `;
  return result.count ?? 0;
};

export const runRetentionBatch = async (baseId?: string): Promise<RetentionResult> => {
  const sensitiveEvents = await clearExpiredEventSensitiveChunk(baseId);
  const metricSamples = await deleteExpiredMetricSamplesChunk(baseId);
  const metricRollups = await deleteExpiredMetricRollupsChunk(baseId);
  const events = await deleteExpiredEventsChunk(baseId);
  const stateChanges = await deleteExpiredStateChangesChunk(baseId);
  const idempotencyRecords = await deleteExpiredIdempotencyChunk(baseId);
  const phases = [
    ["event_sensitive", sensitiveEvents],
    ["metric_samples", metricSamples],
    ["metric_rollups_hourly", metricRollups],
    ["events", events],
    ["state_changes", stateChanges],
    ["ingest_idempotency", idempotencyRecords],
  ] as const;
  const backlog = phases.find(([, count]) => count >= RETENTION_DELETE_BATCH_SIZE);
  const work = phases.find(([, count]) => count > 0);
  return {
    phase: backlog?.[0] ?? work?.[0] ?? "done",
    sensitiveEvents,
    metricSamples,
    metricRollups,
    events,
    stateChanges,
    idempotencyRecords,
    done: !backlog,
  };
};

const retentionJob = lazySync((sync) =>
  sync.job<void>({
    id: "pulse:retention",
    delivery: { ackWaitMs: 5 * 60_000, maxAttempts: 3, backoffMs: [60_000, 120_000] },
  }),
);
const hourlyRollupJob = lazySync((sync) =>
  sync.job<void>({
    id: "pulse:rollup:hourly",
    delivery: { ackWaitMs: 5 * 60_000, maxAttempts: 3, backoffMs: [60_000, 120_000] },
  }),
);
const runHourlyRollup = async () => {
  const result = await sql`
      INSERT INTO pulse.metric_rollups_hourly (
        base_id,
        series_id,
        bucket,
        sample_count,
        value_sum,
        value_min,
        value_max,
        last_value,
        updated_at
      )
      SELECT
        base_id,
        series_id,
        date_bin('1 hour'::interval, ts, '1970-01-01'::timestamptz) AS bucket,
        COUNT(*)::bigint AS sample_count,
        SUM(value) AS value_sum,
        MIN(value) AS value_min,
        MAX(value) AS value_max,
        (array_agg(value ORDER BY ts DESC))[1] AS last_value,
        now() AS updated_at
      FROM pulse.metric_samples
      WHERE ts >= now() - interval '48 hours'
      GROUP BY base_id, series_id, bucket
      ON CONFLICT (series_id, bucket)
      DO UPDATE SET
        sample_count = EXCLUDED.sample_count,
        value_sum = EXCLUDED.value_sum,
        value_min = EXCLUDED.value_min,
        value_max = EXCLUDED.value_max,
        last_value = EXCLUDED.last_value,
        updated_at = now()
    `;
  return { buckets: result.count ?? 0 };
};
const pulseScheduler = lazySync((sync) =>
  sync.scheduler({
    id: "pulse",
    delivery: { maxAttempts: 3, backoffMs: [60_000, 120_000] },
  }),
);
let workers: Worker[] = [];
let started = false;

const submitDueScrapes = async (slotTs: number): Promise<{ submitted: number }> => {
  const rows = await sql<{ id: string; short_id: string; base_id: string; base_short_id: string }[]>`
    SELECT s.id, s.short_id, s.base_id, b.short_id AS base_short_id
    FROM pulse.sources s
    JOIN pulse.bases b ON b.id = s.base_id
    WHERE s.kind = 'metrics'::pulse.source_kind
      AND s.enabled = TRUE
      AND s.endpoint_url IS NOT NULL
      AND s.scrape_interval_seconds IS NOT NULL
      AND b.deletion_started_at IS NULL
      AND (
        b.data_clear_started_at IS NULL
        OR b.data_clear_completed_at IS NOT NULL
        OR b.data_clear_failed_at IS NOT NULL
      )
      AND (
        GREATEST(
          COALESCE(s.last_seen_at, '-infinity'::timestamptz),
          COALESCE(s.last_error_at, '-infinity'::timestamptz)
        ) <= now() - (s.scrape_interval_seconds * interval '1 second')
      )
    ORDER BY
      GREATEST(
        COALESCE(s.last_seen_at, '-infinity'::timestamptz),
        COALESCE(s.last_error_at, '-infinity'::timestamptz)
      ) ASC,
      s.created_at ASC
    LIMIT 200
  `;

  for (const row of rows) {
    await scrapeJob().submit({
      key: `source:${row.id}:slot:${slotTs}`,
      input: {
        baseId: row.base_id,
        publicBaseId: row.base_short_id,
        sourceId: row.id,
        publicSourceId: row.short_id,
      },
    });
  }

  return { submitted: rows.length };
};

export const pulseRuntime = {
  start: async (): Promise<void> => {
    if (started) return;
    workers.push(
      await scrapeJob().process({}, async (context) => {
        await trace
          .withSpan(
            {
              spanKey: trace.syncSpanKey("job", "pulse:metrics:scrape", context.jobId),
              name: "Pulse metrics scrape",
              source: "pulse:metrics:scrape",
              appId: "pulse",
              category: "job",
              attributes: { "cloud.pulse.base_id": context.input.publicBaseId, "cloud.pulse.source_id": context.input.publicSourceId },
            },
            async () => {
              const result = await scrapeMetricsSource(context.input);
              if (!result.ok) throw new ScrapeOutcomeError(result.error.message);
              return result.data;
            },
            { summarize: (result) => result },
          )
          .catch((error: unknown) => {
            // Returned scrape failures, including rejected ingest input, are recorded on the
            // source and retried by its next due slot. Only errors thrown out of the
            // scraper or tracing reach the job's retry and dead-letter policy.
            if (!(error instanceof ScrapeOutcomeError)) throw error;
          });
      }),
    );
    workers.push(
      await retentionJob().process({}, async (context) => {
        const result = await trace.withSpan(
          {
            spanKey: trace.syncSpanKey("job", "pulse:retention", context.jobId),
            name: "Pulse retention cleanup",
            source: "pulse:retention",
            appId: "pulse",
            category: "job",
          },
          () => runRetentionBatch(),
          { summarize: (result) => result },
        );
        if (!result.done) context.resubmit();
      }),
    );
    workers.push(
      await hourlyRollupJob().process({}, async (context) => {
        await trace.withSpan(
          {
            spanKey: trace.syncSpanKey("job", "pulse:rollup:hourly", context.jobId),
            name: "Pulse hourly rollup",
            source: "pulse:rollup:hourly",
            appId: "pulse",
            category: "job",
          },
          runHourlyRollup,
          { summarize: (result) => result },
        );
      }),
    );
    await pulseScheduler().create({
      id: "pulse:metrics:scrape-due",
      cron: "* * * * *",
      misfire: "latest",
      meta: { appId: "pulse", family: "pulse:metrics", label: "Pulse due metrics scrape", source: "pulse:metrics:scrape-due" },
      process: async (context) => {
        await trace.withSpan(
          {
            spanKey: trace.syncSpanKey("scheduler", "pulse", context.runId),
            name: "Pulse due metrics scrape schedule",
            source: "pulse",
            appId: "pulse",
            category: "schedule",
          },
          () => submitDueScrapes(context.slot.getTime()),
          { summarize: (result) => result },
        );
      },
    });
    await pulseScheduler().create({
      id: "pulse:rollup:hourly",
      cron: "23 * * * *",
      misfire: "latest",
      meta: { appId: "pulse", family: "pulse:rollups", label: "Pulse hourly rollup", source: "pulse:rollup:hourly" },
      process: async (context) => {
        await hourlyRollupJob().submit({ key: `slot:${context.slot.getTime()}`, input: undefined });
      },
    });
    await pulseScheduler().create({
      id: "pulse:retention",
      cron: "17 3 * * *",
      misfire: "latest",
      meta: { appId: "pulse", family: "pulse:retention", label: "Pulse retention", source: "pulse:retention" },
      process: async (context) => {
        await retentionJob().submit({ key: `slot:${context.slot.getTime()}`, input: undefined });
      },
    });
    workers.push(await pulseScheduler().process());
    await startPulseBaseJobs();
    await resumePulseBaseDeletionJobs();
    await resumePulseBaseDataClearJobs();
    started = true;
  },
  stop: async (): Promise<void> => {
    await Promise.all(workers.map((worker) => worker.drain()));
    workers = [];
    await stopPulseBaseDeletionJob();
    await stopPulseBaseDataClearJob();
    started = false;
  },
};
