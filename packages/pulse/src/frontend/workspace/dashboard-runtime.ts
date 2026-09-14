import type {
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
import { resolveDashboardControls } from "../../dashboard-controls";
import { jsonFetch } from "../http";

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
  const query = resolveDashboardControls(input.widget.queryText, input.config.layout?.controls ?? [], input.controlValues);
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
  const query = resolveDashboardControls(input.widget.queryText, input.config.layout?.controls ?? [], input.controlValues);
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
  const query = resolveDashboardControls(input.widget.queryText, input.config.layout?.controls ?? [], input.controlValues);
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
  const query = resolveDashboardControls(input.widget.queryText, input.config.layout?.controls ?? [], input.controlValues);
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
