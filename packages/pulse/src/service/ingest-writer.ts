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
import { derivePulseResource, explicitPulseResource, type PulseResourceIdentity } from "../resource-model";
import {
  telemetryValueKind,
  validateDimensions,
  validateEventAttributes,
  validateEventPayload,
  validateEventSensitive,
} from "../telemetry-contract";
import { requireBaseActive } from "./access-control";
import { type PulseSqlClient, prepareIngestBatch, writePreparedIngestBatchInTransaction } from "./ingest-bulk";
import { enforceMetricSeriesBudget, MetricSeriesLimitError } from "./metric-cardinality";
import { PULSE_INGEST_SCOPE, resolveIngestSourceForServiceAccount } from "./source-management";
import { lockStateIdentities } from "./state-transitions";
import { jsonbObject, normalizeDimensions } from "./telemetry-values";

type SqlClient = typeof sql;
const log = logger("pulse:ingest");

class IngestTransactionFailure extends Error {
  constructor(readonly serviceError: ServiceError) {
    super(serviceError.message);
  }
}

const dimensionsHash = (dimensions: Record<string, string>): string =>
  createHash("sha256").update(JSON.stringify(dimensions)).digest("hex");

const metricSeriesKey = (params: { sourceId?: string | null; entityId?: string | null; dimensionsHash: string }): string =>
  [params.sourceId ?? "", params.entityId ?? "", params.dimensionsHash].join("\u001f");

const nullable = <T>(value: T | null | undefined): T | null => value ?? null;

const objectOrEmpty = (value: Record<string, unknown> | undefined): Record<string, unknown> => value ?? {};

const parseTime = (value: string | undefined): Result<Date> => {
  if (!value) return ok(new Date());
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fail(err.badInput("Invalid timestamp")) : ok(date);
};

const countBatchItems = (batch: PulseIngestBatch): number =>
  (batch.metrics?.length ?? 0) + (batch.events?.length ?? 0) + (batch.states?.length ?? 0);

const touchSourceLastSeen = async (sourceId: string | null | undefined, db: SqlClient = sql): Promise<void> => {
  if (!sourceId) return;
  await db`UPDATE pulse.sources SET last_seen_at = now(), updated_at = now() WHERE id = ${sourceId}::uuid`;
};

const deriveResourceForSignal = (params: {
  signalName: string;
  sourceId?: string | null;
  entityId?: string | null;
  entityType?: string | null;
  dimensions: Record<string, string>;
}): PulseResourceIdentity | null =>
  derivePulseResource({
    signalName: params.signalName,
    sourceId: params.sourceId,
    entityId: params.entityId,
    entityType: params.entityType,
    dimensions: params.dimensions,
  });

const upsertObservedResource = async (params: {
  baseId: string;
  sourceId?: string | null;
  resource: PulseResourceIdentity | null;
  dimensions: Record<string, string>;
  seenAt: Date;
  db?: SqlClient;
}): Promise<void> => {
  if (!params.resource) return;
  const db = params.db ?? sql;
  await db`
    INSERT INTO pulse.observed_resources (
      base_id,
      resource_key,
      resource_id,
      resource_type,
      label,
      source_ids,
      dimensions,
      last_seen_at,
      updated_at
    )
    VALUES (
      ${params.baseId}::uuid,
      ${params.resource.key},
      ${params.resource.id},
      ${params.resource.type},
      ${params.resource.label},
      CASE
        WHEN ${params.sourceId ?? null}::uuid IS NULL THEN ARRAY[]::uuid[]
        ELSE ARRAY[${params.sourceId ?? null}::uuid]
      END,
      (${jsonbObject(params.dimensions)}::jsonb #>> '{}')::jsonb,
      ${params.seenAt},
      now()
    )
    ON CONFLICT (base_id, resource_key)
    DO UPDATE SET
      resource_id = EXCLUDED.resource_id,
      resource_type = COALESCE(EXCLUDED.resource_type, pulse.observed_resources.resource_type),
      label = EXCLUDED.label,
      source_ids = (
        SELECT COALESCE(array_agg(DISTINCT source_id), ARRAY[]::uuid[])
        FROM unnest(pulse.observed_resources.source_ids || EXCLUDED.source_ids) AS sources(source_id)
      ),
      dimensions = pulse.observed_resources.dimensions || EXCLUDED.dimensions,
      last_seen_at = GREATEST(pulse.observed_resources.last_seen_at, EXCLUDED.last_seen_at),
      updated_at = now()
  `;
};

const upsertSignalFields = async (params: {
  baseId: string;
  sourceId?: string | null;
  scope: "metric" | "event" | "state";
  signalName: string;
  role: "dimension" | "attribute" | "sensitive";
  values: Record<string, unknown>;
  seenAt: Date;
  db?: SqlClient;
}): Promise<void> => {
  if (!params.sourceId) return;
  const db = params.db ?? sql;
  for (const [key, value] of Object.entries(params.values)) {
    await db`
      INSERT INTO pulse.signal_fields (
        base_id, source_id, scope, signal_name, role, key, value_type, observed_count, first_seen_at, last_seen_at
      ) VALUES (
        ${params.baseId}::uuid, ${params.sourceId}::uuid, ${params.scope}, ${params.signalName}, ${params.role}, ${key},
        ${telemetryValueKind(value)}, 1, ${params.seenAt}, ${params.seenAt}
      )
      ON CONFLICT (base_id, source_id, scope, signal_name, role, key) DO UPDATE SET
        value_type = CASE WHEN pulse.signal_fields.value_type = EXCLUDED.value_type THEN EXCLUDED.value_type ELSE 'mixed' END,
        observed_count = pulse.signal_fields.observed_count + 1,
        first_seen_at = LEAST(pulse.signal_fields.first_seen_at, EXCLUDED.first_seen_at),
        last_seen_at = GREATEST(pulse.signal_fields.last_seen_at, EXCLUDED.last_seen_at)
    `;
  }
};

const resolveMetricSeries = async (params: {
  baseId: string;
  sourceId?: string | null;
  metric: PulseMetric;
  dimensions: Record<string, string>;
  resource: PulseResourceIdentity | null;
  db?: SqlClient;
}): Promise<{ metricId: string; seriesId: string }> => {
  const db = params.db ?? sql;
  const [metricDef] = await db<{ id: string }[]>`
    INSERT INTO pulse.metric_defs (base_id, name, unit, type)
    VALUES (${params.baseId}::uuid, ${params.metric.name}, ${params.metric.unit ?? null}, ${params.metric.type ?? "gauge"}::pulse.metric_type)
    ON CONFLICT (base_id, name)
    DO UPDATE SET unit = COALESCE(EXCLUDED.unit, pulse.metric_defs.unit)
    RETURNING id
  `;
  if (!metricDef) throw new Error("Failed to resolve metric definition");

  const hash = dimensionsHash(params.dimensions);
  const seriesKey = metricSeriesKey({ sourceId: params.sourceId, entityId: params.metric.entityId, dimensionsHash: hash });
  await enforceMetricSeriesBudget(params.baseId, [{ metric: params.metric.name, seriesKey }], db);
  const [series] = await db<{ id: string }[]>`
    INSERT INTO pulse.metric_series (
      base_id,
      metric_id,
      source_id,
      entity_id,
      entity_type,
      series_key,
      dimensions_hash,
      dimensions,
      resource_key,
      resource_id,
      resource_type,
      resource_label,
      last_seen_at
    )
    VALUES (
      ${params.baseId}::uuid,
      ${metricDef.id}::uuid,
      ${params.sourceId ?? null}::uuid,
      ${params.metric.entityId ?? null},
      ${params.metric.entityType ?? null},
      ${seriesKey},
      ${hash},
      (${jsonbObject(params.dimensions)}::jsonb #>> '{}')::jsonb,
      ${params.resource?.key ?? null},
      ${params.resource?.id ?? null},
      ${params.resource?.type ?? null},
      ${params.resource?.label ?? null},
      now()
    )
    ON CONFLICT (base_id, metric_id, series_key)
    DO UPDATE SET
      source_id = EXCLUDED.source_id,
      entity_id = EXCLUDED.entity_id,
      entity_type = EXCLUDED.entity_type,
      dimensions = EXCLUDED.dimensions,
      resource_key = EXCLUDED.resource_key,
      resource_id = EXCLUDED.resource_id,
      resource_type = EXCLUDED.resource_type,
      resource_label = EXCLUDED.resource_label,
      last_seen_at = now()
    RETURNING id
  `;
  if (!series) throw new Error("Failed to resolve metric series");

  for (const [key, value] of Object.entries(params.dimensions)) {
    await db`
      INSERT INTO pulse.metric_series_dimensions (series_id, key, value)
      VALUES (${series.id}::uuid, ${key}, ${value})
      ON CONFLICT (series_id, key) DO UPDATE SET value = EXCLUDED.value
    `;
  }

  return { metricId: metricDef.id, seriesId: series.id };
};

const validateMetric = (metric: PulseMetric): Result<void> => {
  if (!metric.name.trim()) return fail(err.badInput("Metric name is required"));
  if (!Number.isFinite(metric.value)) return fail(err.badInput("Metric value must be finite"));
  const ts = parseTime(metric.ts);
  if (!ts.ok) return fail(ts.error);
  const dimensionsError = validateDimensions(metric.dimensions);
  if (dimensionsError) return fail(err.badInput(dimensionsError));
  return ok();
};

const validateEvent = (event: PulseEvent): Result<void> => {
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
  if (!state.key.trim()) return fail(err.badInput("State key is required"));
  if (typeof state.value === "number" && !Number.isFinite(state.value)) return fail(err.badInput("State value must be finite"));
  const changedAt = parseTime(state.ts);
  if (!changedAt.ok) return fail(changedAt.error);
  const dimensionsError = validateDimensions(state.dimensions);
  if (dimensionsError) return fail(err.badInput(dimensionsError));
  return ok();
};

const validateBatch = (batch: PulseIngestBatch): Result<void> => {
  for (const metric of batch.metrics ?? []) {
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

const recordMetricInClient = async (params: {
  baseId: string;
  sourceId?: string | null;
  metric: PulseMetric;
  db?: SqlClient;
}): Promise<Result<void>> => {
  if (!params.metric.name.trim()) return fail(err.badInput("Metric name is required"));
  if (!Number.isFinite(params.metric.value)) return fail(err.badInput("Metric value must be finite"));

  const ts = parseTime(params.metric.ts);
  if (!ts.ok) return fail(ts.error);

  const dimensions = normalizeDimensions(params.metric.dimensions);
  const db = params.db ?? sql;
  const resource =
    params.metric.resource === undefined
      ? deriveResourceForSignal({
          signalName: params.metric.name,
          sourceId: params.sourceId,
          entityId: params.metric.entityId,
          entityType: params.metric.entityType,
          dimensions,
        })
      : explicitPulseResource(params.metric.resource);
  const series = await resolveMetricSeries({
    baseId: params.baseId,
    sourceId: params.sourceId,
    metric: params.metric,
    dimensions,
    resource,
    db,
  });
  await db`
    INSERT INTO pulse.metric_samples (base_id, series_id, ts, value)
    VALUES (${params.baseId}::uuid, ${series.seriesId}::uuid, ${ts.data}, ${params.metric.value})
    ON CONFLICT (series_id, ts) DO UPDATE SET value = EXCLUDED.value, recorded_at = now()
  `;
  await upsertObservedResource({ baseId: params.baseId, sourceId: params.sourceId, resource, dimensions, seenAt: ts.data, db });
  await upsertSignalFields({
    baseId: params.baseId,
    sourceId: params.sourceId,
    scope: "metric",
    signalName: params.metric.name,
    role: "dimension",
    values: dimensions,
    seenAt: ts.data,
    db,
  });
  return ok();
};

export const recordMetric = async (params: { baseId: string; sourceId?: string | null; metric: PulseMetric }): Promise<Result<void>> => {
  const valid = validateMetric(params.metric);
  if (!valid.ok) return valid;
  try {
    return await sql.begin((tx) => recordMetricInClient({ ...params, db: tx }));
  } catch (error) {
    if (error instanceof MetricSeriesLimitError) return fail(err.badInput(error.message));
    throw error;
  }
};

const insertEventRow = async (params: {
  baseId: string;
  sourceId?: string | null;
  event: PulseEvent;
  resource: PulseResourceIdentity | null;
  ts: Date;
  dimensions: Record<string, string>;
  dimensionsHash: string;
  db: SqlClient;
}): Promise<Result<string>> => {
  const [eventRow] = await params.db<{ id: string }[]>`
    INSERT INTO pulse.events (
      base_id,
      source_id,
      ts,
      kind,
      value,
      entity_id,
      entity_type,
      actor_id,
      session_id,
      correlation_id,
      dimensions_hash,
      dimensions,
      attributes,
      sensitive,
      payload,
      resource_key,
      resource_id,
      resource_type,
      resource_label
    )
    VALUES (
      ${params.baseId}::uuid,
      ${nullable(params.sourceId)}::uuid,
      ${params.ts},
      ${params.event.kind},
      ${nullable(params.event.value)},
      ${nullable(params.event.entityId)},
      ${nullable(params.event.entityType)},
      ${nullable(params.event.actorId)},
      ${nullable(params.event.sessionId)},
      ${nullable(params.event.correlationId)},
      ${params.dimensionsHash},
      (${jsonbObject(params.dimensions)}::jsonb #>> '{}')::jsonb,
      (${jsonbObject(objectOrEmpty(params.event.attributes))}::jsonb #>> '{}')::jsonb,
      (${jsonbObject(objectOrEmpty(params.event.sensitive))}::jsonb #>> '{}')::jsonb,
      (${jsonbObject(objectOrEmpty(params.event.payload))}::jsonb #>> '{}')::jsonb,
      ${params.resource?.key ?? null},
      ${params.resource?.id ?? null},
      ${params.resource?.type ?? null},
      ${params.resource?.label ?? null}
    )
    RETURNING id
  `;
  return eventRow ? ok(eventRow.id) : fail(err.internal("Failed to record event"));
};

const recordEventInClient = async (params: {
  baseId: string;
  sourceId?: string | null;
  event: PulseEvent;
  db?: SqlClient;
}): Promise<Result<void>> => {
  if (!params.event.kind.trim()) return fail(err.badInput("Event kind is required"));
  const ts = parseTime(params.event.ts);
  if (!ts.ok) return fail(ts.error);

  const dimensions = normalizeDimensions(params.event.dimensions);
  const hash = dimensionsHash(dimensions);
  const db = params.db ?? sql;
  const resource = explicitPulseResource(params.event.resource);
  const eventRow = await insertEventRow({
    baseId: params.baseId,
    sourceId: params.sourceId,
    event: params.event,
    resource,
    ts: ts.data,
    dimensions,
    dimensionsHash: hash,
    db,
  });
  if (!eventRow.ok) return fail(eventRow.error);
  await upsertObservedResource({ baseId: params.baseId, sourceId: params.sourceId, resource, dimensions, seenAt: ts.data, db });
  await upsertSignalFields({
    baseId: params.baseId,
    sourceId: params.sourceId,
    scope: "event",
    signalName: params.event.kind,
    role: "dimension",
    values: dimensions,
    seenAt: ts.data,
    db,
  });
  await upsertSignalFields({
    baseId: params.baseId,
    sourceId: params.sourceId,
    scope: "event",
    signalName: params.event.kind,
    role: "sensitive",
    values: params.event.sensitive ?? {},
    seenAt: ts.data,
    db,
  });
  await upsertSignalFields({
    baseId: params.baseId,
    sourceId: params.sourceId,
    scope: "event",
    signalName: params.event.kind,
    role: "attribute",
    values: params.event.attributes ?? {},
    seenAt: ts.data,
    db,
  });
  return ok();
};

export const recordEvent = async (params: { baseId: string; sourceId?: string | null; event: PulseEvent }): Promise<Result<void>> => {
  const valid = validateEvent(params.event);
  return valid.ok ? recordEventInClient(params) : valid;
};

const setStateInClient = async (params: {
  baseId: string;
  sourceId?: string | null;
  state: PulseState;
  db?: SqlClient;
}): Promise<Result<void>> => {
  if (!params.state.key.trim()) return fail(err.badInput("State key is required"));
  const changedAt = parseTime(params.state.ts);
  if (!changedAt.ok) return fail(changedAt.error);

  const dimensions = normalizeDimensions(params.state.dimensions);
  const hash = dimensionsHash(dimensions);
  const encodedValue = JSON.stringify(params.state.value);
  const db = params.db ?? sql;
  const resource =
    params.state.resource === undefined
      ? deriveResourceForSignal({
          signalName: params.state.key,
          sourceId: params.sourceId,
          entityId: params.state.entityId,
          entityType: params.state.entityType,
          dimensions,
        })
      : explicitPulseResource(params.state.resource);

  await lockStateIdentities(params.baseId, [{ key: params.state.key, entityId: params.state.entityId ?? "", dimensionsHash: hash }], db);
  await db`
    INSERT INTO pulse.state_changes (
      base_id, state_key, source_id, entity_id, entity_type, value, dimensions_hash, dimensions,
      resource_key, resource_id, resource_type, resource_label, changed_at
    )
    SELECT
      ${params.baseId}::uuid,
      ${params.state.key},
      ${params.sourceId ?? null}::uuid,
      ${params.state.entityId ?? null},
      ${params.state.entityType ?? null},
      ${encodedValue}::jsonb,
      ${hash},
      (${jsonbObject(dimensions)}::jsonb #>> '{}')::jsonb,
      ${resource?.key ?? null},
      ${resource?.id ?? null},
      ${resource?.type ?? null},
      ${resource?.label ?? null},
      ${changedAt.data}
    WHERE NOT EXISTS (
      SELECT 1
      FROM pulse.states_current current
      WHERE current.base_id = ${params.baseId}::uuid
        AND current.state_key = ${params.state.key}
        AND current.entity_id = ${params.state.entityId ?? ""}
        AND current.dimensions_hash = ${hash}
        AND (current.updated_at > ${changedAt.data} OR current.value IS NOT DISTINCT FROM ${encodedValue}::jsonb)
    )
  `;
  await db`
    INSERT INTO pulse.states_current (
      base_id,
      state_key,
      source_id,
      entity_id,
      entity_type,
      value,
      dimensions_hash,
      dimensions,
      resource_key,
      resource_id,
      resource_type,
      resource_label,
      updated_at
    )
    VALUES (
      ${params.baseId}::uuid,
      ${params.state.key},
      ${params.sourceId ?? null}::uuid,
      ${params.state.entityId ?? ""},
      ${params.state.entityType ?? null},
      ${encodedValue}::jsonb,
      ${hash},
      (${jsonbObject(dimensions)}::jsonb #>> '{}')::jsonb,
      ${resource?.key ?? null},
      ${resource?.id ?? null},
      ${resource?.type ?? null},
      ${resource?.label ?? null},
      ${changedAt.data}
    )
    ON CONFLICT (base_id, state_key, entity_id, dimensions_hash)
    DO UPDATE SET
      value = EXCLUDED.value,
      source_id = EXCLUDED.source_id,
      entity_type = EXCLUDED.entity_type,
      dimensions = EXCLUDED.dimensions,
      resource_key = EXCLUDED.resource_key,
      resource_id = EXCLUDED.resource_id,
      resource_type = EXCLUDED.resource_type,
      resource_label = EXCLUDED.resource_label,
      updated_at = EXCLUDED.updated_at
    WHERE pulse.states_current.updated_at <= EXCLUDED.updated_at
  `;
  await upsertObservedResource({ baseId: params.baseId, sourceId: params.sourceId, resource, dimensions, seenAt: changedAt.data, db });
  await upsertSignalFields({
    baseId: params.baseId,
    sourceId: params.sourceId,
    scope: "state",
    signalName: params.state.key,
    role: "dimension",
    values: dimensions,
    seenAt: changedAt.data,
    db,
  });
  return ok();
};

export const setState = async (params: { baseId: string; sourceId?: string | null; state: PulseState }): Promise<Result<void>> => {
  const valid = validateState(params.state);
  return valid.ok ? sql.begin((tx) => setStateInClient({ ...params, db: tx })) : valid;
};

type IngestCounts = { metrics: number; events: number; states: number };

const ingestBatchInClient = async (params: {
  baseId: string;
  sourceId?: string | null;
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
  sourceId?: string | null;
  batch: PulseIngestBatch;
}): Promise<Result<{ metrics: number; events: number; states: number }>> => {
  const requestedCount = countBatchItems(params.batch);
  if (requestedCount === 0) return fail(err.badInput("Ingest batch is empty"));
  if (requestedCount > PULSE_INTERNAL_INGEST_BATCH_LIMIT) {
    return fail(err.badInput(`Ingest batch exceeds the internal limit of ${PULSE_INTERNAL_INGEST_BATCH_LIMIT} items`));
  }
  const valid = validateBatch(params.batch);
  if (!valid.ok) return fail(valid.error);
  const active = await requireBaseActive(params.baseId);
  if (!active.ok) return fail(active.error);

  // Ingest batches are all-or-nothing: once preflight passes, every write participates in this transaction.
  try {
    return await sql.begin(
      async (tx): Promise<Result<IngestCounts>> =>
        ok(await ingestBatchInClient({ baseId: params.baseId, sourceId: params.sourceId, batch: params.batch, db: tx })),
    );
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
  const active = await requireBaseActive(source.data.baseId);
  if (!active.ok) return fail(active.error);

  const requestHash = createHash("sha256").update(JSON.stringify(params.batch)).digest("hex");
  try {
    return await sql.begin(async (tx): Promise<Result<IngestCounts>> => {
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
        const [existing] = await tx<{ request_hash: string; response: IngestCounts | string | null }[]>`
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
        const response = typeof existing.response === "string" ? JSON.parse(existing.response) : existing.response;
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
