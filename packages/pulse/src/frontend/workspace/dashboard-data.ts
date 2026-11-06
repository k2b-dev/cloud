import { type ChartLegendEntry, type ChartProps, prepareChartSnapshot } from "@k2b/ui";
import type { DashboardRange } from "../../dashboard-contracts";
import type { DashboardPanelData } from "../../dashboard-result";
import { sqlTimestamp } from "../../sql-result-values";
import type { PublicDashboardPanel } from "./dashboard-client";
import { dashboardMessages } from "./dashboard-messages";

export const readDashboardRange = (path: string): DashboardRange => {
  const search = new URL(path, "https://pulse.invalid").searchParams;
  const raw = search.get("range");
  const range = raw === "7d" || raw === "30d" || raw === "90d" ? raw : "24h";
  const from = search.get("from"),
    to = search.get("to");
  if (from && to && Number.isFinite(Date.parse(from)) && Number.isFinite(Date.parse(to)) && Date.parse(from) < Date.parse(to))
    return { range, from: new Date(from).toISOString(), to: new Date(to).toISOString() };
  return { range };
};
export const dashboardSections = <T extends PublicDashboardPanel>(panels: T[]) => {
  const groups = new Map<string, T[]>();
  for (const panel of panels.filter((panel) => panel.kind !== "number")) {
    const group = groups.get(panel.section) ?? [];
    group.push(panel);
    groups.set(panel.section, group);
  }
  return [...groups].map(([name, panels]) => ({
    name,
    panels,
    icon: panels[0]?.sectionIcon,
    color: panels[0]?.sectionColor,
    description: panels[0]?.sectionDescription,
  }));
};
/** Every dashboard time reads in the base's time zone, so the server and every viewer show the same clock. */
export type DashboardClock = { locale: string; timeZone: string };
export const dashboardDateTime = (clock: DashboardClock) =>
  new Intl.DateTimeFormat(clock.locale, { dateStyle: "medium", timeStyle: "short", timeZone: clock.timeZone });
export const dashboardCell = (value: unknown, locale: string): string =>
  value === null || value === undefined
    ? "—"
    : typeof value === "number"
      ? new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(value)
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
const number = (value: unknown): number | null =>
  value !== null && value !== "" && (typeof value === "number" || typeof value === "string") && Number.isFinite(Number(value))
    ? Number(value)
    : null;
export const dashboardLine = (
  panel: PublicDashboardPanel,
  data: DashboardPanelData,
  clock: DashboardClock,
  window?: { from: string; to: string },
) => {
  const { locale, timeZone } = clock;
  const x = data.columns.findIndex((column) => column.name === panel.x);
  const group = data.columns.findIndex((column) => column.name === panel.series);
  // `id` names the series by its source group and column, independent of its position in the result.
  const series = new Map<string, { id: string; label: string; data: { x: number; y: number }[] }>();
  for (const row of data.rows) {
    const time = sqlTimestamp(row[x], data.columns[x]?.type ?? "", timeZone);
    for (const [index, column] of data.columns.entries()) {
      if (index === x || index === group) continue;
      const label = group < 0 ? column.name : `${dashboardCell(row[group], locale)}${data.columns.length > 3 ? ` · ${column.name}` : ""}`;
      const key = JSON.stringify([group < 0 ? null : row[group], column.name]);
      const value = series.get(key) ?? { id: key, label, data: [] };
      const y = number(row[index]);
      if (Number.isFinite(time) && y !== null) value.data.push({ x: time, y });
      series.set(key, value);
    }
  }
  const times = [...new Set(data.rows.map((row) => sqlTimestamp(row[x], data.columns[x]?.type ?? "", timeZone)))]
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const spacing = times
    .slice(1)
    .map((time, index) => time - times[index]!)
    .filter((distance) => distance > 0);
  const date = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone });
  // A bucket such as toStartOfDay() may begin before :from. The chart rejects
  // points outside its domain, so the window widens to the data, never clips it.
  const domain: [number, number] | undefined = window
    ? [Math.min(Date.parse(window.from), times[0] ?? Infinity), Math.max(Date.parse(window.to), times.at(-1) ?? -Infinity)]
    : times.length > 1
      ? [times[0]!, times.at(-1)!]
      : undefined;
  return {
    kind: "line",
    series: [...series.values()],
    smooth: false,
    // ChartExplorer lists the series below the plot, where long names wrap.
    legend: false,
    maxGap: spacing.length ? Math.min(...spacing) * 1.5 : undefined,
    // Ticks land on round times in the base zone (full hours, days, weeks), labelled in the reader's locale.
    xAxis: { domain, ticks: 3 },
    timeAxis: { timeZone, locale },
    yAxis: { ticks: 3, format: (y) => dashboardCell(y, locale) },
    references:
      panel.threshold === undefined
        ? []
        : [
            {
              value: panel.threshold,
              label: `${dashboardMessages.resolve([locale]).t.alarm} ${dashboardCell(panel.threshold, locale)} ${panel.unit}`.trim(),
            },
          ],
    tooltip: ({ datum }) => ({
      title: date.format(Number(datum.values.find((value) => value.key === "x")?.value)),
      rows: datum.values.flatMap((value) =>
        value.key === "y"
          ? [{ label: datum.label ?? panel.title, value: `${dashboardCell(value.value, locale)} ${panel.unit}`.trim() }]
          : [],
      ),
    }),
  } satisfies Extract<ChartProps, { kind: "line" }>;
};
/**
 * One table row per drawn point. The key is the series and the point's time, so a selection stays on the same
 * measurement when a refresh drops older points; a repeated time in one series counts up.
 */
export type DashboardLineRow = { key: string; at: number; series: string; value: number };
/**
 * The line panel as ChartExplorer data: the same axis, references, and tooltips as `dashboardLine`, one row per
 * point for the table and Copy data, and the series names for the explorer's wrapping legend.
 */
export const dashboardLineExplorer = (
  panel: PublicDashboardPanel,
  data: DashboardPanelData,
  clock: DashboardClock,
  window?: { from: string; to: string },
) => {
  const { tooltip, ...line } = dashboardLine(panel, data, clock, window);
  const keys = line.series.map((series) => {
    const seen = new Map<number, number>();
    return series.data.map((point) => {
      const repeat = seen.get(point.x) ?? 0;
      seen.set(point.x, repeat + 1);
      return JSON.stringify([series.id, point.x, repeat]);
    });
  });
  const key = (seriesIndex: number | undefined, index: number) => keys[seriesIndex ?? 0]?.[index] ?? "";
  const rows: DashboardLineRow[] = line.series.flatMap((series, seriesIndex) =>
    series.data.map((point, index) => ({ key: key(seriesIndex, index), at: point.x, series: series.label, value: point.y })),
  );
  const legend: ChartLegendEntry[] =
    line.series.length > 1 ? line.series.map((series, index) => ({ label: series.label, color: index })) : [];
  return {
    data: {
      rows,
      chart: prepareChartSnapshot(line, { key: ({ datum }) => key(datum.seriesIndex, datum.index), tooltip }),
    },
    legend,
  };
};
export const dashboardCategories = (panel: PublicDashboardPanel, data: DashboardPanelData, locale: string) => {
  const x = data.columns.findIndex((column) => column.name === panel.x);
  const group = data.columns.findIndex((column) => column.name === panel.series);
  const values = data.columns.flatMap((column, index) => (index !== x && index !== group ? [{ index, name: column.name }] : []));
  if (x < 0 || !values.length || (panel.kind === "funnel" && values.length !== 1)) throw new Error("PANEL_RESULT_INVALID");
  return data.rows.flatMap((row) =>
    values.map((column) => {
      const value = number(row[column.index]);
      if (value === null || (panel.kind === "funnel" && value < 0)) throw new Error("PANEL_RESULT_INVALID");
      const label = [
        dashboardCell(row[x], locale),
        ...(group < 0 ? [] : [dashboardCell(row[group], locale)]),
        ...(values.length === 1 ? [] : [column.name]),
      ].join(" · ");
      return { label, value };
    }),
  );
};
/** The projection already checked codes and values; rows without a country stay off the map. */
export const dashboardCountries = (panel: PublicDashboardPanel, data: DashboardPanelData) => {
  const x = data.columns.findIndex((column) => column.name === panel.x);
  const value = data.columns.findIndex((column) => column.name !== panel.x);
  if (x < 0 || value < 0) throw new Error("PANEL_RESULT_INVALID");
  return data.rows.flatMap((row) => (row[x] ? [{ code: String(row[x]), value: Number(row[value]) }] : []));
};
