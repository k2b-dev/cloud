import type {
  Aggregation,
  MetricQueryPoint,
  PulseCurrentState,
  PulseDashboard,
  PulseDashboardConfig,
  PulseDashboardEventsWidget,
  PulseDashboardMapWidget,
  PulseDashboardMetricWidget,
  PulseDashboardStatesWidget,
  PulseMapSeries,
  PulseRecordedEvent,
} from "../../contracts";
import { jsonFetch } from "../http";
import { dashboardEventQueryText, dashboardMetricQueryText, dashboardStateQueryText, quoteQueryPart } from "./dashboard-query-text";

const dashboardRuntimeValues = (
  dashboard: PulseDashboard,
  config: PulseDashboardConfig,
  controlValues?: Record<string, string>,
): Record<string, string> => {
  const defaults = Object.fromEntries((config.layout?.controls ?? []).map((control) => [control.variable, control.defaultValue]));
  return { ...defaults, ...(controlValues ?? {}) };
};

const resolveDashboardQueryText = (
  text: string,
  dashboard: PulseDashboard,
  config: PulseDashboardConfig,
  controlValues?: Record<string, string>,
): string => {
  const values = dashboardRuntimeValues(dashboard, config, controlValues);
  return text.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, variable: string) =>
    typeof values[variable] === "string" ? quoteQueryPart(values[variable]) : match,
  );
};

export const metricWidgetQueryText = (widget: PulseDashboardMetricWidget): string => {
  if (widget.queryText && widget.query) return widget.queryText;
  if (widget.query?.kind === "events") return dashboardEventQueryText(widget.query);
  return dashboardMetricQueryText(
    widget.query?.kind === "metric"
      ? widget.query
      : {
          kind: "metric",
          metric: widget.metric,
          aggregation: widget.aggregation as Aggregation,
          bucket: widget.bucket,
          since: widget.since,
          sourceId: widget.sourceId ?? null,
          resourceKey: widget.resourceKey ?? null,
          resourceType: widget.resourceType ?? null,
          dimensions: widget.dimensions,
          reduce: widget.reduce,
          groupBy: widget.groupBy,
        },
  );
};

const fetchDashboardQuery = <T>(baseId: string, query: string, signal?: AbortSignal): Promise<T> =>
  jsonFetch<T>("/api/pulse/query/metric-text", {
    method: "POST",
    signal,
    body: JSON.stringify({ baseId, query }),
  });

export const fetchDashboardMetricWidgetPoints = async (input: {
  baseId: string;
  config: PulseDashboardConfig;
  controlValues?: Record<string, string>;
  dashboard: PulseDashboard;
  signal?: AbortSignal;
  widget: PulseDashboardMetricWidget;
}): Promise<MetricQueryPoint[]> => {
  const query = resolveDashboardQueryText(metricWidgetQueryText(input.widget), input.dashboard, input.config, input.controlValues);
  const data = await fetchDashboardQuery<{ points: MetricQueryPoint[] }>(input.baseId, query, input.signal);
  return data.points ?? [];
};

export const fetchDashboardEventsWidgetRows = async (input: {
  baseId: string;
  config: PulseDashboardConfig;
  controlValues?: Record<string, string>;
  dashboard: PulseDashboard;
  signal?: AbortSignal;
  widget: PulseDashboardEventsWidget;
}): Promise<PulseRecordedEvent[]> => {
  const query = resolveDashboardQueryText(
    input.widget.queryText || dashboardEventQueryText(input.widget.query),
    input.dashboard,
    input.config,
    input.controlValues,
  );
  const data = await fetchDashboardQuery<{ events: PulseRecordedEvent[] }>(input.baseId, query, input.signal);
  return data.events ?? [];
};

export const fetchDashboardStatesWidgetRows = async (input: {
  baseId: string;
  config: PulseDashboardConfig;
  controlValues?: Record<string, string>;
  dashboard: PulseDashboard;
  signal?: AbortSignal;
  widget: PulseDashboardStatesWidget;
}): Promise<PulseCurrentState[]> => {
  const query = resolveDashboardQueryText(
    input.widget.queryText || dashboardStateQueryText(input.widget.query),
    input.dashboard,
    input.config,
    input.controlValues,
  );
  const data = await fetchDashboardQuery<{ states: PulseCurrentState[] }>(input.baseId, query, input.signal);
  return data.states ?? [];
};

export const fetchDashboardMapWidgetSeries = async (input: {
  baseId: string;
  config: PulseDashboardConfig;
  controlValues?: Record<string, string>;
  dashboard: PulseDashboard;
  signal?: AbortSignal;
  widget: PulseDashboardMapWidget;
}): Promise<PulseMapSeries[]> => {
  const query = resolveDashboardQueryText(input.widget.queryText, input.dashboard, input.config, input.controlValues);
  return jsonFetch<PulseMapSeries[]>("/api/pulse/query/event-map", {
    method: "POST",
    signal: input.signal,
    body: JSON.stringify({
      baseId: input.baseId,
      query,
      latitude: input.widget.latitude,
      longitude: input.widget.longitude,
      label: input.widget.label,
      series: input.widget.series,
      size: input.widget.size,
    }),
  });
};
