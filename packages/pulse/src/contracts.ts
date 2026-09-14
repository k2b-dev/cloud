export const SOURCE_KINDS = ["metrics", "http_ingest"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const METRIC_TYPES = ["gauge", "counter"] as const;
export type MetricType = (typeof METRIC_TYPES)[number];

export const AGGREGATIONS = ["avg", "sum", "min", "max", "count", "latest", "rate", "increase", "p50", "p90", "p95", "p99"] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];

export const EVENT_AGGREGATIONS = ["rows", "count", "sum", "unique_actor", "unique_session"] as const;
export type EventAggregation = (typeof EVENT_AGGREGATIONS)[number];

export const PANEL_VISUALS = ["line", "bar", "stat", "gauge", "barGauge", "histogram", "heatmap", "table"] as const;
export type PanelVisual = (typeof PANEL_VISUALS)[number];

export type DashboardRefreshInterval = 1 | 5 | 10 | 60;

export type PulseBase = {
  id: string;
  name: string;
  description: string | null;
  rawRetentionDays: number;
  rollupRetentionDays: number;
  sensitiveRetentionHours: number;
  createdBy: string | null;
  deletionStartedAt: string | null;
  deletionFailedAt: string | null;
  deletionError: string | null;
  dataClearStartedAt: string | null;
  dataClearCompletedAt: string | null;
  dataClearFailedAt: string | null;
  dataClearError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PulseSource = {
  id: string;
  baseId: string;
  kind: SourceKind;
  name: string;
  enabled: boolean;
  endpointUrl: string | null;
  bearerTokenConfigured: boolean;
  scrapeIntervalSeconds: number | null;
  lastSeenAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PulseSourceScrape = {
  id: string;
  sourceId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  success: boolean;
  metrics: number;
  events: number;
  states: number;
  errorMessage: string | null;
};

export type PulseMetric = {
  name: string;
  value: number;
  ts?: string;
  unit?: string | null;
  type?: MetricType;
  resource?: PulseResourceRef | null;
  dimensions?: Record<string, string | number | boolean | null>;
};

export type PulseResourceRef = {
  type: string;
  id: string;
  label?: string | null;
};

export type PulseEvent = {
  kind: string;
  ts?: string;
  value?: number | null;
  actorId?: string | null;
  sessionId?: string | null;
  correlationId?: string | null;
  resource?: PulseResourceRef | null;
  dimensions?: Record<string, string | number | boolean | null>;
  attributes?: Record<string, unknown>;
  sensitive?: Record<string, unknown>;
  payload?: Record<string, unknown>;
};

export type PulseState = {
  key: string;
  value: string | number | boolean | null;
  ts?: string;
  resource?: PulseResourceRef | null;
  dimensions?: Record<string, string | number | boolean | null>;
};

export type PulseIngestBatch = {
  metrics?: PulseMetric[];
  events?: PulseEvent[];
  states?: PulseState[];
};

export type PulseRecordedEvent = {
  id: string;
  kind: string;
  ts: string;
  value: number | null;
  sourceId: string | null;
  resourceKey: string | null;
  resourceType: string | null;
  dimensions: Record<string, string>;
  attributes: Record<string, unknown>;
  payload: Record<string, unknown>;
  recordedAt: string;
};

export type PulseCurrentState = {
  variantKey: string;
  key: string;
  value: unknown;
  sourceId: string | null;
  resourceKey: string | null;
  resourceType: string | null;
  dimensions: Record<string, string>;
  updatedAt: string;
};

export type PulseMetricSummary = {
  name: string;
  unit: string | null;
  type: MetricType;
  seriesCount: number;
  lastSeenAt: string | null;
};

export type PulseMetricSeries = {
  id: string;
  metric: string;
  sourceId: string | null;
  resourceKey: string | null;
  resourceType: string | null;
  dimensions: Record<string, string>;
  lastSeenAt: string | null;
  latestValue: number | null;
  latestSampleAt: string | null;
};

export type PulseResourceSummary = {
  key: string;
  id: string;
  label: string;
  type: string | null;
  sourceIds: string[];
  metricSeriesCount: number;
  metricCount: number;
  eventCount: number;
  stateCount: number;
  lastSeenAt: string | null;
  dimensions: Record<string, string>;
};

export type PulseResourceSearchResult = Pick<PulseResourceSummary, "key" | "id" | "label" | "type" | "lastSeenAt"> & {
  baseId: string;
  baseName: string;
};

export type PulseResourceMetric = {
  seriesId: string;
  resourceKey: string;
  resourceId: string;
  resourceType: string | null;
  metric: string;
  type: MetricType;
  unit: string | null;
  sourceId: string | null;
  dimensions: Record<string, string>;
  lastSeenAt: string | null;
  latestValue: number | null;
  latestSampleAt: string | null;
};

export type PulseSignalField = {
  sourceId: string;
  scope: "metric" | "event" | "state";
  signalName: string;
  role: "dimension" | "attribute" | "sensitive";
  key: string;
  valueType: "null" | "string" | "number" | "boolean" | "object" | "array" | "mixed";
  observedCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type PulseInventory = {
  resources: PulseResourceSummary[];
  metrics: PulseResourceMetric[];
  events: PulseRecordedEvent[];
  states: PulseCurrentState[];
  fields: PulseSignalField[];
};

export type PulseCapabilitySnapshot = {
  timescaleEnabled: boolean;
  timeBucketAvailable: boolean;
  continuousAggregatesAvailable: boolean;
};

type PulseDashboardConditionOperator = ">" | ">=" | "<" | "<=" | "=" | "!=";
type PulseDashboardConditionLevel = "warn" | "critical";

export type PulseDashboardCondition = {
  level: PulseDashboardConditionLevel;
  operator: PulseDashboardConditionOperator;
  value: string | number | boolean;
  message?: string | null;
};

export type PulseDashboardControl = {
  id: string;
  kind: "range" | "source" | "resource" | "resource_type" | "label" | "text";
  variable: string;
  label: string;
  defaultValue: string;
  options?: string[];
  resourceType?: string | null;
};

export type PulseDashboardMetricQuery = {
  kind: "metric";
  metric: string;
  aggregation: Aggregation;
  bucket: string;
  since?: string;
  from?: string;
  to?: string;
  sourceId?: string | null;
  resourceKey?: string | null;
  resourceType?: string | null;
  dimensions?: Record<string, string | number | boolean | null>;
  reduce?: MetricReducer | null;
  groupBy?: string | null;
};

export type PulseDashboardEventQuery = {
  kind: "events";
  event: string | null;
  since?: string;
  from?: string;
  to?: string;
  sourceId?: string | null;
  resourceKey?: string | null;
  resourceType?: string | null;
  dimensions?: Record<string, string | number | boolean | null>;
  aggregation?: EventAggregation;
  bucket?: string | null;
  timeZone?: string;
  groupBy?: string[];
  limit: number;
};

export type PulseDashboardStateQuery = {
  kind: "states";
  state: string | null;
  since?: string | null;
  sourceId?: string | null;
  resourceKey?: string | null;
  resourceType?: string | null;
  dimensions?: Record<string, string | number | boolean | null>;
  limit: number;
};

export type PulseMapFieldSelector = {
  role: "dimension" | "attribute";
  path: string;
};

export type PulseMapPoint = {
  latitude: number;
  longitude: number;
  label?: string;
  size: number;
};

export type PulseMapSeries = {
  label?: string;
  data: PulseMapPoint[];
};

export type PulseDashboardMapWidget = {
  id: string;
  kind: "map";
  title: string;
  queryText: string;
  query: PulseDashboardEventQuery;
  latitude: PulseMapFieldSelector;
  longitude: PulseMapFieldSelector;
  label?: PulseMapFieldSelector;
  series?: PulseMapFieldSelector;
  size: "count" | "sum";
  description?: string | null;
  span?: number;
};

export type PulseDashboardMetricWidget = {
  id: string;
  kind: "metric";
  title: string;
  visual: PanelVisual;
  queryText: string;
  query: PulseDashboardMetricQuery | PulseDashboardEventQuery;
  description?: string | null;
  conditions?: PulseDashboardCondition[];
  span?: number;
};

export type PulseDashboardEventsWidget = {
  id: string;
  kind: "events";
  title: string;
  visual: "table";
  queryText: string;
  query: PulseDashboardEventQuery;
  description?: string | null;
  conditions?: PulseDashboardCondition[];
  span?: number;
};

export type PulseDashboardStatesWidget = {
  id: string;
  kind: "states";
  title: string;
  visual: "table" | "stat";
  queryText: string;
  query: PulseDashboardStateQuery;
  description?: string | null;
  conditions?: PulseDashboardCondition[];
  span?: number;
};

export type PulseDashboardMarkdownWidget = {
  id: string;
  kind: "markdown";
  title?: string | null;
  description?: string | null;
  markdown: string;
  span?: number;
};

export type PulseDashboardCardWidget = {
  id: string;
  kind: "card";
  title: string;
  description?: string | null;
  rows: PulseDashboardRow[];
  span?: number;
};

export type PulseDashboardWidget =
  | PulseDashboardMetricWidget
  | PulseDashboardEventsWidget
  | PulseDashboardStatesWidget
  | PulseDashboardMapWidget
  | PulseDashboardMarkdownWidget
  | PulseDashboardCardWidget;

export type PulseDashboardRow = {
  id: string;
  kind: "row";
  height: "sm" | "md" | "lg";
  cells: PulseDashboardWidget[];
};

export type PulseDashboardSection = {
  id: string;
  kind: "section";
  title: string;
  description?: string | null;
  rows: PulseDashboardRow[];
  sections?: PulseDashboardSection[];
};

export type PulseDashboardLayout = {
  version: 1;
  description?: string | null;
  controls?: PulseDashboardControl[];
  sections: PulseDashboardSection[];
};

export type PulseDashboardConfig = {
  dsl: string;
  layout: PulseDashboardLayout | null;
  refreshIntervalSeconds?: DashboardRefreshInterval | null;
};

export type PulseDashboard = {
  id: string;
  baseId: string;
  name: string;
  config: PulseDashboardConfig;
  publicEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type PulsePublicRecordedEvent = Pick<PulseRecordedEvent, "id" | "kind" | "ts" | "value" | "resourceKey" | "resourceType">;

export type PulsePublicCurrentState = Pick<
  PulseCurrentState,
  "variantKey" | "key" | "value" | "resourceKey" | "resourceType" | "updatedAt"
>;

export type PulsePublicDashboardMetricWidget = Omit<PulseDashboardMetricWidget, "query" | "queryText"> & {
  metric: string;
  aggregation: Aggregation | EventAggregation;
  bucket: string;
  timeZone?: string;
  since?: string;
  from?: string;
  to?: string;
  unit?: string | null;
};

export type PulsePublicDashboardEventsWidget = Omit<PulseDashboardEventsWidget, "query" | "queryText">;

export type PulsePublicDashboardStatesWidget = Omit<PulseDashboardStatesWidget, "query" | "queryText">;

export type PulsePublicDashboardMapWidget = Omit<
  PulseDashboardMapWidget,
  "query" | "queryText" | "latitude" | "longitude" | "label" | "series" | "size"
>;

export type PulsePublicDashboardMarkdownWidget = PulseDashboardMarkdownWidget;

export type PulsePublicDashboardCardWidget = Omit<PulseDashboardCardWidget, "rows"> & {
  rows: PulsePublicDashboardRow[];
};

export type PulsePublicDashboardWidget =
  | PulsePublicDashboardMetricWidget
  | PulsePublicDashboardEventsWidget
  | PulsePublicDashboardStatesWidget
  | PulsePublicDashboardMapWidget
  | PulsePublicDashboardMarkdownWidget
  | PulsePublicDashboardCardWidget;

export type PulsePublicDashboardRow = Omit<PulseDashboardRow, "cells"> & {
  cells: PulsePublicDashboardWidget[];
};

export type PulsePublicDashboardSection = Omit<PulseDashboardSection, "rows" | "sections"> & {
  rows: PulsePublicDashboardRow[];
  sections?: PulsePublicDashboardSection[];
};

export type PulsePublicDashboardLayout = Omit<PulseDashboardLayout, "controls" | "sections"> & {
  sections: PulsePublicDashboardSection[];
};

export type PulseSavedQuery = {
  id: string;
  baseId: string;
  name: string;
  description: string | null;
  query: string;
  createdAt: string;
  updatedAt: string;
};

export type PulsePublicDashboard = {
  id: string;
  name: string;
  config: {
    layout: PulsePublicDashboardLayout | null;
    refreshIntervalSeconds?: DashboardRefreshInterval | null;
  };
};

export type PulseDashboardSnapshot = {
  dashboard: PulsePublicDashboard;
  points: Record<string, MetricQueryPoint[]>;
  events: Record<string, PulsePublicRecordedEvent[]>;
  states: Record<string, PulsePublicCurrentState[]>;
  maps: Record<string, PulseMapSeries[]>;
};

type PulseDashboardDslDiagnostic = {
  severity: "error";
  message: string;
  line: number;
  column: number;
};

export type PulseDashboardDslCompileResult = {
  ok: boolean;
  diagnostics: PulseDashboardDslDiagnostic[];
  config: PulseDashboardConfig | null;
};

export type MetricQuery = {
  kind: "metric";
  baseId: string;
  metric: string;
  aggregation: Aggregation;
  bucket: string;
  since?: string;
  from?: string;
  to?: string;
  sourceId?: string | null;
  resourceKey?: string | null;
  resourceType?: string | null;
  dimensions?: Record<string, string | number | boolean | null>;
  reduce?: MetricReducer | null;
  groupBy?: string | null;
};

export type MetricReducer = "sum" | "avg" | "min" | "max";

export type EventQuery = {
  kind: "events";
  baseId: string;
  event: string | null;
  since?: string;
  from?: string;
  to?: string;
  sourceId?: string | null;
  resourceKey?: string | null;
  resourceType?: string | null;
  dimensions?: Record<string, string | number | boolean | null>;
  aggregation?: EventAggregation;
  bucket?: string | null;
  timeZone?: string;
  groupBy?: string[];
  limit: number;
};

export const isEventAggregateQuery = (query: EventQuery): boolean => (query.aggregation ?? "rows") !== "rows";

export type StateQuery = {
  kind: "states";
  baseId: string;
  state: string | null;
  since?: string | null;
  sourceId?: string | null;
  resourceKey?: string | null;
  resourceType?: string | null;
  dimensions?: Record<string, string | number | boolean | null>;
  limit: number;
};

export type PulseExplorerQuery = MetricQuery | EventQuery | StateQuery;

export type MetricQueryPoint = {
  bucket: string;
  value: number | null;
  group?: Record<string, string>;
};

type PulseQueryDiagnostic = {
  severity: "error" | "info";
  message: string;
};

export type PulseQueryCompileResult = {
  ok: boolean;
  diagnostics: PulseQueryDiagnostic[];
  compiled: PulseExplorerQuery | null;
};
