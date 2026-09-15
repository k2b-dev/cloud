import { err, fail, ok, type Result } from "@k2b/cloud/server";
import { toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import type { EventQuery, MetricQuery, MetricQueryPoint, PulseCurrentState, PulseRecordedEvent, StateQuery } from "../contracts";
import { durationToInterval, intervalToMs } from "../query-dsl";
import { isCalendarBucket, resolveQueryTimeRange, validateEventBucket } from "../query-dsl/time-window";
import { withEventQuerySnapshot } from "./event-query-window";
import {
  type CurrentStateRow,
  iso,
  jsonbObject,
  mapCurrentState,
  mapRecordedEvent,
  normalizeDimensions,
  type RecordedEventRow,
  readJsonObject,
} from "./telemetry-values";

const MAX_METRIC_BUCKETS = 2_000;
const MAX_MATCHED_SERIES = 250;
const MAX_METRIC_POINTS = 100_000;

type MetricWindow = {
  bucketInterval: string;
  bucketMs: number;
  since: Date;
  until: Date;
  rawFrom: Date;
  sinceMs: number;
};

type MetricValueRow = {
  series_id: string;
  bucket: Date | string;
  value: number | null;
};

type MetricSeriesMatch = {
  id: string;
  type: string;
  resource_key: string | null;
  resource_id: string | null;
  resource_type: string | null;
  resource_label: string | null;
  dimensions: unknown;
};

type StateQueryParams = {
  state: string | null;
  sourceId: string | null;
  resourceKey: string | null;
  resourceType: string | null;
  dimensionsJson: string;
  since: Date | null;
  limit: number;
};

const metricGroup = (series: MetricSeriesMatch, groupBy: string | null | undefined): { key: string; group?: Record<string, string> } => {
  if (!groupBy) return { key: "" };
  if (groupBy === "resource") {
    const key = series.resource_key ?? "(none)";
    return {
      key,
      group: {
        resource: series.resource_label || key || "(none)",
        resource_key: key || "(none)",
      },
    };
  }
  const value = normalizeDimensions(readJsonObject(series.dimensions))[groupBy] ?? "(none)";
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
  const range = resolveQueryTimeRange(query);
  if (!range.ok) return range;
  const sinceMs = range.data.durationMs;
  if (!bucketInterval) return fail(err.badInput("Use compact durations like 5m, 1h, or 7d"));

  const bucketMs = intervalToMs(query.bucket) ?? 0;
  if (!bucketMs || Math.ceil(sinceMs / bucketMs) > MAX_METRIC_BUCKETS) {
    return fail(err.badInput(`This query creates too many buckets. Use a larger bucket or a shorter range.`));
  }

  return ok({
    bucketInterval,
    bucketMs,
    since: range.data.from,
    until: range.data.to,
    rawFrom: range.data.from,
    sinceMs,
  });
};

const resolveMetricSeries = async (query: MetricQuery, db: typeof sql): Promise<MetricSeriesMatch[]> => {
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
  const rows = await db<MetricSeriesMatch[]>`
    SELECT ms.id, md.type, ms.resource_key, ms.resource_id, ms.resource_type, ms.resource_label, ms.dimensions
    FROM pulse.metric_series ms
    JOIN pulse.metric_defs md ON md.id = ms.metric_id
    WHERE ms.base_id = ${query.baseId}::uuid
      AND md.name = ${query.metric}
      AND ms.source_id IS NOT DISTINCT FROM COALESCE(${query.sourceId ?? null}::uuid, ms.source_id)
      AND (${query.resourceKey ?? null}::text IS NULL OR ms.resource_key = ${query.resourceKey ?? null})
      AND (${query.resourceType ?? null}::text IS NULL OR ms.resource_type = ${query.resourceType ?? null})
      AND ${dimensionsMatch}
    LIMIT ${MAX_MATCHED_SERIES + 1}
  `;
  return rows;
};

const canUseHourlyRollup = (query: MetricQuery, window: MetricWindow): boolean =>
  window.bucketMs % 3_600_000 === 0 &&
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
      return sql`(array_agg(last_value ORDER BY last_ts DESC))[1]`;
    default:
      return sql`SUM(value_sum) / NULLIF(SUM(sample_count), 0)`;
  }
};

const queryHourlyRollupRows = async (
  query: MetricQuery,
  window: MetricWindow,
  seriesIds: string[],
  db: typeof sql,
): Promise<MetricValueRow[] | null> => {
  if (!canUseHourlyRollup(query, window)) return null;

  // Both paths share a statement snapshot. Only complete hours replace their raw samples.
  // Compute gaps per series first so covered hours never scan raw samples, including when other series lack a rollup.
  return await db<MetricValueRow[]>`
    WITH complete AS MATERIALIZED (
      SELECT h.hour FROM pulse.metric_hours h JOIN pulse.bases b ON b.id=h.base_id
      WHERE h.base_id=${query.baseId}::uuid AND h.state IN ('clean','sealed')
        AND h.hour>=${window.since} AND h.hour+interval '1 hour'<=now() AND h.hour+interval '1 hour'<=${window.until}
        AND h.hour>=date_bin('1 hour',now()-b.rollup_retention_days*interval '1 day','1970-01-01'::timestamptz)
    ), retained AS MATERIALIZED (
      SELECT r.series_id,r.bucket,r.sample_count,r.value_sum,r.value_min,r.value_max,r.last_value,r.last_ts
      FROM pulse.metric_rollups_hourly r JOIN complete c ON c.hour=r.bucket
      WHERE r.base_id=${query.baseId}::uuid AND r.series_id=ANY(${toPgUuidArray(seriesIds)}::uuid[])
        AND r.bucket>=${window.since} AND r.bucket<${window.until}
    ), covered AS (
      SELECT series_id,range_agg(tstzrange(bucket,bucket+interval '1 hour','[)')) AS ranges
      FROM retained GROUP BY series_id
    ), gaps AS MATERIALIZED (
      SELECT selected.series_id,unnest(
        tstzmultirange(tstzrange(${window.since},${window.until},'[)')) - COALESCE(covered.ranges,'{}'::tstzmultirange)
      ) AS range
      FROM unnest(${toPgUuidArray(seriesIds)}::uuid[]) AS selected(series_id)
      LEFT JOIN covered ON covered.series_id=selected.series_id
    ), parts AS (
      SELECT * FROM retained
      UNION ALL
      SELECT raw.* FROM gaps CROSS JOIN LATERAL (
        SELECT s.series_id,date_bin('1 hour',s.ts,'1970-01-01'::timestamptz),count(*)::bigint,
          sum(s.value),min(s.value),max(s.value),(array_agg(s.value ORDER BY s.ts DESC))[1],max(s.ts)
        FROM pulse.metric_samples s
        WHERE s.base_id=${query.baseId}::uuid AND s.series_id=gaps.series_id
          AND s.ts>=lower(gaps.range) AND s.ts<upper(gaps.range)
        GROUP BY s.series_id,2
      ) raw
    )
    SELECT series_id,date_bin(${window.bucketInterval}::interval,bucket,'1970-01-01'::timestamptz) AS bucket,
      ${hourlyRollupAggregateSql(query.aggregation)} AS value
    FROM parts GROUP BY series_id,2 ORDER BY bucket,series_id LIMIT ${MAX_METRIC_POINTS}
  `;
};

const queryLatestMetric = async (
  query: MetricQuery,
  window: MetricWindow,
  seriesIds: string[],
  db: typeof sql,
): Promise<MetricValueRow[]> => {
  const rows = await db<MetricValueRow[]>`
    WITH bucketed AS (
      SELECT
        date_bin(${window.bucketInterval}::interval, ts, '1970-01-01'::timestamptz) AS bucket,
        series_id,
        ts,
        value
      FROM pulse.metric_samples
      WHERE base_id = ${query.baseId}::uuid
        AND series_id = ANY(${toPgUuidArray(seriesIds)}::uuid[])
        AND ts >= ${window.since} AND ts < ${window.until}
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

const queryCounterDeltaMetric = async (
  query: MetricQuery,
  window: MetricWindow,
  seriesIds: string[],
  db: typeof sql,
): Promise<MetricValueRow[]> => {
  const valueSql =
    query.aggregation === "rate" ? sql`SUM(delta) / NULLIF(SUM(seconds) FILTER (WHERE delta IS NOT NULL), 0)` : sql`SUM(delta)`;
  return await db<MetricValueRow[]>`
    WITH samples AS (
      SELECT sample.series_id, sample.ts, sample.value
      FROM unnest(${toPgUuidArray(seriesIds)}::uuid[]) AS selected(id)
      CROSS JOIN LATERAL (
        (SELECT series_id, ts, value FROM pulse.metric_samples
         WHERE base_id = ${query.baseId}::uuid AND series_id = selected.id AND ts < ${window.since} AND ts >= ${window.rawFrom}
         ORDER BY ts DESC LIMIT 1)
        UNION ALL
        (SELECT series_id, ts, value FROM pulse.metric_samples
         WHERE base_id = ${query.baseId}::uuid AND series_id = selected.id AND ts >= ${window.since} AND ts < ${window.until})
      ) sample
    ), pairs AS (
      SELECT *, lag(value) OVER series AS previous_value, lag(ts) OVER series AS previous_ts
      FROM samples WINDOW series AS (PARTITION BY series_id ORDER BY ts)
    ), deltas AS (
      SELECT series_id, date_bin(${window.bucketInterval}::interval, ts, '1970-01-01'::timestamptz) AS bucket,
        CASE WHEN previous_ts < ts THEN
          CASE WHEN value >= previous_value THEN value - previous_value ELSE value END
        END AS delta,
        EXTRACT(epoch FROM ts - previous_ts)::double precision AS seconds
      FROM pairs WHERE ts >= ${window.since} AND ts < ${window.until}
    )
    SELECT series_id, bucket, ${valueSql} AS value FROM deltas
    GROUP BY series_id, bucket ORDER BY bucket, series_id LIMIT ${MAX_METRIC_POINTS}
  `;
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

const querySampleAggregateMetric = async (
  query: MetricQuery,
  window: MetricWindow,
  seriesIds: string[],
  db: typeof sql,
): Promise<MetricValueRow[]> => {
  const rows = await db<MetricValueRow[]>`
    SELECT series_id, date_bin(${window.bucketInterval}::interval, ts, '1970-01-01'::timestamptz) AS bucket,
      ${sampleAggregateSql(query.aggregation)} AS value
    FROM pulse.metric_samples
    WHERE base_id = ${query.baseId}::uuid
      AND series_id = ANY(${toPgUuidArray(seriesIds)}::uuid[])
      AND ts >= ${window.since} AND ts < ${window.until}
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

export const queryMetricData = async (query: MetricQuery, limits: { maxOutputPoints?: number } = {}): Promise<Result<MetricQueryPoint[]>> =>
  sql.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", async (tx) => {
    return queryMetricDataInSnapshot(query, limits, tx);
  });

const queryMetricDataInSnapshot = async (
  query: MetricQuery,
  limits: { maxOutputPoints?: number },
  db: typeof sql,
): Promise<Result<MetricQueryPoint[]>> => {
  const window = resolveMetricWindow(query);
  if (!window.ok) return window;

  const [policy] = await db<{ raw_from: Date; rollup_from: Date }[]>`
    SELECT date_bin('1 hour',now()-retention_days*interval '1 day','1970-01-01'::timestamptz) AS raw_from,
      date_bin('1 hour',now()-rollup_retention_days*interval '1 day','1970-01-01'::timestamptz) AS rollup_from
    FROM pulse.bases WHERE id=${query.baseId}::uuid`;
  if (!policy) return fail(err.notFound("Pulse base"));
  window.data.rawFrom = policy.raw_from;
  if (window.data.since.getTime() < policy.raw_from.getTime()) {
    if (!canUseHourlyRollup(query, window.data))
      return fail(err.badInput("This aggregation and bucket require a range within raw retention"));
    if (window.data.since.getTime() < policy.rollup_from.getTime())
      return fail(err.badInput("Query starts before retained metric history"));
    if (window.data.until.getTime() < policy.raw_from.getTime() && window.data.until.getTime() % 3_600_000 !== 0)
      return fail(err.badInput("Historical metric ranges must end on an exact UTC hour; partial hours require raw data"));
    if (window.data.since.getTime() % 3_600_000 !== 0)
      return fail(err.badInput("Historical metric ranges must start on an exact UTC hour; partial hours require raw data"));
  }

  const series = await resolveMetricSeries(query, db);
  if (series.length === 0) return ok([]);
  if (series.length > MAX_MATCHED_SERIES) {
    return fail(err.badInput("This query matches too many series. Add a source or dimension filter."));
  }
  if ((query.aggregation === "rate" || query.aggregation === "increase") && series.some((item) => item.type !== "counter")) {
    return fail(err.badInput("Rate and increase require a counter metric"));
  }
  if (["p50", "p90", "p95", "p99"].includes(query.aggregation) && series.some((item) => item.type !== "gauge")) {
    return fail(err.badInput("Sample percentiles require a gauge metric"));
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

  const rollupRows = await queryHourlyRollupRows(query, window.data, seriesIds, db);
  if (rollupRows) return boundedMetricPoints(query, rollupRows, series, maxOutputPoints);

  if (query.aggregation === "latest") {
    return boundedMetricPoints(query, await queryLatestMetric(query, window.data, seriesIds, db), series, maxOutputPoints);
  }
  if (query.aggregation === "rate" || query.aggregation === "increase") {
    return boundedMetricPoints(query, await queryCounterDeltaMetric(query, window.data, seriesIds, db), series, maxOutputPoints);
  }

  return boundedMetricPoints(query, await querySampleAggregateMetric(query, window.data, seriesIds, db), series, maxOutputPoints);
};

export const queryEventsData = async (query: EventQuery): Promise<Result<PulseRecordedEvent[]>> =>
  withEventQuerySnapshot(query, async (db, range) => {
    const since = range.from;
    const dimensions = normalizeDimensions(query.dimensions);
    const rows = await db<RecordedEventRow[]>`
    SELECT id, kind, ts, value, source_id, resource_key, resource_type, dimensions, attributes, payload, recorded_at
    FROM pulse.events
    WHERE base_id = ${query.baseId}::uuid
      AND (${query.event ?? null}::text IS NULL OR kind = ${query.event ?? null})
      AND (${query.sourceId ?? null}::uuid IS NULL OR source_id = ${query.sourceId ?? null}::uuid)
      AND (${query.resourceKey ?? null}::text IS NULL OR resource_key = ${query.resourceKey ?? null})
      AND (${query.resourceType ?? null}::text IS NULL OR resource_type = ${query.resourceType ?? null})
      AND dimensions @> (${jsonbObject(dimensions)}::jsonb #>> '{}')::jsonb
      AND ts >= ${since} AND ts < ${range.to}
    ORDER BY ts DESC, recorded_at DESC
    LIMIT ${query.limit}
  `;
    return ok(rows.map(mapRecordedEvent));
  });

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
      return sql`COUNT(DISTINCT (source_identity,actor_id)) FILTER (WHERE actor_id IS NOT NULL)::double precision`;
    case "unique_session":
      return sql`COUNT(DISTINCT (source_identity,session_id)) FILTER (WHERE session_id IS NOT NULL)::double precision`;
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
): Promise<Result<MetricQueryPoint[]>> =>
  withEventQuerySnapshot(query, async (db, range) => {
    const aggregation = query.aggregation ?? "rows";
    if (aggregation === "rows") return fail(err.badInput("Event aggregation is required"));
    const bucketCheck = validateEventBucket(query.bucket, query.timeZone);
    if (!bucketCheck.ok) return bucketCheck;
    if (!query.bucket) return fail(err.badInput("An event aggregate bucket is required"));
    const bucketInterval = durationToInterval(query.bucket);
    const bucketSql =
      query.bucket === "all"
        ? sql`${range.from}::timestamptz`
        : isCalendarBucket(query.bucket)
          ? sql`date_trunc(${query.bucket}::text,event.ts AT TIME ZONE ${query.timeZone}::text) AT TIME ZONE ${query.timeZone}::text`
          : sql`date_bin(${bucketInterval}::interval,event.ts,'1970-01-01'::timestamptz)`;
    const groupBy = query.groupBy ?? [];
    if (groupBy.length > 4) return fail(err.badInput("Group by cannot exceed 4 dimension keys"));

    const dimensions = jsonbObject(normalizeDimensions(query.dimensions));
    const since = range.from;
    const maxOutputPoints = Math.min(1_000, Math.max(1, limits.maxOutputPoints ?? 1_000));
    const rows = await db<EventAggregateRow[]>`
    WITH scoped AS (
      SELECT
        ${bucketSql} AS bucket,
        event.value,
        event.source_identity,
        event.actor_id,
        event.session_id,
        ${eventGroupExpression(groupBy)} AS group_data
      FROM pulse.events event
      WHERE event.base_id = ${query.baseId}::uuid
        AND (${query.event ?? null}::text IS NULL OR event.kind = ${query.event ?? null})
        AND (${query.sourceId ?? null}::uuid IS NULL OR event.source_id = ${query.sourceId ?? null}::uuid)
        AND (${query.resourceKey ?? null}::text IS NULL OR event.resource_key = ${query.resourceKey ?? null})
        AND (${query.resourceType ?? null}::text IS NULL OR event.resource_type = ${query.resourceType ?? null})
        AND event.dimensions @> (${dimensions}::jsonb #>> '{}')::jsonb
        AND event.ts >= ${since} AND event.ts < ${range.to}
    )
    SELECT ${query.bucket === "all" && groupBy.length === 0 ? sql`${range.from}::timestamptz AS bucket` : sql`bucket`},
      ${eventAggregateExpression(aggregation)} AS value,
      ${query.bucket === "all" && groupBy.length === 0 ? sql`'{}'::jsonb AS group_data` : sql`group_data`}
    FROM scoped
    ${query.bucket === "all" && groupBy.length === 0 ? sql`` : sql`GROUP BY bucket, group_data`}
    ${query.bucket === "all" && groupBy.length === 0 ? sql`ORDER BY bucket ASC` : sql`ORDER BY bucket ASC, group_data::text ASC`}
    LIMIT ${maxOutputPoints + 1}
  `;
    if (rows.length > maxOutputPoints) {
      return fail(err.badInput("This query creates too many aggregate points. Use a larger bucket, shorter range, or narrower filter."));
    }
    return ok(
      rows.map((row) => ({
        bucket: iso(row.bucket),
        value: row.value === null ? null : Number(row.value),
        group: normalizeDimensions(readJsonObject(row.group_data)),
      })),
    );
  });

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
    resourceKey: query.resourceKey ?? null,
    resourceType: query.resourceType ?? null,
    dimensionsJson: jsonbObject(dimensions),
    since: sinceMs ? new Date(Date.now() - sinceMs) : null,
    limit: query.limit,
  });
};

const queryCurrentStateRows = async (baseId: string, params: StateQueryParams): Promise<CurrentStateRow[]> =>
  sql<CurrentStateRow[]>`
    SELECT state_key, variant_key, value, source_id, resource_key, resource_type, dimensions, updated_at
    FROM pulse.states_current
    WHERE base_id = ${baseId}::uuid
      AND (${params.state}::text IS NULL OR state_key = ${params.state})
      AND (${params.sourceId}::uuid IS NULL OR source_id = ${params.sourceId}::uuid)
      AND (${params.resourceKey}::text IS NULL OR resource_key = ${params.resourceKey})
      AND (${params.resourceType}::text IS NULL OR resource_type = ${params.resourceType})
      AND dimensions @> (${params.dimensionsJson}::jsonb #>> '{}')::jsonb
      AND (${params.since}::timestamptz IS NULL OR updated_at >= ${params.since}::timestamptz)
    ORDER BY updated_at DESC, state_key ASC
    LIMIT ${params.limit}
  `;
