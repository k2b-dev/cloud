import type { ResourceApiKey } from "@k2b/cloud/access/ui";
import type {
  MetricType,
  PulseCurrentState,
  PulseDashboard,
  PulseInventory,
  PulseMetricSeries,
  PulseMetricSummary,
  PulseRecordedEvent,
  PulseResourceMetric,
  PulseResourceSummary,
  PulseSavedQuery,
  PulseSource,
  PulseSourceScrape,
} from "../../contracts";
import { jsonFetch } from "../http";

type PulseBaseData = {
  dashboards: PulseDashboard[];
  inventory: PulseInventory;
  metrics: PulseMetricSummary[];
  savedQueries: PulseSavedQuery[];
  sources: PulseSource[];
};

type PulseActivityData = {
  events: PulseRecordedEvent[];
  metrics: PulseMetricSummary[];
  states: PulseCurrentState[];
};

type PulseActivityQuery = {
  q: string;
  type: "" | MetricType;
};

type PulseResourceQuery = {
  q?: string;
  ref?: string;
  sourceId?: string;
  type?: string;
  limit?: number;
  offset?: number;
};

type PulseResourceSignals = {
  events: PulseRecordedEvent[];
  metrics: PulseResourceMetric[];
  states: PulseCurrentState[];
};

const activityQueryParams = (query: PulseActivityQuery, includeType: boolean) => {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (includeType && query.type) params.set("type", query.type);
  return params;
};

const resourceQueryParams = (query: PulseResourceQuery) => {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.ref) params.set("ref", query.ref);
  if (query.sourceId) params.set("sourceId", query.sourceId);
  if (query.type) params.set("type", query.type);
  if (query.limit) params.set("limit", String(query.limit));
  if (query.offset) params.set("offset", String(query.offset));
  return params;
};

export const fetchPulseBaseData = async (baseId: string, signal?: AbortSignal): Promise<PulseBaseData> => {
  const [sources, metrics, inventory, dashboards, savedQueries] = await Promise.all([
    jsonFetch<PulseSource[]>(`/api/pulse/bases/${baseId}/sources`, { signal }),
    jsonFetch<PulseMetricSummary[]>(`/api/pulse/bases/${baseId}/metrics`, { signal }),
    jsonFetch<PulseInventory>(`/api/pulse/bases/${baseId}/inventory`, { signal }),
    jsonFetch<PulseDashboard[]>(`/api/pulse/bases/${baseId}/dashboards`, { signal }),
    jsonFetch<PulseSavedQuery[]>(`/api/pulse/bases/${baseId}/saved-queries`, { signal }),
  ]);
  return { dashboards, inventory, metrics, savedQueries, sources };
};

export const fetchPulseResources = async (
  baseId: string,
  query: PulseResourceQuery,
  signal?: AbortSignal,
): Promise<PulseResourceSummary[]> => {
  const params = resourceQueryParams(query);
  return jsonFetch<PulseResourceSummary[]>(`/api/pulse/bases/${baseId}/resources?${params}`, { signal });
};

export const fetchPulseResourceSignals = async (
  baseId: string,
  resourceKey: string,
  signal?: AbortSignal,
): Promise<PulseResourceSignals> => {
  const params = new URLSearchParams({ resourceKey, limit: "500" });
  const [metrics, states, events] = await Promise.all([
    jsonFetch<PulseResourceMetric[]>(`/api/pulse/bases/${baseId}/resource-metrics?${params}`, { signal }),
    jsonFetch<PulseCurrentState[]>(`/api/pulse/bases/${baseId}/resource-states?${params}`, { signal }),
    jsonFetch<PulseRecordedEvent[]>(`/api/pulse/bases/${baseId}/resource-events?${params}`, { signal }),
  ]);
  return { events, metrics, states };
};

export const fetchPulseActivityData = async (
  baseId: string,
  query: PulseActivityQuery,
  signal?: AbortSignal,
): Promise<PulseActivityData> => {
  const eventParams = activityQueryParams(query, false);
  const stateParams = activityQueryParams(query, false);
  const metricParams = activityQueryParams(query, true);
  const [events, states, metrics] = await Promise.all([
    jsonFetch<PulseRecordedEvent[]>(`/api/pulse/bases/${baseId}/recent-events?${eventParams}`, { signal }),
    jsonFetch<PulseCurrentState[]>(`/api/pulse/bases/${baseId}/states?${stateParams}`, { signal }),
    jsonFetch<PulseMetricSummary[]>(`/api/pulse/bases/${baseId}/metrics?${metricParams}`, { signal }),
  ]);
  return { events, metrics, states };
};

export const fetchPulseMetricSeries = async (
  baseId: string,
  metric: string,
  sourceId?: string | null,
  signal?: AbortSignal,
): Promise<PulseMetricSeries[]> => {
  const params = new URLSearchParams({ metric });
  if (sourceId) params.set("sourceId", sourceId);
  return jsonFetch<PulseMetricSeries[]>(`/api/pulse/bases/${baseId}/series?${params}`, { signal });
};

export const fetchPulseSourceScrapes = (baseId: string, sourceId: string, signal?: AbortSignal): Promise<PulseSourceScrape[]> =>
  jsonFetch<PulseSourceScrape[]>(`/api/pulse/bases/${baseId}/sources/${sourceId}/scrapes`, { signal });

export const fetchPulseSourceApiKeys = (baseId: string, sourceId: string, signal?: AbortSignal): Promise<ResourceApiKey[]> =>
  jsonFetch<ResourceApiKey[]>(`/api/pulse/bases/${baseId}/sources/${sourceId}/api-keys`, { signal });
