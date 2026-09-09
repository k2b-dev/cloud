import { err, fail, ok, type Result } from "@k2b/cloud/server";
import { toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import type { EventQuery, MetricQuery, MetricQueryPoint, PulseCurrentState, PulseRecordedEvent, StateQuery } from "../contracts";
import { durationToInterval, intervalToMs } from "../query-dsl";
import {
  type CurrentStateRow,
  iso,
  jsonbObject,
  mapCurrentState,
  mapRecordedEvent,
  normalizeDimensions,
  parseJsonObject,
  type RecordedEventRow,
} from "./telemetry-values";

const MAX_METRIC_BUCKETS = 2_000;
const MAX_MATCHED_SERIES = 250;
const MAX_METRIC_POINTS = 100_000;

type MetricWindow = {
  bucketInterval: string;
  bucketMs: number;
  since: Date;
  sinceMs: number;
};

type MetricValueRow = {
  series_id: string;
  bucket: Date | string;
  value: number | null;
};

type MetricSeriesMatch = {
  id: string;
  resource_key: string | null;
  resource_id: string | null;
  resource_type: string | null;
  resource_label: string | null;
  dimensions: unknown;
};

type StateQueryParams = {
  state: string | null;
  sourceId: string | null;
  entityId: string | null;
  entityType: string | null;
  dimensionsJson: string;
  since: Date | null;
  limit: number;
};

const metricGroup = (series: MetricSeriesMatch, groupBy: string | null | undefined): { key: string; group?: Record<string, string> } => {
  if (!groupBy) return { key: "" };
  if (groupBy === "resource") {
    const key = series.resource_key ?? `${series.resource_type ?? ""}:${series.resource_id ?? ""}`;
    return {
      key,
      group: {
        resource: series.resource_label || key || "(none)",
        resource_key: key || "(none)",
      },
    };
  }
  const value = normalizeDimensions(parseJsonObject(series.dimensions))[groupBy] ?? "(none)";
  return { key: value, group: { [groupBy]: value } };
};

const reduceMetricValues = (values: number[], reducer: NonNullable<MetricQuery["reduce"]>): number | null => {
  if (values.length === 0) return null;
  if (reducer === "sum") return values.reduce((sum, value) => sum + value, 0);
  if (reducer === "min") return Math.min(...values);
  if (reducer === "max") return Math.max(...values);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const metricRowsToPoints = (query: MetricQuery, rows: MetricValueRow[], series: MetricSeriesMatch[]): MetricQueryPoint[] => {
  const seriesGroups = new Map(series.map((item) => [item.id, metricGroup(item, query.groupBy)]));
  const buckets = new Map<string, { bucket: string; group?: Record<string, string>; values: number[] }>();
  for (const row of rows) {
    const group = seriesGroups.get(row.series_id) ?? { key: "" };
    const bucket = iso(row.bucket);
    const key = `${bucket}\u001f${group.key}`;
    const entry = buckets.get(key) ?? { bucket, group: group.group, values: [] };
    if (row.value !== null && Number.isFinite(Number(row.value))) entry.values.push(Number(row.value));
    buckets.set(key, entry);
  }
  const reducer = query.reduce ?? "avg";
  return [...buckets.values()]
    .map((entry) => ({
      bucket: entry.bucket,
      value: reduceMetricValues(entry.values, reducer),
      ...(entry.group ? { group: entry.group } : {}),
    }))
    .sort((a, b) => a.bucket.localeCompare(b.bucket) || JSON.stringify(a.group ?? {}).localeCompare(JSON.stringify(b.group ?? {})));
};

const resolveMetricWindow = (query: MetricQuery): Result<MetricWindow> => {
  const bucketInterval = durationToInterval(query.bucket);
  const sinceMs = intervalToMs(query.since);
  if (!bucketInterval || !sinceMs) return fail(err.badInput("Use compact durations like 5m, 1h, or 7d"));

  const bucketMs = intervalToMs(query.bucket) ?? 0;
  if (!bucketMs || Math.ceil(sinceMs / bucketMs) > MAX_METRIC_BUCKETS) {
    return fail(err.badInput(`This query creates too many buckets. Use a larger bucket or a shorter range.`));
  }

  return ok({
    bucketInterval,
    bucketMs,
    since: new Date(Date.now() - sinceMs),
    sinceMs,
  });
};

const resolveMetricSeries = async (query: MetricQuery): Promise<MetricSeriesMatch[]> => {
  const dimensionConditions = Object.entries(normalizeDimensions(query.dimensions)).map(
    ([key, value]) => sql`
      EXISTS (
        SELECT 1
        FROM pulse.metric_series_dimensions dimension
        WHERE dimension.series_id = ms.id
          AND dimension.key = ${key}
          AND dimension.value = ${value}
      )
    `,
  );
  const dimensionsMatch = dimensionConditions
    .slice(1)
    .reduce((condition, next) => sql`${condition} AND ${next}`, dimensionConditions[0] ?? sql`TRUE`);
  const rows = await sql<MetricSeriesMatch[]>`
    SELECT ms.id, ms.resource_key, ms.resource_id, ms.resource_type, ms.resource_label, ms.dimensions
    FROM pulse.metric_series ms
    JOIN pulse.metric_defs md ON md.id = ms.metric_id
    WHERE ms.base_id = ${query.baseId}::uuid
      AND md.name = ${query.metric}
      AND ms.source_id IS NOT DISTINCT FROM COALESCE(${query.sourceId ?? null}::uuid, ms.source_id)
      AND (${query.entityId ?? null}::text IS NULL OR ms.entity_id = ${query.entityId ?? null})
      AND (${query.entityType ?? null}::text IS NULL OR ms.entity_type = ${query.entityType ?? null})
      AND ${dimensionsMatch}
    LIMIT ${MAX_MATCHED_SERIES + 1}
  `;
  return rows;
};

const canUseHourlyRollup = (query: MetricQuery, window: MetricWindow): boolean =>
  window.sinceMs >= 7 * 24 * 60 * 60_000 &&
  window.bucketMs >= 60 * 60_000 &&
  (query.aggregation === "avg" ||
    query.aggregation === "sum" ||
    query.aggregation === "min" ||
    query.aggregation === "max" ||
    query.aggregation === "count" ||
    query.aggregation === "latest");

const hourlyRollupAggregateSql = (aggregation: MetricQuery["aggregation"]) => {
  switch (aggregation) {
    case "sum":
      return sql`SUM(value_sum)`;
    case "min":
      return sql`MIN(value_min)`;
    case "max":
      return sql`MAX(value_max)`;
    case "count":
      return sql`SUM(sample_count)::double precision`;
    case "latest":
      return sql`(array_agg(last_value ORDER BY bucket DESC))[1]`;
    default:
      return sql`SUM(value_sum) / NULLIF(SUM(sample_count), 0)`;
  }
};

const queryHourlyRollupRows = async (query: MetricQuery, window: MetricWindow, seriesIds: string[]): Promise<MetricValueRow[] | null> => {
  if (!canUseHourlyRollup(query, window)) return null;

  const rows = await sql<MetricValueRow[]>`
    SELECT series_id, date_bin(${window.bucketInterval}::interval, bucket, '1970-01-01'::timestamptz) AS bucket,
      ${hourlyRollupAggregateSql(query.aggregation)} AS value
    FROM pulse.metric_rollups_hourly
    WHERE base_id = ${query.baseId}::uuid
      AND series_id = ANY(${toPgUuidArray(seriesIds)}::uuid[])
      AND bucket >= ${window.since}
    GROUP BY series_id, 2
    ORDER BY bucket ASC, series_id ASC
    LIMIT ${MAX_METRIC_POINTS}
  `;

  const firstRollup = rows[0];
  if (!firstRollup) return null;
  const firstBucketMs = new Date(firstRollup.bucket).getTime();
  if (!Number.isFinite(firstBucketMs) || firstBucketMs > window.since.getTime() + window.bucketMs) return null;
  return rows;
};

const queryLatestMetric = async (query: MetricQuery, window: MetricWindow, seriesIds: string[]): Promise<MetricValueRow[]> => {
  const rows = await sql<MetricValueRow[]>`
    WITH bucketed AS (
      SELECT
        date_bin(${window.bucketInterval}::interval, ts, '1970-01-01'::timestamptz) AS bucket,
        series_id,
        ts,
        value
      FROM pulse.metric_samples
      WHERE base_id = ${query.baseId}::uuid
        AND series_id = ANY(${toPgUuidArray(seriesIds)}::uuid[])
        AND ts >= ${window.since}
    ),
    latest_per_series AS (
      SELECT DISTINCT ON (series_id, bucket)
        bucket,
        series_id,
        value
      FROM bucketed
      ORDER BY series_id, bucket, ts DESC
    )
    SELECT series_id, bucket, value
    FROM latest_per_series
    ORDER BY bucket ASC, series_id ASC
    LIMIT ${MAX_METRIC_POINTS}
  `;
  return rows;
};

const queryCounterDeltaMetric = async (query: MetricQuery, window: MetricWindow, seriesIds: string[]): Promise<MetricValueRow[]> => {
  const valueSql =
    query.aggregation === "rate"
      ? sql`GREATEST(last_value - first_value, 0) / NULLIF(seconds, 0)`
      : sql`GREATEST(last_value - first_value, 0)`;
  const rows = await sql<MetricValueRow[]>`
    WITH bucketed AS (
      SELECT
        date_bin(${window.bucketInterval}::interval, ts, '1970-01-01'::timestamptz) AS bucket,
        series_id,
        ts,
        value
      FROM pulse.metric_samples
      WHERE base_id = ${query.baseId}::uuid
        AND series_id = ANY(${toPgUuidArray(seriesIds)}::uuid[])
        AND ts >= ${window.since}
    ),
    series_bucket AS (
      SELECT
        bucket,
        series_id,
        (array_agg(value ORDER BY ts ASC))[1] AS first_value,
        (array_agg(value ORDER BY ts DESC))[1] AS last_value,
        EXTRACT(epoch FROM MAX(ts) - MIN(ts))::double precision AS seconds
      FROM bucketed
      GROUP BY bucket, series_id
    )
    SELECT series_id, bucket, ${valueSql} AS value
    FROM series_bucket
    ORDER BY bucket ASC, series_id ASC
    LIMIT ${MAX_METRIC_POINTS}
  `;
  return rows;
};

const sampleAggregateSql = (aggregation: MetricQuery["aggregation"]) => {
  switch (aggregation) {
    case "sum":
      return sql`SUM(value)`;
    case "min":
      return sql`MIN(value)`;
    case "max":
      return sql`MAX(value)`;
    case "count":
      return sql`COUNT(*)::double precision`;
    case "p50":
      return sql`percentile_cont(0.5) WITHIN GROUP (ORDER BY value)`;
    case "p90":
      return sql`percentile_cont(0.9) WITHIN GROUP (ORDER BY value)`;
    case "p95":
      return sql`percentile_cont(0.95) WITHIN GROUP (ORDER BY value)`;
    case "p99":
      return sql`percentile_cont(0.99) WITHIN GROUP (ORDER BY value)`;
    default:
      return sql`AVG(value)`;
  }
};

const querySampleAggregateMetric = async (query: MetricQuery, window: MetricWindow, seriesIds: string[]): Promise<MetricValueRow[]> => {
  const rows = await sql<MetricValueRow[]>`
    SELECT series_id, date_bin(${window.bucketInterval}::interval, ts, '1970-01-01'::timestamptz) AS bucket,
      ${sampleAggregateSql(query.aggregation)} AS value
    FROM pulse.metric_samples
    WHERE base_id = ${query.baseId}::uuid
      AND series_id = ANY(${toPgUuidArray(seriesIds)}::uuid[])
      AND ts >= ${window.since}
    GROUP BY series_id, bucket
    ORDER BY bucket ASC, series_id ASC
    LIMIT ${MAX_METRIC_POINTS}
  `;
  return rows;
};

const boundedMetricPoints = (
  query: MetricQuery,
  rows: MetricValueRow[],
  series: MetricSeriesMatch[],
  maxOutputPoints: number,
): Result<MetricQueryPoint[]> => {
  const points = metricRowsToPoints(query, rows, series);
  return points.length <= maxOutputPoints
    ? ok(points)
    : fail(err.badInput("This query creates too many grouped points. Use a larger bucket, shorter range, or narrower filter."));
};

export const queryMetricData = async (
  query: MetricQuery,
  limits: { maxOutputPoints?: number } = {},
): Promise<Result<MetricQueryPoint[]>> => {
  const window = resolveMetricWindow(query);
  if (!window.ok) return window;

  const series = await resolveMetricSeries(query);
  if (series.length === 0) return ok([]);
  if (series.length > MAX_MATCHED_SERIES) {
    return fail(err.badInput("This query matches too many series. Add a source or dimension filter."));
  }
  const groups = new Set(series.map((item) => metricGroup(item, query.groupBy).key));
  const maxOutputPoints = Math.min(MAX_METRIC_POINTS, Math.max(1, limits.maxOutputPoints ?? MAX_METRIC_POINTS));
  const bucketCount = Math.ceil(window.data.sinceMs / window.data.bucketMs);
  if (bucketCount * Math.max(groups.size, 1) > maxOutputPoints) {
    return fail(err.badInput("This query creates too many grouped points. Use a larger bucket, shorter range, or narrower filter."));
  }
  if ((bucketCount + 1) * series.length > MAX_METRIC_POINTS) {
    return fail(err.badInput("This query scans too many series-bucket points. Use a larger bucket, shorter range, or narrower filter."));
  }
  const seriesIds = series.map((item) => item.id);

  const rollupRows = await queryHourlyRollupRows(query, window.data, seriesIds);
  if (rollupRows) return boundedMetricPoints(query, rollupRows, series, maxOutputPoints);

  if (query.aggregation === "latest") {
    return boundedMetricPoints(query, await queryLatestMetric(query, window.data, seriesIds), series, maxOutputPoints);
  }
  if (query.aggregation === "rate" || query.aggregation === "increase") {
    return boundedMetricPoints(query, await queryCounterDeltaMetric(query, window.data, seriesIds), series, maxOutputPoints);
  }

  return boundedMetricPoints(query, await querySampleAggregateMetric(query, window.data, seriesIds), series, maxOutputPoints);
};

export const queryEventsData = async (query: EventQuery): Promise<Result<PulseRecordedEvent[]>> => {
  const sinceMs = intervalToMs(query.since);
  if (!sinceMs) return fail(err.badInput("Use compact durations like 5m, 1h, or 7d"));
  const since = new Date(Date.now() - sinceMs);
  const dimensions = normalizeDimensions(query.dimensions);
  const rows = await sql<RecordedEventRow[]>`
    SELECT id, kind, ts, value, source_id, entity_id, entity_type, dimensions, attributes, payload, recorded_at
    FROM pulse.events
    WHERE base_id = ${query.baseId}::uuid
      AND (${query.event ?? null}::text IS NULL OR kind = ${query.event ?? null})
      AND (${query.sourceId ?? null}::uuid IS NULL OR source_id = ${query.sourceId ?? null}::uuid)
      AND (${query.entityId ?? null}::text IS NULL OR entity_id = ${query.entityId ?? null})
      AND (${query.entityType ?? null}::text IS NULL OR entity_type = ${query.entityType ?? null})
      AND dimensions @> (${jsonbObject(dimensions)}::jsonb #>> '{}')::jsonb
      AND ts >= ${since}
    ORDER BY ts DESC, recorded_at DESC
    LIMIT ${query.limit}
  `;
  return ok(rows.map(mapRecordedEvent));
};

type EventAggregateRow = {
  bucket: Date | string;
  value: number | string | null;
  group_data: unknown;
};

const eventAggregateExpression = (aggregation: NonNullable<EventQuery["aggregation"]>) => {
  switch (aggregation) {
    case "count":
      return sql`COUNT(*)::double precision`;
    case "sum":
      return sql`SUM(value)::double precision`;
    case "unique_actor":
      return sql`COUNT(DISTINCT actor_id)::double precision`;
    case "unique_session":
      return sql`COUNT(DISTINCT session_id)::double precision`;
    default:
      throw new Error("Rows are not an event aggregation");
  }
};

const eventGroupExpression = (groupBy: string[]) => {
  switch (groupBy.length) {
    case 0:
      return sql`'{}'::jsonb`;
    case 1:
      return sql`jsonb_build_object(${groupBy[0]}::text, event.dimensions -> ${groupBy[0]}::text)`;
    case 2:
      return sql`jsonb_build_object(
        ${groupBy[0]}::text, event.dimensions -> ${groupBy[0]}::text,
        ${groupBy[1]}::text, event.dimensions -> ${groupBy[1]}::text
      )`;
    case 3:
      return sql`jsonb_build_object(
        ${groupBy[0]}::text, event.dimensions -> ${groupBy[0]}::text,
        ${groupBy[1]}::text, event.dimensions -> ${groupBy[1]}::text,
        ${groupBy[2]}::text, event.dimensions -> ${groupBy[2]}::text
      )`;
    case 4:
      return sql`jsonb_build_object(
        ${groupBy[0]}::text, event.dimensions -> ${groupBy[0]}::text,
        ${groupBy[1]}::text, event.dimensions -> ${groupBy[1]}::text,
        ${groupBy[2]}::text, event.dimensions -> ${groupBy[2]}::text,
        ${groupBy[3]}::text, event.dimensions -> ${groupBy[3]}::text
      )`;
    default:
      throw new Error("Group by cannot exceed 4 dimension keys");
  }
};

export const queryEventAggregateData = async (
  query: EventQuery,
  limits: { maxOutputPoints?: number } = {},
): Promise<Result<MetricQueryPoint[]>> => {
  const aggregation = query.aggregation ?? "rows";
  if (aggregation === "rows") return fail(err.badInput("Event aggregation is required"));
  const sinceMs = intervalToMs(query.since);
  const bucketInterval = query.bucket ? durationToInterval(query.bucket) : null;
  if (!sinceMs || !bucketInterval) return fail(err.badInput("Use compact durations like 5m, 1h, or 7d"));
  const groupBy = query.groupBy ?? [];
  if (groupBy.length > 4) return fail(err.badInput("Group by cannot exceed 4 dimension keys"));

  const dimensions = jsonbObject(normalizeDimensions(query.dimensions));
  const since = new Date(Date.now() - sinceMs);
  const maxOutputPoints = Math.min(1_000, Math.max(1, limits.maxOutputPoints ?? 1_000));
  const rows = await sql<EventAggregateRow[]>`
    WITH scoped AS (
      SELECT
        date_bin(${bucketInterval}::interval, event.ts, '1970-01-01'::timestamptz) AS bucket,
        event.value,
        event.actor_id,
        event.session_id,
        ${eventGroupExpression(groupBy)} AS group_data
      FROM pulse.events event
      WHERE event.base_id = ${query.baseId}::uuid
        AND (${query.event ?? null}::text IS NULL OR event.kind = ${query.event ?? null})
        AND (${query.sourceId ?? null}::uuid IS NULL OR event.source_id = ${query.sourceId ?? null}::uuid)
        AND (${query.entityId ?? null}::text IS NULL OR event.entity_id = ${query.entityId ?? null})
        AND (${query.entityType ?? null}::text IS NULL OR event.entity_type = ${query.entityType ?? null})
        AND event.dimensions @> (${dimensions}::jsonb #>> '{}')::jsonb
        AND event.ts >= ${since}
    )
    SELECT bucket, ${eventAggregateExpression(aggregation)} AS value, group_data
    FROM scoped
    GROUP BY bucket, group_data
    ORDER BY bucket ASC, group_data::text ASC
    LIMIT ${maxOutputPoints + 1}
  `;
  if (rows.length > maxOutputPoints) {
    return fail(err.badInput("This query creates too many aggregate points. Use a larger bucket, shorter range, or narrower filter."));
  }
  return ok(
    rows.map((row) => ({
      bucket: iso(row.bucket),
      value: row.value === null ? null : Number(row.value),
      group: normalizeDimensions(parseJsonObject(row.group_data)),
    })),
  );
};

export const queryStatesData = async (query: StateQuery): Promise<Result<PulseCurrentState[]>> => {
  const params = resolveStateQueryParams(query);
  if (!params.ok) return params;
  const rows = await queryCurrentStateRows(query.baseId, params.data);
  return ok(rows.map(mapCurrentState));
};

const resolveStateQueryParams = (query: StateQuery): Result<StateQueryParams> => {
  const dimensions = normalizeDimensions(query.dimensions);
  const sinceMs = query.since ? intervalToMs(query.since) : null;
  if (query.since && !sinceMs) return fail(err.badInput("Use compact durations like 5m, 1h, or 7d"));
  return ok({
    state: query.state ?? null,
    sourceId: query.sourceId ?? null,
    entityId: query.entityId ?? null,
    entityType: query.entityType ?? null,
    dimensionsJson: jsonbObject(dimensions),
    since: sinceMs ? new Date(Date.now() - sinceMs) : null,
    limit: query.limit,
  });
};

const queryCurrentStateRows = async (baseId: string, params: StateQueryParams): Promise<CurrentStateRow[]> =>
  sql<CurrentStateRow[]>`
    SELECT state_key, value, source_id, entity_id, entity_type, dimensions, updated_at
    FROM pulse.states_current
    WHERE base_id = ${baseId}::uuid
      AND (${params.state}::text IS NULL OR state_key = ${params.state})
      AND (${params.sourceId}::uuid IS NULL OR source_id = ${params.sourceId}::uuid)
      AND (${params.entityId}::text IS NULL OR entity_id = ${params.entityId})
      AND (${params.entityType}::text IS NULL OR entity_type = ${params.entityType})
      AND dimensions @> (${params.dimensionsJson}::jsonb #>> '{}')::jsonb
      AND (${params.since}::timestamptz IS NULL OR updated_at >= ${params.since}::timestamptz)
    ORDER BY updated_at DESC, state_key ASC
    LIMIT ${params.limit}
  `;
