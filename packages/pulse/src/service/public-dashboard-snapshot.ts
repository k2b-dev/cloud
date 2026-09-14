import { err, fail, isServiceError, ok, type Result } from "@k2b/cloud/server";
import { toPgTextArray } from "@k2b/cloud/services";
import { sql } from "bun";
import type {
  DashboardRefreshInterval,
  EventQuery,
  MetricQuery,
  MetricQueryPoint,
  PulseCurrentState,
  PulseDashboard,
  PulseDashboardEventsWidget,
  PulseDashboardLayout,
  PulseDashboardMapWidget,
  PulseDashboardMetricWidget,
  PulseDashboardRow,
  PulseDashboardSection,
  PulseDashboardSnapshot,
  PulseDashboardStatesWidget,
  PulseDashboardWidget,
  PulseMapSeries,
  PulsePublicCurrentState,
  PulsePublicDashboard,
  PulsePublicDashboardCardWidget,
  PulsePublicDashboardEventsWidget,
  PulsePublicDashboardLayout,
  PulsePublicDashboardMapWidget,
  PulsePublicDashboardMetricWidget,
  PulsePublicDashboardRow,
  PulsePublicDashboardSection,
  PulsePublicDashboardStatesWidget,
  PulsePublicDashboardWidget,
  PulsePublicRecordedEvent,
  PulseRecordedEvent,
  StateQuery,
} from "../contracts";
import { type AccessScope, requireBaseAccess } from "./access-control";
import {
  dashboardEventsWidgets,
  dashboardMapWidgets,
  dashboardMetricWidgets,
  dashboardStatesWidgets,
  readDashboardConfig,
} from "./dashboard-config";
import type { EventMapQuery } from "./event-map-query";
import { publicDashboardTokenHash } from "./public-dashboard-tokens";
import { resolveExistingBasePublicIds } from "./public-resources";
import { iso } from "./telemetry-values";

export const internalDashboardSourceId = (
  sources: ReadonlyMap<string, string>,
  sourceId: string | null | undefined,
): string | null | undefined => {
  if (!sourceId) return sourceId;
  const id = sources.get(sourceId);
  if (!id) throw err.badInput("Dashboard references an unavailable source");
  return id;
};

type DashboardRow = {
  id: string;
  base_id: string;
  name: string;
  config: unknown;
  public_enabled: boolean;
  created_at: Date | string;
  updated_at: Date | string;
};

type PublicDashboardSnapshotDeps = {
  queryMetricData: (query: MetricQuery) => Promise<Result<MetricQueryPoint[]>>;
  queryEventAggregateData: (query: EventQuery) => Promise<Result<MetricQueryPoint[]>>;
  queryEventsData: (query: EventQuery) => Promise<Result<PulseRecordedEvent[]>>;
  queryStatesData: (query: StateQuery) => Promise<Result<PulseCurrentState[]>>;
  queryEventMapData: (query: EventMapQuery) => Promise<Result<PulseMapSeries[]>>;
};

type PublicWidgetResults = {
  points: Record<string, MetricQueryPoint[]>;
  events: Record<string, PulsePublicRecordedEvent[]>;
  states: Record<string, PulsePublicCurrentState[]>;
  maps: Record<string, PulseMapSeries[]>;
  metricUnitByName: Map<string, string | null>;
};

const mapDashboard = (row: DashboardRow): PulseDashboard => ({
  id: row.id,
  baseId: row.base_id,
  name: row.name,
  config: readDashboardConfig(row.base_id, row.config),
  publicEnabled: row.public_enabled,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

const getPublicDashboardByToken = async (token: string): Promise<Result<PulseDashboard>> => {
  const [row] = await sql<DashboardRow[]>`
    SELECT d.id, d.base_id, d.name, d.config, d.public_enabled, d.created_at, d.updated_at
    FROM pulse.dashboards d
    JOIN pulse.bases b ON b.id = d.base_id
    WHERE d.public_enabled = TRUE
      AND b.deletion_started_at IS NULL
      AND d.public_token_hash = ${publicDashboardTokenHash(token)}
  `;
  return row ? ok(mapDashboard(row)) : fail(err.notFound("Pulse dashboard"));
};

const getDashboardById = async (dashboardId: string, user: AccessScope): Promise<Result<PulseDashboard>> => {
  const [row] = await sql<DashboardRow[]>`
    SELECT d.id, d.base_id, d.name, d.config, d.public_enabled, d.created_at, d.updated_at
    FROM pulse.dashboards d
    JOIN pulse.bases b ON b.id = d.base_id
    WHERE d.id = ${dashboardId}::uuid
      AND b.deletion_started_at IS NULL
  `;
  if (!row) return fail(err.notFound("Pulse dashboard"));
  const access = await requireBaseAccess(row.base_id, user, "read");
  if (!access.ok) return fail(access.error);
  return ok(mapDashboard(row));
};

const publicMetricWidget = (
  widget: PulseDashboardMetricWidget,
  metricUnitByName: Map<string, string | null>,
): PulsePublicDashboardMetricWidget => ({
  id: widget.id,
  kind: "metric",
  title: widget.title,
  metric: widget.query.kind === "metric" ? widget.query.metric : (widget.query.event ?? "events"),
  unit: metricUnitByName.get(widget.query.kind === "metric" ? widget.query.metric : "") ?? null,
  visual: widget.visual,
  aggregation: widget.query.aggregation ?? "count",
  bucket: widget.query.bucket ?? "1h",
  timeZone: widget.query.kind === "events" ? widget.query.timeZone : undefined,
  since: widget.query.since,
  from: widget.query.from,
  to: widget.query.to,
  description: widget.description,
  conditions: widget.conditions,
  span: widget.span,
});

const publicEventsWidget = (widget: PulseDashboardEventsWidget): PulsePublicDashboardEventsWidget => ({
  id: widget.id,
  kind: "events",
  title: widget.title,
  visual: widget.visual,
  description: widget.description,
  conditions: widget.conditions,
  span: widget.span,
});

const publicStatesWidget = (widget: PulseDashboardStatesWidget): PulsePublicDashboardStatesWidget => ({
  id: widget.id,
  kind: "states",
  title: widget.title,
  visual: widget.visual,
  description: widget.description,
  conditions: widget.conditions,
  span: widget.span,
});

const publicMapWidget = (widget: PulseDashboardMapWidget): PulsePublicDashboardMapWidget => ({
  id: widget.id,
  kind: "map",
  title: widget.title,
  description: widget.description,
  span: widget.span,
});

const publicDashboardWidget = (widget: PulseDashboardWidget, metricUnitByName: Map<string, string | null>): PulsePublicDashboardWidget => {
  if (widget.kind === "metric") return publicMetricWidget(widget, metricUnitByName);
  if (widget.kind === "events") return publicEventsWidget(widget);
  if (widget.kind === "states") return publicStatesWidget(widget);
  if (widget.kind === "map") return publicMapWidget(widget);
  if (widget.kind === "markdown") return widget;
  const card: PulsePublicDashboardCardWidget = {
    id: widget.id,
    kind: "card",
    title: widget.title,
    description: widget.description,
    span: widget.span,
    rows: widget.rows.map((row) => publicDashboardRow(row, metricUnitByName)),
  };
  return card;
};

const publicDashboardRow = (row: PulseDashboardRow, metricUnitByName: Map<string, string | null>): PulsePublicDashboardRow => ({
  id: row.id,
  kind: "row",
  height: row.height,
  cells: row.cells.map((cell) => publicDashboardWidget(cell, metricUnitByName)),
});

const publicDashboardSection = (
  section: PulseDashboardSection,
  metricUnitByName: Map<string, string | null>,
): PulsePublicDashboardSection => ({
  id: section.id,
  kind: "section",
  title: section.title,
  description: section.description,
  rows: section.rows.map((row) => publicDashboardRow(row, metricUnitByName)),
  sections: section.sections?.map((child) => publicDashboardSection(child, metricUnitByName)),
});

const publicDashboardLayout = (
  layout: PulseDashboardLayout | null,
  metricUnitByName: Map<string, string | null>,
): PulsePublicDashboardLayout | null =>
  layout
    ? {
        version: 1,
        description: layout.description,
        sections: layout.sections.map((section) => publicDashboardSection(section, metricUnitByName)),
      }
    : null;

const publicDashboardMetricUnits = async (baseId: string, widgets: PulseDashboardMetricWidget[]): Promise<Map<string, string | null>> => {
  const names = [...new Set(widgets.flatMap((widget) => (widget.query.kind === "metric" ? [widget.query.metric] : [])))];
  if (!names.length) return new Map();
  const rows = await sql<{ name: string; unit: string | null }[]>`
    SELECT name, unit
    FROM pulse.metric_defs
    WHERE base_id = ${baseId}::uuid
      AND name = ANY(${toPgTextArray(names)}::text[])
  `;
  return new Map(rows.map((row) => [row.name, row.unit]));
};

const publicRecordedEvent = (event: PulseRecordedEvent): PulsePublicRecordedEvent => ({
  id: event.id,
  kind: event.kind,
  ts: event.ts,
  value: event.value,
  resourceKey: event.resourceKey,
  resourceType: event.resourceType,
});

const publicCurrentState = (state: PulseCurrentState): PulsePublicCurrentState => ({
  variantKey: state.variantKey,
  key: state.key,
  value: state.value,
  resourceKey: state.resourceKey,
  resourceType: state.resourceType,
  updatedAt: state.updatedAt,
});

const publicRefreshInterval = (value: DashboardRefreshInterval | null | undefined): DashboardRefreshInterval | null | undefined =>
  value === 1 ? 5 : value;

const metricWidgetQuery = (baseId: string, widget: PulseDashboardMetricWidget): MetricQuery | EventQuery => ({ ...widget.query, baseId });

const runPublicMetricWidgets = async (
  baseId: string,
  widgets: PulseDashboardMetricWidget[],
  deps: PublicDashboardSnapshotDeps,
): Promise<Record<string, MetricQueryPoint[]>> => {
  const points: Record<string, MetricQueryPoint[]> = {};
  for (const widget of widgets) {
    const query = metricWidgetQuery(baseId, widget);
    const result = query.kind === "events" ? await deps.queryEventAggregateData(query) : await deps.queryMetricData(query);
    if (!result.ok) throw result.error;
    points[widget.id] = result.data;
  }
  return points;
};

const runPublicEventsWidgets = async (
  baseId: string,
  widgets: PulseDashboardEventsWidget[],
  deps: PublicDashboardSnapshotDeps,
): Promise<Record<string, PulsePublicRecordedEvent[]>> => {
  const events: Record<string, PulsePublicRecordedEvent[]> = {};
  for (const widget of widgets) {
    const result = await deps.queryEventsData({ baseId, ...widget.query });
    if (!result.ok) throw result.error;
    events[widget.id] = result.data.map(publicRecordedEvent);
  }
  return events;
};

const runPublicStatesWidgets = async (
  baseId: string,
  widgets: PulseDashboardStatesWidget[],
  deps: PublicDashboardSnapshotDeps,
): Promise<Record<string, PulsePublicCurrentState[]>> => {
  const states: Record<string, PulsePublicCurrentState[]> = {};
  for (const widget of widgets) {
    const result = await deps.queryStatesData({ baseId, ...widget.query });
    if (!result.ok) throw result.error;
    states[widget.id] = result.data.map(publicCurrentState);
  }
  return states;
};

const runPublicMapWidgets = async (
  baseId: string,
  widgets: PulseDashboardMapWidget[],
  deps: PublicDashboardSnapshotDeps,
): Promise<Record<string, PulseMapSeries[]>> => {
  const maps: Record<string, PulseMapSeries[]> = {};
  for (const widget of widgets) {
    const result = await deps.queryEventMapData({
      query: { baseId, ...widget.query },
      latitude: widget.latitude,
      longitude: widget.longitude,
      label: widget.label,
      series: widget.series,
      size: widget.size,
    });
    if (!result.ok) throw result.error;
    maps[widget.id] = result.data;
  }
  return maps;
};

const collectPublicWidgetResults = async (dashboard: PulseDashboard, deps: PublicDashboardSnapshotDeps): Promise<PublicWidgetResults> => {
  const config = dashboard.config;
  const metricWidgets = dashboardMetricWidgets(config);
  const metricUnitByName = await publicDashboardMetricUnits(dashboard.baseId, metricWidgets);
  const metrics = metricWidgets;
  const eventWidgets = dashboardEventsWidgets(config);
  const stateWidgets = dashboardStatesWidgets(config);
  const mapWidgets = dashboardMapWidgets(config);
  const sourceSelectors = [
    ...metrics.map((widget) => metricWidgetQuery(dashboard.baseId, widget).sourceId),
    ...eventWidgets.map((widget) => widget.query.sourceId),
    ...stateWidgets.map((widget) => widget.query.sourceId),
    ...mapWidgets.map((widget) => widget.query.sourceId),
  ].filter((value): value is string => Boolean(value));
  const sources = await resolveExistingBasePublicIds("sources", dashboard.baseId, sourceSelectors);
  const internalMetrics = metrics.map((widget) => ({
    ...widget,
    query: { ...widget.query, sourceId: internalDashboardSourceId(sources, widget.query.sourceId) },
  }));
  const internalEvents = eventWidgets.map((widget) => ({
    ...widget,
    query: { ...widget.query, sourceId: internalDashboardSourceId(sources, widget.query.sourceId) },
  }));
  const internalStates = stateWidgets.map((widget) => ({
    ...widget,
    query: { ...widget.query, sourceId: internalDashboardSourceId(sources, widget.query.sourceId) },
  }));
  const internalMaps = mapWidgets.map((widget) => ({
    ...widget,
    query: { ...widget.query, sourceId: internalDashboardSourceId(sources, widget.query.sourceId) },
  }));

  const [points, events, states, maps] = await Promise.all([
    runPublicMetricWidgets(dashboard.baseId, internalMetrics, deps),
    runPublicEventsWidgets(dashboard.baseId, internalEvents, deps),
    runPublicStatesWidgets(dashboard.baseId, internalStates, deps),
    runPublicMapWidgets(dashboard.baseId, internalMaps, deps),
  ]);
  return { points, events, states, maps, metricUnitByName };
};

const publicDashboardFromConfig = (dashboard: PulseDashboard, metricUnitByName: Map<string, string | null>): PulsePublicDashboard => {
  const config = dashboard.config;
  return {
    id: dashboard.id,
    name: dashboard.name,
    config: {
      refreshIntervalSeconds: publicRefreshInterval(config.refreshIntervalSeconds),
      layout: publicDashboardLayout(config.layout, metricUnitByName),
    },
  };
};

export const getPublicDashboardSnapshot = async (
  token: string,
  deps: PublicDashboardSnapshotDeps,
): Promise<Result<PulseDashboardSnapshot>> => {
  try {
    const dashboardResult = await getPublicDashboardByToken(token);
    if (!dashboardResult.ok) return fail(dashboardResult.error);
    const dashboard = dashboardResult.data;
    const { points, events, states, maps, metricUnitByName } = await collectPublicWidgetResults(dashboard, deps);
    const publicDashboard = publicDashboardFromConfig(dashboard, metricUnitByName);

    return ok({ dashboard: publicDashboard, points, events, states, maps });
  } catch (error) {
    return fail(isServiceError(error) ? error : err.internal("Dashboard refresh failed"));
  }
};

export const getDashboardSnapshot = async (
  dashboardId: string,
  user: AccessScope,
  deps: PublicDashboardSnapshotDeps,
): Promise<Result<PulseDashboardSnapshot>> => {
  try {
    const dashboardResult = await getDashboardById(dashboardId, user);
    if (!dashboardResult.ok) return fail(dashboardResult.error);
    const dashboard = dashboardResult.data;
    const { points, events, states, maps, metricUnitByName } = await collectPublicWidgetResults(dashboard, deps);
    return ok({
      dashboard: publicDashboardFromConfig(dashboard, metricUnitByName),
      points,
      events,
      states,
      maps,
    });
  } catch (error) {
    return fail(isServiceError(error) ? error : err.internal("Dashboard refresh failed"));
  }
};
