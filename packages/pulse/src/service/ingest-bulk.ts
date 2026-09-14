import { createHash, randomUUID } from "node:crypto";
import { err } from "@k2b/cloud/server";
import type { sql } from "bun";
import type { PulseIngestBatch } from "../contracts";
import { explicitPulseResource, type PulseResourceIdentity } from "../resource-model";
import { type PulseTelemetryValueKind, telemetryValueKind } from "../telemetry-contract";
import { enforceMetricSeriesBudget } from "./metric-cardinality";
import { markMetricHoursDirty } from "./metric-rollups";
import { lockStateIdentities } from "./state-transitions";
import { normalizeDimensions } from "./telemetry-values";

export type PulseSqlClient = typeof sql;

type PreparedResource = {
  key: string;
  id: string;
  type: string | null;
  label: string;
  dimensions: Record<string, string>;
  seenAt: string;
};

type PreparedMetric = PreparedResourceFields & {
  ordinal: number;
  name: string;
  value: number;
  ts: string;
  unit: string | null;
  metricType: string;
  seriesKey: string;
  dimensionsHash: string;
  dimensions: Record<string, string>;
};

type PreparedEvent = PreparedResourceFields & {
  id: string;
  kind: string;
  ts: string;
  value: number | null;
  actorId: string | null;
  sessionId: string | null;
  correlationId: string | null;
  dimensionsHash: string;
  dimensions: Record<string, string>;
  attributes: Record<string, unknown>;
  sensitive: Record<string, unknown>;
  payload: Record<string, unknown>;
};

type PreparedState = PreparedResourceFields & {
  variantKey: string;
  ordinal: number;
  key: string;
  value: string | number | boolean | null;
  ts: string;
  dimensionsHash: string;
  dimensions: Record<string, string>;
};

type PreparedResourceFields = {
  resourceKey: string | null;
  resourceId: string | null;
  resourceType: string | null;
  resourceLabel: string | null;
};

type PreparedIngestBatch = {
  metrics: PreparedMetric[];
  events: PreparedEvent[];
  states: PreparedState[];
  resources: PreparedResource[];
  fields: PreparedField[];
};

type PreparedField = {
  scope: "metric" | "event" | "state";
  signalName: string;
  role: "dimension" | "attribute" | "sensitive";
  key: string;
  valueType: PulseTelemetryValueKind | "mixed";
  observedCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
};

const variantKey = (sourceId: string, resourceKey: string | null, dimensionsHash: string): string =>
  createHash("sha256")
    .update(JSON.stringify([sourceId, resourceKey, dimensionsHash]))
    .digest("hex");

const dimensionsHash = (dimensions: Record<string, string>): string =>
  createHash("sha256").update(JSON.stringify(dimensions)).digest("hex");

const resourceFields = (resource: PulseResourceIdentity | null): PreparedResourceFields => ({
  resourceKey: resource?.key ?? null,
  resourceId: resource?.id ?? null,
  resourceType: resource?.type ?? null,
  resourceLabel: resource?.label ?? null,
});

const isoTime = (value?: string): string => (value ? new Date(value) : new Date()).toISOString();

export const prepareIngestBatch = (batch: PulseIngestBatch, sourceId: string): PreparedIngestBatch => {
  const resources = new Map<string, PreparedResource>();
  const fields = new Map<string, PreparedField>();

  const observeFields = (
    scope: PreparedField["scope"],
    signalName: string,
    role: PreparedField["role"],
    values: Record<string, unknown>,
    seenAt: string,
  ) => {
    for (const [key, value] of Object.entries(values)) {
      const fieldKey = `${scope}\u001f${signalName}\u001f${role}\u001f${key}`;
      const current = fields.get(fieldKey);
      const nextType = telemetryValueKind(value);
      fields.set(fieldKey, {
        scope,
        signalName,
        role,
        key,
        valueType: current && current.valueType !== nextType ? "mixed" : nextType,
        observedCount: (current?.observedCount ?? 0) + 1,
        firstSeenAt: current && Date.parse(current.firstSeenAt) < Date.parse(seenAt) ? current.firstSeenAt : seenAt,
        lastSeenAt: current && Date.parse(current.lastSeenAt) > Date.parse(seenAt) ? current.lastSeenAt : seenAt,
      });
    }
  };

  const observe = (
    scope: "metric" | "event" | "state",
    signalName: string,
    dimensions: Record<string, string>,
    seenAt: string,
    resource: PulseResourceIdentity | null,
  ) => {
    observeFields(scope, signalName, "dimension", dimensions, seenAt);
    if (!resource) return null;
    const current = resources.get(resource.key);
    resources.set(resource.key, {
      key: resource.key,
      id: resource.id,
      type: resource.type ?? current?.type ?? null,
      label: resource.label,
      dimensions: { ...(current?.dimensions ?? {}), ...dimensions },
      seenAt: !current || Date.parse(seenAt) > Date.parse(current.seenAt) ? seenAt : current.seenAt,
    });
    return resource;
  };

  const metrics = (batch.metrics ?? []).map((metric, ordinal) => {
    const dimensions = normalizeDimensions(metric.dimensions);
    const hash = dimensionsHash(dimensions);
    const ts = isoTime(metric.ts);
    const explicitResource = explicitPulseResource(metric.resource);
    const resource = observe("metric", metric.name, dimensions, ts, explicitResource);
    return {
      ordinal,
      name: metric.name,
      value: metric.value,
      ts,
      unit: metric.unit ?? null,
      metricType: metric.type ?? "gauge",
      seriesKey: variantKey(sourceId, resource?.key ?? null, hash),
      dimensionsHash: hash,
      dimensions,
      ...resourceFields(resource),
    };
  });

  const events = (batch.events ?? []).map((event) => {
    const dimensions = normalizeDimensions(event.dimensions);
    const hash = dimensionsHash(dimensions);
    const ts = isoTime(event.ts);
    const resource = observe("event", event.kind, dimensions, ts, explicitPulseResource(event.resource));
    observeFields("event", event.kind, "attribute", event.attributes ?? {}, ts);
    observeFields("event", event.kind, "sensitive", event.sensitive ?? {}, ts);
    return {
      id: randomUUID(),
      kind: event.kind,
      ts,
      value: event.value ?? null,
      actorId: event.actorId ?? null,
      sessionId: event.sessionId ?? null,
      correlationId: event.correlationId ?? null,
      dimensionsHash: hash,
      dimensions,
      attributes: event.attributes ?? {},
      sensitive: event.sensitive ?? {},
      payload: event.payload ?? {},
      ...resourceFields(resource),
    };
  });

  const states = (batch.states ?? []).map((state, ordinal) => {
    const dimensions = normalizeDimensions(state.dimensions);
    const hash = dimensionsHash(dimensions);
    const ts = isoTime(state.ts);
    const explicitResource = explicitPulseResource(state.resource);
    const resource = observe("state", state.key, dimensions, ts, explicitResource);
    return {
      ordinal,
      key: state.key,
      variantKey: variantKey(sourceId, resource?.key ?? null, hash),
      value: state.value,
      ts,
      dimensionsHash: hash,
      dimensions,
      ...resourceFields(resource),
    };
  });

  return { metrics, events, states, resources: [...resources.values()], fields: [...fields.values()] };
};

const json = (value: unknown): string => JSON.stringify(value);

const writeMetrics = async (baseId: string, sourceId: string, rows: PreparedMetric[], db: PulseSqlClient) => {
  if (rows.length === 0) return;
  const input = json(rows);
  const definitions = await db<{ name: string }[]>`
    WITH input AS (
      SELECT * FROM jsonb_to_recordset((${input}::jsonb #>> '{}')::jsonb) AS row(
        ordinal int, name text, unit text, "metricType" text
      )
    ), definitions AS (
      SELECT DISTINCT ON (name) name, unit, "metricType"
      FROM input
      ORDER BY name, ordinal
    )
    INSERT INTO pulse.metric_defs (base_id, name, unit, type)
    SELECT ${baseId}::uuid, name, unit, "metricType"::pulse.metric_type FROM definitions ORDER BY name
    ON CONFLICT (base_id, name) DO UPDATE SET name = EXCLUDED.name
    WHERE pulse.metric_defs.type = EXCLUDED.type AND pulse.metric_defs.unit IS NOT DISTINCT FROM EXCLUDED.unit
    RETURNING name
  `;
  if (definitions.length !== new Set(rows.map((row) => row.name)).size) {
    throw err.badInput("Metric type and unit must match the existing definition");
  }
  await enforceMetricSeriesBudget(
    baseId,
    rows.map((row) => ({ metric: row.name, seriesKey: row.seriesKey })),
    db,
  );
  await db`
    WITH input AS (
      SELECT * FROM jsonb_to_recordset((${input}::jsonb #>> '{}')::jsonb) AS row(
        ordinal int, name text, "seriesKey" text,
        "dimensionsHash" text, dimensions jsonb, "resourceKey" text, "resourceId" text,
        "resourceType" text, "resourceLabel" text, ts timestamptz
      )
    ), series AS (
      SELECT DISTINCT ON (name, "seriesKey") * FROM input ORDER BY name, "seriesKey", ordinal DESC
    )
    INSERT INTO pulse.metric_series (
      base_id, metric_id, source_id, series_key, dimensions_hash,
      dimensions, resource_key, resource_id, resource_type, resource_label, last_seen_at
    )
    SELECT ${baseId}::uuid, md.id, ${sourceId}::uuid, i."seriesKey",
      i."dimensionsHash", i.dimensions, i."resourceKey", i."resourceId", i."resourceType", i."resourceLabel", i.ts
    FROM series i
    JOIN pulse.metric_defs md ON md.base_id = ${baseId}::uuid AND md.name = i.name
    ON CONFLICT (base_id, metric_id, series_key) DO UPDATE SET
      source_id = EXCLUDED.source_id,
      dimensions = EXCLUDED.dimensions, resource_key = EXCLUDED.resource_key, resource_id = EXCLUDED.resource_id,
      resource_type = EXCLUDED.resource_type, resource_label = EXCLUDED.resource_label,
      last_seen_at = GREATEST(pulse.metric_series.last_seen_at, EXCLUDED.last_seen_at)
  `;
  await db`
    WITH input AS (
      SELECT * FROM jsonb_to_recordset((${input}::jsonb #>> '{}')::jsonb) AS row(name text, "seriesKey" text, dimensions jsonb)
    )
    INSERT INTO pulse.metric_series_dimensions (series_id, key, value)
    SELECT DISTINCT ms.id, dimension.key, dimension.value
    FROM input i
    JOIN pulse.metric_defs md ON md.base_id = ${baseId}::uuid AND md.name = i.name
    JOIN pulse.metric_series ms ON ms.base_id = ${baseId}::uuid AND ms.metric_id = md.id AND ms.series_key = i."seriesKey"
    CROSS JOIN LATERAL jsonb_each_text(i.dimensions) dimension
    ON CONFLICT (series_id, key) DO UPDATE SET value = EXCLUDED.value
  `;
  await db`
    WITH input AS (
      SELECT * FROM jsonb_to_recordset((${input}::jsonb #>> '{}')::jsonb) AS row(
        ordinal int, name text, "seriesKey" text, ts timestamptz, value double precision
      )
    ), samples AS (
      SELECT DISTINCT ON (name, "seriesKey", ts) * FROM input ORDER BY name, "seriesKey", ts, ordinal DESC
    )
    INSERT INTO pulse.metric_samples (base_id, series_id, ts, value)
    SELECT ${baseId}::uuid, ms.id, i.ts, i.value
    FROM samples i
    JOIN pulse.metric_defs md ON md.base_id = ${baseId}::uuid AND md.name = i.name
    JOIN pulse.metric_series ms ON ms.base_id = ${baseId}::uuid AND ms.metric_id = md.id AND ms.series_key = i."seriesKey"
    ON CONFLICT (series_id, ts) DO UPDATE SET value = EXCLUDED.value, recorded_at = now()
  `;
};

const writeEvents = async (baseId: string, sourceId: string, rows: PreparedEvent[], db: PulseSqlClient) => {
  if (rows.length === 0) return;
  const input = json(rows);
  await db`
    WITH input AS (
      SELECT * FROM jsonb_to_recordset((${input}::jsonb #>> '{}')::jsonb) AS row(
        id uuid, kind text, ts timestamptz, value double precision,
        "actorId" text, "sessionId" text, "correlationId" text, "dimensionsHash" text, dimensions jsonb,
        attributes jsonb, sensitive jsonb, payload jsonb, "resourceKey" text, "resourceId" text, "resourceType" text, "resourceLabel" text
      )
    )
    INSERT INTO pulse.events (
      id, base_id, source_id, ts, kind, value, actor_id, session_id,
      correlation_id, dimensions_hash, dimensions, attributes, sensitive, payload, resource_key, resource_id, resource_type, resource_label
    )
    SELECT id, ${baseId}::uuid, ${sourceId}::uuid, ts, kind, value, "actorId",
      "sessionId", "correlationId", "dimensionsHash", dimensions, attributes, sensitive, payload, "resourceKey", "resourceId", "resourceType", "resourceLabel"
    FROM input
  `;
};

const writeStates = async (baseId: string, sourceId: string, rows: PreparedState[], db: PulseSqlClient) => {
  if (rows.length === 0) return;
  const input = json(rows);
  const columns = `ordinal int, key text, value jsonb, ts timestamptz, "variantKey" text, "dimensionsHash" text, dimensions jsonb, "resourceKey" text, "resourceId" text, "resourceType" text, "resourceLabel" text`;
  await lockStateIdentities(
    baseId,
    rows.map((row) => ({ key: row.key, variantKey: row.variantKey })),
    db,
  );
  await db.unsafe(
    `
    WITH input AS (
      SELECT ordinal, key, COALESCE(value, 'null'::jsonb) AS value, ts, "variantKey", "dimensionsHash", dimensions, "resourceKey", "resourceId", "resourceType", "resourceLabel" FROM jsonb_to_recordset(($1::jsonb #>> '{}')::jsonb) AS row(${columns})
    ), transitions AS (
      SELECT incoming.*,
        lag(incoming.value, 1, current.value) OVER (
          PARTITION BY incoming.key, incoming."variantKey" ORDER BY incoming.ts, incoming.ordinal
        ) AS previous_value
      FROM input incoming
      LEFT JOIN pulse.states_current current
        ON current.base_id = $2::uuid AND current.state_key = incoming.key
        AND current.variant_key = incoming."variantKey"
      WHERE current.base_id IS NULL OR incoming.ts >= current.updated_at
    )
    INSERT INTO pulse.state_changes (
      base_id, state_key, source_id, variant_key, value, dimensions_hash, dimensions,
      resource_key, resource_id, resource_type, resource_label, changed_at
    )
    SELECT $2::uuid, key, $3::uuid, "variantKey", value, "dimensionsHash", dimensions,
      "resourceKey", "resourceId", "resourceType", "resourceLabel", ts
    FROM transitions WHERE previous_value IS DISTINCT FROM value
    ORDER BY key, "variantKey", ts, ordinal
  `,
    [input, baseId, sourceId],
  );
  await db.unsafe(
    `
    WITH input AS (
      SELECT ordinal, key, COALESCE(value, 'null'::jsonb) AS value, ts, "variantKey", "dimensionsHash", dimensions, "resourceKey", "resourceId", "resourceType", "resourceLabel" FROM jsonb_to_recordset(($1::jsonb #>> '{}')::jsonb) AS row(${columns})
    ), current_rows AS (
      SELECT DISTINCT ON (key, "variantKey") *
      FROM input ORDER BY key, "variantKey", ts DESC, ordinal DESC
    )
    INSERT INTO pulse.states_current (
      base_id, state_key, source_id, variant_key, value, dimensions_hash, dimensions,
      resource_key, resource_id, resource_type, resource_label, updated_at
    )
    SELECT $2::uuid, key, $3::uuid, "variantKey", value, "dimensionsHash", dimensions,
      "resourceKey", "resourceId", "resourceType", "resourceLabel", ts
    FROM current_rows
    ON CONFLICT (base_id, state_key, variant_key) DO UPDATE SET
      value = EXCLUDED.value, source_id = EXCLUDED.source_id,
      dimensions = EXCLUDED.dimensions, resource_key = EXCLUDED.resource_key, resource_id = EXCLUDED.resource_id,
      resource_type = EXCLUDED.resource_type, resource_label = EXCLUDED.resource_label, updated_at = EXCLUDED.updated_at
    WHERE pulse.states_current.updated_at <= EXCLUDED.updated_at
  `,
    [input, baseId, sourceId],
  );
};

const writeResources = async (baseId: string, sourceId: string, resources: PreparedResource[], db: PulseSqlClient) => {
  if (resources.length === 0) return;
  await db`
    WITH input AS (
      SELECT * FROM jsonb_to_recordset((${json(resources)}::jsonb #>> '{}')::jsonb) AS row(
        key text, id text, type text, label text, dimensions jsonb, "seenAt" timestamptz
      )
    )
    INSERT INTO pulse.observed_resources (
      base_id, resource_key, resource_id, resource_type, label, source_ids, dimensions, last_seen_at, updated_at
    )
    SELECT ${baseId}::uuid, key, id, type, label,
      ARRAY[${sourceId}::uuid],
      dimensions, "seenAt", now()
    FROM input
    ON CONFLICT (base_id, resource_key) DO UPDATE SET
      resource_id = EXCLUDED.resource_id,
      resource_type = COALESCE(EXCLUDED.resource_type, pulse.observed_resources.resource_type),
      label = EXCLUDED.label,
      source_ids = ARRAY(SELECT DISTINCT unnest(pulse.observed_resources.source_ids || EXCLUDED.source_ids)),
      dimensions = pulse.observed_resources.dimensions || EXCLUDED.dimensions,
      last_seen_at = GREATEST(pulse.observed_resources.last_seen_at, EXCLUDED.last_seen_at),
      updated_at = now()
  `;
};

const writeFieldMetadata = async (baseId: string, sourceId: string, fields: PreparedIngestBatch["fields"], db: PulseSqlClient) => {
  if (fields.length === 0) return;
  await db`
    WITH input AS (
      SELECT * FROM jsonb_to_recordset((${json(fields)}::jsonb #>> '{}')::jsonb) AS row(
        scope text, "signalName" text, role text, key text, "valueType" text,
        "observedCount" bigint, "firstSeenAt" timestamptz, "lastSeenAt" timestamptz
      )
    )
    INSERT INTO pulse.signal_fields (
      base_id, source_id, scope, signal_name, role, key, value_type, observed_count, first_seen_at, last_seen_at
    )
    SELECT ${baseId}::uuid, ${sourceId}::uuid, scope, "signalName", role, key, "valueType", "observedCount", "firstSeenAt", "lastSeenAt"
    FROM input
    ON CONFLICT (base_id, source_id, scope, signal_name, role, key) DO UPDATE SET
      value_type = CASE WHEN pulse.signal_fields.value_type = EXCLUDED.value_type THEN EXCLUDED.value_type ELSE 'mixed' END,
      observed_count = pulse.signal_fields.observed_count + EXCLUDED.observed_count,
      first_seen_at = LEAST(pulse.signal_fields.first_seen_at, EXCLUDED.first_seen_at),
      last_seen_at = GREATEST(pulse.signal_fields.last_seen_at, EXCLUDED.last_seen_at)
  `;
};

export const writePreparedIngestBatchInTransaction = async (params: {
  baseId: string;
  sourceId: string;
  batch: PreparedIngestBatch;
  db: PulseSqlClient;
}): Promise<void> => {
  await markMetricHoursDirty(
    params.baseId,
    params.batch.metrics.map((metric) => metric.ts),
    params.db,
  );
  await writeMetrics(params.baseId, params.sourceId, params.batch.metrics, params.db);
  await writeEvents(params.baseId, params.sourceId, params.batch.events, params.db);
  await writeStates(params.baseId, params.sourceId, params.batch.states, params.db);
  await writeResources(params.baseId, params.sourceId, params.batch.resources, params.db);
  await writeFieldMetadata(params.baseId, params.sourceId, params.batch.fields, params.db);
};
