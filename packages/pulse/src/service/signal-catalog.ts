import { buildAccessPrincipalCondition, err, fail, ok, type Result } from "@k2b/cloud/server";
import { sql } from "bun";
import type {
  MetricType,
  PulseCurrentState,
  PulseInventory,
  PulseMetricSeries,
  PulseMetricSummary,
  PulseRecordedEvent,
  PulseResourceMetric,
  PulseResourceSearchResult,
  PulseResourceSummary,
  PulseSignalField,
} from "../contracts";
import { type AccessScope, readableScopeFilter, requireBaseAccess } from "./access-control";
import {
  type CurrentStateRow,
  isoNullable,
  mapCurrentState,
  mapRecordedEvent,
  normalizeDimensions,
  parseJsonObject,
  type RecordedEventRow,
} from "./telemetry-values";

type InventoryMetricRow = {
  series_id: string;
  metric: string;
  type: MetricType;
  unit: string | null;
  source_id: string | null;
  entity_id: string | null;
  entity_type: string | null;
  dimensions: unknown;
  last_seen_at: Date | string | null;
  latest_value: number | null;
  latest_sample_at: Date | string | null;
};

type ObservedResourceRow = {
  id: string;
  resource_key: string;
  resource_id: string;
  resource_type: string | null;
  label: string;
  source_ids: unknown;
  dimensions: unknown;
  last_seen_at: Date | string | null;
};

type SearchResourceRow = Omit<ObservedResourceRow, "id"> & {
  base_id: string;
  base_name: string;
};

type ResourceCountRow = {
  resource_key: string;
  count: number;
};

type ResourceMetricCountRow = {
  resource_key: string;
  series_count: number;
  metric_count: number;
};

type ResourceMetricRow = InventoryMetricRow & {
  resource_key: string;
  resource_id: string;
  resource_type: string | null;
};

type SignalFieldRow = {
  source_id: string;
  scope: PulseSignalField["scope"];
  signal_name: string;
  role: PulseSignalField["role"];
  key: string;
  value_type: PulseSignalField["valueType"];
  observed_count: number;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
};

type SignalFieldListParams = {
  q?: string | null;
  sourceId?: string | null;
  scope?: PulseSignalField["scope"] | null;
  role?: PulseSignalField["role"] | null;
  limit?: number;
  offset?: number;
};

const escapeLikePattern = (value: string): string => value.replace(/([\\%_])/g, "\\$1");

const searchPattern = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? `%${escapeLikePattern(trimmed)}%` : null;
};

const parseUuidArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value !== "string") return [];
  return value
    .replace(/^\{|\}$/g, "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

const mapObservedResource = (
  row: ObservedResourceRow,
  counts: {
    metrics: Map<string, { series: number; metrics: number }>;
    events: Map<string, number>;
    states: Map<string, number>;
  },
): PulseResourceSummary => {
  const metricCounts = counts.metrics.get(row.resource_key);
  return {
    key: row.resource_key,
    id: row.resource_id,
    label: row.label,
    type: row.resource_type,
    sourceIds: parseUuidArray(row.source_ids),
    metricSeriesCount: metricCounts?.series ?? 0,
    metricCount: metricCounts?.metrics ?? 0,
    eventCount: counts.events.get(row.resource_key) ?? 0,
    stateCount: counts.states.get(row.resource_key) ?? 0,
    lastSeenAt: isoNullable(row.last_seen_at),
    dimensions: normalizeDimensions(parseJsonObject(row.dimensions)),
  };
};

const mapResourceMetric = (row: ResourceMetricRow): PulseResourceMetric => ({
  seriesId: row.series_id,
  resourceKey: row.resource_key,
  resourceId: row.resource_id,
  resourceType: row.resource_type,
  metric: row.metric,
  type: row.type,
  unit: row.unit,
  sourceId: row.source_id,
  dimensions: normalizeDimensions(parseJsonObject(row.dimensions)),
  lastSeenAt: isoNullable(row.last_seen_at),
  latestValue: row.latest_value,
  latestSampleAt: isoNullable(row.latest_sample_at),
});

const querySignalFields = async (baseId: string, params: SignalFieldListParams = {}): Promise<PulseSignalField[]> => {
  const pattern = searchPattern(params.q);
  const limit = Math.min(5000, Math.max(1, params.limit ?? 500));
  const offset = Math.max(0, params.offset ?? 0);
  const rows = await sql<SignalFieldRow[]>`
    SELECT source_id, scope, signal_name, role, key, value_type, observed_count, first_seen_at, last_seen_at
    FROM pulse.signal_fields
    WHERE base_id = ${baseId}::uuid
      AND (${params.sourceId ?? null}::uuid IS NULL OR source_id = ${params.sourceId ?? null}::uuid)
      AND (${params.scope ?? null}::text IS NULL OR scope = ${params.scope ?? null})
      AND (${params.role ?? null}::text IS NULL OR role = ${params.role ?? null})
      AND (${pattern}::text IS NULL OR signal_name ILIKE ${pattern} ESCAPE '\\' OR key ILIKE ${pattern} ESCAPE '\\')
    ORDER BY scope, signal_name, role, key, source_id
    LIMIT ${limit}
    OFFSET ${offset}
  `;
  return rows.map((row) => ({
    sourceId: row.source_id,
    scope: row.scope,
    signalName: row.signal_name,
    role: row.role,
    key: row.key,
    valueType: row.value_type,
    observedCount: Number(row.observed_count),
    firstSeenAt: new Date(row.first_seen_at).toISOString(),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
  }));
};

export const listSignalFields = async (
  baseId: string,
  user: AccessScope,
  params: SignalFieldListParams = {},
): Promise<Result<PulseSignalField[]>> => {
  const access = await requireBaseAccess(baseId, user, "read");
  if (!access.ok) return fail(access.error);
  return ok(await querySignalFields(baseId, params));
};

export const listMetrics = async (
  baseId: string,
  user: AccessScope,
  params: {
    q?: string | null;
    sourceId?: string | null;
    type?: MetricType | null;
    entityId?: string | null;
    entityType?: string | null;
    limit?: number;
    offset?: number;
  } = {},
): Promise<Result<PulseMetricSummary[]>> => {
  const access = await requireBaseAccess(baseId, user, "read");
  if (!access.ok) return fail(access.error);
  const pattern = searchPattern(params.q);
  const sourceId = params.sourceId ?? null;
  const limit = Math.min(500, Math.max(1, params.limit ?? 500));
  const offset = Math.max(0, params.offset ?? 0);
  const rows = await sql<
    { name: string; unit: string | null; type: MetricType; series_count: number; last_seen_at: Date | string | null }[]
  >`
    SELECT
      md.name,
      md.unit,
      md.type,
      COUNT(ms.id)::int AS series_count,
      MAX(ms.last_seen_at) AS last_seen_at
    FROM pulse.metric_defs md
    LEFT JOIN pulse.metric_series ms
      ON ms.metric_id = md.id
      AND (${sourceId}::uuid IS NULL OR ms.source_id = ${sourceId}::uuid)
      AND (${params.entityId ?? null}::text IS NULL OR ms.entity_id = ${params.entityId ?? null})
      AND (${params.entityType ?? null}::text IS NULL OR ms.entity_type = ${params.entityType ?? null})
    WHERE md.base_id = ${baseId}::uuid
      AND (${pattern}::text IS NULL OR md.name ILIKE ${pattern} ESCAPE '\\')
      AND (${params.type ?? null}::pulse.metric_type IS NULL OR md.type = ${params.type ?? null}::pulse.metric_type)
    GROUP BY md.id, md.name, md.unit, md.type
    HAVING ${sourceId}::uuid IS NULL OR COUNT(ms.id) > 0
    ORDER BY md.name ASC
    LIMIT ${limit}
    OFFSET ${offset}
  `;
  return ok(
    rows.map((row) => ({
      name: row.name,
      unit: row.unit,
      type: row.type,
      seriesCount: row.series_count,
      lastSeenAt: isoNullable(row.last_seen_at),
    })),
  );
};

export const getResource = async (baseId: string, resourceKey: string, user: AccessScope): Promise<Result<PulseResourceSearchResult>> => {
  const [row] = await sql<SearchResourceRow[]>`
    SELECT resource.base_id, base.name AS base_name, resource.resource_key, resource.resource_id,
           resource.resource_type, resource.label, resource.source_ids, resource.dimensions, resource.last_seen_at
    FROM pulse.observed_resources resource
    JOIN pulse.bases base ON base.id = resource.base_id AND base.deletion_started_at IS NULL
    WHERE resource.base_id = ${baseId}::uuid
      AND resource.resource_key = ${resourceKey}
  `;
  if (!row) return fail(err.notFound("Resource"));
  const access = await requireBaseAccess(row.base_id, user, "read");
  if (!access.ok) return fail(access.error);
  return ok({
    baseId: row.base_id,
    baseName: row.base_name,
    key: row.resource_key,
    id: row.resource_id,
    label: row.label,
    type: row.resource_type,
    lastSeenAt: isoNullable(row.last_seen_at),
  });
};

export const searchResources = async (
  user: AccessScope,
  params: { query?: string | null; limit?: number } = {},
): Promise<Result<PulseResourceSearchResult[]>> => {
  const limit = Math.min(100, Math.max(1, params.limit ?? 25));
  const visibility = readableScopeFilter(user);
  if (!visibility) return ok([]);
  const principalMatch = buildAccessPrincipalCondition({
    subject: visibility.subject,
    columns: {
      userId: sql`a.user_id`,
      groupId: sql`a.group_id`,
      serviceAccountId: sql`a.service_account_id`,
      authenticatedOnly: sql`a.authenticated_only`,
    },
  });
  const pattern = searchPattern(params.query);
  const rows = await sql<SearchResourceRow[]>`
    SELECT
      resource.base_id,
      base.name AS base_name,
      resource.resource_key,
      resource.resource_id,
      resource.resource_type,
      resource.label,
      resource.source_ids,
      resource.dimensions,
      resource.last_seen_at
    FROM pulse.observed_resources resource
    JOIN pulse.bases base ON base.id = resource.base_id
    WHERE base.deletion_started_at IS NULL
      AND (${visibility.boundBaseShortId}::text IS NULL OR base.short_id = ${visibility.boundBaseShortId})
      AND EXISTS (
        SELECT 1
        FROM pulse.base_access base_access
        JOIN auth.access a ON a.id = base_access.access_id
        WHERE base_access.base_id = resource.base_id
          AND ${principalMatch}
          AND a.permission <> 'none'
      )
      AND (${pattern}::text IS NULL OR resource.search_text ILIKE ${pattern} ESCAPE '\\')
    ORDER BY resource.last_seen_at DESC NULLS LAST, resource.label ASC, resource.resource_key ASC
    LIMIT ${limit}
  `;
  return ok(
    rows.map((row) => ({
      baseId: row.base_id,
      baseName: row.base_name,
      key: row.resource_key,
      id: row.resource_id,
      label: row.label,
      type: row.resource_type,
      lastSeenAt: isoNullable(row.last_seen_at),
    })),
  );
};

export const listMetricSeries = async (
  baseId: string,
  user: AccessScope,
  params: {
    metric: string;
    sourceId?: string | null;
    entityId?: string | null;
    entityType?: string | null;
    q?: string | null;
    limit?: number;
    offset?: number;
  },
): Promise<Result<PulseMetricSeries[]>> => {
  const access = await requireBaseAccess(baseId, user, "read");
  if (!access.ok) return fail(access.error);
  const metric = params.metric.trim();
  if (!metric) return fail(err.badInput("Metric is required"));
  const pattern = searchPattern(params.q);
  const limit = Math.min(500, Math.max(1, params.limit ?? 500));
  const offset = Math.max(0, params.offset ?? 0);
  const rows = await sql<
    {
      id: string;
      metric: string;
      source_id: string | null;
      entity_id: string | null;
      entity_type: string | null;
      dimensions: unknown;
      last_seen_at: Date | string | null;
      latest_value: number | null;
      latest_sample_at: Date | string | null;
    }[]
  >`
    SELECT
      ms.id,
      md.name AS metric,
      ms.source_id,
      ms.entity_id,
      ms.entity_type,
      ms.dimensions,
      ms.last_seen_at,
      latest.value AS latest_value,
      latest.ts AS latest_sample_at
    FROM pulse.metric_series ms
    JOIN pulse.metric_defs md ON md.id = ms.metric_id
    LEFT JOIN LATERAL (
      SELECT sample.value, sample.ts
      FROM pulse.metric_samples sample
      WHERE sample.series_id = ms.id
      ORDER BY sample.ts DESC
      LIMIT 1
    ) latest ON TRUE
    WHERE ms.base_id = ${baseId}::uuid
      AND md.name = ${metric}
      AND ms.source_id IS NOT DISTINCT FROM COALESCE(${params.sourceId ?? null}::uuid, ms.source_id)
      AND (${params.entityId ?? null}::text IS NULL OR ms.entity_id = ${params.entityId ?? null})
      AND (${params.entityType ?? null}::text IS NULL OR ms.entity_type = ${params.entityType ?? null})
      AND (
        ${pattern}::text IS NULL
        OR ms.entity_id ILIKE ${pattern} ESCAPE '\\'
        OR ms.entity_type ILIKE ${pattern} ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM pulse.metric_series_dimensions dimension
          WHERE dimension.series_id = ms.id
            AND (dimension.key ILIKE ${pattern} ESCAPE '\\' OR dimension.value ILIKE ${pattern} ESCAPE '\\')
        )
      )
    ORDER BY ms.last_seen_at DESC NULLS LAST, ms.entity_id ASC NULLS LAST
    LIMIT ${limit}
    OFFSET ${offset}
  `;
  return ok(
    rows.map((row) => ({
      id: row.id,
      metric: row.metric,
      sourceId: row.source_id,
      entityId: row.entity_id,
      entityType: row.entity_type,
      dimensions: normalizeDimensions(parseJsonObject(row.dimensions)),
      lastSeenAt: isoNullable(row.last_seen_at),
      latestValue: row.latest_value,
      latestSampleAt: isoNullable(row.latest_sample_at),
    })),
  );
};

export const listRecentEvents = async (
  baseId: string,
  user: AccessScope,
  params: {
    q?: string | null;
    kind?: string | null;
    sourceId?: string | null;
    entityId?: string | null;
    entityType?: string | null;
    limit?: number;
    offset?: number;
  } = {},
): Promise<Result<PulseRecordedEvent[]>> => {
  const access = await requireBaseAccess(baseId, user, "read");
  if (!access.ok) return fail(access.error);
  const pattern = searchPattern(params.q);
  const limit = Math.min(500, Math.max(1, params.limit ?? 500));
  const offset = Math.max(0, params.offset ?? 0);
  const rows = await sql<RecordedEventRow[]>`
    SELECT id, kind, ts, value, source_id, entity_id, entity_type, dimensions, attributes, payload, recorded_at
    FROM pulse.events
    WHERE base_id = ${baseId}::uuid
      AND (${params.kind ?? null}::text IS NULL OR kind = ${params.kind ?? null})
      AND (${params.sourceId ?? null}::uuid IS NULL OR source_id = ${params.sourceId ?? null}::uuid)
      AND (${params.entityId ?? null}::text IS NULL OR entity_id = ${params.entityId ?? null})
      AND (${params.entityType ?? null}::text IS NULL OR entity_type = ${params.entityType ?? null})
      AND (
        ${pattern}::text IS NULL
        OR kind ILIKE ${pattern} ESCAPE '\\'
        OR entity_id ILIKE ${pattern} ESCAPE '\\'
        OR entity_type ILIKE ${pattern} ESCAPE '\\'
        OR dimensions::text ILIKE ${pattern} ESCAPE '\\'
        OR payload::text ILIKE ${pattern} ESCAPE '\\'
      )
    ORDER BY ts DESC, recorded_at DESC
    LIMIT ${limit}
    OFFSET ${offset}
  `;
  return ok(rows.map(mapRecordedEvent));
};

export const listCurrentStates = async (
  baseId: string,
  user: AccessScope,
  params: {
    q?: string | null;
    key?: string | null;
    sourceId?: string | null;
    entityId?: string | null;
    entityType?: string | null;
    limit?: number;
    offset?: number;
  } = {},
): Promise<Result<PulseCurrentState[]>> => {
  const access = await requireBaseAccess(baseId, user, "read");
  if (!access.ok) return fail(access.error);
  const pattern = searchPattern(params.q);
  const limit = Math.min(500, Math.max(1, params.limit ?? 500));
  const offset = Math.max(0, params.offset ?? 0);
  const rows = await sql<CurrentStateRow[]>`
    SELECT state_key, value, source_id, entity_id, entity_type, dimensions, updated_at
    FROM pulse.states_current
    WHERE base_id = ${baseId}::uuid
      AND (${params.key ?? null}::text IS NULL OR state_key = ${params.key ?? null})
      AND (${params.sourceId ?? null}::uuid IS NULL OR source_id = ${params.sourceId ?? null}::uuid)
      AND (${params.entityId ?? null}::text IS NULL OR entity_id = ${params.entityId ?? null})
      AND (${params.entityType ?? null}::text IS NULL OR entity_type = ${params.entityType ?? null})
      AND (
        ${pattern}::text IS NULL
        OR state_key ILIKE ${pattern} ESCAPE '\\'
        OR entity_id ILIKE ${pattern} ESCAPE '\\'
        OR entity_type ILIKE ${pattern} ESCAPE '\\'
        OR dimensions::text ILIKE ${pattern} ESCAPE '\\'
        OR value::text ILIKE ${pattern} ESCAPE '\\'
      )
    ORDER BY updated_at DESC, state_key ASC
    LIMIT ${limit}
    OFFSET ${offset}
  `;
  return ok(rows.map(mapCurrentState));
};

export const listResources = async (
  baseId: string,
  user: AccessScope,
  params: { q?: string | null; ref?: string | null; type?: string | null; sourceId?: string | null; limit?: number; offset?: number } = {},
): Promise<Result<PulseResourceSummary[]>> => {
  const access = await requireBaseAccess(baseId, user, "read");
  if (!access.ok) return fail(access.error);
  const pattern = searchPattern(params.q);
  const ref = params.ref?.trim() || null;
  const type = params.type?.trim() || null;
  const limit = Math.min(500, Math.max(1, params.limit ?? 100));
  const offset = Math.max(0, params.offset ?? 0);
  const rows = await sql<ObservedResourceRow[]>`
    SELECT resource_key, resource_id, resource_type, label, source_ids, dimensions, last_seen_at
    FROM pulse.observed_resources
    WHERE base_id = ${baseId}::uuid
      AND (${ref}::text IS NULL OR resource_key = ${ref} OR resource_id = ${ref} OR label = ${ref})
      AND (${type}::text IS NULL OR resource_type = ${type})
      AND (${params.sourceId ?? null}::uuid IS NULL OR source_ids @> ARRAY[${params.sourceId ?? null}::uuid])
      AND (
        ${pattern}::text IS NULL
        OR search_text ILIKE ${pattern} ESCAPE '\\'
      )
    ORDER BY last_seen_at DESC NULLS LAST, label ASC
    LIMIT ${limit}
    OFFSET ${offset}
  `;
  if (rows.length === 0) return ok([]);

  const resourceKeys = rows.map((row) => row.resource_key);
  const [metricRows, eventRows, stateRows] = await Promise.all([
    sql<ResourceMetricCountRow[]>`
      SELECT
        ms.resource_key,
        COUNT(*)::int AS series_count,
        COUNT(DISTINCT md.name)::int AS metric_count
      FROM pulse.metric_series ms
      JOIN pulse.metric_defs md ON md.id = ms.metric_id
      WHERE ms.base_id = ${baseId}::uuid
        AND ms.resource_key = ANY(${sql.array(resourceKeys, "TEXT")})
      GROUP BY ms.resource_key
    `,
    sql<ResourceCountRow[]>`
      SELECT resource_key, COUNT(*)::int AS count
      FROM pulse.events
      WHERE base_id = ${baseId}::uuid
        AND resource_key = ANY(${sql.array(resourceKeys, "TEXT")})
      GROUP BY resource_key
    `,
    sql<ResourceCountRow[]>`
      SELECT resource_key, COUNT(*)::int AS count
      FROM pulse.states_current
      WHERE base_id = ${baseId}::uuid
        AND resource_key = ANY(${sql.array(resourceKeys, "TEXT")})
      GROUP BY resource_key
    `,
  ]);

  const counts = {
    metrics: new Map(metricRows.map((row) => [row.resource_key, { series: row.series_count, metrics: row.metric_count }])),
    events: new Map(eventRows.map((row) => [row.resource_key, row.count])),
    states: new Map(stateRows.map((row) => [row.resource_key, row.count])),
  };

  return ok(rows.map((row) => mapObservedResource(row, counts)));
};

export const listResourceMetrics = async (
  baseId: string,
  user: AccessScope,
  params: { resourceKey: string; q?: string | null; sourceId?: string | null; type?: MetricType | null; limit?: number; offset?: number },
): Promise<Result<PulseResourceMetric[]>> => {
  const access = await requireBaseAccess(baseId, user, "read");
  if (!access.ok) return fail(access.error);
  const resourceKey = params.resourceKey.trim();
  if (!resourceKey) return fail(err.badInput("Resource key is required"));
  const pattern = searchPattern(params.q);
  const limit = Math.min(500, Math.max(1, params.limit ?? 100));
  const offset = Math.max(0, params.offset ?? 0);
  const rows = await sql<ResourceMetricRow[]>`
    SELECT
      ms.id AS series_id,
      ms.resource_key,
      ms.resource_id,
      ms.resource_type,
      md.name AS metric,
      md.type,
      md.unit,
      ms.source_id,
      ms.entity_id,
      ms.entity_type,
      ms.dimensions,
      ms.last_seen_at,
      latest.value AS latest_value,
      latest.ts AS latest_sample_at
    FROM pulse.metric_series ms
    JOIN pulse.metric_defs md ON md.id = ms.metric_id
    LEFT JOIN LATERAL (
      SELECT sample.value, sample.ts
      FROM pulse.metric_samples sample
      WHERE sample.series_id = ms.id
      ORDER BY sample.ts DESC
      LIMIT 1
    ) latest ON TRUE
    WHERE ms.base_id = ${baseId}::uuid
      AND ms.resource_key = ${resourceKey}
      AND (${params.sourceId ?? null}::uuid IS NULL OR ms.source_id = ${params.sourceId ?? null}::uuid)
      AND (${params.type ?? null}::pulse.metric_type IS NULL OR md.type = ${params.type ?? null}::pulse.metric_type)
      AND (
        ${pattern}::text IS NULL
        OR md.name ILIKE ${pattern} ESCAPE '\\'
        OR ms.resource_id ILIKE ${pattern} ESCAPE '\\'
        OR ms.resource_type ILIKE ${pattern} ESCAPE '\\'
        OR ms.dimensions::text ILIKE ${pattern} ESCAPE '\\'
      )
    ORDER BY ms.last_seen_at DESC NULLS LAST, md.name ASC
    LIMIT ${limit}
    OFFSET ${offset}
  `;
  return ok(rows.map(mapResourceMetric));
};

export const listResourceEvents = async (
  baseId: string,
  user: AccessScope,
  params: { resourceKey: string; q?: string | null; kind?: string | null; sourceId?: string | null; limit?: number; offset?: number },
): Promise<Result<PulseRecordedEvent[]>> => {
  const access = await requireBaseAccess(baseId, user, "read");
  if (!access.ok) return fail(access.error);
  const resourceKey = params.resourceKey.trim();
  if (!resourceKey) return fail(err.badInput("Resource key is required"));
  const pattern = searchPattern(params.q);
  const limit = Math.min(500, Math.max(1, params.limit ?? 100));
  const offset = Math.max(0, params.offset ?? 0);
  const rows = await sql<RecordedEventRow[]>`
    SELECT id, kind, ts, value, source_id, entity_id, entity_type, dimensions, attributes, payload, recorded_at
    FROM pulse.events
    WHERE base_id = ${baseId}::uuid
      AND resource_key = ${resourceKey}
      AND (${params.kind ?? null}::text IS NULL OR kind = ${params.kind ?? null})
      AND (${params.sourceId ?? null}::uuid IS NULL OR source_id = ${params.sourceId ?? null}::uuid)
      AND (
        ${pattern}::text IS NULL
        OR kind ILIKE ${pattern} ESCAPE '\\'
        OR entity_id ILIKE ${pattern} ESCAPE '\\'
        OR entity_type ILIKE ${pattern} ESCAPE '\\'
        OR dimensions::text ILIKE ${pattern} ESCAPE '\\'
        OR payload::text ILIKE ${pattern} ESCAPE '\\'
      )
    ORDER BY ts DESC, recorded_at DESC
    LIMIT ${limit}
    OFFSET ${offset}
  `;
  return ok(rows.map(mapRecordedEvent));
};

export const listResourceStates = async (
  baseId: string,
  user: AccessScope,
  params: { resourceKey: string; q?: string | null; key?: string | null; sourceId?: string | null; limit?: number; offset?: number },
): Promise<Result<PulseCurrentState[]>> => {
  const access = await requireBaseAccess(baseId, user, "read");
  if (!access.ok) return fail(access.error);
  const resourceKey = params.resourceKey.trim();
  if (!resourceKey) return fail(err.badInput("Resource key is required"));
  const pattern = searchPattern(params.q);
  const limit = Math.min(500, Math.max(1, params.limit ?? 100));
  const offset = Math.max(0, params.offset ?? 0);
  const rows = await sql<CurrentStateRow[]>`
    SELECT state_key, value, source_id, entity_id, entity_type, dimensions, updated_at
    FROM pulse.states_current
    WHERE base_id = ${baseId}::uuid
      AND resource_key = ${resourceKey}
      AND (${params.key ?? null}::text IS NULL OR state_key = ${params.key ?? null})
      AND (${params.sourceId ?? null}::uuid IS NULL OR source_id = ${params.sourceId ?? null}::uuid)
      AND (
        ${pattern}::text IS NULL
        OR state_key ILIKE ${pattern} ESCAPE '\\'
        OR entity_id ILIKE ${pattern} ESCAPE '\\'
        OR entity_type ILIKE ${pattern} ESCAPE '\\'
        OR dimensions::text ILIKE ${pattern} ESCAPE '\\'
        OR value::text ILIKE ${pattern} ESCAPE '\\'
      )
    ORDER BY updated_at DESC, state_key ASC
    LIMIT ${limit}
    OFFSET ${offset}
  `;
  return ok(rows.map(mapCurrentState));
};

export const listInventory = async (baseId: string, user: AccessScope): Promise<Result<PulseInventory>> => {
  const resourceResult = await listResources(baseId, user, { limit: 500 });
  if (!resourceResult.ok) return fail(resourceResult.error);
  const resources = resourceResult.data;
  const resourceKeys = resources.map((resource) => resource.key);
  const fields = await querySignalFields(baseId, { limit: 5000 });
  if (resourceKeys.length === 0) return ok({ resources: [], metrics: [], events: [], states: [], fields });

  const [metricRows, eventRows, stateRows] = await Promise.all([
    sql<ResourceMetricRow[]>`
      SELECT
        ms.id AS series_id,
        ms.resource_key,
        ms.resource_id,
        ms.resource_type,
        md.name AS metric,
        md.type,
        md.unit,
        ms.source_id,
        ms.entity_id,
        ms.entity_type,
        ms.dimensions,
        ms.last_seen_at,
        latest.value AS latest_value,
        latest.ts AS latest_sample_at
      FROM pulse.metric_series ms
      JOIN pulse.metric_defs md ON md.id = ms.metric_id
      LEFT JOIN LATERAL (
        SELECT sample.value, sample.ts
        FROM pulse.metric_samples sample
        WHERE sample.series_id = ms.id
        ORDER BY sample.ts DESC
        LIMIT 1
      ) latest ON TRUE
      WHERE ms.base_id = ${baseId}::uuid
        AND ms.resource_key = ANY(${sql.array(resourceKeys, "TEXT")})
      ORDER BY ms.last_seen_at DESC NULLS LAST, md.name ASC
      LIMIT 5000
    `,
    sql<RecordedEventRow[]>`
      SELECT id, kind, ts, value, source_id, entity_id, entity_type, dimensions, attributes, payload, recorded_at
      FROM pulse.events
      WHERE base_id = ${baseId}::uuid
        AND resource_key = ANY(${sql.array(resourceKeys, "TEXT")})
      ORDER BY ts DESC, recorded_at DESC
      LIMIT 1000
    `,
    sql<CurrentStateRow[]>`
      SELECT state_key, value, source_id, entity_id, entity_type, dimensions, updated_at
      FROM pulse.states_current
      WHERE base_id = ${baseId}::uuid
        AND resource_key = ANY(${sql.array(resourceKeys, "TEXT")})
      ORDER BY updated_at DESC, state_key ASC
      LIMIT 5000
    `,
  ]);

  return ok({
    resources,
    metrics: metricRows.map(mapResourceMetric),
    events: eventRows.map(mapRecordedEvent),
    states: stateRows.map(mapCurrentState),
    fields,
  });
};
