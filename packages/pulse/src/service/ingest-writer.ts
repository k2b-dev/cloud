import { createHash } from "node:crypto";
import type { ServiceAccount } from "@k2b/cloud/contracts";
import { err, fail, isServiceError, ok, type Result, type ServiceError } from "@k2b/cloud/server";
import { logger } from "@k2b/cloud/services";
import { sql } from "bun";
import type { PulseEvent, PulseIngestBatch, PulseMetric, PulseState } from "../contracts";
import {
  PULSE_INGEST_IDEMPOTENCY_KEY_MAX_LENGTH,
  PULSE_INGEST_IDEMPOTENCY_TTL_HOURS,
  PULSE_INTERNAL_INGEST_BATCH_LIMIT,
} from "../ingest-limits";
import { BaseStoreError, baseStore } from "../store/base-store";
import { StoreQueryError } from "../store/client";
import {
  validateDimensions,
  validateEventAttributes,
  validateEventPayload,
  validateEventSensitive,
  validateResourceIdentity,
} from "../telemetry-contract";
import { requireBaseWritable } from "./access-control";
import {
  type IngestStore,
  type PulseSqlClient,
  prepareIngestBatch,
  registerIngestBatch,
  writePreparedIngestBatchInTransaction,
} from "./ingest-bulk";
import { MetricSeriesLimitError } from "./metric-cardinality";
import { PULSE_INGEST_SCOPE, resolveIngestSourceForServiceAccount } from "./source-management";

const log = logger("pulse:ingest");
class IngestTransactionFailure extends Error {
  constructor(readonly serviceError: ServiceError) {
    super(serviceError.message);
  }
}
const parseTime = (value: string | undefined): Result<Date> => {
  if (!value) return ok(new Date(0));
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fail(err.badInput("Invalid timestamp")) : ok(date);
};

const countBatchItems = (batch: PulseIngestBatch): number =>
  (batch.metrics?.length ?? 0) + (batch.events?.length ?? 0) + (batch.states?.length ?? 0);

const validateMetric = (metric: PulseMetric): Result<void> => {
  if (metric.resource) {
    const resourceError = validateResourceIdentity(metric.resource.type.trim(), metric.resource.id.trim());
    if (resourceError) return fail(err.badInput(resourceError));
  }
  if (!metric.name.trim()) return fail(err.badInput("Metric name is required"));
  if (!Number.isFinite(metric.value)) return fail(err.badInput("Metric value must be finite"));
  if (metric.type && metric.type !== "gauge" && metric.type !== "counter")
    return fail(err.badInput("Only gauge and counter metrics are supported"));
  if (metric.type === "counter" && metric.value < 0) return fail(err.badInput("Counter values must be nonnegative"));
  const ts = parseTime(metric.ts);
  if (!ts.ok) return fail(ts.error);
  const dimensionsError = validateDimensions(metric.dimensions);
  if (dimensionsError) return fail(err.badInput(dimensionsError));
  return ok();
};

const validateEvent = (event: PulseEvent): Result<void> => {
  if (event.resource) {
    const resourceError = validateResourceIdentity(event.resource.type.trim(), event.resource.id.trim());
    if (resourceError) return fail(err.badInput(resourceError));
  }
  if (!event.kind.trim()) return fail(err.badInput("Event kind is required"));
  if (event.value !== undefined && event.value !== null && !Number.isFinite(event.value)) {
    return fail(err.badInput("Event value must be finite"));
  }
  const ts = parseTime(event.ts);
  if (!ts.ok) return fail(ts.error);
  const dimensionsError = validateDimensions(event.dimensions);
  if (dimensionsError) return fail(err.badInput(dimensionsError));
  const attributesError = validateEventAttributes(event.attributes);
  if (attributesError) return fail(err.badInput(attributesError));
  const sensitiveError = validateEventSensitive(event.sensitive);
  if (sensitiveError) return fail(err.badInput(sensitiveError));
  const payloadError = validateEventPayload(event.payload);
  if (payloadError) return fail(err.badInput(payloadError));
  return ok();
};

const validateState = (state: PulseState): Result<void> => {
  if (state.resource) {
    const resourceError = validateResourceIdentity(state.resource.type.trim(), state.resource.id.trim());
    if (resourceError) return fail(err.badInput(resourceError));
  }
  if (!state.key.trim()) return fail(err.badInput("State key is required"));
  if (typeof state.value === "number" && !Number.isFinite(state.value)) return fail(err.badInput("State value must be finite"));
  const changedAt = parseTime(state.ts);
  if (!changedAt.ok) return fail(changedAt.error);
  const dimensionsError = validateDimensions(state.dimensions);
  if (dimensionsError) return fail(err.badInput(dimensionsError));
  return ok();
};

const validateBatch = (batch: PulseIngestBatch): Result<void> => {
  const definitions = new Map<string, string>();
  for (const metric of batch.metrics ?? []) {
    const definition = JSON.stringify([metric.type ?? "gauge", metric.unit ?? null]);
    if (definitions.has(metric.name) && definitions.get(metric.name) !== definition) {
      return fail(err.badInput("Metric type and unit must agree within a batch"));
    }
    definitions.set(metric.name, definition);
    const result = validateMetric(metric);
    if (!result.ok) return result;
  }
  for (const event of batch.events ?? []) {
    const result = validateEvent(event);
    if (!result.ok) return result;
  }
  for (const state of batch.states ?? []) {
    const result = validateState(state);
    if (!result.ok) return result;
  }
  return ok();
};

export type IngestCounts = { metrics: number; events: number; states: number };
export type IngestResult =
  | { ok: true; data: IngestCounts }
  | { ok: false; error: ServiceError | { code: "PULSE_STORE_UNAVAILABLE"; status: 503; message: string; retryAfter: 30 } };

export const validateIngestTimestamps = (batch: PulseIngestBatch, now: Date): Result<void> => {
  for (const collection of ["metrics", "events", "states"] as const) {
    for (const [index, item] of (batch[collection] ?? []).entries()) {
      if (item.ts && Date.parse(item.ts) > now.getTime() + 5 * 60_000) {
        const identity = "name" in item ? `name "${item.name}"` : "kind" in item ? `kind "${item.kind}"` : `key "${item.key}"`;
        return fail(
          err.badInput(
            `${collection}[${index}] (${identity}) has timestamp ${new Date(item.ts).toISOString()}, more than 5 minutes in the future`,
          ),
        );
      }
    }
  }
  return ok();
};
const lockIngestScope = async (baseId: string, sourceId: string, db: PulseSqlClient) => {
  const writable = await requireBaseWritable(baseId, db);
  if (!writable.ok) throw new IngestTransactionFailure(writable.error);
  const [source] = await db<
    { enabled: boolean; last_accepted_at: Date | null }[]
  >`SELECT enabled,last_accepted_at FROM pulse.sources WHERE id=${sourceId}::uuid AND base_id=${baseId}::uuid AND NOT deleted FOR NO KEY UPDATE`;
  if (!source) throw new IngestTransactionFailure(err.notFound("Pulse source"));
  if (!source.enabled) throw new IngestTransactionFailure(err.conflict("Pulse source is disabled"));
  const [base] = await db<{ database_name: string; retention_days: number; clear_revision: string | null }[]>`
    SELECT s.database_name,b.retention_days,b.data_clear_started_at::text AS clear_revision
    FROM pulse.base_stores s JOIN pulse.bases b ON b.id=s.base_id WHERE b.id=${baseId}::uuid`;
  if (!base) throw new IngestTransactionFailure(err.notFound("Pulse base"));
  return { ...base, lastAcceptedAt: source.last_accepted_at };
};
type KeyRow = { request_hash: string; state: "pending" | "done"; accepted_at: Date; response: IngestCounts | null };
export type IngestParams = { baseId: string; sourceId: string; batch: PulseIngestBatch; idempotencyKey?: string | null };
export const createIngestWriter = ({
  store = baseStore,
  database = sql,
  clock = store.clock,
}: {
  store?: IngestStore;
  database?: typeof sql;
  clock?: () => Date;
} = {}) => {
  const ingest = async (params: IngestParams): Promise<IngestResult> => {
    const count = countBatchItems(params.batch),
      now = clock(),
      key = params.idempotencyKey?.trim() || null;
    if (!count) return fail(err.badInput("Ingest batch is empty"));
    if (count > PULSE_INTERNAL_INGEST_BATCH_LIMIT)
      return fail(err.badInput(`Ingest batch exceeds the internal limit of ${PULSE_INTERNAL_INGEST_BATCH_LIMIT} items`));
    if (key && key.length > PULSE_INGEST_IDEMPOTENCY_KEY_MAX_LENGTH)
      return fail(err.badInput(`Idempotency key exceeds ${PULSE_INGEST_IDEMPOTENCY_KEY_MAX_LENGTH} characters`));
    const valid = validateBatch(params.batch);
    if (!valid.ok) return valid;
    const times = validateIngestTimestamps(params.batch, now);
    if (!times.ok) return times;
    const hash = createHash("sha256").update(JSON.stringify(params.batch)).digest("hex");
    let reserved = false,
      writing = false;
    try {
      // T1 is deliberately a separate, committed transaction.
      const preflight = await database.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout='30s'`.simple();
        await tx`SET LOCAL lock_timeout='30s'`.simple();
        const base = await lockIngestScope(params.baseId, params.sourceId, tx);
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`pulse.ingest:${params.baseId}`},0))`;
        let acceptedAt = new Date(Math.max(now.getTime(), base.lastAcceptedAt ? base.lastAcceptedAt.getTime() + 1 : now.getTime()));
        if (key) {
          await tx`DELETE FROM pulse.ingest_idempotency WHERE source_id=${params.sourceId}::uuid AND idempotency_key=${key} AND expires_at<=${now}`;
          await tx`INSERT INTO pulse.ingest_idempotency(source_id,idempotency_key,request_hash,state,accepted_at,created_at,expires_at)
            VALUES(${params.sourceId}::uuid,${key},${hash},'pending',${acceptedAt},${now},${new Date(now.getTime() + PULSE_INGEST_IDEMPOTENCY_TTL_HOURS * 3_600_000)}) ON CONFLICT(source_id,idempotency_key) DO NOTHING`;
          const [existing] = await tx<
            KeyRow[]
          >`SELECT * FROM pulse.ingest_idempotency WHERE source_id=${params.sourceId}::uuid AND idempotency_key=${key} FOR UPDATE`;
          if (!existing) throw new Error("Missing idempotency reservation");
          if (existing.request_hash !== hash)
            throw new IngestTransactionFailure(err.conflict("Idempotency key was already used for a different ingest batch"));
          if (existing.state === "done" && existing.response)
            return { response: existing.response, acceptedAt: existing.accepted_at, base };
          acceptedAt = existing.accepted_at;
        }
        const prepared = prepareIngestBatch(params.batch, params.sourceId, acceptedAt, key);
        if (prepared.metrics.some((m) => Date.parse(m.ts) < acceptedAt.getTime() - base.retention_days * 86_400_000))
          throw err.badInput("Metric timestamps must be within the raw retention window");
        await registerIngestBatch({
          baseId: params.baseId,
          sourceId: params.sourceId,
          database: base.database_name,
          batch: prepared,
          db: tx,
          store,
          now,
        });
        await tx`UPDATE pulse.sources SET last_accepted_at=greatest(last_accepted_at,${acceptedAt}) WHERE id=${params.sourceId}::uuid`;
        return { response: null, acceptedAt, base };
      });
      if (preflight.response) return ok(preflight.response);
      reserved = Boolean(key);
      const prepared = prepareIngestBatch(params.batch, params.sourceId, preflight.acceptedAt, key);
      const counts = { metrics: prepared.metrics.length, events: prepared.events.length, states: prepared.states.length };
      return await database.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout='30s'`.simple();
        await tx`SET LOCAL lock_timeout='30s'`.simple();
        const base = await lockIngestScope(params.baseId, params.sourceId, tx);
        // Source and state-variant locks serialize their own identities; lifecycle SHARE locks protect all inserts.
        if (base.clear_revision !== preflight.base.clear_revision) throw new Error("Base was cleared during ingest");
        if (key) {
          const [existing] = await tx<
            KeyRow[]
          >`SELECT * FROM pulse.ingest_idempotency WHERE source_id=${params.sourceId}::uuid AND idempotency_key=${key} FOR UPDATE`;
          if (!existing || existing.request_hash !== hash) throw new Error("Idempotency reservation changed during ingest");
          if (existing.state === "done" && existing.response) return ok(existing.response);
        }
        // Every HTTP insert has a 30-second timeout; five collections fit comfortably inside the durable 10-minute lease.
        if (clock().getTime() - now.getTime() > 5 * 60_000) throw new Error("Ingest preflight lease expired; retry");
        writing = true;
        await writePreparedIngestBatchInTransaction({
          baseId: params.baseId,
          sourceId: params.sourceId,
          database: base.database_name,
          batch: prepared,
          db: tx,
          // Leave the full request timeout before T1's lease expires, even if SQL locks delayed T2.
          store: {
            ...store,
            query: async (statement, params) => {
              if (clock().getTime() + 30_000 >= now.getTime() + 10 * 60_000) throw new Error("Ingest write lease expired; retry");
              return store.query(statement, params);
            },
          },
          now: clock(),
        });
        if (key)
          await tx`UPDATE pulse.ingest_idempotency SET state='done',response=(${JSON.stringify(counts)}::jsonb #>> '{}')::jsonb WHERE source_id=${params.sourceId}::uuid AND idempotency_key=${key}`;
        return ok(counts);
      });
    } catch (error) {
      if (!reserved && !writing) {
        if (error instanceof MetricSeriesLimitError) return fail(err.badInput(error.message));
        if (error instanceof IngestTransactionFailure) return fail(error.serviceError);
        if (isServiceError(error)) return fail(error);
      }
      // Do not log queries, endpoints, credentials or remote bodies.
      log.error("Pulse ingest unavailable", {
        baseId: params.baseId,
        sourceId: params.sourceId,
        idempotent: Boolean(key),
        storeError: error instanceof StoreQueryError || error instanceof BaseStoreError,
      });
      return {
        ok: false,
        error: {
          code: "PULSE_STORE_UNAVAILABLE",
          status: 503,
          message:
            !key && writing
              ? "Pulse data store is unavailable. The batch may be partly stored. Send it again with an Idempotency-Key to retry without duplicates."
              : key
                ? "Pulse data store is unavailable. Retry this batch with the same Idempotency-Key."
                : "Pulse data store is unavailable. Retry this batch with an Idempotency-Key.",
          retryAfter: 30,
        },
      };
    }
  };
  return ingest;
};
export const ingestBatch = createIngestWriter();
export const ingestByApiKey = async (params: {
  serviceAccount: ServiceAccount;
  scopes: string[];
  batch: PulseIngestBatch;
  idempotencyKey?: string | null;
}): Promise<IngestResult> => {
  if (!params.scopes.some((s) => [PULSE_INGEST_SCOPE, "write", "admin"].includes(s)))
    return fail(err.forbidden("API key cannot ingest Pulse data"));
  const source = await resolveIngestSourceForServiceAccount(params.serviceAccount);
  if (!source.ok) return source;
  return ingestBatch({ baseId: source.data.baseId, sourceId: source.data.id, batch: params.batch, idempotencyKey: params.idempotencyKey });
};
