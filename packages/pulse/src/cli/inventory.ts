import type {
  MetricType,
  PulseBase,
  PulseCurrentState,
  PulseInventory,
  PulseMetricSeries,
  PulseMetricSummary,
  PulseRecordedEvent,
  PulseSignalField,
  PulseSource,
} from "../contracts";
import { compactId, formatDate, formatValue } from "./shared";

type InventoryResource = PulseInventory["resources"][number];
type InventoryMetric = PulseInventory["metrics"][number];
type ResourceSignalFilters = {
  q?: string;
  sourceId?: string;
  resource?: InventoryResource;
  resourceType?: string;
};
type MetricFilters = ResourceSignalFilters & { type?: MetricType };
type StateFilters = ResourceSignalFilters & { key?: string };
type EventFilters = ResourceSignalFilters & { kind?: string };
type ResourceFilters = { q?: string; type?: string; source?: string };
type SearchValue = string | number | boolean | null | undefined;

const maxIso = (left: string | null, right: string | null): string | null => {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
};

const includesSearch = (q: string | undefined, values: SearchValue[]): boolean => {
  if (!q) return true;
  const normalized = q.toLowerCase();
  return values.some((value) =>
    String(value ?? "")
      .toLowerCase()
      .includes(normalized),
  );
};

const optionalEquals = (filter: string | undefined, value: string | null | undefined): boolean => filter === undefined || value === filter;

const optionalResource = (resource: InventoryResource | undefined, resourceKey: string | null | undefined): boolean =>
  !resource || resource.key === resourceKey;

export const sliceRows = <T>(items: T[], limit?: number, offset?: number): T[] => {
  const start = Math.max(0, offset ?? 0);
  const end = limit === undefined ? undefined : start + Math.max(1, limit);
  return items.slice(start, end);
};

const metricMatchesScope = (metric: InventoryMetric, filters: MetricFilters): boolean => {
  const resourceKey = filters.resource?.key;
  return (
    optionalEquals(filters.type, metric.type) &&
    optionalEquals(filters.sourceId, metric.sourceId) &&
    optionalEquals(resourceKey, metric.resourceKey) &&
    optionalEquals(filters.resourceType, metric.resourceType)
  );
};

const metricSearchValues = (metric: InventoryMetric): SearchValue[] => [
  metric.metric,
  metric.resourceKey,
  metric.resourceId,
  metric.resourceType,
  metric.sourceId,
  ...Object.keys(metric.dimensions),
  ...Object.values(metric.dimensions),
];

const metricMatchesFilters = (metric: InventoryMetric, filters: MetricFilters): boolean =>
  metricMatchesScope(metric, filters) && includesSearch(filters.q, metricSearchValues(metric));

export const filterInventoryMetrics = (inventory: PulseInventory, filters: MetricFilters): InventoryMetric[] =>
  inventory.metrics.filter((metric) => metricMatchesFilters(metric, filters));

export const metricSummariesFromInventory = (metrics: InventoryMetric[]): PulseMetricSummary[] => {
  const summaries = new Map<string, PulseMetricSummary>();
  for (const metric of metrics) {
    const key = `${metric.metric}\u0000${metric.type}\u0000${metric.unit ?? ""}`;
    const current = summaries.get(key);
    if (current) {
      current.seriesCount += 1;
      current.lastSeenAt = maxIso(current.lastSeenAt, metric.lastSeenAt);
      continue;
    }
    summaries.set(key, {
      name: metric.metric,
      type: metric.type,
      unit: metric.unit,
      seriesCount: 1,
      lastSeenAt: metric.lastSeenAt,
    });
  }
  return [...summaries.values()].sort((left, right) => left.name.localeCompare(right.name));
};

const stateMatchesScope = (state: PulseCurrentState, filters: StateFilters): boolean => {
  return (
    optionalEquals(filters.key, state.key) &&
    optionalEquals(filters.sourceId, state.sourceId) &&
    optionalResource(filters.resource, state.resourceKey) &&
    optionalEquals(filters.resourceType, state.resourceType)
  );
};

const stateSearchValues = (state: PulseCurrentState): SearchValue[] => [
  state.key,
  formatValue(state.value),
  state.resourceKey,
  state.resourceType,
  state.sourceId,
  ...Object.keys(state.dimensions),
  ...Object.values(state.dimensions),
];

const stateMatchesFilters = (state: PulseCurrentState, filters: StateFilters): boolean =>
  stateMatchesScope(state, filters) && includesSearch(filters.q, stateSearchValues(state));

export const filterInventoryStates = (inventory: PulseInventory, filters: StateFilters): PulseCurrentState[] =>
  inventory.states.filter((state) => stateMatchesFilters(state, filters));

const eventMatchesScope = (event: PulseRecordedEvent, filters: EventFilters): boolean => {
  return (
    optionalEquals(filters.kind, event.kind) &&
    optionalEquals(filters.sourceId, event.sourceId) &&
    optionalResource(filters.resource, event.resourceKey) &&
    optionalEquals(filters.resourceType, event.resourceType)
  );
};

const eventSearchValues = (event: PulseRecordedEvent): SearchValue[] => [
  event.kind,
  event.value,
  event.resourceKey,
  event.resourceType,
  event.sourceId,
  ...Object.keys(event.dimensions),
  ...Object.values(event.dimensions),
  JSON.stringify(event.payload),
];

const eventMatchesFilters = (event: PulseRecordedEvent, filters: EventFilters): boolean =>
  eventMatchesScope(event, filters) && includesSearch(filters.q, eventSearchValues(event));

export const filterInventoryEvents = (inventory: PulseInventory, filters: EventFilters): PulseRecordedEvent[] =>
  inventory.events.filter((event) => eventMatchesFilters(event, filters));

export const metricRows = (metrics: PulseMetricSummary[]) =>
  metrics.map((metric) => ({
    metric: metric.name,
    type: metric.type,
    unit: metric.unit ?? "",
    series: metric.seriesCount,
    lastSeenAt: formatDate(metric.lastSeenAt),
  }));

export const seriesRows = (series: PulseMetricSeries[]) =>
  series.map((item) => ({
    id: compactId(item.id),
    metric: item.metric,
    source: compactId(item.sourceId),
    resource: item.resourceKey ?? "",
    resourceType: item.resourceType ?? "",
    value: item.latestValue ?? "",
    lastSeenAt: formatDate(item.lastSeenAt),
  }));

export const inventoryMetricRows = (metrics: InventoryMetric[]) =>
  metrics.map((metric) => ({
    id: compactId(metric.seriesId),
    metric: metric.metric,
    type: metric.type,
    unit: metric.unit ?? "",
    source: compactId(metric.sourceId),
    resource: metric.resourceKey,
    value: formatValue(metric.latestValue),
    lastSeenAt: formatDate(metric.lastSeenAt),
  }));

export const stateRows = (states: PulseCurrentState[]) =>
  states.map((state) => ({
    key: state.key,
    value: formatValue(state.value),
    source: compactId(state.sourceId),
    resource: state.resourceKey,
    resourceType: state.resourceType ?? "",
    updatedAt: state.updatedAt,
  }));

export const eventRows = (events: PulseRecordedEvent[]) =>
  events.map((event) => ({
    id: compactId(event.id),
    kind: event.kind,
    value: event.value ?? "",
    source: compactId(event.sourceId),
    resource: event.resourceKey ?? "",
    resourceType: event.resourceType ?? "",
    ts: event.ts,
  }));

export const signalFieldRows = (fields: PulseSignalField[]) =>
  fields.map((field) => ({
    scope: field.scope,
    signal: field.signalName,
    role: field.role,
    field: field.key,
    type: field.valueType,
    source: compactId(field.sourceId),
    observations: field.observedCount,
    lastSeenAt: formatDate(field.lastSeenAt),
  }));

const resourceMatchesScope = (resource: InventoryResource, filters: ResourceFilters): boolean => {
  if (filters.type && resource.type !== filters.type) return false;
  if (filters.source && !resource.sourceIds.includes(filters.source)) return false;
  return true;
};

const resourceMatchesSearch = (resource: InventoryResource, q: string | undefined): boolean => {
  if (!q) return true;
  return includesSearch(q, [resource.label, resource.id, resource.type, ...Object.values(resource.dimensions)]);
};

export const resourceSummaryRows = (resources: InventoryResource[]) =>
  resources.map((resource) => ({
    key: resource.key,
    type: resource.type ?? "",
    label: resource.label,
    metrics: resource.metricCount,
    states: resource.stateCount,
    events: resource.eventCount,
    sources: resource.sourceIds.length,
    lastSeenAt: formatDate(resource.lastSeenAt),
  }));

export const resourceRows = (inventory: PulseInventory, filters: ResourceFilters) => {
  const q = filters.q?.toLowerCase();
  return resourceSummaryRows(
    inventory.resources.filter((resource) => resourceMatchesScope(resource, filters) && resourceMatchesSearch(resource, q)),
  );
};

export const resourceDetailRows = (resource: InventoryResource) => [
  { key: "key", value: resource.key },
  { key: "id", value: resource.id },
  { key: "label", value: resource.label },
  { key: "type", value: resource.type ?? "" },
  { key: "sources", value: resource.sourceIds.map(compactId).join(", ") },
  { key: "metrics", value: resource.metricCount },
  { key: "states", value: resource.stateCount },
  { key: "events", value: resource.eventCount },
  { key: "lastSeenAt", value: formatDate(resource.lastSeenAt) },
  ...Object.entries(resource.dimensions).map(([key, value]) => ({ key: `dimension.${key}`, value })),
];

export const overviewRows = (base: PulseBase, inventory: PulseInventory, sources: PulseSource[], metrics: PulseMetricSummary[]) => {
  const resourceTypes = new Set(inventory.resources.map((resource) => resource.type).filter(Boolean));
  return [
    {
      base: base.name,
      sources: sources.length,
      resources: inventory.resources.length,
      resourceTypes: resourceTypes.size,
      metrics: metrics.length,
      metricSeries: inventory.metrics.length,
      events: inventory.events.length,
      states: inventory.states.length,
      fields: inventory.fields.length,
    },
  ];
};
