import { sql } from "bun";

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_BATCH_SIZE = 1_000;
const DEFAULT_MAX_BATCHES = 100;
const DEFAULT_MAX_DURATION_MS = 5_000;

const positiveInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
};

export const cleanupMailRuntimeHistory = async (
  options: { retentionDays?: number; batchSize?: number; maxBatches?: number; maxDurationMs?: number } = {},
): Promise<{ syncRuns: number; automationLog: number; automationOrder: number }> => {
  const retentionDays = positiveInteger(options.retentionDays ?? DEFAULT_RETENTION_DAYS, "Retention days");
  const batchSize = Math.min(positiveInteger(options.batchSize ?? DEFAULT_BATCH_SIZE, "Batch size"), 10_000);
  const maxBatches = Math.min(positiveInteger(options.maxBatches ?? DEFAULT_MAX_BATCHES, "Max batches"), 1_000);
  const maxDurationMs = Math.min(positiveInteger(options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS, "Max duration"), 60_000);
  const deadline = Date.now() + maxDurationMs;
  let syncRuns = 0,
    automationLog = 0,
    automationOrder = 0;

  for (let batch = 0; batch < maxBatches && Date.now() < deadline; batch += 1) {
    const deleted = await sql.begin(async (tx) => {
      const runRows = await tx<{ id: string }[]>`
        WITH expired AS (
          SELECT id
          FROM mail.sync_runs
          WHERE state <> 'running'
            AND COALESCE(finished_at, started_at) < now() - (${retentionDays}::int * interval '1 day')
          ORDER BY COALESCE(finished_at, started_at), id
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM mail.sync_runs run
        USING expired
        WHERE run.id = expired.id
        RETURNING run.id
      `;
      const logs = await tx<{ id: string }[]>`
        WITH expired AS (
          SELECT log.id FROM mail.automation_log log LEFT JOIN workflows.run run ON run.id = log.run_id
          WHERE log.created_at < now() - (${retentionDays}::int * interval '1 day')
            AND (run.id IS NULL OR run.state IN ('succeeded', 'failed', 'canceled'))
          ORDER BY log.created_at, log.id LIMIT ${batchSize} FOR UPDATE OF log SKIP LOCKED
        ) DELETE FROM mail.automation_log log USING expired WHERE log.id = expired.id RETURNING log.id`;
      const ordering = await tx<{ event_id: string }[]>`
        WITH expired AS (
          SELECT ordering.event_id FROM mail.workflow_effect_order ordering
          WHERE ordering.expires_at < now() - (GREATEST(${retentionDays}::int - 1, 0) * interval '1 day')
            AND NOT EXISTS (
              SELECT 1 FROM mail.workflow_effect_order sibling
              JOIN workflows.event event ON event.id = sibling.event_id
              LEFT JOIN workflows.run run ON run.event_id = sibling.event_id
              WHERE sibling.remote_message_ref_id = ordering.remote_message_ref_id
                AND (sibling.expires_at > now() OR run.state IN ('queued', 'running', 'waiting', 'needs_attention')
                  OR (event.dispatched_at IS NULL AND event.dispatch_failed_at IS NULL))
            )
          ORDER BY ordering.expires_at, ordering.event_id LIMIT ${batchSize} FOR UPDATE OF ordering SKIP LOCKED
        ) DELETE FROM mail.workflow_effect_order ordering USING expired WHERE ordering.event_id = expired.event_id RETURNING ordering.event_id`;
      return { syncRuns: runRows.length, automationLog: logs.length, automationOrder: ordering.length };
    });
    syncRuns += deleted.syncRuns;
    automationLog += deleted.automationLog;
    automationOrder += deleted.automationOrder;
    if (Math.max(deleted.syncRuns, deleted.automationLog, deleted.automationOrder) < batchSize) break;
  }
  return { syncRuns, automationLog, automationOrder };
};
