import type { BaseStoreStatus } from "./store/admin-contracts";
export const SOURCE_KINDS = ["metrics", "http_ingest"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const METRIC_TYPES = ["gauge", "counter"] as const;
export type MetricType = (typeof METRIC_TYPES)[number];

export type PulseBase = {
  store: BaseStoreStatus;
  id: string;
  name: string;
  description: string | null;
  shortId: string;
  icon: string;
  color: string;
  timezone: string;
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
  seriesCount?: number;
  todayCount?: number | null;
  id: string;
  baseId: string;
  kind: SourceKind;
  name: string;
  enabled: boolean;
  endpointUrl: string | null;
  bearerTokenConfigured: boolean;
  scrapeIntervalSeconds: number | null;
  metricFilters: string[];
  status: {
    newestDataAt: string | null;
    throttled: boolean;
    throttledAt: string | null;
    refusedHistograms: { family: string; reason: string }[];
    skippedSummaries: number;
    lastError: string | null;
    lastErrorAt: string | null;
  };
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
