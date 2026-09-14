import type {
  Aggregation,
  MetricType,
  PulseCurrentState,
  PulseMetricSummary,
  PulseRecordedEvent,
  PulseResourceMetric,
} from "../../contracts";
import { buildPulseQuery } from "../query-authoring";
import { quoteQueryPart } from "./dashboard-query-text";

export const defaultMetricAggregation = (type: MetricType): Aggregation => {
  if (type === "counter") return "rate";
  return "latest";
};

export const queryWithDimensionFilter = (query: string, key: string, value: string): string => {
  const filter = `${key}=${quoteQueryPart(value)}`;
  return /\bwhere\b/i.test(query) ? `${query}, ${filter}` : `${query} where ${filter}`;
};

export const queryWithSourceFilter = (query: string, sourceId: string): string => {
  if (!query || /\bsource\b/i.test(query)) return query;
  return `${query} source ${sourceId}`;
};

const sourceClause = (sourceId: string | null | undefined) => (sourceId ? ` source ${sourceId}` : "");
const resourceClause = (resourceKey: string | null | undefined) => (resourceKey ? ` resource ${quoteQueryPart(resourceKey)}` : "");

const whereClause = (dimensions: Record<string, string>) => {
  const entries = Object.entries(dimensions);
  return entries.length ? ` where ${entries.map(([key, value]) => `${key}=${quoteQueryPart(value)}`).join(", ")}` : "";
};

export const metricSummaryQueryText = (
  metric: PulseMetricSummary,
  options: {
    dimensions?: Record<string, string>;
    sourceId?: string | null;
    resourceKey?: string | null;
  } = {},
): string =>
  buildPulseQuery({
    metric: metric.name,
    aggregation: defaultMetricAggregation(metric.type),
    bucket: metric.type === "gauge" ? "1m" : "5m",
    since: "24h",
    sourceId: options.sourceId,
    resourceKey: options.resourceKey,
    dimensions: options.dimensions,
  });

export const resourceMetricQueryText = (metric: PulseResourceMetric): string =>
  buildPulseQuery({
    metric: metric.metric,
    aggregation: defaultMetricAggregation(metric.type),
    bucket: metric.type === "gauge" ? "1m" : "5m",
    since: "24h",
    sourceId: metric.sourceId,
    resourceKey: metric.resourceKey,
    dimensions: metric.dimensions,
  });

export const eventKindQueryText = (
  kind: string,
  options: {
    resourceKey?: string | null;
    sourceId?: string | null;
  } = {},
): string => `events ${quoteQueryPart(kind)} since 24h${sourceClause(options.sourceId)}${resourceClause(options.resourceKey)} limit 100`;

export const stateKeyQueryText = (
  key: string,
  options: {
    resourceKey?: string | null;
    sourceId?: string | null;
  } = {},
): string => `states ${quoteQueryPart(key)} since 10m${sourceClause(options.sourceId)}${resourceClause(options.resourceKey)} limit 100`;

export const recordedEventQueryText = (event: PulseRecordedEvent): string =>
  `events ${quoteQueryPart(event.kind)} since 24h${sourceClause(event.sourceId)}${resourceClause(event.resourceKey)}${whereClause(
    event.dimensions,
  )} limit 100`;

export const currentStateQueryText = (state: PulseCurrentState): string =>
  `states ${quoteQueryPart(state.key)} since 10m${sourceClause(state.sourceId)}${resourceClause(state.resourceKey)}${whereClause(
    state.dimensions,
  )} limit 100`;
