import type { Worker } from "@k2b/sync";
import { lazySync } from "@valentinkolb/cloud";
import { logger, syncOps, trace } from "@valentinkolb/cloud/services";
import { sql } from "bun";
import type { SqlClient } from "./audit";
import { type GridsRecordEvent, GridsRecordEventSchema, publishRecordEventWithFederatedTargets } from "./record-events";

const log = logger("grids:record-event-outbox");
const RECONCILE_INTERVAL_MS = 15_000;
const RECONCILE_BATCH_SIZE = 500;
const RECONCILE_CLAIM_MS = 30_000;
const MAX_DELIVERY_ATTEMPTS = 20;
const DELIVERED_RETENTION_DAYS = 30;
const DEAD_RETENTION_DAYS = 90;
const SHUTDOWN_DRAIN_MS = 30_000;

type OutboxRow = {
  id: string;
  base_id: string;
  payload: unknown;
  status: "pending" | "failed" | "delivered" | "dead";
  attempts: number;
};

class InvalidRecordEventPayloadError extends Error {}

const parsePayload = (value: unknown): GridsRecordEvent => {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new InvalidRecordEventPayloadError("Invalid record event payload: expected valid JSON");
    }
  }
  const result = GridsRecordEventSchema.safeParse(parsed);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = issue?.path.length ? `${issue.path.join(".")}: ` : "";
  throw new InvalidRecordEventPayloadError(`Invalid record event payload: ${path}${issue?.message ?? "schema mismatch"}`);
};

export const enqueueRecordEvent = async (client: SqlClient, event: Omit<GridsRecordEvent, "v" | "occurredAt">): Promise<string> => {
  const payload = { v: 1, ...event };
  const [row] = await client<Array<{ id: string }>>`
    SELECT grids.enqueue_record_event(${event.tableId}::uuid, ${event.recordId}::uuid, ${payload}::jsonb)::text AS id
  `;
  if (!row) throw new Error("record event outbox insert returned no id");
  return row.id;
};

export const captureRecordEventSnapshot = async (
  client: SqlClient,
  input: {
    snapshotId: string;
    tableId: string;
    recordId: string;
    eventType: GridsRecordEvent["type"];
  },
): Promise<void> => {
  const rows = await client`
    INSERT INTO grids.record_event_snapshots (
      id, base_id, table_id, record_id, event_type, record_version, data, deleted_at
    )
    SELECT
      ${input.snapshotId}::uuid,
      table_ref.base_id,
      record.table_id,
      record.id,
      ${input.eventType},
      record.version,
      record.data || COALESCE(relations.data, '{}'::jsonb),
      record.deleted_at
    FROM grids.records record
    JOIN grids.tables table_ref ON table_ref.id = record.table_id
    LEFT JOIN LATERAL (
      SELECT jsonb_object_agg(grouped.field_id, grouped.record_ids) AS data
      FROM (
        SELECT
          link.from_field_id::text AS field_id,
          jsonb_agg(link.to_record_id::text ORDER BY link.position, link.to_record_id) AS record_ids
        FROM grids.record_links link
        WHERE link.from_record_id = record.id
        GROUP BY link.from_field_id
      ) grouped
    ) relations ON TRUE
    WHERE record.id = ${input.recordId}::uuid
      AND record.table_id = ${input.tableId}::uuid
    RETURNING id
  `;
  if (rows.length !== 1) throw new Error("record event snapshot source record is missing");
};

export const dispatchRecordEventOutbox = async (
  id: string,
  publish: (event: GridsRecordEvent) => Promise<void> = publishRecordEventWithFederatedTargets,
): Promise<"delivered" | "already-delivered" | "dead"> => {
  const active = activeDispatches.get(id);
  if (active) {
    const status = await active;
    return status === "dead" ? "dead" : "already-delivered";
  }

  const delivery = dispatchRecordEventOutboxOnce(id, publish);
  activeDispatches.set(id, delivery);
  try {
    return await delivery;
  } finally {
    activeDispatches.delete(id);
  }
};

type DispatchStatus = "delivered" | "already-delivered" | "dead";

const activeDispatches = new Map<string, Promise<DispatchStatus>>();

const recordDeliveryFailure = async (row: OutboxRow, error: unknown): Promise<"failed" | "dead"> => {
  const attempts = row.attempts + 1;
  const delaySeconds = Math.min(300, 2 ** Math.min(attempts, 8));
  const status = error instanceof InvalidRecordEventPayloadError || attempts >= MAX_DELIVERY_ATTEMPTS ? "dead" : "failed";
  const message = error instanceof Error ? error.message : String(error);

  await sql.begin(async (tx) => {
    const updated = await tx<Array<{ id: string }>>`
      UPDATE grids.record_event_outbox
      SET status = ${status},
          attempts = ${attempts},
          next_attempt_at = now() + (${delaySeconds} * interval '1 second'),
          last_error = ${message},
          dead_at = ${status === "dead" ? sql`now()` : null}
      WHERE id = ${row.id}::uuid
        AND status IN ('pending', 'failed')
        AND attempts = ${row.attempts}
      RETURNING id::text AS id
    `;
    if (updated.length === 0 || status !== "dead") return;
    await tx`
      INSERT INTO grids.record_event_delivery_failures (
        base_id, consumer_group, event_id, payload, error, attempts, status, dead_at
      ) VALUES (
        ${row.base_id}::uuid,
        'record-event-outbox',
        ${row.id},
        ${JSON.stringify(row.payload)},
        ${message},
        ${attempts},
        'dead',
        now()
      )
      ON CONFLICT (base_id, consumer_group, event_id) DO UPDATE SET
        payload = EXCLUDED.payload,
        error = EXCLUDED.error,
        attempts = EXCLUDED.attempts,
        status = 'dead',
        last_seen_at = now(),
        dead_at = COALESCE(grids.record_event_delivery_failures.dead_at, now())
    `;
  });
  return status;
};

const dispatchRecordEventOutboxOnce = async (id: string, publish: (event: GridsRecordEvent) => Promise<void>): Promise<DispatchStatus> => {
  const [row] = await sql<OutboxRow[]>`
    SELECT id::text, base_id::text, payload, status, attempts
    FROM grids.record_event_outbox
    WHERE id = ${id}::uuid
  `;
  if (!row || row.status === "delivered") return "already-delivered";
  if (row.status === "dead") return "dead";

  try {
    const event = parsePayload(row.payload);
    // Sync publication may perform network I/O and database-backed target
    // resolution. It must never run inside the outbox state transaction.
    await publish(event);
  } catch (error) {
    await recordDeliveryFailure(row, error);
    throw error;
  }

  const updated = await sql`
    UPDATE grids.record_event_outbox
    SET status = 'delivered', delivered_at = now(), last_error = NULL
    WHERE id = ${id}::uuid
      AND status IN ('pending', 'failed')
      AND attempts = ${row.attempts}
    RETURNING id
  `;
  if (updated.length > 0) return "delivered";

  const [current] = await sql<Array<{ status: OutboxRow["status"] }>>`
    SELECT status
    FROM grids.record_event_outbox
    WHERE id = ${id}::uuid
  `;
  return current?.status === "dead" ? "dead" : "already-delivered";
};

let activeDeliveries = 0;

const deliveryJob = lazySync((sync) =>
  sync.job<{ outboxId: string }>({
    id: "grids:record-event-outbox",
    delivery: { ackWaitMs: 30_000, maxAttempts: 4, backoffMs: [1_000, 5_000, 30_000] },
  }),
);
let deliveryWorker: Worker | undefined;
let unregisterDeadLetters: (() => void) | undefined;
const startDeliveryWorker = async (): Promise<void> => {
  unregisterDeadLetters ??= syncOps.registerDeadLetters({
    name: "grids:record-event-outbox",
    kind: "job",
    store: deliveryJob().deadLetters,
  });
  deliveryWorker ??= await deliveryJob().process({}, async (ctx) => {
    activeDeliveries += 1;
    try {
      await trace.withSpan(
        {
          spanKey: trace.syncSpanKey("job", "grids:record-event-outbox", ctx.jobId),
          name: "Grid record event outbox",
          source: "grids:record-event-outbox",
          appId: "grids",
          category: "job",
          attributes: { "cloud.grids.record_event_outbox_id": ctx.input.outboxId },
        },
        async () => ({ outboxId: ctx.input.outboxId, status: await dispatchRecordEventOutbox(ctx.input.outboxId) }),
        { summarize: (result) => result },
      );
    } finally {
      activeDeliveries -= 1;
      if (runtimeStarted) {
        void runReconcile().catch((error) => {
          log.warn("Record event outbox follow-up reconcile failed", {
            outboxId: ctx.input.outboxId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }
  });
};

const submitRecordEventOutbox = async (outboxId: string): Promise<void> => {
  if (!runtimeStarted) return;
  try {
    await deliveryJob().submit({ coalesce: true, key: outboxId, input: { outboxId } });
  } catch (error) {
    log.warn("Record event outbox submit failed; reconciler will retry", {
      outboxId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

let runtimeStarted = false;

export const notifyRecordEventOutbox = (outboxId: string): void => {
  if (!runtimeStarted) return;
  void runReconcile().catch((error) => {
    log.warn("Record event outbox notification reconcile failed", {
      outboxId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
};

export const claimRecordEventOutboxBatch = async (limit = RECONCILE_BATCH_SIZE): Promise<string[]> => {
  const cap = Math.min(Math.max(limit, 1), RECONCILE_BATCH_SIZE);
  const rows = await sql.begin(async (tx) => {
    const claimed = await tx<Array<{ id: string }>>`
      WITH candidates AS MATERIALIZED (
        SELECT candidate.id
        FROM grids.record_event_outbox candidate
        WHERE candidate.status IN ('pending', 'failed')
          AND candidate.next_attempt_at <= now()
          AND NOT EXISTS (
            SELECT 1
            FROM grids.record_event_outbox predecessor
            WHERE predecessor.record_id = candidate.record_id
              AND predecessor.status IN ('pending', 'failed', 'dead')
              AND (predecessor.created_at, predecessor.id) < (candidate.created_at, candidate.id)
          )
        ORDER BY candidate.next_attempt_at, candidate.created_at, candidate.id
        LIMIT ${cap}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE grids.record_event_outbox outbox
      SET next_attempt_at = now() + (${RECONCILE_CLAIM_MS} * interval '1 millisecond')
      FROM candidates
      WHERE outbox.id = candidates.id
      RETURNING outbox.id::text AS id
    `;
    return [...claimed];
  });
  return rows.map((row) => row.id);
};

export const redriveRecordEventOutbox = async (id: string, replacementPayload?: unknown): Promise<boolean> => {
  const redriven = await sql.begin(async (tx) => {
    const [row] = await tx<OutboxRow[]>`
      SELECT id::text, base_id::text, payload, status, attempts
      FROM grids.record_event_outbox
      WHERE id = ${id}::uuid
      FOR UPDATE
    `;
    if (!row || row.status !== "dead") return false;
    const payload = parsePayload(replacementPayload ?? row.payload);
    await tx`
      UPDATE grids.record_event_outbox
      SET payload = ${payload}::jsonb,
          status = 'pending',
          attempts = 0,
          next_attempt_at = now(),
          last_error = NULL,
          delivered_at = NULL,
          dead_at = NULL
      WHERE id = ${id}::uuid
    `;
    await tx`
      DELETE FROM grids.record_event_delivery_failures
      WHERE base_id = ${row.base_id}::uuid
        AND consumer_group = 'record-event-outbox'
        AND event_id = ${row.id}
    `;
    return true;
  });
  if (redriven) notifyRecordEventOutbox(id);
  return redriven;
};

export const reapTerminalRecordEventOutbox = async (
  deliveredRetentionDays = DELIVERED_RETENTION_DAYS,
  deadRetentionDays = DEAD_RETENTION_DAYS,
): Promise<number> => {
  const rows = await sql<Array<{ id: string }>>`
    WITH deleted AS (
      DELETE FROM grids.record_event_outbox
      WHERE (status = 'delivered' AND delivered_at < now() - (${Math.max(deliveredRetentionDays, 0)} * interval '1 day'))
         OR (status = 'dead' AND dead_at < now() - (${Math.max(deadRetentionDays, 0)} * interval '1 day'))
      RETURNING id, base_id
    ), cleaned_failures AS (
      DELETE FROM grids.record_event_delivery_failures failure
      USING deleted
      WHERE failure.base_id = deleted.base_id
        AND failure.consumer_group = 'record-event-outbox'
        AND failure.event_id = deleted.id::text
    )
    SELECT id::text AS id FROM deleted
  `;
  return rows.length;
};

const reconcileRecordEventOutbox = async (): Promise<number> => {
  await reapTerminalRecordEventOutbox();
  const ids = await claimRecordEventOutboxBatch();
  await Promise.all(ids.map(submitRecordEventOutbox));
  return ids.length;
};

export const recordEventOutboxStats = async (): Promise<{
  pending: number;
  failed: number;
  dead: number;
  oldestPendingAt: string | null;
}> => {
  const [row] = await sql<
    Array<{ pending: number | string; failed: number | string; dead: number | string; oldest_pending_at: Date | string | null }>
  >`
    SELECT
      count(*) FILTER (WHERE status = 'pending')::int AS pending,
      count(*) FILTER (WHERE status = 'failed')::int AS failed,
      count(*) FILTER (WHERE status = 'dead')::int AS dead,
      min(created_at) FILTER (WHERE status IN ('pending', 'failed')) AS oldest_pending_at
    FROM grids.record_event_outbox
  `;
  return {
    pending: Number(row?.pending ?? 0),
    failed: Number(row?.failed ?? 0),
    dead: Number(row?.dead ?? 0),
    oldestPendingAt: row?.oldest_pending_at ? new Date(row.oldest_pending_at).toISOString() : null,
  };
};

let reconcileTimer: ReturnType<typeof setInterval> | null = null;
let activeReconcile: Promise<number> | null = null;
let reconcileRequested = false;

type DrainState = { activeDeliveries: number; activeReconciles: number };

const currentDrainState = (): DrainState => ({
  activeDeliveries,
  activeReconciles: activeReconcile ? 1 : 0,
});

export const waitForRecordEventOutboxDrain = async (
  readState: () => DrainState = currentDrainState,
  timeoutMs = SHUTDOWN_DRAIN_MS,
): Promise<{ drained: boolean; state: DrainState }> => {
  const deadline = performance.now() + Math.max(timeoutMs, 0);
  while (true) {
    const state = readState();
    if (state.activeDeliveries === 0 && state.activeReconciles === 0) {
      return { drained: true, state };
    }
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) return { drained: false, state };
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, remainingMs)));
  }
};

const runReconcile = (): Promise<number> => {
  if (activeReconcile) {
    reconcileRequested = true;
    return activeReconcile;
  }
  activeReconcile = (async () => {
    let claimed = 0;
    do {
      reconcileRequested = false;
      claimed = await reconcileRecordEventOutbox();
    } while (reconcileRequested && runtimeStarted);
    return claimed;
  })().finally(() => {
    activeReconcile = null;
    if (reconcileRequested && runtimeStarted) {
      reconcileRequested = false;
      void runReconcile().catch((error) => {
        log.warn("Record event outbox coalesced reconcile failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  });
  return activeReconcile;
};

export const startRecordEventOutbox = async (): Promise<void> => {
  runtimeStarted = true;
  await startDeliveryWorker();
  await reconcileRecordEventOutbox();
  if (!reconcileTimer) {
    reconcileTimer = setInterval(() => {
      void runReconcile().catch((error) => {
        log.warn("Record event outbox reconcile failed", { error: error instanceof Error ? error.message : String(error) });
      });
    }, RECONCILE_INTERVAL_MS);
  }
};

export const stopRecordEventOutbox = async (): Promise<void> => {
  runtimeStarted = false;
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = null;
  const deadline = performance.now() + SHUTDOWN_DRAIN_MS;
  const producerDrain = await waitForRecordEventOutboxDrain(() => ({ ...currentDrainState(), activeDeliveries: 0 }), SHUTDOWN_DRAIN_MS);
  await deliveryWorker?.drain({ timeoutMs: SHUTDOWN_DRAIN_MS });
  deliveryWorker = undefined;
  unregisterDeadLetters?.();
  unregisterDeadLetters = undefined;
  const drain = await waitForRecordEventOutboxDrain(currentDrainState, Math.max(0, deadline - performance.now()));
  if (!producerDrain.drained || !drain.drained) {
    log.warn("Record event outbox did not drain before shutdown", currentDrainState());
  }
};
