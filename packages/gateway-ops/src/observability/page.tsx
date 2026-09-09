/**
 * Observability overview — the entry point the console did not have.
 *
 * The incident help document describes a diagnosis path (apps → routes →
 * telemetry → logs → storage → notifications), but the navigation offered
 * eight flat links and no starting point, so an operator had to guess which
 * page held the answer. This page answers one question — "is anything wrong
 * right now" — and links straight to the page that explains each signal.
 *
 * The page stays deliberately synthetic: source pages own detailed tables and
 * charts, while this entry point turns their aggregates into an operator queue.
 */

import { ButtonLink, Placeholder, StatCell, StatGrid, StatusBadge } from "@k2b/ui";
import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { logging, type TraceWindow, trace } from "@k2b/cloud/services";
import { AdminLayout } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import ObservabilityChart from "../frontend/ObservabilityChart.island";
import { buildGatewayHealth } from "../health";
import { gatewayOpsMessages } from "../messages";
import { buildOverviewSignals, type OverviewSignalSeverity, overviewVerdict } from "./overview";
import { DEFAULT_TELEMETRY_RANGE, isTelemetryRange, TELEMETRY_RANGES, type TelemetryRange } from "./telemetry/contracts";
import { getTelemetryOverview, getTelemetryTimeseries, listTelemetryRoutes } from "./telemetry/service";

const RANGE_KEYS = Object.keys(TELEMETRY_RANGES) as TelemetryRange[];

const signalIconClass = (severity: OverviewSignalSeverity): string => {
  if (severity === "critical") return "bg-red-500/10 text-red-700 dark:text-red-300";
  if (severity === "warning") return "bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return "bg-zinc-500/10 text-dimmed";
};

/** Reports a section that could not be read instead of rendering it as zero. */
const settled = async <T,>(load: () => Promise<T>, fallback: T): Promise<{ value: T; error: string | null }> => {
  try {
    return { value: await load(), error: null };
  } catch (error) {
    return { value: fallback, error: error instanceof Error ? error.message : String(error) };
  }
};

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = gatewayOpsMessages.resolve([locale]);
  const fmt = (value: number) => value.toLocaleString(locale);
  const url = new URL(c.req.url);
  const rangeParam = url.searchParams.get("range");
  const range = isTelemetryRange(rangeParam) ? rangeParam : DEFAULT_TELEMETRY_RANGE;
  const jobsWindow: TraceWindow = range === "6h" ? "12h" : range;

  const [health, telemetry, telemetryTimeseries, failingRoutes, logSummary, logTimeseries, jobStats] = await Promise.all([
    settled(() => buildGatewayHealth(), null),
    settled(() => getTelemetryOverview({ range }), null),
    settled(() => getTelemetryTimeseries({ range }), []),
    settled(() => listTelemetryRoutes({ range }, "errorRate", { errorsOnly: true, slowOnly: false }), []),
    settled(() => logging.summary(), null),
    settled(() => logging.timeseries({ sinceHours: TELEMETRY_RANGES[range].hours }), []),
    settled(() => trace.stats({ filter: { window: jobsWindow } }), null),
  ]);

  const offlineApps = health.value?.apps.filter((app) => app.status !== "ok") ?? [];
  const worstRoutes = failingRoutes.value.slice(0, 5);
  const signals = buildOverviewSignals(
    {
      range,
      jobsWindow,
      offlineApps: offlineApps.map((app) => app.id),
      serverErrors: telemetry.value?.serverErrors ?? 0,
      rateLimited: telemetry.value?.rateLimited ?? 0,
      failedRuns: jobStats.value?.failed ?? 0,
      stuckRuns: jobStats.value?.stuck ?? 0,
      logErrors: logSummary.value?.errors24h ?? 0,
      unavailable: {
        apps: health.error ?? undefined,
        telemetry: telemetry.error ?? telemetryTimeseries.error ?? failingRoutes.error ?? undefined,
        runs: jobStats.error ?? undefined,
        logs: logSummary.error ?? logTimeseries.error ?? undefined,
      },
    },
    locale,
  );
  const verdict = overviewVerdict(signals, locale);
  const serverErrorSeries = [
    {
      label: t.errors,
      data: telemetryTimeseries.value.map((point) => ({ x: new Date(point.at).getTime(), y: point.serverErrors })),
    },
  ];
  const logSeveritySeries = [
    {
      label: t.warnings,
      data: logTimeseries.value.map((point) => ({ x: point.at.getTime(), y: point.warn })),
    },
    {
      label: t.errors,
      data: logTimeseries.value.map((point) => ({ x: point.at.getTime(), y: point.error })),
    },
  ];
  const rangeUrl = (option: TelemetryRange) =>
    option === DEFAULT_TELEMETRY_RANGE ? "/admin/observability" : `/admin/observability?range=${option}`;

  return () => (
    <AdminLayout c={c} title={t.observability}>
      <div class="app-rows">
        <div class="min-w-0">
          <h1 class="text-base font-semibold text-primary">{t.observability}</h1>
          <p class="mt-1 text-xs text-dimmed">{t.observabilityDescription}</p>
        </div>

        <nav class="flex flex-wrap items-center gap-1" aria-label={t.trafficWindow}>
          <span class="mr-1 text-[10px] text-dimmed">{t.trafficWindow}</span>
          {RANGE_KEYS.map((option) => (
            <ButtonLink
              href={rangeUrl(option)}
              variant={option === range ? "primary" : "secondary"}
              size="sm"
              aria-current={option === range ? "true" : undefined}
            >
              {option}
            </ButtonLink>
          ))}
        </nav>

        <section class="paper p-3">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <StatusBadge tone={verdict.tone} label={t.currentState} variant="dot" />
              <h2 class="mt-1 text-base font-semibold text-primary">{verdict.label}</h2>
              <p class="mt-1 text-xs text-dimmed">{verdict.description}</p>
            </div>
            <span class="rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] px-2 py-1 text-[10px] tabular-nums text-dimmed">
              {signals.length === 0 ? t.allSignalsQuiet : t.openSignals({ count: signals.length })}
            </span>
          </div>

          {signals.length > 0 ? (
            <ul class="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {signals.map((signal) => (
                <li>
                  <a
                    href={signal.href}
                    class="group flex h-full items-start gap-2 rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-subtle)] p-3 transition-colors hover:bg-[var(--ui-hover)] focus-visible:outline-none focus-visible:[box-shadow:var(--ui-focus)]"
                  >
                    <span
                      class={`grid size-7 shrink-0 place-items-center rounded-[var(--ui-radius-control)] ${signalIconClass(signal.severity)}`}
                    >
                      <i class={signal.icon} aria-hidden="true" />
                    </span>
                    <span class="min-w-0 flex-1">
                      <span class="flex items-center justify-between gap-2 text-xs font-medium text-primary">
                        <span>{signal.title}</span>
                        <i class="ti ti-arrow-up-right shrink-0 text-dimmed group-hover:text-primary" aria-hidden="true" />
                      </span>
                      <span class="mt-1 block text-[10px] text-dimmed">{signal.detail}</span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p class="mt-3 rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-subtle)] p-3 text-xs text-secondary">
              {t.noSignalsHint}
            </p>
          )}
        </section>

        <StatGrid columns={5}>
          <StatCell
            label={t.appsOnline}
            value={health.value ? `${health.value.apps.length - offlineApps.length}/${health.value.apps.length}` : "—"}
            sub={health.error ? t.unavailable : t.registeredAppsLabel}
            href="/admin/gateway/apps"
            accent={offlineApps.length > 0 ? { tone: "red", icon: "ti ti-plug-connected-x" } : { tone: "emerald", icon: "ti ti-check" }}
          />
          <StatCell
            label={t.requests}
            value={telemetry.value ? fmt(telemetry.value.requests) : "—"}
            sub={telemetry.error ? t.unavailable : range}
            href={`/admin/observability/telemetry?range=${range}`}
          />
          <StatCell
            label={t.slowRequests}
            value={telemetry.value ? fmt(telemetry.value.slowRequests) : "—"}
            sub={telemetry.error ? t.unavailable : range}
            href={`/admin/observability/telemetry?range=${range}`}
          />
          <StatCell
            label={t.failedRuns}
            value={jobStats.value ? fmt(jobStats.value.failed) : "—"}
            sub={jobStats.error ? t.unavailable : jobsWindow}
            valueClass={(jobStats.value?.failed ?? 0) > 0 ? "text-amber-600 dark:text-amber-400" : "text-primary"}
            href={`/admin/observability/jobs?window=${jobsWindow}&health=failed`}
            accent={(jobStats.value?.failed ?? 0) > 0 ? { tone: "amber", icon: "ti ti-x" } : undefined}
          />
          <StatCell
            label={t.logWarnings}
            value={logSummary.value ? fmt(logSummary.value.warnings24h) : "—"}
            sub={logSummary.error ? t.unavailable : t.last24h}
            valueClass={(logSummary.value?.warnings24h ?? 0) > 0 ? "text-amber-600 dark:text-amber-400" : "text-primary"}
            href="/admin/observability/logs?level=warn"
          />
        </StatGrid>

        <section class="grid gap-2 xl:grid-cols-2">
          <article class="paper p-3">
            <div class="flex flex-wrap items-start justify-between gap-2">
              <div class="min-w-0">
                <h2 class="text-xs font-semibold text-primary">{t.serverErrorsOverTime}</h2>
                <p class="text-[10px] text-dimmed">{t.serverErrorsDescription}</p>
              </div>
              <ButtonLink href={`/admin/observability/telemetry?range=${range}`} variant="secondary" size="sm">
                {t.openTraffic}
                <i class="ti ti-arrow-up-right" aria-hidden="true" />
              </ButtonLink>
            </div>
            {telemetryTimeseries.error ? (
              <Placeholder state="error" variant="compact" description={telemetryTimeseries.error} />
            ) : telemetryTimeseries.value.length === 0 ? (
              <Placeholder variant="compact" description={t.noTrafficRecorded} />
            ) : (
              <ObservabilityChart
                kind="line"
                class="mt-2 h-56 w-full text-dimmed"
                series={serverErrorSeries}
                xFormat="timeline"
                yFormat="number"
                interactive
              />
            )}
          </article>

          <article class="paper p-3">
            <div class="flex flex-wrap items-start justify-between gap-2">
              <div class="min-w-0">
                <h2 class="text-xs font-semibold text-primary">{t.logSeverityOverTime}</h2>
                <p class="text-[10px] text-dimmed">{t.logSeverityDescription}</p>
              </div>
              <ButtonLink href={`/admin/observability/logs?window=${range}`} variant="secondary" size="sm">
                {t.openLogs}
                <i class="ti ti-arrow-up-right" aria-hidden="true" />
              </ButtonLink>
            </div>
            {logTimeseries.error ? (
              <Placeholder state="error" variant="compact" description={logTimeseries.error} />
            ) : (
              <ObservabilityChart
                kind="line"
                class="mt-2 h-56 w-full text-dimmed"
                series={logSeveritySeries}
                xFormat="timeline"
                yFormat="number"
                legend
                interactive
              />
            )}
          </article>
        </section>

        <section class="paper p-3">
          <h2 class="text-xs font-semibold text-primary">{t.failingRoutes}</h2>
          <p class="text-[10px] text-dimmed">{t.failingRoutesDescription}</p>
          {failingRoutes.error ? (
            <Placeholder state="error" variant="compact" description={failingRoutes.error} />
          ) : worstRoutes.length === 0 ? (
            <Placeholder variant="compact" description={t.noFailingRoutes} />
          ) : (
            <ul class="mt-2 flex flex-col gap-1">
              {worstRoutes.map((row) => (
                <li>
                  <a
                    href={`/admin/observability/telemetry?range=${range}&app=${encodeURIComponent(row.appId)}&route=${encodeURIComponent(row.route)}`}
                    class="flex items-baseline justify-between gap-3 hover:text-primary"
                  >
                    <code class="truncate text-[11px] text-primary">{row.route}</code>
                    <span class="shrink-0 text-[10px] tabular-nums text-red-500">
                      {fmt(row.errors)}/{fmt(row.requests)}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </AdminLayout>
  );
});
