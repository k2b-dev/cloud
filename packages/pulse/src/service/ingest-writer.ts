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
import { blockCheckpointMismatch, type CheckpointIdentity, inspectBaseCheckpoint, sameCheckpoint } from "../store/maintenance";
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
  type PlannedStates,
  type PulseSqlClient,
  planIngestStates,
  prepareIngestBatch,
  registerIngestBatch,
  writePreparedIngestBatchInTransaction,
} from "./ingest-bulk";
import { type IngestQuota, ingestQuota, type QuotaError } from "./ingest-quota";
import { MetricSeriesLimitError } from "./metric-cardinality";
import { type OwnedIngestIdentity, requireOwnedIngestSource } from "./owned-ingest";
import { PULSE_INGEST_SCOPE, resolveIngestSourceForServiceAccount } from "./source-management";
import { recordStoreOutage } from "./store-health";

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
export type IngestFailure =
  | ServiceError
  | QuotaError
  | { code: "PULSE_STORE_UNAVAILABLE" | "PULSE_STORE_DISK_LOW"; status: 503; message: string; retryAfter: number };
export type IngestResult = { ok: true; data: IngestCounts } | { ok: false; error: IngestFailure };
class IngestRefusal extends Error {
  constructor(readonly failure: IngestFailure) {
    super(failure.message);
  }
}

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
  if (!source.enabled)
    throw new IngestTransactionFailure({ code: "PULSE_SOURCE_DISABLED", status: 409, message: "Pulse source is disabled" });
  const [base] = await db<(CheckpointIdentity & { database_name: string; retention_days: number })[]>`
    SELECT s.database_name,b.retention_days,s.reset_generation::text AS reset_generation,s.checkpoint_id,s.pending_checkpoint_id
    FROM pulse.base_stores s JOIN pulse.bases b ON b.id=s.base_id WHERE b.id=${baseId}::uuid`;
  if (!base) throw new IngestTransactionFailure(err.notFound("Pulse base"));
  return { ...base, lastAcceptedAt: source.last_accepted_at };
};
type KeyRow = {
  request_hash: string;
  state: "pending" | "done";
  accepted_at: Date;
  response: IngestCounts | null;
  planned_states: PlannedStates | null;
  reset_generation: string | null;
  checkpoint_id: string | null;
  pending_checkpoint_id: string | null;
};
export const completedIngestResponse = (
  receipt: Pick<KeyRow, "state" | "response" | "reset_generation" | "checkpoint_id" | "pending_checkpoint_id">,
  checkpoint: CheckpointIdentity,
): IngestCounts | null =>
  receipt.state === "done" &&
  receipt.reset_generation !== null &&
  sameCheckpoint({ ...receipt, reset_generation: receipt.reset_generation }, checkpoint)
    ? receipt.response
    : null;
export type IngestParams = {
  baseId: string;
  sourceId: string;
  batch: PulseIngestBatch;
  ownedSource?: OwnedIngestIdentity;
  idempotencyKey?: string | null;
  requestBytes?: number;
  locale?: string;
  /** Internal scrape fence captured before remote collection starts. */
  resetGeneration?: string;
};

export const createIngestWriter = ({
  store = baseStore,
  database = sql,
  clock = store.clock,
  quota = ingestQuota,
}: {
  store?: IngestStore;
  database?: typeof sql;
  clock?: () => Date;
  quota?: IngestQuota;
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
    let resetGeneration = params.resetGeneration;
    try {
      const connectedStore = { ...store, query: await store.prepare("ingest") };
      const writable = await requireBaseWritable(params.baseId, database);
      if (!writable.ok) return writable;
      const inspected = await inspectBaseCheckpoint(params.baseId, connectedStore, database);
      resetGeneration ??= inspected.row.reset_generation;
      if (inspected.reason) {
        await blockCheckpointMismatch(inspected.row, inspected.reason, database);
        const admission = await requireBaseWritable(params.baseId, database);
        if (!admission.ok) return admission;
        throw new BaseStoreError("CHECKPOINT_CHANGED");
      }
      // T1 is deliberately a separate, committed transaction.
      const preflight = await database.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout='30s'`.simple();
        await tx`SET LOCAL lock_timeout='30s'`.simple();
        const base = await lockIngestScope(params.baseId, params.sourceId, tx);
        if (params.resetGeneration !== undefined && params.resetGeneration !== base.reset_generation)
          throw new IngestTransactionFailure(err.conflict("Base data was reset during scrape"));
        if (!sameCheckpoint(base, inspected.row)) throw new BaseStoreError("CHECKPOINT_CHANGED");
        if (params.ownedSource) {
          const owned = await requireOwnedIngestSource(params.baseId, params.sourceId, params.ownedSource, tx);
          if (!owned.ok) throw new IngestTransactionFailure(owned.error);
        }
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`pulse.ingest:${params.baseId}`},0))`;
        let acceptedAt = new Date(Math.max(now.getTime(), base.lastAcceptedAt ? base.lastAcceptedAt.getTime() + 1 : now.getTime()));
        let plannedStates: PlannedStates | null = null;
        let replay = false;
        if (key) {
          await tx`DELETE FROM pulse.ingest_idempotency WHERE source_id=${params.sourceId}::uuid AND idempotency_key=${key} AND expires_at<=${now}`;
          await tx`INSERT INTO pulse.ingest_idempotency(source_id,idempotency_key,request_hash,state,accepted_at,created_at,expires_at)
            VALUES(${params.sourceId}::uuid,${key},${hash},'pending',${acceptedAt},${now},${new Date(now.getTime() + PULSE_INGEST_IDEMPOTENCY_TTL_HOURS * 3_600_000)}) ON CONFLICT(source_id,idempotency_key) DO NOTHING`;
          const [existing] = await tx<
            KeyRow[]
          >`SELECT *,reset_generation::text AS reset_generation FROM pulse.ingest_idempotency WHERE source_id=${params.sourceId}::uuid AND idempotency_key=${key} FOR UPDATE`;
          if (!existing) throw new Error("Missing idempotency reservation");
          if (existing.request_hash !== hash)
            throw new IngestTransactionFailure({
              code: "CONFLICT",
              status: 409,
              message: "Idempotency key was already used for a different ingest batch",
            });
          const response = completedIngestResponse(existing, base);
          if (response) return { response };
          acceptedAt = existing.accepted_at;
          plannedStates = existing.planned_states;
          // A checkpoint transition invalidates completion, but never the original row identities.
          replay = existing.state === "done" || existing.planned_states !== null;
        }
        const [limits] =
          await tx`SELECT values_per_minute,bytes_per_minute,storage_bytes,usage_bytes FROM pulse.base_stores WHERE base_id=${params.baseId}::uuid`;
        if (!limits) throw new IngestTransactionFailure(err.notFound("Pulse base store"));
        if (limits.usage_bytes !== null && Number(limits.usage_bytes) >= Number(limits.storage_bytes))
          throw new IngestTransactionFailure({
            code: "PULSE_BASE_STORAGE_FULL",
            status: 409,
            message: "Pulse base storage threshold reached. A base admin can shorten retention or a Cloud admin can raise the threshold.",
          });
        const [disk] = await tx`SELECT free_bytes,total_bytes FROM pulse.store_instance WHERE singleton`;
        if (disk?.total_bytes && Number(disk.total_bytes) > 0 && Number(disk.free_bytes) / Number(disk.total_bytes) < 0.1)
          throw new IngestRefusal({
            code: "PULSE_STORE_DISK_LOW",
            status: 503,
            message: "Pulse data store disk space is low. Retry later.",
            retryAfter: 300,
          });
        const prepared = prepareIngestBatch(params.batch, params.sourceId, acceptedAt, key);
        if (prepared.metrics.some((m) => Date.parse(m.ts) < acceptedAt.getTime() - base.retention_days * 86_400_000))
          throw err.badInput("Metric timestamps must be within the raw retention window");
        const quotaError = await quota.consume({
          baseId: params.baseId,
          values: count,
          bytes: params.requestBytes ?? new TextEncoder().encode(JSON.stringify(params.batch)).byteLength,
          valuesPerMinute: Number(limits.values_per_minute),
          bytesPerMinute: Number(limits.bytes_per_minute),
        });
        if (quotaError) throw new IngestRefusal(quotaError);
        await registerIngestBatch({
          baseId: params.baseId,
          sourceId: params.sourceId,
          database: base.database_name,
          batch: prepared,
          db: tx,
          store: connectedStore,
          now,
          acceptedAt,
        });
        if (plannedStates === null) {
          plannedStates = await planIngestStates(params.baseId, params.sourceId, prepared, tx);
          if (key)
            await tx`UPDATE pulse.ingest_idempotency SET planned_states=(${JSON.stringify(plannedStates)}::jsonb #>> '{}')::jsonb
              WHERE source_id=${params.sourceId}::uuid AND idempotency_key=${key}`;
        }
        await tx`UPDATE pulse.sources SET last_accepted_at=greatest(last_accepted_at,${acceptedAt}) WHERE id=${params.sourceId}::uuid`;
        return { response: null, acceptedAt, base, prepared, plannedStates, replay };
      });
      if (preflight.response) return ok(preflight.response);
      reserved = Boolean(key);
      const { prepared, plannedStates } = preflight;
      const counts = { metrics: prepared.metrics.length, events: prepared.events.length, states: prepared.states.length };
      return await database.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout='30s'`.simple();
        await tx`SET LOCAL lock_timeout='30s'`.simple();
        const base = await lockIngestScope(params.baseId, params.sourceId, tx);
        if (params.ownedSource) {
          const owned = await requireOwnedIngestSource(params.baseId, params.sourceId, params.ownedSource, tx);
          if (!owned.ok) throw new IngestTransactionFailure(owned.error);
        }
        // Source locks serialize this source; lifecycle SHARE locks protect all inserts.
        if (base.reset_generation !== preflight.base.reset_generation)
          throw new IngestTransactionFailure({ code: "CONFLICT", status: 409, message: "Base data was reset during ingest" });
        if (!sameCheckpoint(base, inspected.row)) throw new BaseStoreError("CHECKPOINT_CHANGED");
        if (key) {
          const [existing] = await tx<
            KeyRow[]
          >`SELECT *,reset_generation::text AS reset_generation FROM pulse.ingest_idempotency WHERE source_id=${params.sourceId}::uuid AND idempotency_key=${key} FOR UPDATE`;
          if (!existing || existing.request_hash !== hash || existing.accepted_at.getTime() !== preflight.acceptedAt.getTime())
            throw new Error("Idempotency reservation changed during ingest");
          const response = completedIngestResponse(existing, base);
          if (response) return ok(response);
        }
        // Every HTTP insert has a 30-second timeout; five collections fit comfortably inside the durable 10-minute lease.
        if (clock().getTime() - now.getTime() > 5 * 60_000) throw new Error("Ingest preflight lease expired; retry");
        writing = true;
        await writePreparedIngestBatchInTransaction({
          baseId: params.baseId,
          sourceId: params.sourceId,
          database: base.database_name,
          batch: prepared,
          plannedStates,
          replay: preflight.replay,
          db: tx,
          // Leave the full request timeout before T1's lease expires, even if SQL locks delayed T2.
          store: {
            ...connectedStore,
            query: async (statement, params) => {
              if (clock().getTime() + 30_000 >= now.getTime() + 10 * 60_000) throw new Error("Ingest write lease expired; retry");
              return connectedStore.query(statement, params);
            },
          },
          now: clock(),
        });
        const changeIds = plannedStates.flatMap((s) => (s.change_id ? [s.change_id] : []));
        if (changeIds.length)
          await tx`UPDATE pulse.state_variants SET pending_change_id=NULL,pending_change_at=NULL
            WHERE base_id=${params.baseId}::uuid AND pending_change_id=ANY(${sql.array(changeIds, "UUID")})`;
        if (key)
          await tx`UPDATE pulse.ingest_idempotency SET state='done',response=(${JSON.stringify(counts)}::jsonb #>> '{}')::jsonb,
            reset_generation=${base.reset_generation}::bigint,checkpoint_id=${base.checkpoint_id}::uuid,pending_checkpoint_id=${base.pending_checkpoint_id}::uuid
            WHERE source_id=${params.sourceId}::uuid AND idempotency_key=${key}`;
        return ok(counts);
      });
    } catch (error) {
      if (error instanceof IngestRefusal) {
        if (error.failure.code === "PULSE_BASE_THROTTLED")
          await database.begin(async (tx) => {
            await tx`SET LOCAL statement_timeout='30s'`.simple();
            await tx`SET LOCAL lock_timeout='30s'`.simple();
            const writable = await requireBaseWritable(params.baseId, tx);
            if (!writable.ok) return;
            const [base] = await tx<
              { generation: string }[]
            >`SELECT reset_generation::text AS generation FROM pulse.base_stores WHERE base_id=${params.baseId}::uuid`;
            if (base?.generation === resetGeneration)
              await tx`UPDATE pulse.sources SET throttled_at=${now} WHERE id=${params.sourceId}::uuid`;
          });
        return { ok: false, error: error.failure };
      }
      if (error instanceof IngestTransactionFailure) return fail(error.serviceError);
      if (isServiceError(error)) return fail(error);
      if (!reserved && !writing && error instanceof MetricSeriesLimitError) return fail(err.badInput(error.message));
      if (error instanceof StoreQueryError && error.kind === "unreachable") {
        try {
          await recordStoreOutage(clock(), database, params.locale);
        } catch (outageError) {
          log.error("Pulse outage could not be recorded", {
            errorClass: outageError instanceof Error ? outageError.constructor.name : typeof outageError,
          });
        }
      }
      // Do not log queries, endpoints, credentials or remote bodies.
      log.error("Pulse ingest unavailable", {
        baseId: params.baseId,
        sourceId: params.sourceId,
        idempotent: Boolean(key),
        errorClass: error instanceof Error ? error.constructor.name : typeof error,
        storeError: error instanceof StoreQueryError || error instanceof BaseStoreError,
        ...(error instanceof StoreQueryError ? { storeKind: error.kind, storeCode: error.code } : {}),
      });
      return {
        ok: false,
        error: {
          code: "PULSE_STORE_UNAVAILABLE",
          status: 503,
          message:
            !key && writing
              ? "Pulse data store is unavailable. The batch may be partly stored, and sending it again can store those parts twice. Send every batch with an Idempotency-Key from the first attempt to retry safely."
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
  requestBytes?: number;
  locale?: string;
}): Promise<IngestResult> => {
  if (!params.scopes.some((s) => [PULSE_INGEST_SCOPE, "write", "admin"].includes(s)))
    return fail(err.forbidden("API key cannot ingest Pulse data"));
  const source = await resolveIngestSourceForServiceAccount(params.serviceAccount);
  if (!source.ok) return source;
  return ingestBatch({
    baseId: source.data.baseId,
    sourceId: source.data.id,
    batch: params.batch,
    idempotencyKey: params.idempotencyKey,
    requestBytes: params.requestBytes,
    locale: params.locale,
  });
};
