import type { AccessMember } from "@k2b/cloud/contracts";
import type { BaseStoreStatus } from "./store/admin-contracts";
export const SOURCE_KINDS = ["metrics", "http_ingest"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const METRIC_TYPES = ["gauge", "counter"] as const;
export type MetricType = (typeof METRIC_TYPES)[number];

export type PulseBase = {
  memberCount: number;
  /**
   * The first three members, admins first, as the access list names them; only for someone who administers the base
   * (who has access is the admins' list), and left out by older servers.
   */
  members?: AccessMember[];
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

/**
 * Whether a base's data store can take and answer data. Unavailable: no store is configured, the instance store has an
 * outage, or the base store failed; a running provision, clear or delete is not an outage. `since` is the outage start,
 * else the failed store's last error, and null while available.
 */
export type PulseStoreOutage = { unavailable: boolean; since: string | null };

/** One base as `GET /api/pulse/bases/:baseId` returns it: the list fields plus its store outage, read live. */
export type PulseBaseRead = PulseBase & { outage: PulseStoreOutage };

/** `lastReason` names the first refused field or the refusal in words, never values from the batch. */
export type PulseSourceRejections = { last24h: number; lastReason: string | null; lastAt: string | null };

/** The most sources one list request returns; a base with more is read page by page with `offset`. */
export const SOURCE_PAGE_MAX = 500;

/** The figures of all of a base's sources; `failing` names the first three, `today` is null while the store cannot answer. */
/** Minutes of fetches a source row shows, one slot per minute. */
export const FETCH_TICKS = 30;
/** Today's fetches in half-hour slots, 00:00 to 24:00 in the base's zone. */
export const FETCHES_TODAY_SLOTS = 48;
/** One minute of a source's fetches: all succeeded, one failed, or none ran. */
export type FetchSlot = "ok" | "bad" | "none";
/** Minutes of fetches the open source shows. */
export const SOURCE_HOUR_MINUTES = 60;
/** One entry of a source's history: who created or changed it, or when it stopped delivering or delivered again. */
export type SourceEvent = {
  at: string;
  kind: "created" | "updated" | "stale" | "fresh";
  actor: { kind: "user" | "service_account"; name: string } | null;
};
/** An alert rule that concerns one source, as its open detail lists it. */
export type SourceAlert = {
  id: string;
  name: string;
  state: "ok" | "pending" | "firing" | "no_data" | "error";
  severity: "warn" | "critical" | null;
  /** Since when the rule is in its state. */
  since: string | null;
};
/** One minute of a source's fetches with the values they brought. */
export type FetchMinute = { slot: FetchSlot; values: number };
/**
 * Today's fetches of a base: how many succeeded and failed, and FETCHES_TODAY_SLOTS half-hour slots of the day in its
 * zone: "bad" once one fetch in the slot failed, "ok" when all succeeded, "none" without a fetch (also the hours ahead).
 */
export type FetchesToday = { ok: number; failed: number; slots: FetchSlot[] };

export type SourceFigures = {
  total: number;
  active: number;
  failingCount: number;
  /** The first three failing sources, newest failure first, with since when they fail. */
  failing: { id: string; name: string; since: string | null }[];
  /** Enabled sources that have never delivered: new ones waiting for their first values. */
  waiting: number;
  series: number;
  today: number | null;
  /** Today's fetches of the base's metrics sources; null when they could not be read. */
  fetchesToday: FetchesToday | null;
};

export type PulseSource = {
  seriesCount?: number;
  todayCount?: number | null;
  /** In lists, for metrics sources: the last FETCH_TICKS minutes of fetches, oldest first. */
  fetches?: FetchSlot[];
  id: string;
  baseId: string;
  kind: SourceKind;
  name: string;
  enabled: boolean;
  endpointUrl: string | null;
  bearerTokenConfigured: boolean;
  scrapeIntervalSeconds: number | null;
  metricFilters: string[];
  revision: number;
  expectEverySeconds: number | null;
  expectDailyBy: string | null;
  staleSince: string | null;
  status: {
    newestDataAt: string | null;
    throttled: boolean;
    throttledAt: string | null;
    refusedHistograms: { family: string; reason: string }[];
    skippedSummaries: number;
    lastError: string | null;
    lastErrorAt: string | null;
    /** Refused ingest requests sent with this source's key; absent in write responses and from older servers. */
    rejected?: PulseSourceRejections;
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
