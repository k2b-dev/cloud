import { Button, ButtonLink, DataTable, type DataTableColumn, IconButtonLink, Pagination, Placeholder, StatCell, StatGrid, useLocale } from "@k2b/ui";
import { createPagination } from "@valentinkolb/cloud/contracts";
import { type AuthContext, getDateConfig, getLocale } from "@valentinkolb/cloud/server";
import { type TraceListFilter, type TraceRunStats, type TraceSourceGroup, type TraceSpan, trace } from "@valentinkolb/cloud/services";
import {
  formatDate,
  formatDurationMs as formatMs,
  formatNumber,
  formatPercent,
  formatDateTime as formatTimestamp,
} from "@valentinkolb/cloud/shared";
import { AdminLayout } from "@valentinkolb/cloud/ssr";
import { ssr } from "../../config";
import ObservabilityChart from "../../frontend/ObservabilityChart.island";
import JobsActionToast from "./_components/JobsActionToast.island";
import JobsFilterBar from "./_components/JobsFilterBar.island";
import RunDetailPanel from "./_components/RunDetailPanel";
import {
  buildJobsFilterUrl,
  type JobsFilterState,
  jobsDurationOptions,
  jobsWindowOptions,
  minDurationFromFilter,
  parseJobsFilterFromUrl,
} from "./_components/types";
import {
  type BackgroundJobOverviewRow,
  buildBackgroundJobRows,
  buildJobTimelineRows,
  filterBackgroundJobRows,
  jobsObservabilityService,
} from "./service";
import { gatewayOpsMessages, type GatewayOpsMessages } from "../../messages";

const baseUrl = "/admin/observability/jobs";

/**
 * A schedule can legitimately be a little late — the handler polls, the tick
 * lands a moment after the minute. Only a clear overshoot means it stopped.
 */
const OVERDUE_GRACE_MS = 2 * 60 * 1000;

const formatDuration = (ms: number): string => {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
};

const windowLabel = (filter: JobsFilterState, t: GatewayOpsMessages): string => {
  if (filter.window === "10m") return t.lastMinutes({ count: 10 }).toLowerCase();
  if (filter.window === "12h") return t.lastHours({ count: 12 }).toLowerCase();
  if (filter.window === "24h") return t.lastHours({ count: 24 }).toLowerCase();
  return t.lastDays({ count: filter.window === "30d" ? 30 : 7 }).toLowerCase();
};

const durationLabel = (filter: JobsFilterState, t: GatewayOpsMessages): string =>
  filter.duration === "all" ? t.allDurations : (jobsDurationOptions.find((option) => option.value === filter.duration)?.label ?? t.allDurations);

const runKey = (span: Pick<TraceSpan, "traceId" | "spanId">): string => `${span.traceId}:${span.spanId}`;

const parseRunKey = (value: string | null): { traceId: string; spanId: string } | null => {
  if (!value) return null;
  const [traceId, spanId] = value.split(":");
  if (!traceId || !spanId) return null;
  if (!/^[a-f0-9]{32}$/i.test(traceId) || !/^[a-f0-9]{16}$/i.test(spanId)) return null;
  return { traceId, spanId };
};

const traceFilterFromJobs = (filter: JobsFilterState): TraceListFilter => {
  const traceFilter: TraceListFilter = {
    window: filter.window,
    excludeDefinitions: true,
    search: filter.search || undefined,
    source: filter.source ?? undefined,
    category: filter.type === "all" ? undefined : filter.type,
    minDurationMs: minDurationFromFilter(filter.duration),
  };

  if (filter.health === "failed") traceFilter.status = "error";
  if (filter.health === "running") traceFilter.active = true;
  if (filter.health === "healthy") traceFilter.status = "ok";

  return traceFilter;
};

const statusBadge = (input: { status: string | null; running?: boolean }) => {
  const { t } = gatewayOpsMessages.resolve([useLocale()()]);
  if (input.running) {
    return (
      <span class="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-950/40 dark:text-blue-200">
        {t.running}
      </span>
    );
  }
  if (input.status === "error") {
    return (
      <span class="rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-950/40 dark:text-red-200">{t.failed}</span>
    );
  }
  if (input.status === "ok") {
    return (
      <span class="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200">
        {t.healthy}
      </span>
    );
  }
  return <span class="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-dimmed dark:bg-zinc-900">{t.unset}</span>;
};

const groupHealth = (group: TraceSourceGroup) => {
  if (group.latestStartedAt && !group.latestEndedAt) return statusBadge({ status: group.latestStatus, running: true });
  return statusBadge({ status: group.latestStatus });
};

const rowHealth = (row: BackgroundJobOverviewRow) => (row.trace ? groupHealth(row.trace) : statusBadge({ status: null }));

const stateBadge = (row: BackgroundJobOverviewRow) => {
  const { t } = gatewayOpsMessages.resolve([useLocale()()]);
  if (row.kind === "trace") {
    if (row.trace.categories.includes("backfill")) {
      return (
        <span class="inline-flex items-center gap-1 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-950/40 dark:text-blue-200">
          <i class="ti ti-database-import" aria-hidden="true" />
          {t.backfill}
        </span>
      );
    }
    return <span class="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-dimmed dark:bg-zinc-900">{t.traceOnly}</span>;
  }
  if (row.state === "available") {
    return (
      <span class="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200">
        {t.available}
      </span>
    );
  }
  return (
    <span class="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
      {t.unavailable}
    </span>
  );
};

const summarize = (summary: Record<string, unknown> | null): string => {
  if (!summary) return "-";
  const entries = Object.entries(summary).filter(([, value]) => value !== null && value !== undefined);
  if (entries.length === 0) return "-";
  return entries
    .slice(0, 4)
    .map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
    .join(" · ");
};

const paginationBaseUrl = (filter: JobsFilterState): string => {
  const url = buildJobsFilterUrl(baseUrl, { page: 1, run: null }, filter);
  return url.includes("?") ? `${url}&page=` : `${url}?page=`;
};

const sourceUrl = (filter: JobsFilterState, source: string): string => buildJobsFilterUrl(baseUrl, { source, page: 1, run: null }, filter);

const runUrl = (filter: JobsFilterState, span: TraceSpan): string => buildJobsFilterUrl(baseUrl, { run: runKey(span) }, filter);

const closeRunUrl = (filter: JobsFilterState): string => buildJobsFilterUrl(baseUrl, { run: null }, filter);

const statsGrid = (stats: TraceRunStats, filter: JobsFilterState) => {
  const locale = useLocale();
  const { t } = gatewayOpsMessages.resolve([locale()]);
  return <StatGrid columns={6}>
    <StatCell label={t.sources} value={formatNumber(stats.sources, { locale: locale() })} sub={filter.source ? t.selectedSource : t.jobFamilies} />
    <StatCell label={t.runs} value={formatNumber(stats.runs, { locale: locale() })} sub={windowLabel(filter, t)} />
    <StatCell
      label={t.failed}
      value={formatNumber(stats.failed, { locale: locale() })}
      sub={t.errorRateValue({ value: formatPercent(stats.errorRate, { locale: locale() }) })}
      valueClass={stats.failed > 0 ? "text-red-500" : "text-primary"}
      accent={stats.failed > 0 ? { tone: "red", icon: "ti ti-alert-circle" } : { tone: "emerald", icon: "ti ti-check" }}
    />
    <StatCell
      label={t.running}
      value={formatNumber(stats.running, { locale: locale() })}
      sub={t.inFlightNow}
      accent={stats.running > 0 ? { tone: "blue", icon: "ti ti-loader" } : undefined}
    />
    <StatCell
      label={t.stuck}
      value={formatNumber(stats.stuck, { locale: locale() })}
      sub={t.openAbandoned}
      valueClass={stats.stuck > 0 ? "text-red-500" : "text-primary"}
      accent={stats.stuck > 0 ? { tone: "red", icon: "ti ti-plug-connected-x" } : undefined}
      href={stats.stuck > 0 ? buildJobsFilterUrl(baseUrl, { health: "stuck" }, filter) : undefined}
    />
    <StatCell
      label="P99"
      value={formatMs(stats.p99DurationMs, { locale: locale() })}
      sub={
        stats.anomalous > 0
          ? t.averageExcluded({ average: formatMs(stats.avgDurationMs, { locale: locale() }), count: formatNumber(stats.anomalous, { locale: locale() }) })
          : t.average({ value: formatMs(stats.avgDurationMs, { locale: locale() }) })
      }
      title={
        stats.anomalous > 0
          ? t.anomalousRunsExcluded({ count: formatNumber(stats.anomalous, { locale: locale() }) })
          : undefined
      }
    />
  </StatGrid>;
};

const sourceSubtitle = (group: TraceSourceGroup, t: GatewayOpsMessages, locale: string): string => {
  if (group.categories.length === 1 && group.categories[0] === "backfill") {
    return t.backfillRuns({ count: formatNumber(group.runs, { locale }) });
  }
  const parts = [t.sourceRunCounts({ jobs: formatNumber(group.jobRuns, { locale }), jobCount: group.jobRuns, schedules: formatNumber(group.scheduleRuns, { locale }), scheduleCount: group.scheduleRuns })];
  if (group.aiRuns) parts.push(t.aiRunsShort({ count: formatNumber(group.aiRuns, { locale }) }));
  if (group.customRuns) parts.push(t.customRunsShort({ count: formatNumber(group.customRuns, { locale }) }));
  return parts.join(" · ");
};

const overviewSubtitle = (row: BackgroundJobOverviewRow, t: GatewayOpsMessages, locale: string): string => {
  const parts = [row.family];
  if (row.resourceKind) parts.push(row.resourceKind);
  if (row.resourceLabel) parts.push(row.resourceLabel);
  if (row.kind === "schedule") parts.push(`${row.schedulerId} / ${row.scheduleId}`);
  else parts.push(sourceSubtitle(row.trace, t, locale));
  return parts.join(" · ");
};

const DetailLink = (props: { row: BackgroundJobOverviewRow }) => {
  const { t } = gatewayOpsMessages.resolve([useLocale()()]);
  if (!props.row.detailHref) return null;
  return (
    <ButtonLink variant="ghost" size="sm" href={props.row.detailHref} title={t.openOwningResource}>
      <i class="ti ti-external-link" />
      {t.open}
    </ButtonLink>
  );
};

const RunNowButton = (props: { row: BackgroundJobOverviewRow; filter: JobsFilterState }) => {
  const { t } = gatewayOpsMessages.resolve([useLocale()()]);
  if (props.row.kind !== "schedule") return null;
  const disabled = props.row.state !== "available";
  return (
    <form method="post" action="/admin/observability/jobs/run-now" class="inline-flex justify-end">
      <input type="hidden" name="schedulerId" value={props.row.schedulerId} />
      <input type="hidden" name="scheduleId" value={props.row.scheduleId} />
      <input type="hidden" name="redirectTo" value={buildJobsFilterUrl(baseUrl, { run: null }, props.filter)} />
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        disabled={disabled}
        title={disabled ? props.row.lastError || t.noSchedulerHandler : t.requestManualRun}
      >
        <i class="ti ti-player-play" />
        {t.runNow}
      </Button>
    </form>
  );
};

const ActionCell = (props: { row: BackgroundJobOverviewRow; filter: JobsFilterState }) => {
  const hasDetail = Boolean(props.row.detailHref);
  const hasRun = props.row.kind === "schedule";
  if (!hasDetail && !hasRun) return <span class="text-[10px] text-dimmed">-</span>;
  return (
    <div class="inline-flex flex-wrap justify-end gap-1">
      <DetailLink row={props.row} />
      <RunNowButton row={props.row} filter={props.filter} />
    </div>
  );
};

const OverviewTable = (props: { rows: BackgroundJobOverviewRow[]; filter: JobsFilterState }) => {
  const locale = useLocale();
  const { t } = gatewayOpsMessages.resolve([locale()]);
  const columns: DataTableColumn<BackgroundJobOverviewRow>[] = [
    { id: "source", header: t.scheduleSource, value: (row) => row.source, cellClass: "min-w-[280px]" },
    { id: "control", header: t.control, subtitle: t.handler, value: (row) => row.state },
    { id: "health", header: t.latest, subtitle: t.traceRun, value: (row) => row.trace?.latestStatus ?? "" },
    { id: "runs", header: t.runs, value: (row) => row.trace?.runs ?? 0, headerClass: "text-right", cellClass: "text-right" },
    { id: "failed", header: t.failed, subtitle: t.errorRate, value: (row) => row.trace?.failed ?? 0, headerClass: "text-right", cellClass: "text-right" },
    { id: "runtime", header: t.runtime, subtitle: t.averageP99, value: (row) => row.trace?.avgDurationMs ?? 0, headerClass: "text-right", cellClass: "text-right" },
    { id: "next", header: t.next, subtitle: t.scheduled, value: (row) => row.nextRunAt ?? 0, cellClass: "whitespace-nowrap" },
    { id: "action", header: "", value: (row) => row.scheduleId ?? row.source, headerClass: "text-right", cellClass: "text-right" },
  ];
  return <section class="paper overflow-hidden">
    <div class="px-3 py-2">
      <h2 class="text-xs font-semibold text-primary">{t.schedulesAndFamilies}</h2>
      <p class="text-[10px] text-dimmed">{t.schedulesAndFamiliesDescription}</p>
    </div>
    <DataTable
      rows={props.rows}
      columns={columns}
      getRowId={(row) => (row.kind === "schedule" ? `${row.schedulerId}:${row.scheduleId}` : `trace:${row.source}`)}
      hoverRows
      highlightColumns={false}
      density="compact"
      class="overflow-x-auto"
      empty={t.noJobSources}
      renderCell={({ row, col }) => {
        if (col.id === "source")
          return (
            <a href={sourceUrl(props.filter, row.source)} class="block min-w-0 hover:text-blue-600 dark:hover:text-blue-300">
              <span class="block truncate text-[11px] font-medium text-primary">{row.label}</span>
              <span class="block truncate text-[10px] text-dimmed">{overviewSubtitle(row, t, locale())}</span>
            </a>
          );
        if (col.id === "control") return stateBadge(row);
        if (col.id === "health") return rowHealth(row);
        if (col.id === "runs") return <span class="text-[10px] tabular-nums text-dimmed">{formatNumber(row.trace?.runs ?? 0, { locale: locale() })}</span>;
        if (col.id === "failed")
          return (
            <span class="text-[10px] tabular-nums text-dimmed">
              {formatNumber(row.trace?.failed ?? 0, { locale: locale() })} · {formatPercent(row.trace?.errorRate ?? 0, { locale: locale() })}
            </span>
          );
        if (col.id === "runtime")
          return (
            <span class="text-[10px] tabular-nums text-dimmed">
              {formatMs(row.trace?.avgDurationMs ?? null, { locale: locale() })} / {formatMs(row.trace?.p99DurationMs ?? null, { locale: locale() })}
            </span>
          );
        if (col.id === "next") {
          // A schedule whose next run is already in the past is not "due soon",
          // it has stopped firing — the failure mode a plain timestamp hides.
          const overdueMs = row.nextRunAt ? Date.now() - row.nextRunAt : 0;
          return overdueMs > OVERDUE_GRACE_MS ? (
            <span
              class="text-[10px] text-red-500"
              title={t.expectedAt({ time: formatTimestamp(row.nextRunAt === null ? null : new Date(row.nextRunAt), { locale: locale() }) })}
            >
              {t.overdue({ duration: formatDuration(overdueMs) })}
            </span>
          ) : (
            <span class="text-[10px] text-dimmed">{formatTimestamp(row.nextRunAt === null ? null : new Date(row.nextRunAt), { locale: locale() })}</span>
          );
        }
        if (col.id === "action") return <ActionCell row={row} filter={props.filter} />;
        return "";
      }}
    />
  </section>;
};

const SourceRunsTable = (props: {
  spans: TraceSpan[];
  total: number;
  pagination: ReturnType<typeof createPagination>;
  filter: JobsFilterState;
  selectedRunKey: string | null;
}) => {
  const locale = useLocale();
  const { t } = gatewayOpsMessages.resolve([locale()]);
  const columns: DataTableColumn<TraceSpan>[] = [
    { id: "started", header: t.started, value: (row) => row.startedAt, cellClass: "whitespace-nowrap" },
    { id: "name", header: t.run, value: (row) => row.name, cellClass: "min-w-[240px]" },
    { id: "type", header: t.type, value: (row) => row.category },
    { id: "status", header: t.status, value: (row) => row.status },
    { id: "duration", header: t.duration, value: (row) => row.durationMs, headerClass: "text-right", cellClass: "text-right" },
    { id: "events", header: t.events, value: (row) => row.eventCount, headerClass: "text-right", cellClass: "text-right" },
    { id: "summary", header: t.summary, value: (row) => summarize(row.summary) },
  ];
  return <section class="paper overflow-hidden">
    <div class="px-3 py-2">
      <h2 class="text-xs font-semibold text-primary">{t.runs}</h2>
      <p class="text-[10px] text-dimmed">{t.runsCountAndDuration({ count: formatNumber(props.spans.length, { locale: locale() }), total: formatNumber(props.total, { locale: locale() }), duration: durationLabel(props.filter, t) })}</p>
    </div>
    <DataTable
      rows={props.spans}
      columns={columns}
      getRowId={runKey}
      selectedRowId={props.selectedRunKey}
      hoverRows
      highlightColumns={false}
      density="compact"
      class="overflow-x-auto"
      empty={t.noMatchingRuns}
      renderCell={({ row, col }) => {
        if (col.id === "started") return <span class="text-[10px] text-dimmed">{formatDate(row.startedAt, { locale: locale() })}</span>;
        if (col.id === "name")
          return (
            <a href={runUrl(props.filter, row)} class="block min-w-0 hover:text-blue-600 dark:hover:text-blue-300">
              <span class="block truncate text-[11px] font-medium text-primary">{row.name}</span>
              <span class="block truncate text-[10px] text-dimmed">{row.spanKey ?? row.spanId}</span>
            </a>
          );
        if (col.id === "type") return <span class="text-[10px] text-dimmed">{row.category}</span>;
        if (col.id === "status") return statusBadge({ status: row.status, running: !row.endedAt });
        if (col.id === "duration") return <span class="text-[10px] tabular-nums text-dimmed">{formatMs(row.durationMs, { locale: locale() })}</span>;
        if (col.id === "events") return <span class="text-[10px] tabular-nums text-dimmed">{formatNumber(row.eventCount, { locale: locale() })}</span>;
        if (col.id === "summary") return <span class="block max-w-[360px] truncate text-[10px] text-dimmed">{summarize(row.summary)}</span>;
        return "";
      }}
    />
    <div class="px-3 py-2">
      <Pagination currentPage={props.pagination.page} totalPages={props.pagination.total_pages} baseUrl={paginationBaseUrl(props.filter)} />
    </div>
  </section>;
};

type JobsActionFeedback = { tone: "error"; message: string } | null;

const parseActionFeedback = (url: URL, t: GatewayOpsMessages): JobsActionFeedback => {
  const status = url.searchParams.get("job_action");
  if (status === "error") return { tone: "error", message: url.searchParams.get("job_message") || t.scheduleRunRequestFailed };
  return null;
};

const FeedbackBanner = (props: { feedback: JobsActionFeedback }) => {
  if (!props.feedback) return null;
  return (
    <div class="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
      <i class="ti ti-alert-circle" /> {props.feedback.message}
    </div>
  );
};

const ControlWarning = (props: { error: string | null }) => {
  const { t } = gatewayOpsMessages.resolve([useLocale()()]);
  return props.error ? (
    <div class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
      <i class="ti ti-alert-triangle" /> {t.schedulerUnavailable({ error: props.error })}
    </div>
  ) : null;
};

export default ssr<AuthContext>(async (c) => {
  const url = new URL(c.req.url);
  const locale = getLocale(c);
  const dateConfig = getDateConfig(c);
  const { t } = gatewayOpsMessages.resolve([locale]);
  const filter = parseJobsFilterFromUrl(url);
  const actionFeedback = parseActionFeedback(url, t);
  const traceFilter = traceFilterFromJobs(filter);
  const perPage = 100;
  const paginationInput = { page: filter.page, perPage, offset: (filter.page - 1) * perPage };
  const selectedRun = parseRunKey(filter.run);
  const schedulesPromise = filter.source
    ? Promise.resolve({ schedules: [], error: null as string | null })
    : jobsObservabilityService
        .listSchedules()
        .then((schedules) => ({ schedules, error: null as string | null }))
        .catch((error) => ({ schedules: [], error: error instanceof Error ? error.message : String(error) }));

  const [stats, groups, listResult, selectedSpan, selectedEvents, scheduleResult, timelineResult] = await Promise.all([
    trace.stats({ filter: traceFilter }),
    filter.source ? Promise.resolve([]) : trace.sourceGroups({ filter: traceFilter }),
    filter.source ? trace.list(paginationInput, { filter: traceFilter }) : Promise.resolve({ spans: [], total: 0 }),
    selectedRun ? trace.getSpan(selectedRun) : Promise.resolve(null),
    selectedRun ? trace.events({ ...selectedRun, limit: 200 }) : Promise.resolve([]),
    schedulesPromise,
    // Lanes need the individual runs; the overview table only has aggregates.
    trace.list({ page: 1, perPage: 2000, offset: 0 }, { filter: traceFilter }).catch(() => ({ spans: [], total: 0 })),
  ]);
  const windowSeconds = jobsWindowOptions.find((option) => option.value === filter.window)?.seconds ?? 86_400;
  const timelineWindow = { fromMs: Date.now() - windowSeconds * 1000, toMs: Date.now() };
  const rawTimelineRows = buildJobTimelineRows(timelineResult.spans, timelineWindow);

  const pagination = createPagination(paginationInput, listResult.total);
  const selectedRunKey = selectedSpan ? runKey(selectedSpan) : filter.run;
  const overviewRows = filterBackgroundJobRows(buildBackgroundJobRows(scheduleResult.schedules, groups), {
    search: filter.search,
    type: filter.type,
    health: filter.health,
    requireTraceMatch: filter.duration !== "all",
  });
  const labelsBySource = new Map(overviewRows.map((row) => [row.source, row.label]));
  const timelineStateLabel = {
    ok: t.succeeded,
    error: t.failed,
    running: t.running,
    stuck: t.neverFinished,
  } as const;
  const timelineRows = rawTimelineRows.map((row) => {
    const label = labelsBySource.get(row.source) ?? row.label;
    return {
      label,
      href: sourceUrl(filter, row.source),
      tooltip: label === row.source ? row.source : `${label} (${row.source})`,
      intervals: row.intervals.map((interval) => {
        const statusMessage = interval.statusMessage?.trim();
        const tooltip = [
          interval.name,
          timelineStateLabel[interval.state],
          formatTimestamp(new Date(interval.startedAt), dateConfig),
          interval.durationMs === null ? null : formatMs(interval.durationMs, { locale }),
          statusMessage ? statusMessage.slice(0, 160) : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return {
          ...interval,
          href: buildJobsFilterUrl(baseUrl, { source: row.source, run: `${interval.traceId}:${interval.spanId}`, page: 1 }, filter),
          tooltip,
        };
      }),
    };
  });

  return () => (
    <AdminLayout c={c} title={t.backgroundJobs}>
      <JobsActionToast />
      <div class="app-rows">
        <div class="min-w-0" style="view-transition-name: admin-jobs-title">
          <div class="flex items-center gap-2">
            {filter.source ? (
              <IconButtonLink
                href={buildJobsFilterUrl(baseUrl, { source: null, run: null, page: 1 }, filter)}
                size="sm"
                label={t.backToJobSources}
              >
                <i class="ti ti-arrow-left" />
              </IconButtonLink>
            ) : null}
            <div class="min-w-0">
              <h1 class="truncate text-base font-semibold text-primary">{filter.source ?? t.backgroundJobs}</h1>
              <p class="mt-1 text-xs text-dimmed">
                {filter.source
                  ? t.sourceRunsDescription({ window: windowLabel(filter, t) })
                  : t.jobsDescription}
              </p>
            </div>
          </div>
        </div>

        {statsGrid(stats, filter)}

        <section class="paper p-3">
          <h2 class="text-xs font-semibold text-primary">{t.runTimeline}</h2>
          <p class="text-[10px] text-dimmed">{t.runTimelineDescription}</p>
          {timelineResult.total > timelineResult.spans.length ? (
            <p class="mt-1 text-[10px] text-amber-700 dark:text-amber-300">
              {t.timelineSample({ count: formatNumber(timelineResult.spans.length, { locale }), total: formatNumber(timelineResult.total, { locale }) })}
            </p>
          ) : null}
          {timelineRows.length === 0 ? (
            <Placeholder variant="compact" description={t.noRunsWindow} />
          ) : (
            <ObservabilityChart
              kind="stateTimeline"
              class="mt-2 w-full text-dimmed"
              rows={timelineRows}
              domain={[timelineWindow.fromMs, timelineWindow.toMs]}
              states={[
                { state: "ok", label: t.succeeded, color: "#10b981" },
                { state: "error", label: t.failed, color: "#ef4444" },
                { state: "running", label: t.running, color: "#3b82f6" },
                { state: "stuck", label: t.neverFinished, color: "#f59e0b" },
              ]}
              xFormat="timeline"
              legend
              interactive
            />
          )}
        </section>
        <FeedbackBanner feedback={actionFeedback} />
        <ControlWarning error={scheduleResult.error} />

        <section class="paper p-3">
          <JobsFilterBar filter={filter} />
        </section>

        {filter.source ? (
          <div class={selectedSpan ? "grid min-h-0 gap-2 xl:grid-cols-[minmax(0,1fr)_26rem]" : "min-h-0"}>
            <SourceRunsTable
              spans={listResult.spans}
              total={listResult.total}
              pagination={pagination}
              filter={filter}
              selectedRunKey={selectedRunKey}
            />
            {selectedSpan ? (
              <RunDetailPanel
                span={selectedSpan}
                events={selectedEvents}
                status={statusBadge({ status: selectedSpan.status, running: !selectedSpan.endedAt })}
                closeHref={closeRunUrl(filter)}
              />
            ) : null}
          </div>
        ) : (
          <OverviewTable rows={overviewRows} filter={filter} />
        )}
      </div>
    </AdminLayout>
  );
});
