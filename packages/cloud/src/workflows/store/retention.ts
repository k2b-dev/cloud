import type { SQL } from "bun";
import { logger } from "../../services/logging";
import { toPgUuidArray } from "../../services/postgres";
import { withTransaction } from "./transaction";

/**
 * Events are cause records; runs keep their own inputs and context. After 30
 * days only the slim cause row remains: Mail backfill and Grids idempotency
 * still need its dedupe key. This window is fixed, not configurable.
 */
export const WORKFLOW_EVENT_RETENTION_DAYS = 30;

const DEFAULT_BATCH_SIZE = 1000;
const log = logger("workflows:retention");

/** Expire one bounded batch atomically; concurrent Core replicas skip locked rows. */
export const expireWorkflowEventPayloadsBatch = async (options: { olderThan: Date; limit?: number; db?: SQL }): Promise<number> => {
  const limit = options.limit ?? DEFAULT_BATCH_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Workflow event retention batch size must be a positive integer.");
  return withTransaction(options.db, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      SELECT e.id FROM workflows.event e
      WHERE e.payload_expired_at IS NULL
        AND (e.dispatched_at IS NOT NULL OR e.dispatch_failed_at IS NOT NULL)
        AND COALESCE(e.dispatched_at, e.dispatch_failed_at) < ${options.olderThan}
        AND NOT EXISTS (
          SELECT 1 FROM workflows.run r
          WHERE r.event_id = e.id AND r.state NOT IN ('succeeded', 'failed', 'canceled')
        )
      ORDER BY COALESCE(e.dispatched_at, e.dispatch_failed_at), e.id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `;
    if (rows.length === 0) return 0;
    const ids = toPgUuidArray(rows.map((row) => row.id));
    await tx`DELETE FROM workflows.event_delivery WHERE event_id = ANY(${ids}::uuid[])`;
    await tx`
      UPDATE workflows.event
      SET data = '{}'::jsonb, context = '{}'::jsonb, authorization_snapshot = '{}'::jsonb,
          payload_expired_at = now()
      WHERE id = ANY(${ids}::uuid[])
    `;
    return rows.length;
  });
};

/** Sweep for at most five minutes, stopping between batches on cancellation. */
export const expireWorkflowEventPayloads = async (
  options: { now?: Date; signal?: AbortSignal; db?: SQL; batchSize?: number } = {},
): Promise<number> => {
  const olderThan = new Date((options.now ?? new Date()).getTime() - WORKFLOW_EVENT_RETENTION_DAYS * 86_400_000);
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const deadline = Date.now() + 5 * 60_000;
  let expired = 0;
  while (!options.signal?.aborted && Date.now() < deadline) {
    const count = await expireWorkflowEventPayloadsBatch({ olderThan, limit: batchSize, db: options.db });
    expired += count;
    if (count < batchSize) break;
  }
  return expired;
};

const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
let retentionTimer: ReturnType<typeof setInterval> | null = null;
let retentionRunning = false;

/** Core owns this scheduler; SKIP LOCKED makes multiple replicas safe. */
export const startWorkflowEventRetention = (): (() => void) => {
  if (retentionTimer) return () => undefined;
  const abort = new AbortController();
  const expire = async (): Promise<void> => {
    if (retentionRunning) return;
    retentionRunning = true;
    try {
      const expired = await expireWorkflowEventPayloads({ signal: abort.signal });
      if (expired > 0) log.info("Expired workflow event payloads", { expired });
    } catch (error) {
      log.error("Workflow event retention sweep failed", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      retentionRunning = false;
    }
  };
  void expire();
  retentionTimer = setInterval(() => void expire(), RETENTION_INTERVAL_MS);
  retentionTimer.unref?.();
  return () => {
    abort.abort();
    if (retentionTimer) clearInterval(retentionTimer);
    retentionTimer = null;
  };
};
