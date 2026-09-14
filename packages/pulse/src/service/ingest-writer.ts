import { createHash } from "node:crypto";
import type { ServiceAccount } from "@k2b/cloud/contracts";
import { err, fail, isServiceError, ok, type Result, type ServiceError } from "@k2b/cloud/server";
import { logger } from "@k2b/cloud/services";
import { sql, type TransactionSQL } from "bun";
import type { PulseEvent, PulseIngestBatch, PulseMetric, PulseState } from "../contracts";
import {
  PULSE_INGEST_IDEMPOTENCY_KEY_MAX_LENGTH,
  PULSE_INGEST_IDEMPOTENCY_TTL_HOURS,
  PULSE_INTERNAL_INGEST_BATCH_LIMIT,
} from "../ingest-limits";
import {
  validateDimensions,
  validateEventAttributes,
  validateEventPayload,
  validateEventSensitive,
  validateResourceIdentity,
} from "../telemetry-contract";
import { requireBaseActive } from "./access-control";
import { type PulseSqlClient, prepareIngestBatch, writePreparedIngestBatchInTransaction } from "./ingest-bulk";
import { MetricSeriesLimitError } from "./metric-cardinality";
import { PULSE_INGEST_SCOPE, resolveIngestSourceForServiceAccount } from "./source-management";

type SqlClient = typeof sql;
const log = logger("pulse:ingest");

class IngestTransactionFailure extends Error {
  constructor(readonly serviceError: ServiceError) {
    super(serviceError.message);
  }
}

const parseTime = (value: string | undefined): Result<Date> => {
  if (!value) return ok(new Date());
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fail(err.badInput("Invalid timestamp")) : ok(date);
};

const countBatchItems = (batch: PulseIngestBatch): number =>
  (batch.metrics?.length ?? 0) + (batch.events?.length ?? 0) + (batch.states?.length ?? 0);

const touchSourceLastSeen = async (sourceId: string, db: SqlClient = sql): Promise<void> => {
  await db`UPDATE pulse.sources SET last_seen_at = now(), updated_at = now() WHERE id = ${sourceId}::uuid`;
};

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

type IngestCounts = { metrics: number; events: number; states: number };

const lockIngestScope = async (params: { baseId: string; sourceId: string; db: PulseSqlClient }): Promise<void> => {
  const active = await requireBaseActive(params.baseId, params.db);
  if (!active.ok) throw new IngestTransactionFailure(active.error);
  if (!params.sourceId) throw new IngestTransactionFailure(err.badInput("An ingest source is required"));
  const [source] = await params.db`
    SELECT enabled FROM pulse.sources
    WHERE id = ${params.sourceId}::uuid AND base_id = ${params.baseId}::uuid
    FOR NO KEY UPDATE
  `;
  if (!source) throw new IngestTransactionFailure(err.notFound("Pulse source"));
  if (!source.enabled) throw new IngestTransactionFailure(err.conflict("Pulse source is disabled"));
};

const ingestBatchInClient = async (params: {
  baseId: string;
  sourceId: string;
  batch: PulseIngestBatch;
  db: PulseSqlClient;
}): Promise<IngestCounts> => {
  const prepared = prepareIngestBatch(params.batch, params.sourceId);
  await writePreparedIngestBatchInTransaction({ baseId: params.baseId, sourceId: params.sourceId, batch: prepared, db: params.db });
  await touchSourceLastSeen(params.sourceId, params.db);
  return {
    metrics: prepared.metrics.length,
    events: prepared.events.length,
    states: prepared.states.length,
  };
};

export const ingestBatch = async (params: {
  baseId: string;
  sourceId: string;
  batch: PulseIngestBatch;
  transaction?: TransactionSQL;
}): Promise<Result<{ metrics: number; events: number; states: number }>> => {
  const requestedCount = countBatchItems(params.batch);
  if (requestedCount === 0) return fail(err.badInput("Ingest batch is empty"));
  if (requestedCount > PULSE_INTERNAL_INGEST_BATCH_LIMIT) {
    return fail(err.badInput(`Ingest batch exceeds the internal limit of ${PULSE_INTERNAL_INGEST_BATCH_LIMIT} items`));
  }
  const valid = validateBatch(params.batch);
  if (!valid.ok) return fail(valid.error);

  // Ingest batches are all-or-nothing: once preflight passes, every write participates in this transaction.
  try {
    const write = async (tx: SqlClient): Promise<Result<IngestCounts>> => {
      await lockIngestScope({ baseId: params.baseId, sourceId: params.sourceId, db: tx });
      return ok(await ingestBatchInClient({ baseId: params.baseId, sourceId: params.sourceId, batch: params.batch, db: tx }));
    };
    return await (params.transaction ? params.transaction.savepoint(write) : sql.begin(write));
  } catch (error) {
    if (error instanceof MetricSeriesLimitError) return fail(err.badInput(error.message));
    if (error instanceof IngestTransactionFailure) return fail(error.serviceError);
    if (isServiceError(error)) return fail(error);
    log.error("Pulse batch ingest failed", {
      baseId: params.baseId,
      sourceId: params.sourceId ?? null,
      items: requestedCount,
      error: error instanceof Error ? error.message : String(error),
    });
    return fail(err.internal("Failed to ingest Pulse batch"));
  }
};

export const ingestByApiKey = async (params: {
  serviceAccount: ServiceAccount;
  scopes: string[];
  batch: PulseIngestBatch;
  idempotencyKey?: string | null;
}): Promise<Result<IngestCounts>> => {
  if (!params.scopes.includes(PULSE_INGEST_SCOPE) && !params.scopes.includes("write") && !params.scopes.includes("admin")) {
    return fail(err.forbidden("API key cannot ingest Pulse data"));
  }
  const source = await resolveIngestSourceForServiceAccount(params.serviceAccount);
  if (!source.ok) return fail(source.error);
  const idempotencyKey = params.idempotencyKey?.trim() || null;
  if (!idempotencyKey) return ingestBatch({ baseId: source.data.baseId, sourceId: source.data.id, batch: params.batch });
  if (idempotencyKey.length > PULSE_INGEST_IDEMPOTENCY_KEY_MAX_LENGTH) {
    return fail(err.badInput(`Idempotency key exceeds ${PULSE_INGEST_IDEMPOTENCY_KEY_MAX_LENGTH} characters`));
  }

  const requestedCount = countBatchItems(params.batch);
  if (requestedCount === 0) return fail(err.badInput("Ingest batch is empty"));
  if (requestedCount > PULSE_INTERNAL_INGEST_BATCH_LIMIT) {
    return fail(err.badInput(`Ingest batch exceeds the internal limit of ${PULSE_INTERNAL_INGEST_BATCH_LIMIT} items`));
  }
  const valid = validateBatch(params.batch);
  if (!valid.ok) return fail(valid.error);

  const requestHash = createHash("sha256").update(JSON.stringify(params.batch)).digest("hex");
  try {
    return await sql.begin(async (tx): Promise<Result<IngestCounts>> => {
      await lockIngestScope({ baseId: source.data.baseId, sourceId: source.data.id, db: tx });
      const inserted = await tx<{ request_hash: string }[]>`
        INSERT INTO pulse.ingest_idempotency (source_id, idempotency_key, request_hash, expires_at)
        VALUES (
          ${source.data.id}::uuid,
          ${idempotencyKey},
          ${requestHash},
          now() + (${PULSE_INGEST_IDEMPOTENCY_TTL_HOURS}::text || ' hours')::interval
        )
        ON CONFLICT (source_id, idempotency_key) DO NOTHING
        RETURNING request_hash
      `;
      if (inserted.length === 0) {
        const [existing] = await tx<{ request_hash: string; response: IngestCounts | null }[]>`
          SELECT request_hash, response
          FROM pulse.ingest_idempotency
          WHERE source_id = ${source.data.id}::uuid AND idempotency_key = ${idempotencyKey}
        `;
        if (!existing) throw new Error("Failed to resolve ingest idempotency record");
        if (existing.request_hash !== requestHash) {
          throw new IngestTransactionFailure({
            code: "CONFLICT",
            message: "Idempotency key was already used for a different ingest batch",
            status: 409,
          });
        }
        const response = existing.response;
        if (!response) throw new Error("Idempotent ingest response is unavailable");
        return ok(response);
      }

      const counts = await ingestBatchInClient({
        baseId: source.data.baseId,
        sourceId: source.data.id,
        batch: params.batch,
        db: tx,
      });
      await tx`
        UPDATE pulse.ingest_idempotency
        SET response = (${JSON.stringify(counts)}::jsonb #>> '{}')::jsonb
        WHERE source_id = ${source.data.id}::uuid AND idempotency_key = ${idempotencyKey}
      `;
      return ok(counts);
    });
  } catch (error) {
    if (error instanceof MetricSeriesLimitError) return fail(err.badInput(error.message));
    if (error instanceof IngestTransactionFailure) return fail(error.serviceError);
    if (isServiceError(error)) return fail(error);
    log.error("Pulse API-key ingest failed", {
      baseId: source.data.baseId,
      sourceId: source.data.id,
      items: requestedCount,
      idempotent: true,
      error: error instanceof Error ? error.message : String(error),
    });
    return fail(err.internal("Failed to ingest Pulse batch"));
  }
};
