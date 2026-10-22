import { niceStep } from "@k2b/stdlib";
import type { ChartProps } from "@k2b/ui";
import type { DashboardRange } from "../../dashboard-contracts";
import type { DashboardPanelData } from "../../dashboard-result";
import { sqlTimestamp } from "../../sql-result-values";
import type { PublicDashboardPanel } from "./dashboard-client";

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
  locale: string,
  window?: { from: string; to: string },
): Extract<ChartProps, { kind: "line" }> => {
  const x = data.columns.findIndex((column) => column.name === panel.x);
  const group = data.columns.findIndex((column) => column.name === panel.series);
  const series = new Map<string, { label: string; data: { x: number; y: number }[] }>();
  for (const row of data.rows) {
    const time = sqlTimestamp(row[x], data.columns[x]?.type ?? "");
    for (const [index, column] of data.columns.entries()) {
      if (index === x || index === group) continue;
      const label = group < 0 ? column.name : `${dashboardCell(row[group], locale)}${data.columns.length > 3 ? ` · ${column.name}` : ""}`;
      const key = JSON.stringify([group < 0 ? null : row[group], column.name]);
      const value = series.get(key) ?? { label, data: [] };
      const y = number(row[index]);
      if (Number.isFinite(time) && y !== null) value.data.push({ x: time, y });
      series.set(key, value);
    }
  }
  const times = [...new Set(data.rows.map((row) => sqlTimestamp(row[x], data.columns[x]?.type ?? "")))]
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const spacing = times
    .slice(1)
    .map((time, index) => time - times[index]!)
    .filter((distance) => distance > 0);
  const date = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  const span = window ? Date.parse(window.to) - Date.parse(window.from) : (times.at(-1) ?? 0) - (times[0] ?? 0);
  const tickStep = niceStep(span, 3);
  const domain: [number, number] | undefined = window
    ? [Date.parse(window.from), Date.parse(window.to)]
    : times.length > 1
      ? [times[0]!, times.at(-1)!]
      : undefined;
  const tickDate = new Intl.DateTimeFormat(locale, {
    ...(span <= 2 * 86400000
      ? { hour: "2-digit", minute: "2-digit" }
      : span <= 8 * 86400000
        ? { weekday: "short" }
        : { month: "2-digit", day: "2-digit" }),
    timeZone: "UTC",
  });
  return {
    kind: "line",
    series: [...series.values()],
    smooth: false,
    legend: true,
    legendPlacement: "top-start",
    interactive: true,
    maxGap: spacing.length ? Math.min(...spacing) * 1.5 : undefined,
    xAxis: {
      domain,
      ticks: 3,
      // The renderer adds exact endpoints beside its regular ticks. Label only
      // the regular lattice when endpoints would add a second adjacent label.
      format: (x) => (domain && (x === domain[0] || x === domain[1]) && x % tickStep !== 0 ? "" : tickDate.format(x)),
    },
    yAxis: { ticks: 3, format: (y) => dashboardCell(y, locale) },
    references: panel.threshold === undefined ? [] : [{ value: panel.threshold, label: `${panel.threshold} ${panel.unit}` }],
    tooltip: ({ datum }) => ({
      title: date.format(Number(datum.values.find((value) => value.key === "x")?.value)),
      rows: datum.values.flatMap((value) =>
        value.key === "y"
          ? [{ label: datum.label ?? panel.title, value: `${dashboardCell(value.value, locale)} ${panel.unit}`.trim() }]
          : [],
      ),
    }),
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
