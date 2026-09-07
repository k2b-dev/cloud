import type { JobContext, Worker } from "@k2b/sync";
import { lazySync } from "@valentinkolb/cloud";
import { logger, trace } from "@valentinkolb/cloud/services";
import { sql } from "bun";

const BASE_DELETE_BATCH_SIZE = 50_000;
const log = logger("pulse:base-lifecycle");

type BaseDeletionBatch = {
  phase: string;
  deletedRows: number;
  done: boolean;
};

type BaseJobInput = {
  baseId: string;
  publicBaseId: string;
};

const recordBaseDeletionProgress = async (params: {
  baseId: string;
  phase: string;
  deletedRows: number;
  status?: "queued" | "deleting" | "failed";
  errorMessage?: string | null;
}): Promise<void> => {
  await sql`
    INSERT INTO pulse.base_deletions (
      base_id,
      status,
      phase,
      deleted_rows,
      last_batch_rows,
      error_message,
      updated_at
    )
    VALUES (
      ${params.baseId}::uuid,
      ${params.status ?? "deleting"},
      ${params.phase},
      ${params.deletedRows},
      ${params.deletedRows},
      ${params.errorMessage ?? null},
      now()
    )
    ON CONFLICT (base_id)
    DO UPDATE SET
      status = EXCLUDED.status,
      phase = EXCLUDED.phase,
      deleted_rows = pulse.base_deletions.deleted_rows + EXCLUDED.deleted_rows,
      last_batch_rows = EXCLUDED.last_batch_rows,
      error_message = EXCLUDED.error_message,
      updated_at = now()
  `;
};

const deleteMetricSamplesChunk = async (baseId: string): Promise<number> => {
  const result = await sql`
    WITH victim AS (
      SELECT ctid
      FROM pulse.metric_samples
      WHERE base_id = ${baseId}::uuid
      LIMIT ${BASE_DELETE_BATCH_SIZE}
    )
    DELETE FROM pulse.metric_samples item
    USING victim
    WHERE item.ctid = victim.ctid
  `;
  return result.count ?? 0;
};

const deleteMetricRollupsChunk = async (baseId: string): Promise<number> => {
  const result = await sql`
    WITH victim AS (
      SELECT ctid
      FROM pulse.metric_rollups_hourly
      WHERE base_id = ${baseId}::uuid
      LIMIT ${BASE_DELETE_BATCH_SIZE}
    )
    DELETE FROM pulse.metric_rollups_hourly item
    USING victim
    WHERE item.ctid = victim.ctid
  `;
  return result.count ?? 0;
};

const deleteStateChangesChunk = async (baseId: string): Promise<number> => {
  const result = await sql`
    WITH victim AS (
      SELECT ctid
      FROM pulse.state_changes
      WHERE base_id = ${baseId}::uuid
      LIMIT ${BASE_DELETE_BATCH_SIZE}
    )
    DELETE FROM pulse.state_changes item
    USING victim
    WHERE item.ctid = victim.ctid
  `;
  return result.count ?? 0;
};

const deleteEventsChunk = async (baseId: string): Promise<number> => {
  const result = await sql`
    WITH victim AS (
      SELECT ctid
      FROM pulse.events
      WHERE base_id = ${baseId}::uuid
      LIMIT ${BASE_DELETE_BATCH_SIZE}
    )
    DELETE FROM pulse.events item
    USING victim
    WHERE item.ctid = victim.ctid
  `;
  return result.count ?? 0;
};

const deleteCurrentStatesChunk = async (baseId: string): Promise<number> => {
  const result = await sql`
    WITH victim AS (
      SELECT ctid
      FROM pulse.states_current
      WHERE base_id = ${baseId}::uuid
      LIMIT ${BASE_DELETE_BATCH_SIZE}
    )
    DELETE FROM pulse.states_current item
    USING victim
    WHERE item.ctid = victim.ctid
  `;
  return result.count ?? 0;
};

const deleteMetricSeriesDimensionsChunk = async (baseId: string): Promise<number> => {
  const result = await sql`
    WITH victim AS (
      SELECT dims.series_id, dims.key
      FROM pulse.metric_series_dimensions dims
      JOIN pulse.metric_series series ON series.id = dims.series_id
      WHERE series.base_id = ${baseId}::uuid
      LIMIT ${BASE_DELETE_BATCH_SIZE}
    )
    DELETE FROM pulse.metric_series_dimensions item
    USING victim
    WHERE item.series_id = victim.series_id
      AND item.key = victim.key
  `;
  return result.count ?? 0;
};

const deleteSourceScrapesChunk = async (baseId: string): Promise<number> => {
  const result = await sql`
    WITH victim AS (
      SELECT ctid
      FROM pulse.source_scrapes
      WHERE base_id = ${baseId}::uuid
      LIMIT ${BASE_DELETE_BATCH_SIZE}
    )
    DELETE FROM pulse.source_scrapes item
    USING victim
    WHERE item.ctid = victim.ctid
  `;
  return result.count ?? 0;
};

const deleteIngestIdempotencyChunk = async (baseId: string): Promise<number> => {
  const result = await sql`
    WITH victim AS (
      SELECT item.source_id, item.idempotency_key
      FROM pulse.ingest_idempotency item
      JOIN pulse.sources source ON source.id = item.source_id
      WHERE source.base_id = ${baseId}::uuid
      LIMIT ${BASE_DELETE_BATCH_SIZE}
    )
    DELETE FROM pulse.ingest_idempotency item
    USING victim
    WHERE item.source_id = victim.source_id
      AND item.idempotency_key = victim.idempotency_key
  `;
  return result.count ?? 0;
};

const deleteMetricSeriesChunk = async (baseId: string): Promise<number> => {
  const result = await sql`
    WITH victim AS (
      SELECT ctid
      FROM pulse.metric_series
      WHERE base_id = ${baseId}::uuid
      LIMIT ${BASE_DELETE_BATCH_SIZE}
    )
    DELETE FROM pulse.metric_series item
    USING victim
    WHERE item.ctid = victim.ctid
  `;
  return result.count ?? 0;
};

const deleteMetricDefsChunk = async (baseId: string): Promise<number> => {
  const result = await sql`
    WITH victim AS (
      SELECT ctid
      FROM pulse.metric_defs
      WHERE base_id = ${baseId}::uuid
      LIMIT ${BASE_DELETE_BATCH_SIZE}
    )
    DELETE FROM pulse.metric_defs item
    USING victim
    WHERE item.ctid = victim.ctid
  `;
  return result.count ?? 0;
};

const deleteSignalFieldsChunk = async (baseId: string): Promise<number> => {
  const result = await sql`
    WITH victim AS (
      SELECT ctid
      FROM pulse.signal_fields
      WHERE base_id = ${baseId}::uuid
      LIMIT ${BASE_DELETE_BATCH_SIZE}
    )
    DELETE FROM pulse.signal_fields item
    USING victim
    WHERE item.ctid = victim.ctid
  `;
  return result.count ?? 0;
};

const deleteObservedResourcesChunk = async (baseId: string): Promise<number> => {
  const result = await sql`
    WITH victim AS (
      SELECT ctid
      FROM pulse.observed_resources
      WHERE base_id = ${baseId}::uuid
      LIMIT ${BASE_DELETE_BATCH_SIZE}
    )
    DELETE FROM pulse.observed_resources item
    USING victim
    WHERE item.ctid = victim.ctid
  `;
  return result.count ?? 0;
};

const deleteSavedQueriesChunk = async (baseId: string): Promise<number> => {
  const result = await sql`
    WITH victim AS (
      SELECT ctid
      FROM pulse.saved_queries
      WHERE base_id = ${baseId}::uuid
      LIMIT ${BASE_DELETE_BATCH_SIZE}
    )
    DELETE FROM pulse.saved_queries item
    USING victim
    WHERE item.ctid = victim.ctid
  `;
  return result.count ?? 0;
};

const deleteDashboardsChunk = async (baseId: string): Promise<number> => {
  const result = await sql`
    WITH victim AS (
      SELECT ctid
      FROM pulse.dashboards
      WHERE base_id = ${baseId}::uuid
      LIMIT ${BASE_DELETE_BATCH_SIZE}
    )
    DELETE FROM pulse.dashboards item
    USING victim
    WHERE item.ctid = victim.ctid
  `;
  return result.count ?? 0;
};

const deleteSourcesChunk = async (baseId: string): Promise<number> => {
  const result = await sql`
    WITH victim AS (
      SELECT ctid
      FROM pulse.sources
      WHERE base_id = ${baseId}::uuid
      LIMIT ${BASE_DELETE_BATCH_SIZE}
    )
    DELETE FROM pulse.sources item
    USING victim
    WHERE item.ctid = victim.ctid
  `;
  return result.count ?? 0;
};

const deleteBaseAccessChunk = async (baseId: string): Promise<number> => {
  const result = await sql`
    WITH victim AS (
      SELECT access_id
      FROM pulse.base_access
      WHERE base_id = ${baseId}::uuid
      LIMIT 1000
    )
    DELETE FROM auth.access item
    USING victim
    WHERE item.id = victim.access_id
  `;
  return result.count ?? 0;
};

const BASE_DELETE_STEPS: Array<{ phase: string; run: (baseId: string) => Promise<number> }> = [
  { phase: "metric_samples", run: deleteMetricSamplesChunk },
  { phase: "metric_rollups_hourly", run: deleteMetricRollupsChunk },
  { phase: "state_changes", run: deleteStateChangesChunk },
  { phase: "events", run: deleteEventsChunk },
  { phase: "states_current", run: deleteCurrentStatesChunk },
  { phase: "metric_series_dimensions", run: deleteMetricSeriesDimensionsChunk },
  { phase: "source_scrapes", run: deleteSourceScrapesChunk },
  { phase: "ingest_idempotency", run: deleteIngestIdempotencyChunk },
  { phase: "metric_series", run: deleteMetricSeriesChunk },
  { phase: "metric_defs", run: deleteMetricDefsChunk },
  { phase: "signal_fields", run: deleteSignalFieldsChunk },
  { phase: "observed_resources", run: deleteObservedResourcesChunk },
  { phase: "saved_queries", run: deleteSavedQueriesChunk },
  { phase: "dashboards", run: deleteDashboardsChunk },
  { phase: "sources", run: deleteSourcesChunk },
  { phase: "access", run: deleteBaseAccessChunk },
];

const BASE_DATA_CLEAR_STEPS: Array<{ phase: string; run: (baseId: string) => Promise<number> }> = [
  { phase: "metric_samples", run: deleteMetricSamplesChunk },
  { phase: "metric_rollups_hourly", run: deleteMetricRollupsChunk },
  { phase: "state_changes", run: deleteStateChangesChunk },
  { phase: "events", run: deleteEventsChunk },
  { phase: "states_current", run: deleteCurrentStatesChunk },
  { phase: "metric_series_dimensions", run: deleteMetricSeriesDimensionsChunk },
  { phase: "source_scrapes", run: deleteSourceScrapesChunk },
  { phase: "ingest_idempotency", run: deleteIngestIdempotencyChunk },
  { phase: "metric_series", run: deleteMetricSeriesChunk },
  { phase: "metric_defs", run: deleteMetricDefsChunk },
  { phase: "signal_fields", run: deleteSignalFieldsChunk },
  { phase: "observed_resources", run: deleteObservedResourcesChunk },
];

const recordBaseDataClearProgress = async (params: {
  baseId: string;
  phase: string;
  deletedRows: number;
  status?: "queued" | "clearing" | "failed" | "completed";
  errorMessage?: string | null;
}): Promise<void> => {
  await sql`
    INSERT INTO pulse.base_data_clears (
      base_id,
      status,
      phase,
      deleted_rows,
      last_batch_rows,
      error_message,
      updated_at
    )
    VALUES (
      ${params.baseId}::uuid,
      ${params.status ?? "clearing"},
      ${params.phase},
      ${params.deletedRows},
      ${params.deletedRows},
      ${params.errorMessage ?? null},
      now()
    )
    ON CONFLICT (base_id)
    DO UPDATE SET
      status = EXCLUDED.status,
      phase = EXCLUDED.phase,
      deleted_rows = pulse.base_data_clears.deleted_rows + EXCLUDED.deleted_rows,
      last_batch_rows = EXCLUDED.last_batch_rows,
      error_message = EXCLUDED.error_message,
      updated_at = now()
  `;
};

export const purgeBaseDeletionBatch = async (baseId: string): Promise<BaseDeletionBatch> => {
  await sql`
    UPDATE pulse.base_deletions
    SET status = 'deleting', phase = 'deleting', updated_at = now()
    WHERE base_id = ${baseId}::uuid
  `;

  for (const step of BASE_DELETE_STEPS) {
    const deletedRows = await step.run(baseId);
    if (deletedRows > 0) {
      await recordBaseDeletionProgress({ baseId, phase: step.phase, deletedRows });
      return { phase: step.phase, deletedRows, done: false };
    }
  }

  const finalDelete = await sql`
    DELETE FROM pulse.bases
    WHERE id = ${baseId}::uuid
  `;
  return { phase: "base", deletedRows: finalDelete.count ?? 0, done: true };
};

export const purgeBaseDataClearBatch = async (baseId: string): Promise<BaseDeletionBatch> => {
  const [base] = await sql<{ data_clear_completed_at: Date | string | null }[]>`
    SELECT data_clear_completed_at
    FROM pulse.bases
    WHERE id = ${baseId}::uuid
  `;
  if (!base) return { phase: "base", deletedRows: 0, done: true };
  if (base.data_clear_completed_at) return { phase: "completed", deletedRows: 0, done: true };

  await sql`
    UPDATE pulse.base_data_clears
    SET status = 'clearing', phase = 'clearing', updated_at = now()
    WHERE base_id = ${baseId}::uuid
  `;

  for (const step of BASE_DATA_CLEAR_STEPS) {
    const deletedRows = await step.run(baseId);
    if (deletedRows > 0) {
      await recordBaseDataClearProgress({ baseId, phase: step.phase, deletedRows });
      return { phase: step.phase, deletedRows, done: false };
    }
  }

  await sql.begin(async (tx) => {
    await tx`
      UPDATE pulse.sources
      SET last_seen_at = NULL,
          last_error = NULL,
          last_error_at = NULL,
          updated_at = now()
      WHERE base_id = ${baseId}::uuid
    `;
    await tx`
      UPDATE pulse.bases
      SET data_clear_completed_at = now(),
          data_clear_failed_at = NULL,
          data_clear_error = NULL,
          updated_at = now()
      WHERE id = ${baseId}::uuid
    `;
    await tx`
      UPDATE pulse.base_data_clears
      SET status = 'completed',
          phase = 'completed',
          last_batch_rows = 0,
          error_message = NULL,
          completed_at = now(),
          updated_at = now()
      WHERE base_id = ${baseId}::uuid
    `;
  });

  return { phase: "completed", deletedRows: 0, done: true };
};

const baseDeletionJob = lazySync((sync) =>
  sync.job<BaseJobInput>({
    id: "pulse:base-delete",
    delivery: { ackWaitMs: 2 * 60_000, maxAttempts: 10, backoffMs: [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000] },
  }),
);
let baseDeletionJobWorker: Worker | undefined;
const baseDeletionJobError = async ({ context, error }: { context: JobContext<BaseJobInput>; error: Error }) => {
  const message = error instanceof Error ? error.message : "Pulse base deletion failed";
  const failed = context.attempt >= 10;
  await sql`
        UPDATE pulse.base_deletions
        SET status = ${failed ? "failed" : "deleting"},
            error_message = ${message},
            updated_at = now()
        WHERE base_id = ${context.input.baseId}::uuid
      `;
  await sql`
        UPDATE pulse.bases
        SET deletion_failed_at = CASE WHEN ${failed} THEN now() ELSE deletion_failed_at END,
            deletion_error = ${message},
            updated_at = now()
        WHERE id = ${context.input.baseId}::uuid
      `;
  if (failed)
    log.error("Pulse base deletion exhausted retries", {
      baseId: context.input.publicBaseId,
      error: message,
      failureCount: context.failureCount,
    });

  return failed ? { action: "dead_letter" as const, reason: message } : { action: "retry" as const };
};
const baseDataClearJob = lazySync((sync) =>
  sync.job<BaseJobInput>({
    id: "pulse:base-data-clear",
    delivery: { ackWaitMs: 2 * 60_000, maxAttempts: 10, backoffMs: [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000] },
  }),
);
let baseDataClearJobWorker: Worker | undefined;
const baseDataClearJobError = async ({ context, error }: { context: JobContext<BaseJobInput>; error: Error }) => {
  const message = error instanceof Error ? error.message : "Pulse data clear failed";
  const failed = context.attempt >= 10;
  await sql`
        UPDATE pulse.base_data_clears
        SET status = ${failed ? "failed" : "clearing"},
            error_message = ${message},
            updated_at = now()
        WHERE base_id = ${context.input.baseId}::uuid
      `;
  await sql`
        UPDATE pulse.bases
        SET data_clear_failed_at = CASE WHEN ${failed} THEN now() ELSE data_clear_failed_at END,
            data_clear_error = ${message},
            updated_at = now()
        WHERE id = ${context.input.baseId}::uuid
      `;
  if (failed)
    log.error("Pulse data clear exhausted retries", {
      baseId: context.input.publicBaseId,
      error: message,
      failureCount: context.failureCount,
    });

  return failed ? { action: "dead_letter" as const, reason: message } : { action: "retry" as const };
};
export const startPulseBaseJobs = async (): Promise<void> => {
  baseDeletionJobWorker ??= await baseDeletionJob().process({ onError: baseDeletionJobError }, async (context) => {
    const result = await trace.withSpan(
      {
        spanKey: trace.syncSpanKey("job", "pulse:base-delete", context.jobId),
        name: "Pulse base deletion",
        source: "pulse:base-delete",
        appId: "pulse",
        category: "job",
        attributes: { "cloud.pulse.base_id": context.input.publicBaseId },
      },
      () => purgeBaseDeletionBatch(context.input.baseId),
      { summarize: (result) => result },
    );
    if (!result.done) context.resubmit();
  });
  baseDataClearJobWorker ??= await baseDataClearJob().process({ onError: baseDataClearJobError }, async (context) => {
    const result = await trace.withSpan(
      {
        spanKey: trace.syncSpanKey("job", "pulse:base-data-clear", context.jobId),
        name: "Pulse base data clear",
        source: "pulse:base-data-clear",
        appId: "pulse",
        category: "job",
        attributes: { "cloud.pulse.base_id": context.input.publicBaseId },
      },
      () => purgeBaseDataClearBatch(context.input.baseId),
      { summarize: (result) => result },
    );
    if (!result.done) context.resubmit();
  });
};

export const submitBaseDeletionJob = async (baseId: string, publicBaseId: string): Promise<void> => {
  await baseDeletionJob().submit({
    key: `base:${baseId}`,
    coalesce: true,
    input: { baseId, publicBaseId },
  });
};

export const submitBaseDataClearJob = async (baseId: string, publicBaseId: string): Promise<void> => {
  await baseDataClearJob().submit({
    key: `base:${baseId}`,
    coalesce: true,
    input: { baseId, publicBaseId },
  });
};

export const resumePulseBaseDeletionJobs = async (): Promise<void> => {
  const rows = await sql<{ base_id: string; public_base_id: string }[]>`
    SELECT deletion.base_id, base.short_id AS public_base_id
    FROM pulse.base_deletions deletion
    JOIN pulse.bases base ON base.id = deletion.base_id
    WHERE deletion.status IN ('queued', 'deleting')
    ORDER BY deletion.updated_at ASC
    LIMIT 100
  `;
  for (const row of rows) await submitBaseDeletionJob(row.base_id, row.public_base_id);
};

export const resumePulseBaseDataClearJobs = async (): Promise<void> => {
  const rows = await sql<{ base_id: string; public_base_id: string }[]>`
    SELECT clear.base_id, base.short_id AS public_base_id
    FROM pulse.base_data_clears clear
    JOIN pulse.bases base ON base.id = clear.base_id
    WHERE clear.status IN ('queued', 'clearing')
    ORDER BY clear.updated_at ASC
    LIMIT 100
  `;
  for (const row of rows) await submitBaseDataClearJob(row.base_id, row.public_base_id);
};

export const stopPulseBaseDeletionJob = async (): Promise<void> => {
  await baseDeletionJobWorker?.stop();
  baseDeletionJobWorker = undefined;
};
export const stopPulseBaseDataClearJob = async (): Promise<void> => {
  await baseDataClearJobWorker?.stop();
  baseDataClearJobWorker = undefined;
};
