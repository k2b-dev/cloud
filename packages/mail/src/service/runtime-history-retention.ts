import { sql } from "@k2b/cloud";
import { logger } from "@k2b/cloud/services";
import { databaseErrorCode } from "./database-errors";

const log = logger("mail:runtime-history");
// A weekend plus the following incident-response day for successes; a month for failures.
const DEFAULT_SUCCESS_RETENTION_DAYS = 3;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_BATCH_SIZE = 1_000;
const DEFAULT_MAX_BATCHES = 100;
const DEFAULT_MAX_DURATION_MS = 5_000;

const positiveInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
};

// Integration tests explain the actual statements. Each predicate has its own age/order index.
export const runtimeHistoryBatches = [
  {
    key: "syncRuns",
    index: "mail.sync_runs_completed_retention_idx",
    successful: true,
    query: `WITH expired AS (
      SELECT ctid AS tid FROM mail.sync_runs
      WHERE state = 'completed' AND COALESCE(finished_at, started_at) < $1::timestamptz
      ORDER BY COALESCE(finished_at, started_at), id LIMIT $2 FOR UPDATE SKIP LOCKED
    ) DELETE FROM mail.sync_runs run WHERE run.ctid = ANY(ARRAY(SELECT tid FROM expired)) RETURNING run.id`,
  },
  {
    key: "syncRuns",
    index: "mail.sync_runs_error_retention_idx",
    successful: false,
    query: `WITH expired AS (
      SELECT ctid AS tid FROM mail.sync_runs
      WHERE state NOT IN ('running', 'completed') AND COALESCE(finished_at, started_at) < $1::timestamptz
      ORDER BY COALESCE(finished_at, started_at), id LIMIT $2 FOR UPDATE SKIP LOCKED
    ) DELETE FROM mail.sync_runs run WHERE run.ctid = ANY(ARRAY(SELECT tid FROM expired)) RETURNING run.id`,
  },
  {
    key: "automationLog",
    index: "mail.automation_log_retention_idx",
    successful: false,
    query: `WITH expired AS (
      SELECT log.ctid AS tid FROM mail.automation_log log LEFT JOIN workflows.run run ON run.id = log.run_id
      WHERE log.created_at < $1::timestamptz
        AND (run.id IS NULL OR run.state IN ('succeeded', 'failed', 'canceled'))
      ORDER BY log.created_at, log.id LIMIT $2 FOR UPDATE OF log SKIP LOCKED
    ) DELETE FROM mail.automation_log log WHERE log.ctid = ANY(ARRAY(SELECT tid FROM expired)) RETURNING log.id`,
  },
  {
    key: "automationOrder",
    index: "mail.workflow_effect_order_expiry_idx",
    successful: false,
    query: `WITH expired AS (
      SELECT ordering.ctid AS tid FROM mail.workflow_effect_order ordering
      WHERE ordering.expires_at < $1::timestamptz + interval '1 day'
        AND NOT EXISTS (
          SELECT 1 FROM mail.workflow_effect_order sibling
          JOIN workflows.event event ON event.id = sibling.event_id
          LEFT JOIN workflows.run run ON run.event_id = sibling.event_id
          WHERE sibling.remote_message_ref_id = ordering.remote_message_ref_id
            AND (sibling.expires_at > $3::timestamptz OR run.state IN ('queued', 'running', 'waiting', 'needs_attention')
              OR (event.dispatched_at IS NULL AND event.dispatch_failed_at IS NULL))
        )
      ORDER BY ordering.expires_at, ordering.event_id LIMIT $2 FOR UPDATE OF ordering SKIP LOCKED
    ) DELETE FROM mail.workflow_effect_order ordering
      WHERE ordering.ctid = ANY(ARRAY(SELECT tid FROM expired)) RETURNING ordering.event_id`,
  },
] as const;

export const cleanupMailRuntimeHistory = async (
  options: {
    retentionDays?: number;
    successRetentionDays?: number;
    batchSize?: number;
    maxBatches?: number;
    maxDurationMs?: number;
    now?: Date;
  } = {},
  db: typeof sql = sql,
): Promise<{ syncRuns: number; automationLog: number; automationOrder: number }> => {
  const retentionDays = positiveInteger(options.retentionDays ?? DEFAULT_RETENTION_DAYS, "Retention days");
  const successDays = positiveInteger(options.successRetentionDays ?? DEFAULT_SUCCESS_RETENTION_DAYS, "Success retention days");
  const batchSize = Math.min(positiveInteger(options.batchSize ?? DEFAULT_BATCH_SIZE, "Batch size"), 10_000);
  const maxBatches = Math.min(positiveInteger(options.maxBatches ?? DEFAULT_MAX_BATCHES, "Max batches"), 1_000);
  const maxDurationMs = Math.min(positiveInteger(options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS, "Max duration"), 60_000);
  const now = options.now ?? new Date();
  const started = performance.now();
  const totals = { syncRuns: 0, automationLog: 0, automationOrder: 0 };
  const errors: unknown[] = [];
  let hadError = false;
  const deadline = started + maxDurationMs;
  const progress = runtimeHistoryBatches.map((source) => ({ source, batches: 0, backlog: false }));

  for (const entry of progress) {
    const { source } = entry;
    // Only sync history requires its new indexes before attempting a bounded delete.
    // Auxiliary cleanup already ran before these indexes existed and must continue during builds.
    if (source.key !== "syncRuns") continue;
    const [index] = await db<{ ready: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_index
        WHERE indexrelid = to_regclass(${source.index}) AND indisvalid AND indisready AND indislive) AS ready
    `;
    if (!index?.ready) {
      log.warn("Mail history cleanup waiting for background index", { index: source.index });
      hadError = true;
      entry.batches = maxBatches;
    }
  }

  const drain = async (entry: (typeof progress)[number], sourceDeadline: number) => {
    const { source } = entry;
    const days = source.successful ? successDays : retentionDays;
    const cutoff = new Date(now.getTime() - days * 86_400_000);
    try {
      while (entry.batches < maxBatches) {
        const remaining = Math.floor(sourceDeadline - performance.now());
        if (remaining <= 0) break;
        // Commit each batch independently with database-enforced statement/lock budgets.
        const rows = await db.begin(async (tx) => {
          await tx`SELECT set_config('statement_timeout', ${String(remaining)}, true),
            set_config('lock_timeout', ${String(Math.min(250, remaining))}, true)`;
          return tx.unsafe(source.query, source.key === "automationOrder" ? [cutoff, batchSize, now] : [cutoff, batchSize]);
        });
        entry.batches += 1;
        const count = rows.length;
        totals[source.key] += count;
        entry.backlog = count === batchSize;
        if (count < batchSize) break;
      }
    } catch (error) {
      hadError = true;
      const code = databaseErrorCode(error);
      // A full batch before statement-budget cancellation may borrow unused time in the second turn.
      if (code !== "57014") entry.backlog = false;
      if (["57014", "55P03"].includes(code ?? "")) {
        log.warn("Mail history cleanup statement budget exhausted", { index: source.index, deleted: totals[source.key] });
      } else {
        log.error("Mail history cleanup failed", { index: source.index, error: String(error) });
        errors.push(error);
      }
    }
  };
  for (const entry of progress) {
    // Reserve a fair first turn for every source; slow auxiliary tables cannot starve sync history.
    await drain(entry, Math.min(deadline, performance.now() + maxDurationMs / progress.length));
  }
  while (Math.floor(deadline - performance.now()) > 0) {
    const backlogged = progress.filter((entry) => entry.source.key === "syncRuns" && entry.backlog && entry.batches < maxBatches);
    if (backlogged.length === 0) break;
    for (const [index, entry] of backlogged.entries()) {
      // Reassign unused time again if one sync source empties before the other.
      await drain(entry, performance.now() + Math.max(0, deadline - performance.now()) / (backlogged.length - index));
    }
  }
  const deleted = totals.syncRuns + totals.automationLog + totals.automationOrder;
  if (deleted > 0 || hadError) {
    const durationMs = Math.max(1, Math.round(performance.now() - started));
    log.info("Mail runtime history cleanup", { ...totals, durationMs, rowsPerMinute: Math.round((deleted * 60_000) / durationMs) });
  }
  if (errors.length > 0) throw new AggregateError(errors, "Mail runtime history cleanup failed");
  return totals;
};
