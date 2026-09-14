import { beforeAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import { newShortId } from "../lib/short-id";

const runDbSmoke = process.env.PULSE_LIFECYCLE_DB_TEST === "1";
const postgresTest = runDbSmoke ? test : test.skip;

const uuid = () => crypto.randomUUID();
const jsonb = (value: unknown) => JSON.stringify(value);

const initializePulseSchema = async () => {
  const { initializeSchema } = await import("../schema");
  await initializeSchema();
};

type RetentionPolicy = {
  rawDays?: number;
  rollupDays?: number;
  sensitiveHours?: number;
};

const createBase = async (name: string, policy: RetentionPolicy = {}): Promise<string> => {
  const baseId = uuid();
  await sql`
    INSERT INTO pulse.bases (id, short_id, name, retention_days, rollup_retention_days, sensitive_retention_hours)
    VALUES (${baseId}::uuid, ${newShortId()}, ${name}, ${policy.rawDays ?? 30}, ${policy.rollupDays ?? 365}, ${policy.sensitiveHours ?? 24})
  `;
  return baseId;
};

const createSource = async (baseId: string): Promise<string> => {
  const sourceId = uuid();
  await sql`
    INSERT INTO pulse.sources (
      id,
      short_id,
      base_id,
      kind,
      name,
      last_seen_at,
      last_error,
      last_error_at
    )
    VALUES (
      ${sourceId}::uuid,
      ${newShortId()},
      ${baseId}::uuid,
      'http_ingest'::pulse.source_kind,
      'Lifecycle smoke source',
      now(),
      'previous error',
      now()
    )
  `;
  return sourceId;
};

const insertTelemetryFixture = async (baseId: string, sourceId: string, age: "active" | "sensitive-expired" | "raw-expired" = "active") => {
  const offsetMs = age === "raw-expired" ? 40 * 24 * 60 * 60 * 1_000 : age === "sensitive-expired" ? 2 * 60 * 60 * 1_000 : 0;
  const ts = new Date(Date.now() - offsetMs);
  const metricId = uuid();
  const seriesId = uuid();
  const eventId = uuid();
  const stateChangeId = uuid();
  const dims = { host: "lifecycle-smoke", service: "pulse" };

  await sql`
    INSERT INTO pulse.metric_defs (id, base_id, name, unit, type)
    VALUES (${metricId}::uuid, ${baseId}::uuid, ${`lifecycle.metric.${metricId}`}, 'count', 'gauge'::pulse.metric_type)
  `;
  await sql`
    INSERT INTO pulse.metric_series (
      id,
      base_id,
      metric_id,
      source_id,
      resource_key,
      resource_type,
      series_key,
      dimensions_hash,
      dimensions,
      last_seen_at
    )
    VALUES (
      ${seriesId}::uuid,
      ${baseId}::uuid,
      ${metricId}::uuid,
      ${sourceId}::uuid,
      'resource:lifecycle-smoke',
      'resource',
      ${`series:${seriesId}`},
      ${seriesId},
      ${jsonb(dims)}::jsonb,
      ${ts}::timestamptz
    )
  `;
  await sql`
    INSERT INTO pulse.metric_series_dimensions (series_id, key, value)
    VALUES (${seriesId}::uuid, 'host', 'lifecycle-smoke')
  `;
  await sql`
    INSERT INTO pulse.metric_samples (base_id, series_id, ts, value)
    VALUES (${baseId}::uuid, ${seriesId}::uuid, ${ts}::timestamptz, 42)
  `;
  await sql`INSERT INTO pulse.metric_hours(base_id,hour,state)
    VALUES (${baseId}::uuid,date_bin('1 hour',${ts}::timestamptz,'1970-01-01'::timestamptz),'clean')
    ON CONFLICT DO NOTHING`;
  await sql`
    INSERT INTO pulse.metric_rollups_hourly (
      base_id,
      series_id,
      bucket,
      sample_count,
      value_sum,
      value_min,
      value_max,
      last_value,
      last_ts
    )
    VALUES (${baseId}::uuid, ${seriesId}::uuid, ${ts}::timestamptz, 1, 42, 42, 42, 42, ${ts}::timestamptz)
  `;
  await sql`
    INSERT INTO pulse.events (
      id,
      base_id,
      source_id,
      ts,
      kind,
      value,
      resource_key,
      resource_type,
      dimensions_hash,
      dimensions,
      sensitive,
      payload
    )
    VALUES (
      ${eventId}::uuid,
      ${baseId}::uuid,
      ${sourceId}::uuid,
      ${ts}::timestamptz,
      ${`lifecycle.event.${eventId}`},
      1,
      'resource:lifecycle-smoke',
      'resource',
      ${eventId},
      ${jsonb(dims)}::jsonb,
      ${jsonb({ ip: `192.0.2.${age === "active" ? 1 : age === "sensitive-expired" ? 2 : 3}` })}::jsonb,
      ${jsonb({ ok: true })}::jsonb
    )
  `;
  await sql`
    INSERT INTO pulse.states_current (
      base_id,
      state_key,
      variant_key,
      source_id,
      resource_key,
      resource_type,
      value,
      dimensions_hash,
      dimensions,
      updated_at
    )
    VALUES (
      ${baseId}::uuid,
      ${`lifecycle.state.${stateChangeId}`},
      ${stateChangeId},
      ${sourceId}::uuid,
      'resource:lifecycle-smoke',
      'resource',
      ${jsonb(true)}::jsonb,
      ${stateChangeId},
      ${jsonb(dims)}::jsonb,
      ${ts}::timestamptz
    )
  `;
  await sql`
    INSERT INTO pulse.state_changes (
      id,
      base_id,
      state_key,
      variant_key,
      source_id,
      resource_key,
      resource_type,
      value,
      dimensions_hash,
      dimensions,
      changed_at
    )
    VALUES (
      ${stateChangeId}::uuid,
      ${baseId}::uuid,
      ${`lifecycle.state.${stateChangeId}`},
      ${stateChangeId},
      ${sourceId}::uuid,
      'resource:lifecycle-smoke',
      'resource',
      ${jsonb(true)}::jsonb,
      ${stateChangeId},
      ${jsonb(dims)}::jsonb,
      ${ts}::timestamptz
    )
  `;
  await sql`
    INSERT INTO pulse.signal_fields (
      base_id, source_id, scope, signal_name, role, key, value_type, observed_count, first_seen_at, last_seen_at
    ) VALUES (
      ${baseId}::uuid, ${sourceId}::uuid, 'metric', 'lifecycle.metric', 'dimension', 'host', 'string', 1,
      ${ts}::timestamptz, ${ts}::timestamptz
    )
    ON CONFLICT (base_id, source_id, scope, signal_name, role, key) DO UPDATE SET
      observed_count = pulse.signal_fields.observed_count + 1,
      last_seen_at = GREATEST(pulse.signal_fields.last_seen_at, EXCLUDED.last_seen_at)
  `;
  await sql`
    INSERT INTO pulse.source_scrapes (
      base_id,
      source_id,
      started_at,
      finished_at,
      duration_ms,
      success,
      metrics_count,
      events_count,
      states_count
    )
    VALUES (${baseId}::uuid, ${sourceId}::uuid, ${ts}::timestamptz, ${ts}::timestamptz, 1, TRUE, 1, 1, 1)
  `;
};

const insertDashboardAndSavedQuery = async (baseId: string) => {
  await sql`
    INSERT INTO pulse.dashboards (short_id, base_id, name, config)
    VALUES (${newShortId()}, ${baseId}::uuid, 'Lifecycle dashboard', '{}'::jsonb)
  `;
  await sql`
    INSERT INTO pulse.saved_queries (short_id, base_id, name, query)
    VALUES (${newShortId()}, ${baseId}::uuid, 'Lifecycle query', 'metric lifecycle.metric latest since 1h')
  `;
};

const cleanupBase = async (baseId: string): Promise<void> => {
  await sql`DELETE FROM pulse.bases WHERE id = ${baseId}::uuid`;
};

const countRows = async (table: string, baseId: string): Promise<number> => {
  const [row] = await sql.unsafe<{ count: number }[]>(`SELECT COUNT(*)::int AS count FROM ${table} WHERE base_id = $1::uuid`, [baseId]);
  return row?.count ?? 0;
};

const countBase = async (baseId: string): Promise<number> => {
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM pulse.bases
    WHERE id = ${baseId}::uuid
  `;
  return row?.count ?? 0;
};

const countMetricSeriesDimensions = async (baseId: string): Promise<number> => {
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM pulse.metric_series_dimensions dims
    JOIN pulse.metric_series series ON series.id = dims.series_id
    WHERE series.base_id = ${baseId}::uuid
  `;
  return row?.count ?? 0;
};

const countAccessRowsForBase = async (baseId: string): Promise<number> => {
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM pulse.base_access
    WHERE base_id = ${baseId}::uuid
  `;
  return row?.count ?? 0;
};

const runUntilDone = async (run: () => Promise<{ done: boolean }>, maxBatches = 24): Promise<void> => {
  for (let i = 0; i < maxBatches; i += 1) {
    const result = await run();
    if (result.done) return;
  }
  throw new Error(`Lifecycle batch did not finish within ${maxBatches} batches`);
};

const expectBaseTelemetryCleared = async (baseId: string) => {
  await expect(countRows("pulse.metric_hours", baseId)).resolves.toBe(0);
  await expect(countRows("pulse.metric_samples", baseId)).resolves.toBe(0);
  await expect(countRows("pulse.metric_rollups_hourly", baseId)).resolves.toBe(0);
  await expect(countRows("pulse.state_changes", baseId)).resolves.toBe(0);
  await expect(countRows("pulse.events", baseId)).resolves.toBe(0);
  await expect(countRows("pulse.states_current", baseId)).resolves.toBe(0);
  await expect(countMetricSeriesDimensions(baseId)).resolves.toBe(0);
  await expect(countRows("pulse.source_scrapes", baseId)).resolves.toBe(0);
  await expect(countRows("pulse.metric_series", baseId)).resolves.toBe(0);
  await expect(countRows("pulse.metric_defs", baseId)).resolves.toBe(0);
  await expect(countRows("pulse.signal_fields", baseId)).resolves.toBe(0);
};

beforeAll(async () => {
  if (runDbSmoke) await initializePulseSchema();
});

describe("Pulse lifecycle Postgres smoke", () => {
  postgresTest("clear keeps other bases isolated across physical time chunks", async () => {
    const { purgeBaseDataClearBatch } = await import("./base-lifecycle");
    const own = await createBase("Clear target"),
      foreign = await createBase("Keep other chunk");
    try {
      await insertTelemetryFixture(own, await createSource(own));
      await insertTelemetryFixture(foreign, await createSource(foreign), "raw-expired");
      const [timescale] = await sql`SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname='timescaledb') AS enabled`;
      if (timescale.enabled) {
        const [chunks] =
          await sql`SELECT count(DISTINCT tableoid)::int AS count FROM pulse.events WHERE base_id IN (${own}::uuid,${foreign}::uuid)`;
        expect(chunks.count).toBe(2);
      }
      await sql`INSERT INTO pulse.base_data_clears(base_id,status,phase) VALUES(${own}::uuid,'queued','queued')`;
      await runUntilDone(() => purgeBaseDataClearBatch(own));
      await expectBaseTelemetryCleared(own);
      for (const table of ["pulse.metric_samples", "pulse.metric_rollups_hourly", "pulse.events"]) {
        expect(await countRows(table, foreign)).toBe(1);
      }
    } finally {
      await cleanupBase(own);
      await cleanupBase(foreign);
    }
  });

  postgresTest("clears telemetry in batches while preserving base, sources, dashboards, and saved queries", async () => {
    const { purgeBaseDataClearBatch } = await import("./base-lifecycle");
    const baseId = await createBase("Lifecycle clear smoke");
    const sourceId = await createSource(baseId);
    try {
      await insertTelemetryFixture(baseId, sourceId);
      await insertDashboardAndSavedQuery(baseId);
      await sql`
        INSERT INTO pulse.base_data_clears (base_id, status, phase)
        VALUES (${baseId}::uuid, 'queued', 'queued')
      `;

      await runUntilDone(() => purgeBaseDataClearBatch(baseId));

      await expectBaseTelemetryCleared(baseId);
      await expect(countRows("pulse.sources", baseId)).resolves.toBe(1);
      await expect(countRows("pulse.dashboards", baseId)).resolves.toBe(1);
      await expect(countRows("pulse.saved_queries", baseId)).resolves.toBe(1);

      const [base] = await sql<{ data_clear_completed_at: Date | null }[]>`
        SELECT data_clear_completed_at
        FROM pulse.bases
        WHERE id = ${baseId}::uuid
      `;
      expect(base?.data_clear_completed_at).toBeTruthy();

      const [source] = await sql<{ last_seen_at: Date | null; last_error: string | null; last_error_at: Date | null }[]>`
        SELECT last_seen_at, last_error, last_error_at
        FROM pulse.sources
        WHERE id = ${sourceId}::uuid
      `;
      expect(source).toEqual({ last_seen_at: null, last_error: null, last_error_at: null });
    } finally {
      await cleanupBase(baseId);
    }
  });

  postgresTest("deletes a base and its telemetry in bounded batches", async () => {
    const { purgeBaseDeletionBatch } = await import("./base-lifecycle");
    const baseId = await createBase("Lifecycle delete smoke");
    const sourceId = await createSource(baseId);
    try {
      await insertTelemetryFixture(baseId, sourceId);
      await insertDashboardAndSavedQuery(baseId);
      await sql`
        INSERT INTO pulse.base_deletions (base_id, status, phase)
        VALUES (${baseId}::uuid, 'queued', 'queued')
      `;

      await runUntilDone(() => purgeBaseDeletionBatch(baseId));

      await expect(countBase(baseId)).resolves.toBe(0);
      await expectBaseTelemetryCleared(baseId);
      await expect(countRows("pulse.sources", baseId)).resolves.toBe(0);
      await expect(countRows("pulse.dashboards", baseId)).resolves.toBe(0);
      await expect(countRows("pulse.saved_queries", baseId)).resolves.toBe(0);
      await expect(countAccessRowsForBase(baseId)).resolves.toBe(0);
    } finally {
      await cleanupBase(baseId);
    }
  });

  postgresTest("retention removes only expired telemetry for the scoped test base", async () => {
    const { runRetentionBatch } = await import("./runtime");
    const baseId = await createBase("Lifecycle retention smoke", { rawDays: 1, rollupDays: 365, sensitiveHours: 1 });
    const sourceId = await createSource(baseId);
    try {
      await insertTelemetryFixture(baseId, sourceId, "raw-expired");
      await insertTelemetryFixture(baseId, sourceId, "sensitive-expired");
      await insertTelemetryFixture(baseId, sourceId);

      const first = await runRetentionBatch(baseId);
      expect(first.phase).toBe("event_sensitive");
      expect(first.sensitiveEvents).toBe(2);
      expect(first.metricSamples).toBe(1);
      expect(first.events).toBe(1);
      expect(first.stateChanges).toBe(1);
      expect(first.done).toBe(false);
      await runUntilDone(() => runRetentionBatch(baseId));

      await expect(countRows("pulse.metric_samples", baseId)).resolves.toBe(2);
      await expect(countRows("pulse.metric_rollups_hourly", baseId)).resolves.toBe(3);
      await expect(countRows("pulse.state_changes", baseId)).resolves.toBe(2);
      await expect(countRows("pulse.events", baseId)).resolves.toBe(2);
      await expect(countRows("pulse.states_current", baseId)).resolves.toBe(3);

      const [sensitive] = await sql<{ retained: number; cleared: number }[]>`
        SELECT
          COUNT(*) FILTER (WHERE sensitive <> '{}'::jsonb)::int AS retained,
          COUNT(*) FILTER (WHERE sensitive = '{}'::jsonb)::int AS cleared
        FROM pulse.events
        WHERE base_id = ${baseId}::uuid
      `;
      expect(sensitive).toEqual({ retained: 1, cleared: 1 });
    } finally {
      await cleanupBase(baseId);
    }
  });
});
