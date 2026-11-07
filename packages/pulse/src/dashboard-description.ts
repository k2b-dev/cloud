import { type ChartInput, chartKinds, chartRenderOptions, chartRows, chartTooltip } from "@k2b/editor/charts";
import { type ChartTooltipFormatter, chartRenderHeight, renderChartSvg } from "@k2b/ui/charts/core";
import { DASHBOARD_MAX_MARKS, DASHBOARD_MAX_POINTS, DASHBOARD_MAX_SERIES, type DashboardPanel } from "./dashboard-contracts";
import type { DashboardPanelData } from "./dashboard-result";
import { sqlTimestamp } from "./sql-result-values";

type ChartPanel = Pick<DashboardPanel, "kind" | "title" | "x" | "series" | "unit" | "threshold">;
export type DashboardClock = { locale: string; timeZone: string };
const numeric = (cell: unknown): number | null => {
  if (cell === null) return null;
  if ((typeof cell !== "number" && typeof cell !== "string") || cell === "" || !Number.isFinite(Number(cell)))
    throw new Error("Chart values must be finite numbers or null");
  return Number(cell);
};
const text = (cell: unknown, locale: string): string =>
  cell === null || cell === undefined
    ? "—"
    : typeof cell === "number"
      ? new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(cell)
      : typeof cell === "object"
        ? JSON.stringify(cell)
        : String(cell);
const columnIndex = (data: DashboardPanelData, name: string | undefined) => data.columns.findIndex((column) => column.name === name);
const budget = (marks: number, series: number, points: number) => {
  if (marks > DASHBOARD_MAX_MARKS) throw new Error("A panel supports at most 3,840 produced marks. Aggregate the query.");
  if (series > DASHBOARD_MAX_SERIES || points > DASHBOARD_MAX_POINTS)
    throw new Error("A panel supports at most 8 series and 480 points per series. Aggregate the query.");
};

/** Keep SQL series identities and null observations in the portable description. */
export function dashboardPointDescription(panel: ChartPanel, data: DashboardPanelData, clock: DashboardClock) {
  const x = columnIndex(data, panel.x),
    group = columnIndex(data, panel.series);
  const values = data.columns.flatMap((column, index) => (index !== x && index !== group ? [{ index, name: column.name }] : []));
  if (x < 0 || !values.length) throw new Error("Choose an x column and at least one value column");
  const series = new Map<string, { id: string; label: string; data: { x: number; y: number | null }[] }>();
  for (const row of data.rows) {
    const at = panel.kind === "scatter" ? numeric(row[x]) : sqlTimestamp(row[x], data.columns[x]!.type, clock.timeZone);
    if (at === null || !Number.isFinite(at)) throw new Error("The x column contains an invalid value");
    for (const value of values) {
      const id = JSON.stringify([group < 0 ? null : row[group], value.name]);
      const entry = series.get(id) ?? {
        id,
        label: group < 0 ? value.name : `${text(row[group], clock.locale)}${values.length > 1 ? ` · ${value.name}` : ""}`,
        data: [],
      };
      entry.data.push({ x: at, y: numeric(row[value.index]) });
      budget(0, series.size + (series.has(id) ? 0 : 1), entry.data.length);
      series.set(id, entry);
    }
  }
  return {
    kind: panel.kind === "scatter" ? ("scatter" as const) : ("line" as const),
    title: panel.title,
    series: [...series.values()],
    smooth: false,
    legend: panel.kind === "scatter" && series.size > 1,
    ...(panel.threshold === undefined ? {} : { references: [{ value: panel.threshold }] }),
  };
}

/** Saved category order and legacy labels remain intact; missing values stay null. */
export function dashboardCategoryDescription(panel: ChartPanel, data: DashboardPanelData, locale: string) {
  const x = columnIndex(data, panel.x),
    group = columnIndex(data, panel.series);
  const values = data.columns.flatMap((column, index) => (index !== x && index !== group ? [{ index, name: column.name }] : []));
  if (x < 0 || !values.length || (panel.kind === "funnel" && (values.length !== 1 || panel.series)))
    throw new Error("PANEL_RESULT_INVALID");
  const counts = new Map<string, number>();
  const categories = data.rows.flatMap((row) =>
    values.map((column) => {
      const value = numeric(row[column.index]);
      if (panel.kind === "funnel" && (value === null || value < 0)) throw new Error("PANEL_RESULT_INVALID");
      const key = JSON.stringify([group < 0 ? null : row[group], column.name]);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      budget(0, counts.size, counts.get(key)!);
      return {
        label: [text(row[x], locale), ...(group < 0 ? [] : [text(row[group], locale)]), ...(values.length === 1 ? [] : [column.name])].join(
          " · ",
        ),
        value,
      };
    }),
  );
  return categories;
}

/** SQL columns become the same function-free JSON entry read by Chat and Notebooks. */
export function dashboardChartDescription(panel: ChartPanel, data: DashboardPanelData, clock: DashboardClock) {
  const common = { title: panel.title };
  if (panel.kind === "line" || panel.kind === "scatter") return dashboardPointDescription(panel, data, clock);
  if (panel.kind === "bar" || panel.kind === "funnel" || panel.kind === "pie" || panel.kind === "donut" || panel.kind === "barGauge") {
    const rows = dashboardCategoryDescription(panel, data, clock.locale);
    if (
      (panel.kind === "pie" || panel.kind === "donut" || panel.kind === "barGauge") &&
      rows.some((row) => row.value !== null && row.value < 0)
    )
      throw new Error("Share and gauge values must be nonnegative");
    if (panel.kind === "funnel")
      return { kind: "barGauge" as const, ...common, data: rows, min: 0, max: Math.max(1, ...rows.map((row) => row.value ?? 0)) };
    return { kind: panel.kind, ...common, data: rows };
  }
  const x = columnIndex(data, panel.x);
  const values = data.columns.flatMap((column, index) => (index !== x && column.name !== panel.series ? [index] : []));
  if (!values.length) throw new Error("Choose a value column");
  if (panel.kind !== "boxplot" && panel.kind !== "heatmap") budget(0, values.length, data.rows.length);
  if (panel.kind === "histogram" || panel.kind === "sparkline") {
    if (values.length !== 1 || panel.series) throw new Error("Choose exactly one value column");
    return { kind: panel.kind, ...common, data: data.rows.map((row) => numeric(row[values[0]!])) };
  }
  if (panel.kind === "gauge") {
    if (data.rows.length !== 1 || values.length !== 1 || panel.series || panel.x) throw new Error("A gauge needs one aggregate value");
    const value = numeric(data.rows[0]![values[0]!]);
    if (value === null || value < 0 || value > 100) throw new Error("Gauge values must be between 0 and 100");
    return { kind: "gauge" as const, ...common, value, min: 0, max: 100, unit: panel.unit };
  }
  if (panel.kind === "boxplot") {
    if (x < 0 || values.length !== 1 || panel.series) throw new Error("A box plot needs category and observation columns");
    const groups = new Map<string, { label: string; values: (number | null)[] }>();
    for (const row of data.rows) {
      const key = JSON.stringify(row[x]) ?? "null";
      const entry = groups.get(key) ?? { label: text(row[x], clock.locale), values: [] };
      entry.values.push(numeric(row[values[0]!]));
      groups.set(key, entry);
      budget(0, groups.size, entry.values.length);
    }
    return { kind: "boxplot" as const, ...common, data: [...groups.values()] };
  }
  if (panel.kind === "heatmap") {
    const y = columnIndex(data, panel.series);
    if (x < 0 || y < 0 || values.length !== 1) throw new Error("A heatmap needs x, series (row) and one value column");
    const cells = new Set<string>();
    const result = data.rows.map((row) => {
      const key = JSON.stringify([row[x], row[y]]);
      if (cells.has(key)) throw new Error("Aggregate duplicate heatmap cells in SQL");
      cells.add(key);
      return { x: text(row[x], clock.locale), y: text(row[y], clock.locale), value: numeric(row[values[0]!]) };
    });
    budget(0, new Set(result.map((cell) => cell.y)).size, new Set(result.map((cell) => cell.x)).size);
    return { kind: "heatmap" as const, ...common, data: result };
  }
  throw new Error("This panel is not a catalog chart");
}

/** Host budgets are separate from the shared, unbounded chart validator. Count what the renderer produces. */
export function dashboardChartRenderOptions(panel: ChartPanel, data: DashboardPanelData, clock: DashboardClock) {
  const description = dashboardChartDescription(panel, data, clock);
  const input: ChartInput = chartKinds().parse(description);
  const numbers = new Intl.NumberFormat(clock.locale, { maximumFractionDigits: 3 });
  const withUnit = (value: number) => `${numbers.format(value)} ${panel.unit}`.trim();
  const formats = {
    value: input.kind === "gauge" ? (value: number) => numbers.format(value) : withUnit,
    y: input.kind === "histogram" ? (value: number) => numbers.format(value) : withUnit,
    ...(input.kind === "histogram" ? { x: withUnit } : {}),
  };
  const options = chartRenderOptions(input, clock.locale, { formats });
  const tooltip: ChartTooltipFormatter = ({ datum }) => {
    const rows = chartRows(input, clock.locale, { formats });
    const row = rows.add(datum);
    return chartTooltip(rows.columns(), row);
  };
  budget([...renderChartSvg(options, 480, chartRenderHeight(options)).matchAll(/data-chart-datum=/g)].length, 0, 0);
  return { ...options, tooltip };
}
