/**
 * Instance-wide entry points: `status` for a quick verdict and `diagnose`
 * for the bounded, agent-oriented troubleshooting bundle.
 */
import { command, flag } from "../index";
import type { PostgresDiagnostics, RedisDiagnostics } from "./data";
import type { GatewayHealth } from "./gateway";
import type { BackgroundJobRow } from "./jobs";
import { getLogs, type LogSummary, trimLogMessages } from "./logs";
import type { NatsSnapshot } from "./nats";
import type { SyncOverview } from "./sync";
import type { MetricsCollector } from "./metrics";
import { apiGet, formatBytes, parseLookbackHours, printJsonOrTable, queryString, safeCollect, skippedCollect, truncate } from "./shared";
import type { TelemetryEvent, TelemetryRouteRow } from "./telemetry";
import { diagnoseRange } from "./telemetry";

export const DIAGNOSE_SECTIONS = ["health", "logs", "telemetry", "jobs", "postgres", "redis", "metrics", "sync", "nats"] as const;
export type DiagnoseSection = (typeof DIAGNOSE_SECTIONS)[number];

export const parseDiagnoseSections = (value: string | undefined, label: string): Set<DiagnoseSection> | null => {
  if (!value) return null;
  const sections = new Set<DiagnoseSection>();
  for (const raw of value.split(",")) {
    const section = raw.trim();
    if (!section) continue;
    if (!DIAGNOSE_SECTIONS.includes(section as DiagnoseSection)) {
      throw new Error(`${label} must contain only: ${DIAGNOSE_SECTIONS.join(", ")}.`);
    }
    sections.add(section as DiagnoseSection);
  }
  return sections;
};

export const instanceCommands = [
  command("status", {
    summary: "Show gateway and app health",
    run: async ({ ctx }) => {
      const health = await apiGet<GatewayHealth>(ctx, "/api/gateway/health");
      const row = {
        status: health.status,
        apps: health.summary.apps,
        healthy: health.summary.healthy,
        degraded: health.summary.degraded,
        offline: health.summary.offline,
        routes: health.summary.routes,
        requests: health.summary.requests,
        errors: health.summary.errors,
      };
      printJsonOrTable(
        ctx,
        health,
        [row],
        [
          { key: "status" },
          { key: "apps" },
          { key: "healthy" },
          { key: "degraded" },
          { key: "offline" },
          { key: "routes" },
          { key: "requests" },
          { key: "errors" },
        ],
      );
    },
  }),
  command("diagnose", {
    summary: "Collect a bounded diagnostics bundle for agents",
    flags: {
      since: flag.string({ default: "24h", description: "Lookback window like 30m, 6h, or 7d" }),
      logLimit: flag.int({ name: "log-limit", default: 20, min: 1, max: 50, description: "Recent error/warn logs per level" }),
      include: flag.string({ description: "Comma-separated sections: health,logs,telemetry,jobs,postgres,redis,metrics,sync,nats" }),
      skip: flag.string({ description: "Comma-separated sections to skip" }),
      messageLength: flag.int({
        name: "message-length",
        default: 500,
        min: 40,
        max: 5000,
        description: "Log message length in JSON bundle",
      }),
      fullLogs: flag.boolean({ name: "full-logs", description: "Do not trim log messages in the JSON bundle" }),
    },
    run: async ({ ctx, flags }) => {
      const hours = parseLookbackHours(flags.since);
      const logLimit = flags.logLimit ?? 20;
      const include = parseDiagnoseSections(flags.include, "--include");
      const skip = parseDiagnoseSections(flags.skip, "--skip");
      const shouldCollect = (section: DiagnoseSection) => (!include || include.has(section)) && !skip?.has(section);
      const [
        health,
        logSummary,
        logErrors,
        logWarnings,
        telemetrySummary,
        telemetryErrors,
        failingRoutes,
        jobs,
        postgres,
        redis,
        metrics,
        sync,
        nats,
      ] = await Promise.all([
        shouldCollect("health")
          ? safeCollect("gateway health", () => apiGet<GatewayHealth>(ctx, "/api/gateway/health"))
          : skippedCollect("gateway health"),
        shouldCollect("logs")
          ? safeCollect("log summary", () => apiGet<LogSummary>(ctx, "/api/logging/summary"))
          : skippedCollect("log summary"),
        shouldCollect("logs")
          ? safeCollect("error logs", () => getLogs(ctx, { level: "error", sinceHours: hours, perPage: logLimit }))
          : skippedCollect("error logs"),
        shouldCollect("logs")
          ? safeCollect("warning logs", () => getLogs(ctx, { level: "warn", sinceHours: hours, perPage: logLimit }))
          : skippedCollect("warning logs"),
        shouldCollect("telemetry")
          ? safeCollect("telemetry summary", () =>
              apiGet<Record<string, number | null>>(ctx, `/api/gateway/telemetry/summary${queryString({ hours })}`),
            )
          : skippedCollect("telemetry summary"),
        shouldCollect("telemetry")
          ? safeCollect("telemetry errors", () =>
              apiGet<{ items: TelemetryEvent[]; total: number }>(
                ctx,
                `/api/gateway/telemetry/events${queryString({ errors: "1", hours, page: 1, per_page: Math.min(logLimit, 50) })}`,
              ),
            )
          : skippedCollect("telemetry errors"),
        // The single most useful line in the bundle: a total request count
        // says nothing when one route dominates traffic, whereas a ranked
        // list names the endpoints actually failing.
        shouldCollect("telemetry")
          ? safeCollect("failing routes", () =>
              apiGet<{ items: TelemetryRouteRow[] }>(
                ctx,
                `/api/gateway/telemetry/routes${queryString({ range: diagnoseRange(hours), sort: "errorRate", errors: "1", limit: 10 })}`,
              ),
            )
          : skippedCollect("failing routes"),
        shouldCollect("jobs")
          ? safeCollect("background jobs", () =>
              apiGet<{ items: BackgroundJobRow[] }>(ctx, `/api/gateway/jobs${queryString({ health: "failed" })}`),
            )
          : skippedCollect("background jobs"),
        shouldCollect("postgres")
          ? safeCollect("postgres", () => apiGet<PostgresDiagnostics>(ctx, "/api/gateway/data/postgres"))
          : skippedCollect("postgres"),
        shouldCollect("redis")
          ? safeCollect("redis", () => apiGet<RedisDiagnostics>(ctx, "/api/gateway/data/redis"))
          : skippedCollect("redis"),
        shouldCollect("metrics")
          ? safeCollect("metrics", () =>
              apiGet<{ generatedAt: string; series: number; collectors: MetricsCollector[] }>(ctx, "/api/gateway/metrics/snapshot"),
            )
          : skippedCollect("metrics"),
        shouldCollect("sync")
          ? safeCollect("sync", async () => {
              const snapshot = await apiGet<SyncOverview>(ctx, "/api/gateway/sync?problems=true");
              // Support bundles need failure context, not user payload previews.
              return { ...snapshot, deadLetters: snapshot.deadLetters.map(({ dataPreview: _preview, ...entry }) => entry) };
            })
          : skippedCollect("sync"),
        shouldCollect("nats")
          ? safeCollect("nats", () => apiGet<NatsSnapshot>(ctx, "/api/gateway/nats?problems=true&limit=20"))
          : skippedCollect("nats"),
      ]);
      const bundle = {
        generatedAt: new Date().toISOString(),
        lookbackHours: hours,
        health,
        logs: {
          summary: logSummary,
          errors:
            logErrors.ok && !flags.fullLogs
              ? { ...logErrors, data: trimLogMessages(logErrors.data, flags.messageLength ?? 500) }
              : logErrors,
          warnings:
            logWarnings.ok && !flags.fullLogs
              ? { ...logWarnings, data: trimLogMessages(logWarnings.data, flags.messageLength ?? 500) }
              : logWarnings,
        },
        telemetry: { summary: telemetrySummary, errors: telemetryErrors, failingRoutes },
        jobs,
        postgres,
        redis,
        metrics,
        sync,
        nats,
      };
      if (ctx.options.output === "json") {
        ctx.json(bundle);
        return;
      }

      const lines = ["Cloud admin diagnose", `lookback: ${hours}h`, ""];
      if (health.ok) {
        lines.push(
          `gateway: ${health.data.status}`,
          `apps: ${health.data.summary.healthy ?? 0} healthy, ${health.data.summary.degraded ?? 0} degraded, ${health.data.summary.offline ?? 0} offline`,
        );
      } else lines.push(`gateway: unavailable (${health.error})`);
      if (logSummary.ok) {
        lines.push(
          `logs: ${logSummary.data.errors24h} errors / ${logSummary.data.warnings24h} warnings in 24h, ${logSummary.data.total} retained`,
        );
      } else lines.push(`logs: unavailable (${logSummary.error})`);
      if (telemetrySummary.ok) {
        lines.push(`telemetry: ${telemetrySummary.data.requests ?? 0} requests, ${telemetrySummary.data.errors ?? 0} errors`);
      } else lines.push(`telemetry: unavailable (${telemetrySummary.error})`);
      if (failingRoutes.ok) {
        const worst = failingRoutes.data.items.slice(0, 3);
        lines.push(
          worst.length === 0
            ? "failing routes: none"
            : `failing routes: ${worst.map((row) => `${row.route} ${row.errors}/${row.requests}`).join(", ")}`,
        );
      } else if (!("skipped" in failingRoutes)) lines.push(`failing routes: unavailable (${failingRoutes.error})`);
      if (jobs.ok)
        lines.push(`failing jobs: ${jobs.data.items.length === 0 ? "none" : jobs.data.items.map((row) => row.source).join(", ")}`);
      else if (!("skipped" in jobs)) lines.push(`failing jobs: unavailable (${jobs.error})`);
      if (postgres.ok)
        lines.push(
          `postgres: ${postgres.data.tables} tables, ${formatBytes(postgres.data.totalBytes)}, ${postgres.data.warnings.length} warnings`,
        );
      else lines.push(`postgres: unavailable (${postgres.error})`);
      if (redis.ok) lines.push(`redis: ${redis.data.dbSize} keys, ${redis.data.warnings.length} warnings`);
      else lines.push(`redis: unavailable (${redis.error})`);
      if (metrics.ok) {
        const failed = metrics.data.collectors.filter((collector) => collector.status !== "ok");
        lines.push(`metrics: ${metrics.data.series} series, ${failed.length} failed collectors`);
      } else lines.push(`metrics: unavailable (${metrics.error})`);
      if (sync.ok)
        lines.push(
          `sync: ${sync.data.resources.length} resources needing attention; ${sync.data.deadLetters.length}${sync.data.truncatedStores.length ? "+" : ""} sampled dead letters; ${sync.data.apps.filter((app) => app.status !== "ok").length} unavailable apps`,
        );
      else if (!("skipped" in sync)) lines.push(`sync: unavailable (${sync.error})`);
      if (nats.ok)
        lines.push(
          `nats: cluster ${nats.data.cluster.status}; inventory ${nats.data.inventory.status}; ${nats.data.inventory.matchedTotal ?? "unknown"} streams needing attention`,
        );
      else if (!("skipped" in nats)) lines.push(`nats: unavailable (${nats.error})`);
      if (logErrors.ok && logErrors.data.entries.length > 0) {
        lines.push("", "recent errors:");
        for (const entry of logErrors.data.entries.slice(0, 5)) {
          lines.push(`- [${entry.createdAt}] ${entry.source}: ${truncate(entry.message, 140)} (#${entry.id})`);
        }
      }
      ctx.print(lines.join("\n"));
    },
  }),
];
