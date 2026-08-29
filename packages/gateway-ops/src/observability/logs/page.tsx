import { ButtonLink, Pagination, Placeholder, StatCell, StatGrid } from "@k2b/ui";
import { type AuthContext, getLocale } from "@valentinkolb/cloud/server";
import { get } from "@valentinkolb/cloud/services";
import { AdminLayout } from "@valentinkolb/cloud/ssr";
import { ssr } from "../../config";
import ObservabilityChart from "../../frontend/ObservabilityChart.island";
import LogTable from "./_components/LogTable.island";
import { buildLogFilterUrl, LOG_WINDOWS } from "./_components/types";

const LOGS_PAGE_PATH = "/admin/observability/logs";

const LOG_WINDOW_KEYS = Object.keys(LOG_WINDOWS) as (keyof typeof LOG_WINDOWS)[];

import { parseLogFilterFromUrl } from "./_components/types";
import { createPagination } from "./contracts";
import { loggingService } from "./service";
import { gatewayOpsMessages } from "../../messages";

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = gatewayOpsMessages.resolve([locale]);
  const url = new URL(c.req.url);
  const filter = parseLogFilterFromUrl(url);

  const perPage = 100;
  const pagination = { page: filter.page, perPage, offset: (filter.page - 1) * perPage };
  const scopedFilter = {
    sources: filter.sources.length > 0 ? filter.sources : undefined,
    level: filter.level !== "all" ? filter.level : undefined,
    search: filter.search || undefined,
    sinceHours: LOG_WINDOWS[filter.window],
  };

  // A logging backend that is down must degrade the page, not 500 it: the
  // operator still needs the rest of the console to diagnose why.
  const [listResult, sources, summary, sourceStats, timeseriesResult] = await Promise.all([
    loggingService.entry
      .list({
        pagination,
        filter: scopedFilter,
      })
      .then((result) => ({ result, error: null as string | null }))
      .catch((error) => ({ result: { items: [], total: 0 }, error: error instanceof Error ? error.message : String(error) })),
    loggingService.source.list().catch(() => []),
    loggingService.stats.summary().catch(() => null),
    loggingService.stats.by({ groupBy: "source", limit: 1, ...scopedFilter }).catch(() => []),
    loggingService.stats
      .timeseries(scopedFilter)
      .then((points) => ({ points, error: null as string | null }))
      .catch((error) => ({ points: [], error: error instanceof Error ? error.message : String(error) })),
  ]);
  const { items: entries, total } = listResult.result;
  const loadError = listResult.error;
  const timeseries = timeseriesResult.points;
  const statsUnavailable = Boolean(loadError || timeseriesResult.error);
  const topSource = sourceStats[0] ?? null;
  const windowTotals = timeseries.reduce(
    (sum, point) => ({
      total: sum.total + point.total,
      warn: sum.warn + point.warn,
      error: sum.error + point.error,
    }),
    { total: 0, warn: 0, error: 0 },
  );
  const levelSeries = (
    [
      [t.debug, "debug"],
      [t.info, "info"],
      [t.warn, "warn"],
      [t.error, "error"],
    ] as const
  )
    .filter(([, level]) => filter.level === "all" || filter.level === level)
    .map(([label, level]) => ({
      label,
      data: timeseries.map((point) => ({ x: point.at.getTime(), y: point[level] })),
    }));

  const paginationResult = createPagination(pagination, total);
  const baseUrl = (() => {
    const withoutPage = buildLogFilterUrl(LOGS_PAGE_PATH, { page: 1 }, filter);
    return withoutPage.includes("?") ? `${withoutPage}&page=` : `${withoutPage}?page=`;
  })();

  const rawRetention = await get<unknown>("logs.retention_days");
  const retentionDays = typeof rawRetention === "number" ? rawRetention : 30;

  return () => (
    <AdminLayout c={c} title={t.logs}>
      <div class="app-rows">
        <div class="min-w-0" style="view-transition-name: admin-logs-title">
          <h1 class="text-base font-semibold text-primary">{t.logs}</h1>
          <p class="mt-1 text-xs text-dimmed">{t.logsDescription}</p>
        </div>

        {loadError ? (
          <Placeholder
            state="error"
            surface="paper"
            icon="ti ti-database-off"
            title={t.logStoreUnavailable}
            description={loadError}
          />
        ) : null}

        <nav class="flex flex-wrap items-center gap-1" aria-label={t.logWindow}>
          <span class="mr-1 text-[10px] text-dimmed">{t.window}</span>
          {LOG_WINDOW_KEYS.map((option) => (
            <ButtonLink
              href={buildLogFilterUrl(LOGS_PAGE_PATH, { window: option, page: 1 }, filter)}
              variant={option === filter.window ? "primary" : "secondary"}
              size="sm"
              aria-current={option === filter.window ? "true" : undefined}
            >
              {option}
            </ButtonLink>
          ))}
        </nav>

        {/* Stat cards — see skills/cloud-app/references/frontend.md § Stats */}
        <StatGrid columns={5}>
          <StatCell
            label={t.errors}
            value={statsUnavailable ? "—" : windowTotals.error.toLocaleString(locale)}
            sub={statsUnavailable ? t.unavailable : filter.window}
            valueClass={windowTotals.error > 0 ? "text-red-500" : "text-primary"}
            href={buildLogFilterUrl(LOGS_PAGE_PATH, { level: "error", page: 1 }, filter)}
            accent={windowTotals.error > 0 ? { tone: "red", icon: "ti ti-alert-circle" } : undefined}
          />
          <StatCell
            label={t.warnings}
            value={statsUnavailable ? "—" : windowTotals.warn.toLocaleString(locale)}
            sub={statsUnavailable ? t.unavailable : filter.window}
            valueClass={windowTotals.warn > 0 ? "text-amber-600 dark:text-amber-400" : "text-primary"}
            href={buildLogFilterUrl(LOGS_PAGE_PATH, { level: "warn", page: 1 }, filter)}
            accent={windowTotals.warn > 0 ? { tone: "amber", icon: "ti ti-alert-triangle" } : undefined}
          />
          <StatCell
            label={t.volume}
            value={statsUnavailable ? "—" : windowTotals.total.toLocaleString(locale)}
            sub={t.matchingFilters({ window: filter.window })}
          />
          <StatCell
            label={t.noisiestSource}
            value={topSource ? topSource.key : "—"}
            sub={topSource ? t.logEntriesCount({ count: topSource.count }) : t.noEntriesInWindow}
            href={topSource ? buildLogFilterUrl(LOGS_PAGE_PATH, { sources: [topSource.key], page: 1 }, filter) : undefined}
            accent={{ tone: "blue", icon: "ti ti-stack-3" }}
          />
          <StatCell label={t.retained} value={summary ? summary.total.toLocaleString(locale) : "—"} sub={t.autoPruneDays({ days: retentionDays })} />
        </StatGrid>

        <section class="paper p-3">
          <h2 class="text-xs font-semibold text-primary">{t.volumeOverTime}</h2>
          <p class="text-[10px] text-dimmed">{t.volumeOverTimeDescription}</p>
          {timeseriesResult.error ? (
            <Placeholder state="error" variant="compact" description={timeseriesResult.error} />
          ) : (
            <ObservabilityChart
              kind="line"
              class="mt-2 h-64 w-full text-dimmed"
              series={levelSeries}
              xFormat="timeline"
              yFormat="number"
              legend
              interactive
            />
          )}
        </section>

        <LogTable entries={entries} total={total} filter={filter} sources={sources} retentionDays={retentionDays} />
        <Pagination currentPage={paginationResult.page} totalPages={paginationResult.total_pages} baseUrl={baseUrl} />
      </div>
    </AdminLayout>
  );
});
