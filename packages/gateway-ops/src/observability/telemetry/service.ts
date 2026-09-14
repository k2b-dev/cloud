/**
 * Read layer for the telemetry admin page.
 *
 * Everything the overview renders comes from `gateway.telemetry_rollups_minute`,
 * never from raw events. The rollup table is written alongside every event and
 * retained far longer, so it answers "how did this look over 30 days" for the
 * cost of a small indexed scan, where the raw table means seq-scanning ~1M rows
 * per page load. Raw events are only read once a route is selected and the
 * question becomes "show me the individual requests".
 *
 * Ingest and retention live in `../../telemetry`; this module only reads.
 */
import { sql } from "bun";
import { SLOW_REQUEST_MS } from "../../telemetry";
import { TELEMETRY_RANGES, type TelemetryRange, type TelemetryRouteScope, type TelemetryRouteSort } from "./contracts";

/** Routes listed in the ranking table before the tail is cut off. */
const RANKING_LIMIT = 100;

/**
 * Below this, an error *rate* is noise — one failed request out of two is
 * 50% and would otherwise outrank a route failing 900 times. Rate-based
 * ordering demotes such routes; they stay listed with their real numbers.
 */
const MIN_REQUESTS_FOR_RATE_RANK = 20;

export type TelemetryOverview = {
  requests: number;
  serverErrors: number;
  clientErrors: number;
  rateLimited: number;
  slowRequests: number;
  avgDurationMs: number | null;
  maxDurationMs: number | null;
};

export type TelemetryTimeseriesPoint = {
  at: string;
  requests: number;
  errors: number;
  serverErrors: number;
  avgDurationMs: number | null;
  maxDurationMs: number | null;
};

export type TelemetryRouteRow = {
  appId: string;
  route: string;
  requests: number;
  errors: number;
  slowRequests: number;
  avgDurationMs: number | null;
  maxDurationMs: number | null;
};

export type TelemetryEventRow = {
  id: number;
  appId: string;
  routePrefix: string;
  route: string;
  method: string;
  status: number;
  durationMs: number;
  errorKind: string | null;
  occurredAt: string;
};

export type TelemetryQuery = {
  range: TelemetryRange;
  appId?: string;
  route?: string;
};

/**
 * Rows written before route templates existed carry NULL / '' and would
 * otherwise vanish from a grouped view. Falling back to the route prefix
 * keeps history readable — coarser, but never blank.
 */
const ROUTE_EXPR = sql`COALESCE(NULLIF(path_template, ''), route_prefix)`;

const rangeFilter = (range: TelemetryRange) => sql`bucket >= now() - (${TELEMETRY_RANGES[range].hours}::int * INTERVAL '1 hour')`;

const scopeFilter = (query: TelemetryQuery) => {
  const appId = query.appId?.trim() || null;
  const route = query.route?.trim() || null;
  return sql`
    (${appId}::text IS NULL OR app_id = ${appId})
    AND (${route}::text IS NULL OR ${ROUTE_EXPR} = ${route})
  `;
};

export const getTelemetryOverview = async (query: TelemetryQuery): Promise<TelemetryOverview> => {
  const [row] = await sql<
    {
      requests: number;
      server_errors: number;
      client_errors: number;
      rate_limited: number;
      slow_requests: number;
      avg_duration_ms: number | null;
      max_duration_ms: number | null;
    }[]
  >`
    SELECT
      COALESCE(SUM(request_count), 0)::int AS requests,
      COALESCE(SUM(request_count) FILTER (WHERE status_code >= 500), 0)::int AS server_errors,
      COALESCE(SUM(request_count) FILTER (WHERE status_code >= 400 AND status_code < 500 AND status_code <> 429), 0)::int AS client_errors,
      COALESCE(SUM(request_count) FILTER (WHERE status_code = 429), 0)::int AS rate_limited,
      COALESCE(SUM(slow_count), 0)::int AS slow_requests,
      (SUM(total_duration_ms)::float / NULLIF(SUM(request_count), 0)) AS avg_duration_ms,
      MAX(max_duration_ms)::float AS max_duration_ms
    FROM gateway.telemetry_rollups_minute
    WHERE ${rangeFilter(query.range)} AND ${scopeFilter(query)}
  `;
  return {
    requests: row?.requests ?? 0,
    serverErrors: row?.server_errors ?? 0,
    clientErrors: row?.client_errors ?? 0,
    rateLimited: row?.rate_limited ?? 0,
    slowRequests: row?.slow_requests ?? 0,
    avgDurationMs: row?.avg_duration_ms ?? null,
    maxDurationMs: row?.max_duration_ms ?? null,
  };
};

/**
 * Buckets minute rollups up to the range's resolution. Empty buckets are not
 * returned — a gap in traffic is a gap in the series, not a zero.
 */
const bucketedSeries = (range: TelemetryRange) => {
  const seconds = TELEMETRY_RANGES[range].bucketSeconds;
  return sql`to_timestamp(floor(extract(epoch FROM bucket) / ${seconds}) * ${seconds})`;
};

export const getTelemetryTimeseries = async (query: TelemetryQuery): Promise<TelemetryTimeseriesPoint[]> => {
  const rows = await sql<
    {
      at: string;
      requests: number;
      errors: number;
      server_errors: number;
      avg_duration_ms: number | null;
      max_duration_ms: number | null;
    }[]
  >`
    SELECT
      ${bucketedSeries(query.range)}::text AS at,
      COALESCE(SUM(request_count), 0)::int AS requests,
      COALESCE(SUM(request_count) FILTER (WHERE status_code >= 400), 0)::int AS errors,
      COALESCE(SUM(request_count) FILTER (WHERE status_code >= 500), 0)::int AS server_errors,
      SUM(total_duration_ms)::float / NULLIF(SUM(request_count), 0) AS avg_duration_ms,
      MAX(max_duration_ms)::float AS max_duration_ms
    FROM gateway.telemetry_rollups_minute
    WHERE ${rangeFilter(query.range)} AND ${scopeFilter(query)}
    GROUP BY 1
    ORDER BY 1 ASC
  `;
  return rows.map((row) => ({
    at: row.at,
    requests: row.requests,
    errors: row.errors,
    serverErrors: row.server_errors,
    avgDurationMs: row.avg_duration_ms,
    maxDurationMs: row.max_duration_ms,
  }));
};

/**
 * Postgres only accepts output aliases as a bare ORDER BY term, never inside an
 * expression, so the aggregates are repeated here rather than reusing the
 * SELECT aliases.
 */
const routeOrdering = (sort: TelemetryRouteSort) => {
  switch (sort) {
    case "errors":
      return sql`SUM(error_count) DESC, SUM(request_count) DESC`;
    case "requests":
      return sql`SUM(request_count) DESC`;
    case "slow":
      return sql`SUM(slow_count) DESC, SUM(request_count) DESC`;
    case "duration":
      return sql`MAX(max_duration_ms) DESC NULLS LAST, (SUM(total_duration_ms)::float / NULLIF(SUM(request_count), 0)) DESC NULLS LAST`;
    default:
      return sql`
        CASE WHEN SUM(request_count) >= ${MIN_REQUESTS_FOR_RATE_RANK}
          THEN SUM(error_count)::float / NULLIF(SUM(request_count), 0)
          ELSE 0
        END DESC,
        SUM(error_count) DESC,
        SUM(request_count) DESC
      `;
  }
};

/**
 * Filters the aggregate, not the raw rows: "only failing routes" means the
 * route failed at all in this window, not that a bucket contained a failure.
 */
const routeHaving = (scope: TelemetryRouteScope) => sql`
  (${scope.errorsOnly}::boolean IS FALSE OR SUM(error_count) > 0)
  AND (${scope.slowOnly}::boolean IS FALSE OR SUM(slow_count) > 0)
`;

export const listTelemetryRoutes = async (
  query: TelemetryQuery,
  sort: TelemetryRouteSort,
  scope: TelemetryRouteScope = { errorsOnly: false, slowOnly: false },
): Promise<TelemetryRouteRow[]> => {
  const rows = await sql<
    {
      app_id: string;
      route: string;
      requests: number;
      errors: number;
      slow_requests: number;
      avg_duration_ms: number | null;
      max_duration_ms: number | null;
    }[]
  >`
    SELECT
      app_id,
      ${ROUTE_EXPR} AS route,
      COALESCE(SUM(request_count), 0)::int AS requests,
      COALESCE(SUM(error_count), 0)::int AS errors,
      COALESCE(SUM(slow_count), 0)::int AS slow_requests,
      (SUM(total_duration_ms)::float / NULLIF(SUM(request_count), 0)) AS avg_duration_ms,
      MAX(max_duration_ms)::float AS max_duration_ms
    FROM gateway.telemetry_rollups_minute
    WHERE ${rangeFilter(query.range)} AND ${scopeFilter(query)}
    GROUP BY app_id, ${ROUTE_EXPR}
    HAVING ${routeHaving(scope)}
    ORDER BY ${routeOrdering(sort)}
    LIMIT ${RANKING_LIMIT}
  `;
  return rows.map((row) => ({
    appId: row.app_id,
    route: row.route,
    requests: row.requests,
    errors: row.errors,
    slowRequests: row.slow_requests,
    avgDurationMs: row.avg_duration_ms,
    maxDurationMs: row.max_duration_ms,
  }));
};

export const listTelemetryApps = async (range: TelemetryRange): Promise<string[]> => {
  const rows = await sql<{ app_id: string }[]>`
    SELECT DISTINCT app_id
    FROM gateway.telemetry_rollups_minute
    WHERE ${rangeFilter(range)}
    ORDER BY app_id ASC
  `;
  return rows.map((row) => row.app_id);
};

/**
 * Individual requests for the selected route — the drilldown, and the only
 * query here that touches raw events. Always scoped by range, and capped:
 * this answers "show me examples", not "let me page through a million rows".
 */
export const listTelemetryEvents = async (query: TelemetryQuery, limit: number): Promise<TelemetryEventRow[]> => {
  const appId = query.appId?.trim() || null;
  const route = query.route?.trim() || null;
  const rows = await sql<
    {
      id: number;
      app_id: string;
      route_prefix: string;
      route: string;
      method: string;
      status_code: number;
      duration_ms: number;
      error_kind: string | null;
      occurred_at: string;
    }[]
  >`
    SELECT
      id, app_id, route_prefix, ${ROUTE_EXPR} AS route,
      method, status_code, duration_ms, error_kind, occurred_at::text
    FROM gateway.telemetry_events
    WHERE occurred_at >= now() - (${TELEMETRY_RANGES[query.range].hours}::int * INTERVAL '1 hour')
      AND (${appId}::text IS NULL OR app_id = ${appId})
      AND (${route}::text IS NULL OR ${ROUTE_EXPR} = ${route})
    ORDER BY occurred_at DESC
    LIMIT ${Math.max(1, Math.min(500, Math.floor(limit)))}
  `;
  return rows.map((row) => ({
    id: Number(row.id),
    appId: row.app_id,
    routePrefix: row.route_prefix,
    route: row.route,
    method: row.method,
    status: row.status_code,
    durationMs: row.duration_ms,
    errorKind: row.error_kind,
    occurredAt: row.occurred_at,
  }));
};

export {
  DEFAULT_TELEMETRY_RANGE,
  DEFAULT_TELEMETRY_ROUTE_SORT,
  isTelemetryRange,
  isTelemetryRouteSort,
  TELEMETRY_RANGES,
  TELEMETRY_ROUTE_SORTS,
  TELEMETRY_SORT_LABELS,
  type TelemetryRange,
  type TelemetryRouteScope,
  type TelemetryRouteSort,
} from "./contracts";
export { SLOW_REQUEST_MS };

export type TelemetryTotals = {
  requests: number;
  errors: number;
  slowRequests: number;
  avgDurationMs: number | null;
};

const emptyTotals = (): TelemetryTotals => ({ requests: 0, errors: 0, slowRequests: 0, avgDurationMs: null });

/**
 * Per-app and per-prefix traffic for a window.
 *
 * The gateway overview used to read the router's in-memory counters, which are
 * cumulative since the router process started. A router up for two weeks
 * reports a healthy lifetime average while it is failing every request right
 * now, so those numbers are replaced with windowed rollups.
 */
const totalsBy = async (column: "app_id" | "route_prefix", range: TelemetryRange): Promise<Map<string, TelemetryTotals>> => {
  const groupBy = column === "app_id" ? sql`app_id` : sql`route_prefix`;
  const rows = await sql<{ key: string; requests: number; errors: number; slow_requests: number; avg_duration_ms: number | null }[]>`
    SELECT
      ${groupBy}::text AS key,
      COALESCE(SUM(request_count), 0)::int AS requests,
      COALESCE(SUM(error_count), 0)::int AS errors,
      COALESCE(SUM(slow_count), 0)::int AS slow_requests,
      (SUM(total_duration_ms)::float / NULLIF(SUM(request_count), 0)) AS avg_duration_ms
    FROM gateway.telemetry_rollups_minute
    WHERE ${rangeFilter(range)}
    GROUP BY ${groupBy}
  `;
  return new Map(
    rows.map((row) => [
      row.key,
      { requests: row.requests, errors: row.errors, slowRequests: row.slow_requests, avgDurationMs: row.avg_duration_ms },
    ]),
  );
};

export const getTelemetryAppTotals = (range: TelemetryRange): Promise<Map<string, TelemetryTotals>> => totalsBy("app_id", range);

export const getTelemetryPrefixTotals = (range: TelemetryRange): Promise<Map<string, TelemetryTotals>> => totalsBy("route_prefix", range);

export const telemetryTotalsOrEmpty = (totals: Map<string, TelemetryTotals>, key: string): TelemetryTotals =>
  totals.get(key) ?? emptyTotals();
