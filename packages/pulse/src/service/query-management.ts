import { err, fail, ok, type Result } from "@k2b/cloud/server";
import type {
  MetricQuery,
  MetricQueryPoint,
  PulseCurrentState,
  PulseExplorerQuery,
  PulseMapFieldSelector,
  PulseMapSeries,
  PulseQueryCompileResult,
  PulseRecordedEvent,
} from "../contracts";
import { compilePulseQueryText } from "../query-dsl";
import { type AccessScope, requireBaseAccess } from "./access-control";
import { queryEventMapData } from "./event-map-query";
import { resolveBasePublicId, resolveBasePublicIds } from "./public-resources";
import { queryEventAggregateData, queryEventsData, queryMetricData, queryStatesData } from "./query-execution";

type MetricExplorerQuery = Extract<PulseExplorerQuery, { kind: "metric" }>;
type EventsExplorerQuery = Extract<PulseExplorerQuery, { kind: "events" }>;
type StatesExplorerQuery = Extract<PulseExplorerQuery, { kind: "states" }>;
export type ExplorerQueryResult = {
  compiled: PulseExplorerQuery;
  points: MetricQueryPoint[];
  events: PulseRecordedEvent[];
  states: PulseCurrentState[];
};

export type DashboardTextQuery =
  | { kind: "query"; query: string }
  | {
      kind: "map";
      query: string;
      latitude: PulseMapFieldSelector;
      longitude: PulseMapFieldSelector;
      label?: PulseMapFieldSelector;
      series?: PulseMapFieldSelector;
      size: "count" | "sum";
    };

export type DashboardTextQueryResult = { kind: "query"; data: ExplorerQueryResult } | { kind: "map"; data: PulseMapSeries[] };

type PulseQueryExecutionLimits = {
  maxMetricPoints?: number;
  maxAggregatePoints?: number;
  maxRows?: number;
};

const resolveQuerySource = async <T extends PulseExplorerQuery>(query: T): Promise<Result<T>> => {
  if (!query.sourceId) return ok(query);
  const sourceId = await resolveBasePublicId("sources", query.baseId, query.sourceId);
  return sourceId ? ok({ ...query, sourceId } as T) : fail(err.notFound("Source"));
};

export const queryMetric = async (
  query: MetricQuery,
  user: AccessScope,
  limits: { maxOutputPoints?: number } = {},
): Promise<Result<MetricQueryPoint[]>> => {
  const access = await requireBaseAccess(query.baseId, user, "read");
  if (!access.ok) return fail(access.error);
  return queryMetricData(query, limits);
};

const runMetricExplorerQuery = async (
  query: MetricExplorerQuery,
  limits: PulseQueryExecutionLimits,
): Promise<Result<ExplorerQueryResult>> => {
  const points = await queryMetricData(query, { maxOutputPoints: limits.maxMetricPoints });
  if (!points.ok) return fail(points.error);
  return ok({ compiled: query, points: points.data, events: [], states: [] });
};

const runEventsExplorerQuery = async (
  query: EventsExplorerQuery,
  limits: PulseQueryExecutionLimits,
): Promise<Result<ExplorerQueryResult>> => {
  const boundedQuery = { ...query, limit: Math.min(query.limit, limits.maxRows ?? query.limit) };
  if ((query.aggregation ?? "rows") !== "rows") {
    const points = await queryEventAggregateData(boundedQuery, { maxOutputPoints: limits.maxAggregatePoints });
    if (!points.ok) return fail(points.error);
    return ok({ compiled: query, points: points.data, events: [], states: [] });
  }
  const events = await queryEventsData(boundedQuery);
  if (!events.ok) return fail(events.error);
  return ok({ compiled: query, points: [], events: events.data, states: [] });
};

const runStatesExplorerQuery = async (
  query: StatesExplorerQuery,
  limits: PulseQueryExecutionLimits,
): Promise<Result<ExplorerQueryResult>> => {
  const boundedQuery = { ...query, limit: Math.min(query.limit, limits.maxRows ?? query.limit) };
  const states = await queryStatesData(boundedQuery);
  if (!states.ok) return fail(states.error);
  return ok({ compiled: query, points: [], events: [], states: states.data });
};

export const queryMetricText = async (
  params: {
    baseId: string;
    query: string;
    user: AccessScope;
  },
  limits: PulseQueryExecutionLimits = {},
): Promise<Result<ExplorerQueryResult>> => {
  const compiled = compilePulseQueryText(params.baseId, params.query);
  if (!compiled.ok) return fail(compiled.error);

  return executeCompiledQuery(compiled.data, params.user, limits);
};

const executeResolvedQuery = async (
  query: PulseExplorerQuery,
  limits: PulseQueryExecutionLimits = {},
): Promise<Result<ExplorerQueryResult>> => {
  switch (query.kind) {
    case "metric":
      return runMetricExplorerQuery(query, limits);
    case "events":
      return runEventsExplorerQuery(query, limits);
    case "states":
      return runStatesExplorerQuery(query, limits);
  }
};

export const executeCompiledQuery = async (
  query: PulseExplorerQuery,
  user: AccessScope,
  limits: PulseQueryExecutionLimits = {},
): Promise<Result<ExplorerQueryResult>> => {
  const access = await requireBaseAccess(query.baseId, user, "read");
  if (!access.ok) return fail(access.error);
  const internal = await resolveQuerySource(query);
  if (!internal.ok) return fail(internal.error);
  const result = await executeResolvedQuery(internal.data, limits);
  return result.ok ? ok({ ...result.data, compiled: query }) : result;
};

type PreparedDashboardTextQuery = {
  request: DashboardTextQuery;
  publicQuery: PulseExplorerQuery;
  internalQuery: PulseExplorerQuery;
};

export const prepareDashboardTextQueries = async (
  baseId: string,
  requests: DashboardTextQuery[],
  resolveSources = resolveBasePublicIds,
): Promise<Result<PreparedDashboardTextQuery>[]> => {
  const compiled = requests.map((request) => compilePulseQueryText(baseId, request.query));
  const sourceIds = [...new Set(compiled.flatMap((result) => (result.ok && result.data.sourceId ? [result.data.sourceId] : [])))];
  const sources = await resolveSources("sources", baseId, sourceIds);
  return requests.map((request, index) => {
    const query = compiled[index]!;
    if (!query.ok) return fail(query.error);
    const sourceId = query.data.sourceId ? sources?.get(query.data.sourceId) : null;
    if (query.data.sourceId && !sourceId) return fail(err.notFound("Source"));
    return ok({
      request,
      publicQuery: query.data,
      internalQuery: sourceId ? ({ ...query.data, sourceId } as PulseExplorerQuery) : query.data,
    });
  });
};

export const executeDashboardTextQueries = async (params: {
  baseId: string;
  requests: DashboardTextQuery[];
  user: AccessScope;
}): Promise<Result<DashboardTextQueryResult>[]> => {
  const access = await requireBaseAccess(params.baseId, params.user, "read");
  if (!access.ok) return params.requests.map(() => fail(access.error));
  const prepared = await prepareDashboardTextQueries(params.baseId, params.requests);

  return Promise.all(
    prepared.map(async (item): Promise<Result<DashboardTextQueryResult>> => {
      if (!item.ok) return item;
      const { request, publicQuery, internalQuery } = item.data;
      if (request.kind === "map") {
        if (internalQuery.kind !== "events" || (internalQuery.aggregation ?? "rows") !== "rows") {
          return fail(err.badInput("Map widgets require an event rows query"));
        }
        const result = await queryEventMapData({
          query: internalQuery,
          latitude: request.latitude,
          longitude: request.longitude,
          label: request.label,
          series: request.series,
          size: request.size,
        });
        return result.ok ? ok({ kind: "map", data: result.data }) : result;
      }
      const result = await executeResolvedQuery(internalQuery);
      return result.ok ? ok({ kind: "query", data: { ...result.data, compiled: publicQuery } }) : result;
    }),
  );
};

export const queryEventMapText = async (params: {
  baseId: string;
  query: string;
  latitude: PulseMapFieldSelector;
  longitude: PulseMapFieldSelector;
  label?: PulseMapFieldSelector;
  series?: PulseMapFieldSelector;
  size: "count" | "sum";
  user: AccessScope;
}): Promise<Result<PulseMapSeries[]>> => {
  const access = await requireBaseAccess(params.baseId, params.user, "read");
  if (!access.ok) return fail(access.error);
  const compiled = compilePulseQueryText(params.baseId, params.query);
  if (!compiled.ok) return fail(compiled.error);
  if (compiled.data.kind !== "events" || (compiled.data.aggregation ?? "rows") !== "rows") {
    return fail(err.badInput("Map widgets require an event rows query"));
  }
  const internal = await resolveQuerySource(compiled.data);
  if (!internal.ok) return fail(internal.error);
  return queryEventMapData({
    query: internal.data,
    latitude: params.latitude,
    longitude: params.longitude,
    label: params.label,
    series: params.series,
    size: params.size,
  });
};

export const compileQueryText = async (params: {
  baseId: string;
  query: string;
  user: AccessScope;
}): Promise<Result<PulseQueryCompileResult>> => {
  const access = await requireBaseAccess(params.baseId, params.user, "read");
  if (!access.ok) return fail(access.error);
  const compiled = compilePulseQueryText(params.baseId, params.query);
  if (!compiled.ok) {
    return ok({
      ok: false,
      diagnostics: [{ severity: "error", message: compiled.error.message }],
      compiled: null,
    });
  }
  const internal = await resolveQuerySource(compiled.data);
  if (!internal.ok) {
    return ok({ ok: false, diagnostics: [{ severity: "error", message: internal.error.message }], compiled: null });
  }
  return ok({
    ok: true,
    diagnostics: [{ severity: "info", message: "Query is valid." }],
    compiled: compiled.data,
  });
};
