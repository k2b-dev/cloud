import type {
  PulseCurrentState,
  PulseInventory,
  PulseMetricSeries,
  PulseMetricSummary,
  PulseRecordedEvent,
  PulseSource,
} from "../../contracts";
import type { BrowseEntity } from "./types";

type BrowseMatcher = (values: Array<string | null | undefined>) => boolean;

type BrowseSourceRow = {
  source: PulseSource;
  metricCount: number;
  eventCount: number;
  stateCount: number;
};

type BrowseMetricRow = {
  metric: PulseMetricSummary;
  seriesCount: number;
  sampleDimensions: Record<string, string>;
};

type BrowseEventRow = {
  kind: string;
  count: number;
  sample: PulseRecordedEvent;
};

type BrowseStateRow = {
  key: string;
  count: number;
  sample: PulseCurrentState;
};

type BrowseLabelGroup = {
  key: string;
  count: number;
  values: Array<{ key: string; value: string; count: number }>;
};

type BrowseScope = {
  sourceId: string;
  resourceKey: string;
};

const resourceEntity = (resource: PulseInventory["resources"][number]): BrowseEntity => ({
  id: resource.key,
  type: resource.type,
  sourceIds: resource.sourceIds,
  metricCount: resource.metricCount,
  eventCount: resource.eventCount,
  stateCount: resource.stateCount,
  dimensions: resource.dimensions,
});

const emptyEntity = (id: string, type: string | null): BrowseEntity => ({
  id,
  type,
  sourceIds: [],
  metricCount: 0,
  eventCount: 0,
  stateCount: 0,
  dimensions: {},
});

const ensureEntity = (
  entities: Map<string, BrowseEntity>,
  resourceKey: string | null,
  resourceType: string | null,
  sourceId: string | null,
  dimensions: Record<string, string>,
): BrowseEntity | null => {
  if (!resourceKey) return null;
  const current = entities.get(resourceKey) ?? emptyEntity(resourceKey, resourceType);
  if (!current.type && resourceType) current.type = resourceType;
  if (sourceId && !current.sourceIds.includes(sourceId)) current.sourceIds.push(sourceId);
  current.dimensions = { ...dimensions, ...current.dimensions };
  entities.set(resourceKey, current);
  return current;
};

const incrementUnlistedEntity = (
  resource: BrowseEntity | null,
  resourceIds: Set<string>,
  key: "metricCount" | "eventCount" | "stateCount",
) => {
  if (resource && !resourceIds.has(resource.id)) resource[key] += 1;
};

const entityTotal = (resource: BrowseEntity): number => resource.metricCount + resource.eventCount + resource.stateCount;

const compareEntities = (left: BrowseEntity, right: BrowseEntity): number =>
  entityTotal(right) - entityTotal(left) || left.id.localeCompare(right.id);

export const buildBrowseEntities = (params: {
  inventory: PulseInventory;
  series: PulseMetricSeries[];
  events: PulseRecordedEvent[];
  states: PulseCurrentState[];
}): BrowseEntity[] => {
  const entities = new Map(params.inventory.resources.map((resource) => [resource.key, resourceEntity(resource)]));
  const resourceIds = new Set(params.inventory.resources.map((resource) => resource.key));

  for (const item of params.series) {
    incrementUnlistedEntity(
      ensureEntity(entities, item.resourceKey, item.resourceType, item.sourceId, item.dimensions),
      resourceIds,
      "metricCount",
    );
  }
  for (const item of params.events) {
    incrementUnlistedEntity(
      ensureEntity(entities, item.resourceKey, item.resourceType, item.sourceId, item.dimensions),
      resourceIds,
      "eventCount",
    );
  }
  for (const item of params.states) {
    incrementUnlistedEntity(
      ensureEntity(entities, item.resourceKey, item.resourceType, item.sourceId, item.dimensions),
      resourceIds,
      "stateCount",
    );
  }

  return [...entities.values()].sort(compareEntities);
};

const itemInScope = (item: { sourceId: string | null; resourceKey: string | null }, scope: BrowseScope): boolean => {
  if (scope.sourceId && item.sourceId !== scope.sourceId) return false;
  return !(scope.resourceKey && item.resourceKey !== scope.resourceKey);
};

const dimensionSearchValues = (dimensions: Record<string, string>): string[] => [...Object.keys(dimensions), ...Object.values(dimensions)];

export const filterBrowseSeries = (series: PulseMetricSeries[], scope: BrowseScope): PulseMetricSeries[] =>
  series.filter((item) => itemInScope(item, scope));

const sourceCounts = (items: Array<{ sourceId: string | null }>): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (!item.sourceId) continue;
    counts.set(item.sourceId, (counts.get(item.sourceId) ?? 0) + 1);
  }
  return counts;
};

export const buildBrowseSources = (params: {
  sources: PulseSource[];
  series: PulseMetricSeries[];
  events: PulseRecordedEvent[];
  states: PulseCurrentState[];
  matches: BrowseMatcher;
}): BrowseSourceRow[] => {
  const metricCounts = sourceCounts(params.series);
  const eventCounts = sourceCounts(params.events);
  const stateCounts = sourceCounts(params.states);
  return params.sources
    .map((source) => ({
      source,
      metricCount: metricCounts.get(source.id) ?? 0,
      eventCount: eventCounts.get(source.id) ?? 0,
      stateCount: stateCounts.get(source.id) ?? 0,
    }))
    .filter(({ source }) => params.matches([source.name, source.kind, source.endpointUrl ?? "", source.lastError ?? ""]))
    .slice(0, 24);
};

const metricSearchValues = (item: BrowseMetricRow): string[] => [
  item.metric.name,
  item.metric.type,
  item.metric.unit ?? "",
  ...dimensionSearchValues(item.sampleDimensions),
];

const metricMatchesScope = (metric: PulseMetricSummary, scopedSeries: PulseMetricSeries[], resourceKey: string): boolean =>
  !resourceKey || scopedSeries.length === 0 || scopedSeries.some((series) => series.metric === metric.name);

export const buildBrowseMetrics = (params: {
  metrics: PulseMetricSummary[];
  scopedSeries: PulseMetricSeries[];
  allSeries: PulseMetricSeries[];
  selectedEntityDimensions: Record<string, string>;
  resourceKey: string;
  matches: BrowseMatcher;
}): BrowseMetricRow[] =>
  params.metrics
    .map((metric) => {
      const metricScopedSeries = params.scopedSeries.filter((item) => item.metric === metric.name);
      const sampleSeries = metricScopedSeries[0] ?? params.allSeries.find((item) => item.metric === metric.name);
      return {
        metric,
        seriesCount: metricScopedSeries.length > 0 ? metricScopedSeries.length : metric.seriesCount,
        sampleDimensions: params.resourceKey ? (sampleSeries?.dimensions ?? params.selectedEntityDimensions) : {},
      };
    })
    .filter((item) => metricMatchesScope(item.metric, params.scopedSeries, params.resourceKey) && params.matches(metricSearchValues(item)))
    .slice(0, 60);

const eventMatches = (event: PulseRecordedEvent, scope: BrowseScope, matches: BrowseMatcher): boolean =>
  itemInScope(event, scope) && matches([event.kind, event.resourceKey, event.resourceType, ...dimensionSearchValues(event.dimensions)]);

export const buildBrowseEvents = (events: PulseRecordedEvent[], scope: BrowseScope, matches: BrowseMatcher): BrowseEventRow[] => {
  const groups = new Map<string, BrowseEventRow>();
  for (const event of events) {
    if (!eventMatches(event, scope, matches)) continue;
    const current = groups.get(event.kind);
    groups.set(event.kind, { kind: event.kind, count: (current?.count ?? 0) + 1, sample: current?.sample ?? event });
  }
  return [...groups.values()].sort((left, right) => right.count - left.count || left.kind.localeCompare(right.kind)).slice(0, 40);
};

const stateMatches = (state: PulseCurrentState, scope: BrowseScope, matches: BrowseMatcher): boolean =>
  itemInScope(state, scope) && matches([state.key, state.resourceKey, state.resourceType, ...dimensionSearchValues(state.dimensions)]);

export const buildBrowseStates = (states: PulseCurrentState[], scope: BrowseScope, matches: BrowseMatcher): BrowseStateRow[] => {
  const groups = new Map<string, BrowseStateRow>();
  for (const state of states) {
    if (!stateMatches(state, scope, matches)) continue;
    const current = groups.get(state.key);
    groups.set(state.key, { key: state.key, count: (current?.count ?? 0) + 1, sample: current?.sample ?? state });
  }
  return [...groups.values()].sort((left, right) => right.count - left.count || left.key.localeCompare(right.key)).slice(0, 40);
};

const addLabels = (labels: Map<string, Map<string, number>>, dimensions: Record<string, string>) => {
  for (const [key, value] of Object.entries(dimensions)) {
    const values = labels.get(key) ?? new Map<string, number>();
    values.set(value, (values.get(value) ?? 0) + 1);
    labels.set(key, values);
  }
};

const labelGroups = (labels: Map<string, Map<string, number>>, matches: BrowseMatcher): BrowseLabelGroup[] =>
  [...labels.entries()]
    .map(([key, values]) => ({
      key,
      count: [...values.values()].reduce((sum, value) => sum + value, 0),
      values: [...values.entries()]
        .map(([value, count]) => ({ key, value, count }))
        .filter((item) => matches([item.key, item.value]))
        .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
        .slice(0, 8),
    }))
    .filter((group) => group.values.length > 0)
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key))
    .slice(0, 12);

export const buildBrowseLabels = (params: {
  scopedSeries: PulseMetricSeries[];
  events: PulseRecordedEvent[];
  states: PulseCurrentState[];
  scope: BrowseScope;
  matches: BrowseMatcher;
}): BrowseLabelGroup[] => {
  const labels = new Map<string, Map<string, number>>();
  for (const item of params.scopedSeries) addLabels(labels, item.dimensions);
  for (const item of params.events) {
    if (itemInScope(item, params.scope)) addLabels(labels, item.dimensions);
  }
  for (const item of params.states) {
    if (itemInScope(item, params.scope)) addLabels(labels, item.dimensions);
  }
  return labelGroups(labels, params.matches);
};
