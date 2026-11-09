import type { CloudMoneyDescription } from "@k2b/cloud/ai";
import { type ChartInput, chartKinds, chartRenderOptions, chartRows, chartTooltip, drawChart } from "@k2b/editor/charts";
import { progressBarParts } from "@k2b/ui";
import type { ChartDescription } from "@k2b/ui/charts";
import type { ChartTooltipFormatter } from "@k2b/ui/charts/core";
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

/** Align categories without turning a missing observation into zero or flattening series into labels. */
export function dashboardAlignedCategories(
  panel: Pick<DashboardPanel, "x" | "series">,
  data: DashboardPanelData,
  locale: string,
  excluded: string[] = [],
) {
  const x = columnIndex(data, panel.x);
  const group = columnIndex(data, panel.series);
  const values = data.columns.flatMap((column, index) =>
    index !== x && index !== group && !excluded.includes(column.name) ? [{ index, name: column.name }] : [],
  );
  if (x < 0 || !values.length) throw new Error("Choose a category and at least one value column");
  const categories = new Map<string, string>();
  const series = new Map<string, { label: string; cells: Map<string, number | null> }>();
  for (const row of data.rows) {
    const category = JSON.stringify(row[x]) ?? "null";
    categories.set(category, text(row[x], locale));
    for (const value of values) {
      const key = JSON.stringify([group < 0 ? null : row[group], value.name]);
      const entry = series.get(key) ?? {
        label: group < 0 ? value.name : `${text(row[group], locale)}${values.length > 1 ? ` · ${value.name}` : ""}`,
        cells: new Map<string, number | null>(),
      };
      budget(0, series.size + (series.has(key) ? 0 : 1), entry.cells.size + 1);
      if (entry.cells.has(category)) throw new Error("Aggregate duplicate category/series pairs in SQL");
      entry.cells.set(category, numeric(row[value.index]));
      series.set(key, entry);
    }
  }
  budget(0, series.size, categories.size);
  return {
    x: [...categories.values()],
    series: [...series.values()].map((entry) => ({
      label: entry.label,
      data: [...categories.keys()].map((key) => entry.cells.get(key) ?? null),
    })),
  };
}

/** Additive SQL kinds. Legacy single-value bars and funnels keep their saved drawing path. */
function dashboardCatalogDescription(panel: ChartPanel, data: DashboardPanelData, clock: DashboardClock): ChartDescription {
  const common = { title: panel.title };
  const x = columnIndex(data, panel.x);
  const values = data.columns.flatMap((column, index) => (index !== x && column.name !== panel.series ? [index] : []));
  const oneValue = () => {
    if (x < 0 || values.length !== 1 || panel.series) throw new Error("Choose one category and one value column");
    budget(0, 1, data.rows.length);
    return data.rows.map((row) => ({ label: text(row[x], clock.locale), value: numeric(row[values[0]!]) }));
  };
  if (panel.kind === "lineForecast") {
    const at = columnIndex(data, panel.x),
      value = columnIndex(data, "value"),
      forecast = columnIndex(data, "forecast");
    const low = columnIndex(data, "low"),
      high = columnIndex(data, "high");
    if (at < 0 || value < 0 || forecast < 0 || low < 0 !== high < 0) throw new Error("Invalid forecast columns");
    const points = data.rows
      .map((row) => {
        const flag = numeric(row[forecast]);
        const time = sqlTimestamp(row[at], data.columns[at]!.type, clock.timeZone);
        if (!Number.isFinite(time) || (flag !== 0 && flag !== 1)) throw new Error("Forecast needs valid times and 0/1 flags");
        return { x: time, y: numeric(row[value]), flag, row };
      })
      .sort((a, b) => a.x - b.x);
    const start = points.findIndex((point) => point.flag === 1);
    if (
      start < 0 ||
      points.slice(start).some((point) => point.flag !== 1) ||
      new Set(points.map((point) => point.x)).size !== points.length
    )
      throw new Error("Forecast must be a contiguous suffix of unique times");
    const band: [number, number][] | undefined =
      low < 0
        ? undefined
        : points.slice(start).map(({ row }) => {
            const lo = numeric(row[low]),
              hi = numeric(row[high]);
            if (lo === null || hi === null) throw new Error("Forecast bounds must be numbers");
            return [lo, hi];
          });
    budget(0, 1, points.length);
    return {
      kind: "line",
      ...common,
      series: [{ label: "value", data: points.map(({ x, y }) => ({ x, y })) }],
      smooth: false,
      xAxis: { format: { date: "minute" }, ticks: 3 },
      forecast: { from: points[start]!.x, ...(band ? { band } : {}) },
    };
  }
  if (panel.kind === "sankey") {
    const source = columnIndex(data, "source"),
      target = columnIndex(data, "target"),
      value = columnIndex(data, "value");
    if (source < 0 || target < 0 || value < 0) throw new Error("Sankey columns must be source, target, value");
    const nodes = new Map<string, { id: string; label: string }>();
    const links = data.rows.map((row) => {
      for (const index of [source, target]) {
        const id = row[index];
        if (typeof id !== "string" || !id.trim()) throw new Error("Sankey endpoints must be nonempty text");
        nodes.set(id, { id, label: id });
      }
      const amount = numeric(row[value]);
      if (amount === null || amount <= 0) throw new Error("Sankey values must be positive");
      return { source: String(row[source]), target: String(row[target]), value: amount };
    });
    budget(0, 1, Math.max(nodes.size, links.length));
    return { kind: "sankey", ...common, nodes: [...nodes.values()], links, locale: clock.locale };
  }
  if (panel.kind === "calendarHeatmap") {
    const rows = oneValue();
    const cells: [string, number | null][] = rows.map((row) => [row.label, row.value]);
    return {
      kind: "heatmap",
      ...common,
      layout: "calendar",
      data: cells,
      scale: "sequential",
      locale: clock.locale,
      label: panel.unit || undefined,
    };
  }
  if (panel.kind === "waterfall") {
    const rows = oneValue(),
      start = rows[0],
      end = rows.at(-1);
    if (rows.length < 2 || !start || start.value === null || end?.value !== null || rows.slice(1, -1).some((row) => row.value === null))
      throw new Error("Waterfall needs a starting balance, signed changes, and a final null total row");
    return {
      kind: "waterfall",
      ...common,
      start: { label: start.label, value: start.value },
      steps: rows.slice(1, -1).map((row) => ({ label: row.label, value: row.value! })),
      end: { label: end.label },
    };
  }
  if (["barRows", "barList", "funnelStages"].includes(panel.kind)) {
    const rows = oneValue();
    if (panel.kind !== "barRows" && rows.some((row) => row.value !== null && row.value < 0))
      throw new Error("Ranked lists and funnels need nonnegative values");
    return panel.kind === "funnelStages"
      ? { kind: "funnel", ...common, data: rows }
      : { kind: "bar", ...common, data: rows, layout: "rows", ...(panel.kind === "barList" ? { share: true } : {}) };
  }
  if (panel.kind === "treemap" || panel.kind === "bubble") {
    const groupColumn = columnIndex(data, panel.series);
    if (x < 0 || groupColumn < 0) throw new Error("Choose label/x and group columns");
    const counts = new Map<string, number>();
    const groupFor = (row: unknown[]) => {
      const group = text(row[groupColumn], clock.locale);
      counts.set(group, (counts.get(group) ?? 0) + 1);
      budget(0, counts.size, counts.get(group)!);
      return group;
    };
    if (panel.kind === "treemap") {
      if (values.length !== 1) throw new Error("Treemap needs one value column");
      const items = data.rows.flatMap((row) => {
        const group = groupFor(row),
          value = numeric(row[values[0]!]);
        if (value === null) return [];
        return [{ label: text(row[x], clock.locale), group, value }];
      });
      return { kind: "treemap", ...common, groups: [...counts.keys()], data: items, locale: clock.locale };
    }
    const label = columnIndex(data, "label"),
      y = columnIndex(data, "y"),
      sizeColumn = columnIndex(data, "size");
    if (label < 0 || y < 0) throw new Error("Bubble columns must include label and y");
    const points = data.rows.flatMap((row) => {
      const group = groupFor(row),
        at = numeric(row[x]),
        value = numeric(row[y]),
        size = sizeColumn < 0 ? undefined : numeric(row[sizeColumn]);
      // Missing coordinates or sizes have no point; their input positions still count toward the host budget.
      if (at === null || value === null || size === null) return [];
      return [{ label: text(row[label], clock.locale), group, x: at, y: value, ...(size === undefined ? {} : { size }) }];
    });
    return {
      kind: "bubble",
      ...common,
      groups: [...counts.keys()],
      data: points,
      xLabel: panel.x ?? "x",
      yLabel: "y",
      ...(sizeColumn < 0 ? {} : { sizeLabel: "size" }),
      locale: clock.locale,
    };
  }
  if (panel.kind === "pareto") {
    if (x < 0 || values.length !== 2 || panel.series) throw new Error("Pareto needs category, current and previous columns");
    budget(0, 2, data.rows.length);
    const items = data.rows.map((row) => {
      const value = numeric(row[values[0]!]),
        prev = numeric(row[values[1]!]);
      if (value === null || prev === null) throw new Error("Pareto needs both comparison values");
      return { label: text(row[x], clock.locale), value, prev };
    });
    return {
      kind: "pareto",
      ...common,
      labels: [data.columns[values[0]!]!.name, data.columns[values[1]!]!.name],
      data: items,
      locale: clock.locale,
    };
  }
  if (panel.kind === "radar") {
    const maximum = columnIndex(data, "max");
    const maxima = new Set(data.rows.map((row) => numeric(row[maximum])));
    const max = maxima.values().next().value;
    if (maximum < 0 || maxima.size !== 1 || max === null || max === undefined || max <= 0)
      throw new Error("Radar needs one identical positive max in every row");
    const aligned = dashboardAlignedCategories(panel, data, clock.locale, ["max"]);
    if (aligned.series.some((series) => series.data.some((value) => value === null))) throw new Error("Radar needs a value on every axis");
    return {
      kind: "radar",
      ...common,
      axes: aligned.x,
      max,
      series: aligned.series.map((series) => ({ label: series.label, data: series.data.map((value) => value!) })),
      unit: panel.unit,
      locale: clock.locale,
    };
  }
  const aligned = dashboardAlignedCategories(panel, data, clock.locale, panel.kind === "dots" ? ["total"] : []);
  if (panel.kind === "dots") {
    const totalColumn = columnIndex(data, "total");
    const totals = new Set(data.rows.map((row) => numeric(row[totalColumn]))),
      total = totals.values().next().value;
    if (totalColumn < 0 || totals.size !== 1 || total === null || total === undefined || total <= 0)
      throw new Error("Dots need one identical positive total in every row");
    // A missing subset leaves the whole category blank. Complete matrices include their unallocated remainder.
    const matrices = aligned.x.filter((_, index) => aligned.series.every((series) => series.data[index] !== null)).length;
    budget(matrices * 100, aligned.series.length, aligned.x.length);
    return { kind: "bar", ...common, ...aligned, layout: "nested", marks: "dots", total, dots: 100 };
  }
  if (panel.kind === "barCompare") {
    if (panel.series || aligned.series.length !== 2) throw new Error("Comparison needs category, current and previous columns");
    return { kind: "bar", ...common, x: aligned.x, series: aligned.series.slice(0, 1), compare: aligned.series[1], layout: "grouped" };
  }
  if (panel.kind === "hbar")
    return {
      kind: "hbar",
      ...common,
      series: aligned.series.map((series) => series.label),
      rows: aligned.x.map((label, index) => ({ label, values: aligned.series.map((series) => series.data[index] ?? null) })),
    };
  return {
    kind: "bar",
    ...common,
    ...aligned,
    layout: panel.kind === "barStacked" || panel.kind === "barPercent" ? "stacked" : "grouped",
    ...(panel.kind === "barPercent" ? { normalize: true } : {}),
  };
}

/** SQL columns become the same function-free JSON entry read by Chat and Notebooks. */
export function dashboardChartDescription(panel: ChartPanel, data: DashboardPanelData, clock: DashboardClock) {
  const legacy = [
    "line",
    "scatter",
    "bar",
    "funnel",
    "pie",
    "donut",
    "barGauge",
    "histogram",
    "sparkline",
    "gauge",
    "boxplot",
    "heatmap",
    "area",
    "areaPercent",
  ];
  const barValues = data.columns.filter((column) => column.name !== panel.x && column.name !== panel.series);
  if (!legacy.includes(panel.kind) || (panel.kind === "bar" && (panel.series || barValues.length > 1)))
    return dashboardCatalogDescription(panel, data, clock);
  const common = { title: panel.title };
  if (panel.kind === "area" || panel.kind === "areaPercent")
    return {
      kind: "area" as const,
      ...common,
      ...dashboardAlignedCategories(panel, data, clock.locale),
      layout: "stacked" as const,
      normalize: panel.kind === "areaPercent",
    };
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

/** Inspection groups can contain several marks: count bars, comparisons and points inside those groups. */
export function dashboardProducedMarks(input: ChartInput, svg: string): number {
  const marks =
    input.kind === "bar" && input.marks === "dots"
      ? /class="k2b-chart-dot"/g
      : input.kind === "hbar" || input.kind === "funnel" || (input.kind === "bar" && input.series)
        ? /<rect class="stdlib-chart-bar[ "]/g
        : input.kind === "pareto"
          ? /class="k2b-chart-pareto-(?:current|previous)"|<circle /g
          : input.kind === "radar"
            ? /<circle /g
            : /data-chart-datum=/g;
  return [...svg.matchAll(marks)].length;
}

/** Host budgets are separate from the shared, unbounded chart validator. Count what the renderer produces. */
export function dashboardChartRenderOptions(panel: ChartPanel, data: DashboardPanelData, clock: DashboardClock) {
  const description = dashboardChartDescription(panel, data, clock);
  const input: ChartInput = chartKinds().parse(description);
  const numbers = new Intl.NumberFormat(clock.locale, { maximumFractionDigits: 3 });
  const withUnit = (value: number) => `${numbers.format(value)} ${panel.unit}`.trim();
  const forecastTime = new Intl.DateTimeFormat(clock.locale, {
    timeZone: clock.timeZone,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const formats = {
    value: input.kind === "gauge" ? (value: number) => numbers.format(value) : withUnit,
    y: input.kind === "histogram" ? (value: number) => numbers.format(value) : withUnit,
    ...(input.kind === "histogram"
      ? { x: withUnit }
      : panel.kind === "lineForecast"
        ? { x: (value: number) => forecastTime.format(value) }
        : {}),
  };
  const rendered = chartRenderOptions(input, clock.locale, { formats });
  const options =
    panel.kind === "lineForecast" && rendered.kind === "line"
      ? {
          ...rendered,
          // Let the time renderer choose compact tick labels; tooltips keep the full local timestamp.
          xAxis: { ...rendered.xAxis, format: undefined },
          timeAxis: { timeZone: clock.timeZone, locale: clock.locale },
        }
      : rendered;
  const tooltip: ChartTooltipFormatter = ({ datum }) => {
    const rows = chartRows(input, clock.locale, { formats });
    const row = rows.add(datum);
    return chartTooltip(rows.columns(), row);
  };
  const svg = drawChart(options);
  budget(dashboardProducedMarks(input, svg), 0, 0);
  return { ...options, tooltip };
}

/** Fixed SQL aliases make money blocks portable without adding fields to saved panels. */
export function dashboardMoneyDescription(panel: ChartPanel, data: DashboardPanelData, locale: string): CloudMoneyDescription {
  if (!/^[A-Z]{3}$/.test(panel.unit)) throw new Error("Choose an ISO 4217 currency in unit");
  const currency = panel.unit;
  const amount = (row: unknown[], name: string, nonnegative = true) => {
    const index = columnIndex(data, name);
    if (index < 0) throw new Error(`Missing money column ${name}`);
    const value = numeric(row[index]);
    if (value === null || (nonnegative && value < 0)) throw new Error("Money values must be nonnegative numbers");
    return value;
  };
  if (panel.kind === "budget") {
    const x = columnIndex(data, panel.x);
    if (x < 0) throw new Error("Choose a budget label column");
    const items = data.rows.map((row) => {
      const used = amount(row, "used"),
        limit = amount(row, "limit");
      const expected = columnIndex(data, "expected") < 0 ? undefined : amount(row, "expected");
      if (!Number.isFinite(used + (expected ?? 0))) throw new Error("Budget totals must be finite");
      return { label: text(row[x], locale), used, limit, ...(expected === undefined ? {} : { expected }) };
    });
    const marks = items.reduce((count, item) => {
      const bar = progressBarParts([{ value: item.used }, { value: item.expected ?? 0 }], item.limit);
      return count + bar.parts.length + (bar.mark === null ? 0 : 1);
    }, 0);
    budget(marks, columnIndex(data, "expected") < 0 ? 2 : 3, items.length);
    return { block: "budget", currency, items };
  }
  if (panel.kind !== "balance" || data.rows.length !== 1) throw new Error("A balance needs one aggregate row");
  const row = data.rows[0]!;
  const start = amount(row, "start", false),
    incoming = amount(row, "in"),
    outgoing = amount(row, "out");
  if (!Number.isFinite(start + incoming) || !Number.isFinite(start + incoming - outgoing)) throw new Error("Balance totals must be finite");
  return { block: "balance", currency, start, in: incoming, out: outgoing };
}
