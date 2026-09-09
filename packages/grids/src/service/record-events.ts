import { createHash } from "node:crypto";
import type { MessageMeta } from "@k2b/sync";
import { lazySync } from "@k2b/cloud";
import { latestTopicCursor } from "@k2b/cloud/services";
import { sql } from "bun";
import { z } from "zod";
import { projectPublicIds } from "./public-resources";

const TOPIC_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
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

export const toPublicRecordEvent = async (event: GridsRecordEvent) => {
  const [bases, tables, records, fields] = await Promise.all([
    projectPublicIds("base", [event.baseId]),
    projectPublicIds("table", [event.tableId]),
    projectPublicIds("record", [event.recordId]),
    projectPublicIds("field", event.changedFieldIds),
  ]);
  const required = (ids: ReadonlyMap<string, string>, id: string, resource: string) => {
    const publicId = ids.get(id);
    if (!publicId) throw new Error(`Missing public ID for ${resource}`);
    return publicId;
  };
  return {
    ...event,
    baseId: required(bases, event.baseId, "base"),
    tableId: required(tables, event.tableId, "table"),
    recordId: required(records, event.recordId, "record"),
    changedFieldIds: event.changedFieldIds.map((id) => required(fields, id, "field")),
  };
};

const recordTopic = lazySync((sync) =>
  sync.topic<GridsRecordEvent>({
    id: "grids:records",
    retention: { maxAgeMs: TOPIC_RETENTION_MS, maxBytes: 1024 * 1024 * 1024 },
    maxPayloadBytes: 68_000,
  }),
);

export const recordEventWorkQueue = lazySync((sync) =>
  sync.queue<GridsRecordEvent>({
    id: "grids:workflow-record-events",
    ordering: { mode: "partitioned", partitions: RECORD_EVENT_WORK_PARTITIONS },
    retention: { maxAgeMs: TOPIC_RETENTION_MS, maxBytes: 1024 * 1024 * 1024 },
    maxPayloadBytes: 68_000,
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

const publishRecordEventToTopic = (event: GridsRecordEvent, idempotencyKey: string) =>
  recordTopic().publish({
    tenantId: event.baseId,
    orderingKey: event.recordId,
    idempotencyKey,
    data: event,
  });

export const publishRecordEvent = async (event: GridsRecordEvent, options: { replayKey?: string } = {}): Promise<void> => {
  const idempotencyKey = hashEventKey(recordEventIdempotencyKey(event));
  const workIdempotencyKey = options.replayKey ? `${idempotencyKey}:replay:${options.replayKey}` : idempotencyKey;
  await Promise.all([
    publishRecordEventToTopic(event, idempotencyKey),
    recordEventWorkQueue().send({
      orderingKey: event.recordId,
      tenantId: WORK_QUEUE_TENANT,
      idempotencyKey: hashEventKey(`${event.baseId}:${workIdempotencyKey}`),
      meta: { baseId: event.baseId },
      data: event,
    }),
  ]);
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

export const resolveFederatedTargetsForRecordEvent = async (
  event: GridsRecordEvent,
): Promise<Array<{ baseId: string; tableId: string; changedFieldIds: string[] }>> => {
  if (event.type === "comment.created") return [];
  const mappingCondition =
    event.changedFieldIds.length === 0
      ? sql`TRUE`
      : sql`(
          mapping.source_field_id = ANY(${sql.array(event.changedFieldIds, "UUID")}::uuid[])
          OR mapped_source_field.type IN ('formula', 'lookup', 'rollup')
        )`;
  const rows = await sql<Array<{ base_id: string; table_id: string; changed_field_ids: string[] }>>`
    SELECT target.base_id::text,
           target.id::text AS table_id,
           COALESCE(
             array_agg(DISTINCT mapping.target_field_id::text) FILTER (WHERE mapping.target_field_id IS NOT NULL),
             ARRAY[]::text[]
           ) AS changed_field_ids
    FROM grids.federated_table_revisions revision
    JOIN grids.tables target
      ON target.id = revision.table_id
     AND target.kind = 'federated'
     AND target.deleted_at IS NULL
    JOIN grids.bases target_base
      ON target_base.id = target.base_id
     AND target_base.deleted_at IS NULL
    JOIN grids.federated_table_sources source
      ON source.revision_id = revision.id
     AND source.source_table_id = ${event.tableId}::uuid
     AND source.authorized_at IS NOT NULL
     AND source.revoked_at IS NULL
    LEFT JOIN grids.federated_field_mappings mapping
      ON mapping.revision_id = revision.id
     AND mapping.source_table_id = source.source_table_id
    LEFT JOIN grids.fields mapped_source_field
      ON mapped_source_field.id = mapping.source_field_id
     AND mapped_source_field.table_id = source.source_table_id
    WHERE revision.status = 'active'
      AND ${mappingCondition}
    GROUP BY target.base_id, target.id
    HAVING ${event.changedFieldIds.length === 0 ? sql`TRUE` : sql`COUNT(mapping.target_field_id) > 0`}
  `;
  return rows.map((row) => ({ baseId: row.base_id, tableId: row.table_id, changedFieldIds: row.changed_field_ids }));
};

/**
 * Combined-table targets receive the projected event on the topic only. The
 * workflow queue cannot serve them: the committed snapshot belongs to the
 * source table, so a record-event trigger on a Combined table has nothing to
 * evaluate and would fail deterministically.
 */
export const publishRecordEventWithFederatedTargets = async (
  event: GridsRecordEvent,
  options: { replayKey?: string } = {},
): Promise<void> => {
  const targets = await resolveFederatedTargetsForRecordEvent(event);
  await Promise.all([
    publishRecordEvent(event, options),
    ...targets.map((target) => {
      const projected: GridsRecordEvent = {
        ...event,
        baseId: target.baseId,
        tableId: target.tableId,
        changedFieldIds: target.changedFieldIds,
        actorId: null,
      };
      return publishRecordEventToTopic(projected, hashEventKey(recordEventIdempotencyKey(projected)));
    }),
  ]);
};

export const liveRecordEvents = (config: { baseId: string; after?: string | null; signal?: AbortSignal }) =>
  recordTopic()
    .hub({ tenantId: config.baseId })
    .subscribe({
      after: config.after ?? undefined,
      signal: config.signal,
    });

export const latestRecordEventCursor = async (baseId: string): Promise<string> =>
  latestTopicCursor({ topic: recordTopic(), resourceId: "grids:records", tenantId: baseId });
