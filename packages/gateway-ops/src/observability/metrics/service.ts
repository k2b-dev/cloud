import { listAppsDetailed } from "@valentinkolb/cloud";
import type { User } from "@valentinkolb/cloud/contracts";
import type { AuthContext } from "@valentinkolb/cloud/server";
import { listGatewayRouteSnapshots, logging, serviceAccountCredentials, serviceAccounts } from "@valentinkolb/cloud/services";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { getGridsOperationalSnapshot, listAppSloWindows } from "../../grids-operational-health";
import { listRegisteredAppStatus } from "../../registered-apps";
import { getPostgresDiagnostics, getRedisDiagnostics } from "../data/service";
import { getNatsClusterDiagnostics, getNatsInventorySummary } from "../nats/service";
import { natsMetricSamples } from "../nats/metrics";
import { getNatsConsumerMetricSamples } from "../nats/consumer-metrics";

export const METRICS_ENDPOINT = "/metrics";
export const METRICS_SCOPE = "metrics:read";
export const METRICS_SERVICE_ACCOUNT = {
  name: "Cloud metrics scrape",
  appId: "gateway-ops",
  resourceType: "metrics",
  resourceId: "cloud",
} as const;

const CACHE_TTL_MS = 15_000;
const COLLECTOR_TIMEOUT_MS = 2_500;
const TOP_REDIS_PREFIXES = 10;

type MetricType = "counter" | "gauge";
type MetricLabels = Record<string, string | number | boolean>;

type MetricSample = {
  name: string;
  help: string;
  type: MetricType;
  value: number;
  labels?: MetricLabels;
};

export type MetricsCollectorStatus = {
  id: string;
  name: string;
  description: string;
  metricNames: string[];
  status: "ok" | "degraded" | "error";
  durationMs: number;
  series: number;
  lastRunAt: string;
  error: string | null;
};

export type MetricsSnapshot = {
  generatedAt: string;
  expiresAt: number;
  text: string;
  series: number;
  collectors: MetricsCollectorStatus[];
};

export type MetricsToken = {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};

export type CreateMetricsTokenInput = {
  name: string;
  expiresAt?: string | null;
};

export type CreatedMetricsToken = {
  token: string;
  credential: MetricsToken;
};

type CollectorDefinition = {
  timeoutMs?: number;
  id: string;
  name: string;
  description: string;
  metricNames: string[];
  collect: () => Promise<MetricSample[]>;
  /**
   * Reports an unreachable backing source without failing the collector.
   *
   * Some diagnostics deliberately never throw — they degrade to an
   * `available: false` payload so the page can still render. The collector
   * then completed "successfully" and reported ok, which is how the
   * collectors tile showed all green while Postgres was down. Inspecting the
   * emitted samples keeps the `_up 0` series that Prometheus alerts on while
   * still marking the collector degraded.
   */
  degraded?: (samples: MetricSample[]) => string | null;
};

/** True when the collector emitted an explicit "backing source is up" gauge set to 0. */
export const upGaugeIsDown = (samples: MetricSample[], name: string): boolean =>
  samples.some((sample) => sample.name === name && sample.value === 0);

const seconds = (value: number): number => Math.floor(value / 1000);
const nowIso = (): string => new Date().toISOString();
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const finite = (value: number): number => (Number.isFinite(value) ? value : 0);

const escapeLabelValue = (value: string): string => value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');

const formatLabels = (labels: MetricLabels | undefined): string => {
  if (!labels || Object.keys(labels).length === 0) return "";
  const body = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}="${escapeLabelValue(String(value))}"`)
    .join(",");
  return `{${body}}`;
};

const formatMetricText = (samples: MetricSample[]): string => {
  const lines: string[] = ["# Cloud platform metrics exported by Gateway Ops.", `# Generated at ${nowIso()}`];
  const seen = new Set<string>();
  for (const sample of samples) {
    if (!seen.has(sample.name)) {
      seen.add(sample.name);
      lines.push(`# HELP ${sample.name} ${sample.help}`);
      lines.push(`# TYPE ${sample.name} ${sample.type}`);
    }
    lines.push(`${sample.name}${formatLabels(sample.labels)} ${finite(sample.value)}`);
  }
  lines.push("");
  return lines.join("\n");
};

const withTimeout = async <T>(label: string, promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const metricCatalog: CollectorDefinition[] = [
  {
    id: "gateway",
    name: "Gateway",
    description: "Gateway router instances, routes, and proxy request counters from route snapshots.",
    metricNames: [
      "cloud_gateway_instances",
      "cloud_gateway_route_count",
      "cloud_gateway_route_warnings",
      "cloud_gateway_requests_total",
      "cloud_gateway_errors_total",
      "cloud_gateway_request_duration_ms_total",
      "cloud_gateway_unmatched_requests_total",
    ],
    collect: async () => {
      const snapshots = await listGatewayRouteSnapshots();
      const latest = snapshots.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
      const byApp = new Map<string, { requests: number; errors: number; durationMs: number }>();
      for (const snapshot of snapshots) {
        for (const row of snapshot.stats.byApp) {
          const current = byApp.get(row.appId) ?? { requests: 0, errors: 0, durationMs: 0 };
          current.requests += row.count;
          current.errors += row.errors;
          current.durationMs += row.totalMs;
          byApp.set(row.appId, current);
        }
      }
      return [
        {
          name: "cloud_gateway_instances",
          help: "Number of active gateway router instances publishing route snapshots.",
          type: "gauge",
          value: snapshots.length,
        },
        {
          name: "cloud_gateway_route_count",
          help: "Number of route prefixes in the latest gateway route table.",
          type: "gauge",
          value: latest?.routeCount ?? 0,
        },
        {
          name: "cloud_gateway_route_warnings",
          help: "Number of route warnings in the latest gateway route table.",
          type: "gauge",
          value: latest?.routeWarnings.length ?? 0,
        },
        {
          name: "cloud_gateway_unmatched_requests_total",
          help: "Total unmatched requests observed by gateway routers since process start.",
          type: "counter",
          value: snapshots.reduce((sum, snapshot) => sum + snapshot.stats.noRouteCount, 0),
        },
        ...[...byApp.entries()].flatMap(([appId, row]) => [
          {
            name: "cloud_gateway_requests_total",
            help: "Total proxied requests observed by gateway routers since process start.",
            type: "counter" as const,
            value: row.requests,
            labels: { app_id: appId },
          },
          {
            name: "cloud_gateway_errors_total",
            help: "Total gateway proxy errors observed since process start.",
            type: "counter" as const,
            value: row.errors,
            labels: { app_id: appId },
          },
          {
            name: "cloud_gateway_request_duration_ms_total",
            help: "Total gateway proxy request duration in milliseconds since process start.",
            type: "counter" as const,
            value: Math.round(row.durationMs),
            labels: { app_id: appId },
          },
        ]),
      ];
    },
  },
  {
    id: "apps",
    name: "App Registry",
    description: "Registered app health derived from live registry heartbeats and persisted Gateway Ops state.",
    metricNames: [
      "cloud_app_registered_total",
      "cloud_app_online_total",
      "cloud_app_degraded_total",
      "cloud_app_offline_total",
      "cloud_app_up",
    ],
    collect: async () => {
      const liveApps = await listAppsDetailed();
      const apps = await listRegisteredAppStatus(liveApps);
      const online = apps.filter((app) => app.isOnline);
      const healthy = apps.filter((app) => app.live && app.live.expiresAt - Date.now() > 30_000);
      const offline = apps.filter((app) => !app.isOnline);
      const degraded = apps.length - healthy.length - offline.length;
      return [
        {
          name: "cloud_app_registered_total",
          help: "Number of apps registered in Gateway Ops.",
          type: "gauge",
          value: apps.length,
        },
        {
          name: "cloud_app_online_total",
          help: "Number of registered apps with a live registry entry.",
          type: "gauge",
          value: online.length,
        },
        {
          name: "cloud_app_degraded_total",
          help: "Number of registered apps with stale live registry state.",
          type: "gauge",
          value: degraded,
        },
        {
          name: "cloud_app_offline_total",
          help: "Number of registered apps without a live registry entry.",
          type: "gauge",
          value: offline.length,
        },
        ...apps.map((app) => ({
          name: "cloud_app_up",
          help: "Whether a registered app has a fresh live registry heartbeat.",
          type: "gauge" as const,
          value: app.live && app.live.expiresAt - Date.now() > 30_000 ? 1 : 0,
          labels: { app_id: app.id },
        })),
      ];
    },
  },
  {
    id: "logs",
    name: "Logs",
    description: "Log volume and warning/error counts from the logging service summary.",
    metricNames: [
      "cloud_logs_entries_total",
      "cloud_logs_entries_24h_total",
      "cloud_logs_errors_24h_total",
      "cloud_logs_warnings_24h_total",
      "cloud_logs_sources_total",
      "cloud_logs_last_error_timestamp_seconds",
    ],
    collect: async () => {
      const summary = await logging.summary();
      return [
        {
          name: "cloud_logs_entries_total",
          help: "Total retained log entries.",
          type: "gauge",
          value: summary.total,
        },
        {
          name: "cloud_logs_entries_24h_total",
          help: "Log entries created in the last 24 hours.",
          type: "gauge",
          value: summary.total24h,
        },
        {
          name: "cloud_logs_errors_24h_total",
          help: "Error log entries created in the last 24 hours.",
          type: "gauge",
          value: summary.errors24h,
        },
        {
          name: "cloud_logs_warnings_24h_total",
          help: "Warning log entries created in the last 24 hours.",
          type: "gauge",
          value: summary.warnings24h,
        },
        {
          name: "cloud_logs_sources_total",
          help: "Distinct log sources with retained entries.",
          type: "gauge",
          value: summary.sources,
        },
        {
          name: "cloud_logs_last_error_timestamp_seconds",
          help: "Unix timestamp of the latest retained error log, or zero when none exists.",
          type: "gauge",
          value: summary.lastErrorAt ? seconds(new Date(summary.lastErrorAt).getTime()) : 0,
        },
      ];
    },
  },
  {
    id: "grids",
    name: "Grids",
    description: "Grids query, event pipeline, workflow, and combined-table operational health.",
    metricNames: [
      "cloud_grids_installed",
      "cloud_grids_operational_status",
      "cloud_grids_record_event_outbox_entries",
      "cloud_grids_record_event_outbox_oldest_age_seconds",
      "cloud_grids_workflow_runs",
      "cloud_grids_workflow_oldest_queued_age_seconds",
      "cloud_grids_workflow_stale_running",
      "cloud_grids_workflow_effects",
      "cloud_grids_workflow_effect_oldest_age_seconds",
      "cloud_grids_federated_degraded",
      "cloud_grids_email_failures_24h",
      "cloud_grids_gql_requests_24h",
      "cloud_grids_gql_errors_24h",
      "cloud_grids_gql_duration_ms",
      "cloud_app_request_availability_ratio",
      "cloud_app_request_fast_ratio",
      "cloud_app_request_slo_observed_seconds",
    ],
    collect: async () => {
      const [snapshot, sloWindows] = await Promise.all([getGridsOperationalSnapshot(), listAppSloWindows("grids")]);
      if (!snapshot) {
        return [
          { name: "cloud_grids_installed", help: "Whether the Grids operational health view is installed.", type: "gauge", value: 0 },
        ];
      }
      return [
        { name: "cloud_grids_installed", help: "Whether the Grids operational health view is installed.", type: "gauge", value: 1 },
        ...(["ok", "warn", "error"] as const).map((status) => ({
          name: "cloud_grids_operational_status",
          help: "Current aggregate Grids operational status as a one-hot gauge.",
          type: "gauge" as const,
          value: snapshot.status === status ? 1 : 0,
          labels: { status },
        })),
        ...(
          [
            ["pending", snapshot.outboxPending],
            ["failed", snapshot.outboxFailed],
            ["dead", snapshot.outboxDead],
          ] as const
        ).map(([status, value]) => ({
          name: "cloud_grids_record_event_outbox_entries",
          help: "Retained Grids record events by actionable delivery status.",
          type: "gauge" as const,
          value,
          labels: { status },
        })),
        {
          name: "cloud_grids_record_event_outbox_oldest_age_seconds",
          help: "Age in seconds of the oldest pending or retrying Grids record event.",
          type: "gauge",
          value: snapshot.outboxOldestActiveAgeSeconds,
        },
        ...(
          [
            ["queued", snapshot.workflowQueued],
            ["running", snapshot.workflowRunning],
            ["waiting", snapshot.workflowWaiting],
            ["needs_attention", snapshot.workflowNeedsAttention],
          ] as const
        ).map(([status, value]) => ({
          name: "cloud_grids_workflow_runs",
          help: "Active or actionable Grids workflow runs by status.",
          type: "gauge" as const,
          value,
          labels: { status },
        })),
        {
          name: "cloud_grids_workflow_oldest_queued_age_seconds",
          help: "Age in seconds of the oldest queued Grids workflow run.",
          type: "gauge",
          value: snapshot.workflowOldestQueuedAgeSeconds,
        },
        {
          name: "cloud_grids_workflow_stale_running",
          help: "Grids workflow runs still marked running after their lease expired.",
          type: "gauge",
          value: snapshot.workflowStaleRunning,
        },
        ...(
          [
            ["executing", snapshot.effectsExecuting],
            ["needs_attention", snapshot.effectsNeedsAttention],
          ] as const
        ).map(([status, value]) => ({
          name: "cloud_grids_workflow_effects",
          help: "Active or actionable Grids workflow effects by status.",
          type: "gauge" as const,
          value,
          labels: { status },
        })),
        {
          name: "cloud_grids_workflow_effect_oldest_age_seconds",
          help: "Age in seconds of the oldest pending or executing Grids workflow effect.",
          type: "gauge",
          value: snapshot.effectsOldestActiveAgeSeconds,
        },
        {
          name: "cloud_grids_federated_degraded",
          help: "Current Grids combined-table revisions in degraded state.",
          type: "gauge",
          value: snapshot.federatedDegraded,
        },
        {
          name: "cloud_grids_email_failures_24h",
          help: "Failed Grids workflow email deliveries in the last 24 hours.",
          type: "gauge",
          value: snapshot.emailFailed24h,
        },
        {
          name: "cloud_grids_gql_requests_24h",
          help: "GQL executions traced in the last 24 hours.",
          type: "gauge",
          value: snapshot.gqlTotal24h,
        },
        {
          name: "cloud_grids_gql_errors_24h",
          help: "GQL diagnostics and runtime errors traced in the last 24 hours.",
          type: "gauge",
          value: snapshot.gqlErrors24h,
        },
        ...(
          [
            ["avg", snapshot.gqlAvgDurationMs24h],
            ["p99", snapshot.gqlP99DurationMs24h],
          ] as const
        ).map(([stat, value]) => ({
          name: "cloud_grids_gql_duration_ms",
          help: "GQL execution duration over the last 24 hours.",
          type: "gauge" as const,
          value,
          labels: { stat },
        })),
        ...sloWindows.flatMap((window) => [
          {
            name: "cloud_app_request_availability_ratio",
            help: "Gateway request availability ratio for a bounded SLO window.",
            type: "gauge" as const,
            value: window.availabilityRatio,
            labels: { app_id: "grids", window: window.window },
          },
          {
            name: "cloud_app_request_fast_ratio",
            help: "Share of gateway requests faster than the slow-request threshold.",
            type: "gauge" as const,
            value: window.fastRequestRatio,
            labels: { app_id: "grids", window: window.window },
          },
          {
            name: "cloud_app_request_slo_observed_seconds",
            help: "Observed history available inside an app request SLO window.",
            type: "gauge" as const,
            value: window.observedSeconds,
            labels: { app_id: "grids", window: window.window },
          },
        ]),
      ];
    },
  },
  {
    id: "postgres",
    degraded: (samples) => (upGaugeIsDown(samples, "cloud_postgres_up") ? "Postgres diagnostics unavailable" : null),
    name: "Postgres",
    description: "Postgres table, schema, extension, size, and warning diagnostics.",
    metricNames: [
      "cloud_postgres_up",
      "cloud_postgres_schema_count",
      "cloud_postgres_table_count",
      "cloud_postgres_relation_bytes_total",
      "cloud_postgres_extension_installed_total",
      "cloud_postgres_extension_available_total",
      "cloud_postgres_warnings_total",
      "cloud_postgres_connections",
      "cloud_postgres_connection_utilization_ratio",
      "cloud_postgres_lock_waits",
      "cloud_postgres_oldest_waiting_query_seconds",
      "cloud_postgres_oldest_transaction_seconds",
      "cloud_postgres_oldest_query_seconds",
      "cloud_postgres_deadlocks_total",
    ],
    collect: async () => {
      const diagnostics = await getPostgresDiagnostics();
      return [
        {
          name: "cloud_postgres_up",
          help: "Whether Postgres diagnostics were collected successfully.",
          type: "gauge",
          value: diagnostics.available ? 1 : 0,
        },
        {
          name: "cloud_postgres_schema_count",
          help: "Number of non-system Postgres schemas.",
          type: "gauge",
          value: diagnostics.schemas,
        },
        {
          name: "cloud_postgres_table_count",
          help: "Number of user tables reported by pg_stat_user_tables.",
          type: "gauge",
          value: diagnostics.tables,
        },
        {
          name: "cloud_postgres_relation_bytes_total",
          help: "Total relation bytes across user tables.",
          type: "gauge",
          value: diagnostics.totalBytes,
        },
        {
          name: "cloud_postgres_extension_installed_total",
          help: "Number of installed Postgres extensions.",
          type: "gauge",
          value: diagnostics.installedExtensions,
        },
        {
          name: "cloud_postgres_extension_available_total",
          help: "Number of available Postgres extensions.",
          type: "gauge",
          value: diagnostics.availableExtensions,
        },
        {
          name: "cloud_postgres_warnings_total",
          help: "Number of Postgres diagnostic warnings.",
          type: "gauge",
          value: diagnostics.warnings.length,
        },
        ...(
          [
            ["active", diagnostics.runtime.activeConnections],
            ["idle_in_transaction", diagnostics.runtime.idleInTransaction],
            ["total", diagnostics.runtime.connections],
            ["max", diagnostics.runtime.maxConnections],
          ] as const
        ).map(([state, value]) => ({
          name: "cloud_postgres_connections",
          help: "Postgres connections by bounded operational state.",
          type: "gauge" as const,
          value,
          labels: { state },
        })),
        {
          name: "cloud_postgres_connection_utilization_ratio",
          help: "Share of configured Postgres connections currently in use.",
          type: "gauge",
          value: diagnostics.runtime.maxConnections > 0 ? diagnostics.runtime.connections / diagnostics.runtime.maxConnections : 0,
        },
        {
          name: "cloud_postgres_lock_waits",
          help: "Postgres connections currently waiting on a lock.",
          type: "gauge",
          value: diagnostics.runtime.waitingLocks,
        },
        {
          name: "cloud_postgres_oldest_waiting_query_seconds",
          help: "Runtime in seconds of the oldest Postgres query currently waiting on a lock.",
          type: "gauge",
          value: diagnostics.runtime.oldestWaitingQuerySeconds,
        },
        {
          name: "cloud_postgres_oldest_transaction_seconds",
          help: "Age in seconds of the oldest current Postgres transaction.",
          type: "gauge",
          value: diagnostics.runtime.oldestTransactionSeconds,
        },
        {
          name: "cloud_postgres_oldest_query_seconds",
          help: "Age in seconds of the oldest active Postgres query.",
          type: "gauge",
          value: diagnostics.runtime.oldestQuerySeconds,
        },
        {
          name: "cloud_postgres_deadlocks_total",
          help: "Postgres deadlocks reported since database statistics were reset.",
          type: "counter",
          value: diagnostics.runtime.deadlocks,
        },
      ];
    },
  },
  {
    id: "redis",
    degraded: (samples) => (upGaugeIsDown(samples, "cloud_redis_up") ? "Redis diagnostics unavailable" : null),
    name: "Redis",
    description: "Redis keyspace, expiry, TTL, and bounded prefix sample diagnostics.",
    metricNames: [
      "cloud_redis_up",
      "cloud_redis_keys_total",
      "cloud_redis_keys_expiring_total",
      "cloud_redis_avg_ttl_ms",
      "cloud_redis_sampled_keys",
      "cloud_redis_scan_complete",
      "cloud_redis_prefix_sample_keys",
      "cloud_redis_warnings_total",
    ],
    collect: async () => {
      const diagnostics = await getRedisDiagnostics();
      const keyspaceSamples = diagnostics.keyspace.flatMap((row) => [
        {
          name: "cloud_redis_keys_total",
          help: "Redis keys reported by INFO keyspace.",
          type: "gauge" as const,
          value: row.keys,
          labels: { database: row.database },
        },
        {
          name: "cloud_redis_keys_expiring_total",
          help: "Redis keys with expiry reported by INFO keyspace.",
          type: "gauge" as const,
          value: row.expires,
          labels: { database: row.database },
        },
        {
          name: "cloud_redis_avg_ttl_ms",
          help: "Redis average TTL in milliseconds reported by INFO keyspace.",
          type: "gauge" as const,
          value: row.avgTtlMs,
          labels: { database: row.database },
        },
      ]);
      const prefixSamples = diagnostics.prefixes
        .filter((row) => row.depth === 1)
        .slice(0, TOP_REDIS_PREFIXES)
        .map((row) => ({
          name: "cloud_redis_prefix_sample_keys",
          help: "Bounded Redis key prefix sample count. Prefix labels are sampled and limited.",
          type: "gauge" as const,
          value: row.count,
          labels: { depth: row.depth, prefix: row.prefix },
        }));

      return [
        {
          name: "cloud_redis_up",
          help: "Whether Redis diagnostics were collected successfully.",
          type: "gauge",
          value: diagnostics.available ? 1 : 0,
        },
        {
          name: "cloud_redis_sampled_keys",
          help: "Number of Redis keys included in the bounded SCAN sample.",
          type: "gauge",
          value: diagnostics.sampledKeys,
        },
        {
          name: "cloud_redis_scan_complete",
          help: "Whether the Redis SCAN completed before the sample cap.",
          type: "gauge",
          value: diagnostics.scanComplete ? 1 : 0,
        },
        {
          name: "cloud_redis_warnings_total",
          help: "Number of Redis diagnostic warnings.",
          type: "gauge",
          value: diagnostics.warnings.length,
        },
        ...keyspaceSamples,
        ...prefixSamples,
      ];
    },
  },
];

metricCatalog.push({
  id: "nats",
  name: "NATS and Sync",
  description: "Broker capacity, replication and complete account-level Sync inventory.",
  timeoutMs: 12_000,
  metricNames: [
    "cloud_nats_cluster_configured",
    "cloud_nats_cluster_up",
    "cloud_nats_inventory_up",
    "cloud_nats_jetstream_enabled",
    "cloud_nats_node_storage_bytes",
    "cloud_nats_node_storage_limit_bytes",
    "cloud_nats_node_memory_bytes",
    "cloud_nats_node_memory_limit_bytes",
    "cloud_nats_meta_replicas_unhealthy",
    "cloud_nats_account_streams",
    "cloud_nats_account_storage_bytes",
    "cloud_sync_streams",
    "cloud_sync_storage_bytes",
    "cloud_sync_messages",
    "cloud_sync_consumers",
    "cloud_sync_dead_letters",
    "cloud_sync_streams_replication_unhealthy",
    "cloud_nats_consumer_inventory_up",
    "cloud_nats_consumers_pending",
    "cloud_nats_consumers_ack_pending",
    "cloud_nats_consumers_redelivered",
    "cloud_sync_consumers_pending",
    "cloud_sync_consumers_ack_pending",
    "cloud_sync_consumers_redelivered",
  ],
  collect: async () => {
    const [cluster, inventory] = await Promise.all([getNatsClusterDiagnostics(), getNatsInventorySummary()]);
    return [...natsMetricSamples(cluster, inventory), ...(await getNatsConsumerMetricSamples(inventory))];
  },
  degraded: (samples) =>
    upGaugeIsDown(samples, "cloud_nats_inventory_up") ||
    upGaugeIsDown(samples, "cloud_nats_consumer_inventory_up") ||
    (samples.some((sample) => sample.name === "cloud_nats_cluster_configured" && sample.value === 1) &&
      upGaugeIsDown(samples, "cloud_nats_cluster_up"))
      ? "NATS diagnostics are unavailable or incomplete."
      : null,
});

export const metricsCollectors = metricCatalog.map(({ id, name, description, metricNames }) => ({ id, name, description, metricNames }));

const selfMetric = (name: string, help: string, value: number, labels?: MetricLabels): MetricSample => ({
  name,
  help,
  type: "gauge",
  value,
  labels,
});

const runCollector = async (collector: CollectorDefinition): Promise<{ status: MetricsCollectorStatus; samples: MetricSample[] }> => {
  const start = performance.now();
  const lastRunAt = nowIso();
  try {
    const samples = await withTimeout(collector.name, collector.collect(), collector.timeoutMs ?? COLLECTOR_TIMEOUT_MS);
    const degraded = collector.degraded?.(samples) ?? null;
    return {
      samples,
      status: {
        id: collector.id,
        name: collector.name,
        description: collector.description,
        metricNames: collector.metricNames,
        status: degraded ? "degraded" : "ok",
        durationMs: Math.round(performance.now() - start),
        series: samples.length,
        lastRunAt,
        error: degraded,
      },
    };
  } catch (error) {
    return {
      samples: [],
      status: {
        id: collector.id,
        name: collector.name,
        description: collector.description,
        metricNames: collector.metricNames,
        status: "error",
        durationMs: Math.round(performance.now() - start),
        series: 0,
        lastRunAt,
        error: errorMessage(error),
      },
    };
  }
};

let cachedSnapshot: MetricsSnapshot | null = null;
let pendingSnapshot: Promise<MetricsSnapshot> | null = null;

const buildMetricsSnapshot = async (): Promise<MetricsSnapshot> => {
  const generatedAt = nowIso();
  const collected = await Promise.all(metricCatalog.map(runCollector));
  const statuses = collected.map((result) => result.status);
  const samples = collected.flatMap((result) => result.samples);
  for (const status of statuses) {
    samples.push(
      selfMetric(
        "cloud_metrics_collector_success",
        "Whether a Cloud metrics collector completed successfully.",
        status.status === "ok" ? 1 : 0,
        {
          collector: status.id,
        },
      ),
      selfMetric("cloud_metrics_collector_duration_ms", "Cloud metrics collector duration in milliseconds.", status.durationMs, {
        collector: status.id,
      }),
      selfMetric("cloud_metrics_collector_series", "Number of metric series emitted by a Cloud metrics collector.", status.series, {
        collector: status.id,
      }),
    );
  }
  samples.push(
    selfMetric("cloud_metrics_cache_ttl_seconds", "Configured Gateway Ops metrics cache TTL in seconds.", CACHE_TTL_MS / 1000),
    selfMetric(
      "cloud_metrics_generated_timestamp_seconds",
      "Unix timestamp when the Gateway Ops metrics payload was generated.",
      seconds(Date.now()),
    ),
  );
  return {
    generatedAt,
    expiresAt: Date.now() + CACHE_TTL_MS,
    text: formatMetricText(samples),
    series: samples.length,
    collectors: statuses,
  };
};

export const getMetricsSnapshot = async (): Promise<MetricsSnapshot> => {
  if (cachedSnapshot && cachedSnapshot.expiresAt > Date.now()) return cachedSnapshot;
  if (pendingSnapshot) return pendingSnapshot;
  pendingSnapshot = buildMetricsSnapshot()
    .then((snapshot) => {
      cachedSnapshot = snapshot;
      return snapshot;
    })
    .finally(() => {
      pendingSnapshot = null;
    });
  return pendingSnapshot;
};

export const getCachedMetricsSnapshot = (): MetricsSnapshot | null => cachedSnapshot;

const tokenFromCredential = (credential: {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}): MetricsToken => ({
  id: credential.id,
  name: credential.name,
  tokenPrefix: credential.tokenPrefix,
  scopes: credential.scopes,
  expiresAt: credential.expiresAt,
  lastUsedAt: credential.lastUsedAt,
  createdAt: credential.createdAt,
});

export const getOrCreateMetricsServiceAccount = async (actor: User): Promise<Result<{ id: string }>> => {
  const result = await serviceAccounts.getOrCreateResourceBound({
    ...METRICS_SERVICE_ACCOUNT,
    createdBy: actor.id,
  });
  if (!result.ok) return result;
  return ok({ id: result.data.id });
};

export const listMetricsTokens = async (): Promise<MetricsToken[]> => {
  const serviceAccount = await serviceAccounts.getByResource(METRICS_SERVICE_ACCOUNT);
  if (!serviceAccount) return [];
  const page = await serviceAccountCredentials.listOverview({
    pagination: { page: 1, perPage: 500 },
    filter: {
      serviceAccountId: serviceAccount.id,
      credentialStatus: "active",
    },
  });
  return page.items.map(tokenFromCredential);
};

export const createMetricsToken = async (input: CreateMetricsTokenInput, actor: User): Promise<Result<CreatedMetricsToken>> => {
  const serviceAccount = await getOrCreateMetricsServiceAccount(actor);
  if (!serviceAccount.ok) return fail(serviceAccount.error);
  const result = await serviceAccountCredentials.createResourceApiToken({
    serviceAccountId: serviceAccount.data.id,
    actor,
    name: input.name,
    expiresAt: input.expiresAt ?? null,
    scopes: [METRICS_SCOPE],
  });
  if (!result.ok) return result;
  return ok({
    token: result.data.token,
    credential: tokenFromCredential(result.data.credential),
  });
};

export const revokeMetricsToken = async (credentialId: string, actor: User): Promise<Result<void>> => {
  const serviceAccount = await serviceAccounts.getByResource(METRICS_SERVICE_ACCOUNT);
  if (!serviceAccount) return fail(err.notFound("Metrics service account"));
  const page = await serviceAccountCredentials.listOverview({
    pagination: { page: 1, perPage: 500 },
    filter: { serviceAccountId: serviceAccount.id, credentialStatus: "active" },
  });
  if (!page.items.some((item) => item.id === credentialId)) return fail(err.notFound("Metrics token"));
  return serviceAccountCredentials.revoke({ credentialId, actor });
};

export const canReadMetrics = (actor: AuthContext["Variables"]["actor"] | undefined): boolean => {
  if (!actor) return false;
  if (actor.kind === "user") return actor.user.roles.includes("admin");
  return (
    actor.serviceAccount.kind === "resource_bound" &&
    actor.serviceAccount.status === "active" &&
    actor.serviceAccount.appId === METRICS_SERVICE_ACCOUNT.appId &&
    actor.serviceAccount.resourceType === METRICS_SERVICE_ACCOUNT.resourceType &&
    actor.serviceAccount.resourceId === METRICS_SERVICE_ACCOUNT.resourceId &&
    actor.scopes.includes(METRICS_SCOPE)
  );
};
