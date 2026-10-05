import { createHash } from "node:crypto";
import { lazySync } from "@k2b/cloud";
import type { MessageMeta } from "@k2b/sync";
import { z } from "zod";

const QUEUE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RECORD_EVENT_PAYLOAD_BYTES = 68_000;
/**
 * 256 dead letters at the payload limit plus Sync's 4 KiB of dead-letter
 * headroom, the depth Sync gives a job or queue by default. The work queue
 * dead-letters only when PostgreSQL, which records workflow delivery failures,
 * is unavailable.
 */
const RECORD_EVENT_DEAD_LETTER_BYTES = 256 * (RECORD_EVENT_PAYLOAD_BYTES + 4096);
const WORK_QUEUE_TENANT = "workflow-kernel";
export const RECORD_EVENT_WORK_PARTITIONS = 32;
export const RECORD_EVENT_WORK_LEASE_MS = 120_000;
/** PostgreSQL-owned workflow delivery budget; each failed attempt re-queues the event behind its partition. */
export const RECORD_EVENT_WORK_MAX_ATTEMPTS = 20;
/** In-place transport attempts, used only while the failure store itself is unavailable. */
export const RECORD_EVENT_WORK_TRANSPORT_ATTEMPTS = 3;
const RECORD_EVENT_WORK_TRANSPORT_BACKOFF_MS = [1_000, 5_000];
const RECORD_EVENT_RETRY_BASE_MS = 1_000;
const RECORD_EVENT_RETRY_MAX_MS = 5 * 60_000;

/** Exponential delay for the next application retry: 1 s after the first failure, capped at five minutes. */
export const workflowRecordEventRetryDelayMs = (attempts: number): number =>
  Math.min(RECORD_EVENT_RETRY_MAX_MS, RECORD_EVENT_RETRY_BASE_MS * 2 ** Math.max(0, Math.min(attempts - 1, 12)));

export const GridsRecordEventSchema = z
  .object({
    v: z.literal(1),
    type: z.enum(["record.created", "record.updated", "record.deleted", "record.restored", "record.finalized", "comment.created"]),
    baseId: z.string().uuid(),
    tableId: z.string().uuid(),
    recordId: z.string().uuid(),
    version: z.number().int().positive().nullable(),
    changedFieldIds: z.array(z.string().uuid()),
    actorId: z.string().uuid().nullable(),
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type GridsRecordEvent = z.infer<typeof GridsRecordEventSchema>;

export const recordEventWorkQueue = lazySync((sync) =>
  sync.queue<GridsRecordEvent>({
    id: "grids:workflow-record-events",
    ordering: { mode: "partitioned", partitions: RECORD_EVENT_WORK_PARTITIONS },
    retention: { maxAgeMs: QUEUE_RETENTION_MS, maxBytes: 1024 * 1024 * 1024 },
    deadLetterRetention: { maxBytes: RECORD_EVENT_DEAD_LETTER_BYTES },
    maxPayloadBytes: RECORD_EVENT_PAYLOAD_BYTES,
    delivery: {
      ackWaitMs: RECORD_EVENT_WORK_LEASE_MS,
      maxAttempts: RECORD_EVENT_WORK_TRANSPORT_ATTEMPTS,
      backoffMs: RECORD_EVENT_WORK_TRANSPORT_BACKOFF_MS,
    },
  }),
);

const hashEventKey = (key: string): string => createHash("sha256").update(key).digest("hex");

const recordEventIdempotencyKey = (event: GridsRecordEvent): string =>
  `${event.type}:${event.tableId}:${event.recordId}:${event.version ?? "deleted"}:${event.occurredAt}`;

/** Queues a committed record event for the workflows it triggers; `replayKey` sends it again. */
export const publishRecordEvent = async (event: GridsRecordEvent, options: { replayKey?: string } = {}): Promise<void> => {
  const idempotencyKey = hashEventKey(recordEventIdempotencyKey(event));
  const workIdempotencyKey = options.replayKey ? `${idempotencyKey}:replay:${options.replayKey}` : idempotencyKey;
  await recordEventWorkQueue().send({
    orderingKey: event.recordId,
    tenantId: WORK_QUEUE_TENANT,
    idempotencyKey: hashEventKey(`${event.baseId}:${workIdempotencyKey}`),
    meta: { baseId: event.baseId },
    data: event,
  });
};

/**
 * Re-queues a failed workflow delivery behind its partition instead of holding
 * the partition for an in-place retry. `deliveryKey` identifies the original
 * accepted delivery across retries so the PostgreSQL failure row accumulates.
 */
export const requeueRecordEventWork = async (input: {
  event: GridsRecordEvent;
  tenantId: string;
  meta: MessageMeta | undefined;
  deliveryKey: string;
  attempts: number;
}): Promise<void> => {
  await recordEventWorkQueue().send({
    orderingKey: input.event.recordId,
    tenantId: input.tenantId,
    idempotencyKey: hashEventKey(`${input.deliveryKey}:retry:${input.attempts}`),
    delayMs: workflowRecordEventRetryDelayMs(input.attempts),
    meta: { ...input.meta, deliveryKey: input.deliveryKey },
    data: input.event,
  });
};
