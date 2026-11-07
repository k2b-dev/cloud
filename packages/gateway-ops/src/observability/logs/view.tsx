import { formatDateTime, formatNumber } from "@k2b/cloud/shared";
import { AppWorkspace, ButtonLink, CopyButton, Placeholder, StatCell, StatGrid } from "@k2b/ui";
import OperationalCharts from "../../frontend/OperationalCharts.island";
import { prepareOperationalCharts } from "../../frontend/operational-charts";
import RangeTabs from "../../frontend/RangeTabs";
import { gatewayOpsMessages } from "../../messages";
import { type Attention, areaText, ObservabilityArea, ObservabilityPane } from "../_components/ObservabilityArea";
import LogEntryDetail from "./_components/LogEntryDetail.island";
import LogTable from "./_components/LogTable.island";
import { LEVEL } from "./_components/log-levels";
import { buildLogFilterUrl, LOG_WINDOWS, type LogFilterState } from "./_components/types";
import type { LoggingService } from "./service";

export const LOGS_PAGE_PATH = "/admin/observability/logs";
/** The log table needs this much room; at 1440 px the first column gives way beside an open entry. */
const LOG_LIST_MIN_WIDTH = 640;
/** The open entry: message, fields and metadata stay readable beside the list. */
const LOG_ENTRY_MIN_WIDTH = 420;
const LOG_WINDOW_KEYS = Object.keys(LOG_WINDOWS) as (keyof typeof LOG_WINDOWS)[];

type Stats = LoggingService["stats"];
export type LogsViewProps = {
  c: Parameters<typeof ObservabilityArea>[0]["c"];
  locale: string;
  timeZone: string;
  attention: Attention;
  filter: LogFilterState;
  entries: Parameters<typeof LogTable>[0]["entries"];
  total: number;
  totalPages: number;
  baseUrl: string;
  sources: string[];
  loadError: string | null;
  summary: Awaited<ReturnType<Stats["summary"]>> | null;
  topSource: Awaited<ReturnType<Stats["by"]>>[number] | null;
  timeseriesResult: { points: Awaited<ReturnType<Stats["timeseries"]>>; error: string | null };
  retentionDays: number;
  selectedId: string | null;
  selected: { entry: Awaited<ReturnType<LoggingService["entry"]["get"]>>; error: string | null } | null;
  retryHref: string;
};

/** Logs as a wide list beside the first column, and the open entry in the detail column. */
export function LogsView(props: LogsViewProps) {
  const { c, locale, timeZone, attention, filter, entries, total, totalPages, baseUrl, sources, loadError, summary, topSource } = props;
  const { timeseriesResult, retentionDays, selectedId, selected, retryHref } = props;
  const { t } = gatewayOpsMessages.resolve([locale]);
  const timeseries = timeseriesResult.points;
  const statsUnavailable = Boolean(loadError || timeseriesResult.error);
  const windowTotals = timeseries.reduce(
    (sum, point) => ({ total: sum.total + point.total, warn: sum.warn + point.warn, error: sum.error + point.error }),
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
    .map(([label, level]) => ({ label, data: timeseries.map((point) => ({ x: point.at.getTime(), y: point[level] })) }));
  const listHref = buildLogFilterUrl(LOGS_PAGE_PATH, {}, filter);
  const selectedLevel = selected?.entry ? LEVEL[selected.entry.level] : undefined;
  return (
    <ObservabilityArea c={c} locale={locale} section="logs" attention={attention} level={selectedId ? "detail" : "section"}>
      <ObservabilityPane label={areaText(locale).logs} description={t.logsDescription} href={listHref} minSize={LOG_LIST_MIN_WIDTH}>
        <RangeTabs
          caption={t.window}
          label={t.logWindow}
          current={filter.window}
          items={LOG_WINDOW_KEYS.map((option) => ({
            id: option,
            href: buildLogFilterUrl(LOGS_PAGE_PATH, { window: option, page: 1 }, filter),
          }))}
        />

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
            sub={
              topSource
                ? t.logEntriesCount({ count: topSource.count, formattedCount: formatNumber(topSource.count, { locale }) })
                : t.noEntriesInWindow
            }
            href={topSource ? buildLogFilterUrl(LOGS_PAGE_PATH, { sources: [topSource.key], page: 1 }, filter) : undefined}
            accent={{ tone: "blue", icon: "ti ti-stack-3" }}
          />
          <StatCell
            label={t.retained}
            value={summary ? `≈ ${summary.total.toLocaleString(locale)}` : "—"}
            sub={t.autoPruneDays({ days: retentionDays })}
          />
        </StatGrid>

        <section>
          {timeseriesResult.error ? (
            <Placeholder state="error" variant="compact" description={timeseriesResult.error} />
          ) : (
            <OperationalCharts
              columns={2}
              charts={prepareOperationalCharts(
                [
                  {
                    kind: "line",
                    title: t.volumeOverTime,
                    description: t.volumeOverTimeDescription,
                    series: levelSeries,
                    maxGap: timeseries.length > 1 ? timeseries[1]!.at.getTime() - timeseries[0]!.at.getTime() : undefined,
                  },
                  {
                    kind: "line",
                    title: `${t.warn} / ${t.error}`,
                    series: levelSeries.filter((series) => series.label === t.warn || series.label === t.error),
                    maxGap: timeseries.length > 1 ? timeseries[1]!.at.getTime() - timeseries[0]!.at.getTime() : undefined,
                  },
                ],
                locale,
              )}
            />
          )}
        </section>

        <LogTable
          selectedId={selectedId}
          entryHrefBase={listHref}
          entries={entries}
          total={total}
          filter={filter}
          sources={sources}
          timeZone={timeZone}
          totalPages={totalPages}
          baseUrl={baseUrl}
          loadError={loadError}
        />
      </ObservabilityPane>
      {selectedId ? (
        <AppWorkspace.MainPane
          id="detail"
          minSize={LOG_ENTRY_MIN_WIDTH}
          label={selected?.entry ? `${selectedLevel?.label ?? selected.entry.level} · ${selected.entry.source}` : t.logEntry}
          description={selected?.entry ? formatDateTime(selected.entry.createdAt, { locale, timeZone: timeZone }) : undefined}
          actions={selected?.entry ? <CopyButton text={JSON.stringify(selected.entry, null, 2)} label={t.copy} /> : undefined}
        >
          {selected?.entry ? (
            <LogEntryDetail entry={selected.entry} timeZone={timeZone} />
          ) : selected?.error ? (
            <Placeholder
              state="error"
              title={t.logStoreUnavailable}
              description={selected.error}
              action={
                <ButtonLink href={retryHref} variant="secondary" size="sm">
                  {t.retry}
                </ButtonLink>
              }
            />
          ) : (
            <Placeholder
              title={t.logEntryGone}
              description={t.logEntryGoneDetail}
              action={
                <ButtonLink href={listHref} variant="secondary" size="sm">
                  {t.backToLogs}
                </ButtonLink>
              }
            />
          )}
        </AppWorkspace.MainPane>
      ) : null}
    </ObservabilityArea>
  );
}
