import { type ChartDatum, charts, i18n } from "@k2b/stdlib";
import type { ChartRenderOptions } from "@k2b/ui";
import type { CloudAiChartInput } from "./default-tool-contracts";

/**
 * The chart chat block: the plain-data `cloud.chart()` options of the `chart` tool become the options of the shared
 * renderer (`@k2b/ui` Chart and `stdlib.charts`) and a data table with the same rows the chart marks. Pure, so the
 * schema, the browser, and the CLI read a chart the same way.
 */

const labels = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      category: "Category",
      series: "Series",
      value: "Value",
      share: "Share",
      from: "From",
      to: "To",
      count: "Count",
      min: "Minimum",
      max: "Maximum",
    },
    de: {
      category: "Kategorie",
      series: "Datenreihe",
      value: "Wert",
      share: "Anteil",
      from: "Von",
      to: "Bis",
      count: "Anzahl",
      min: "Minimum",
      max: "Maximum",
    },
  },
});

export const checkCloudAiChartLabels = () => labels.check();

/** Logical drawing size of the shared renderer; CSS fits it to the block. */
const WIDTH = 480;
const HEIGHT = 280;
/** Tick labels are 11px IBM Plex Mono, about 6.7px per character. */
const CHAR = 6.7;
/**
 * Text keeps its pixel size while the drawing stretches to the chat column. The drawing is never measured or redrawn,
 * so label room is reserved for the narrowest column, about 296px of 480 units on a 320px phone; wide columns show it
 * as a little more space left of the axis.
 */
const NARROW = 480 / 296;

type Formats = {
  tick: (value: number) => string;
  value: (value: number) => string;
  x?: { tick: (value: number) => string; value: (value: number) => string };
};

const dateText = (value: string) => (value.length === 10 ? `${value}T00:00` : value);
/** Dates are calendar days and wall-clock times in the user's zone; UTC keeps them as written on every device. */
const dateTime = (value: number | string) => (typeof value === "number" ? value : Date.parse(`${dateText(value)}Z`));

const seriesOf = (input: CloudAiChartInput) => (input.kind === "line" || input.kind === "scatter" ? input.series : []);

const formats = (input: CloudAiChartInput, locale: string): Formats => {
  const tick = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 });
  const value = new Intl.NumberFormat(locale, { maximumFractionDigits: 6 });
  const points = seriesOf(input).flatMap((series) => series.data);
  const dates = points.some((point) => typeof point.x === "string");
  const times = points.some((point) => typeof point.x === "string" && point.x.length > 10);
  const dateTick = new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    ...(times ? { hour: "2-digit", minute: "2-digit" } : {}),
  });
  const dateValue = new Intl.DateTimeFormat(locale, { timeZone: "UTC", dateStyle: "medium", ...(times ? { timeStyle: "short" } : {}) });
  return {
    tick: (v) => tick.format(v),
    value: (v) => value.format(v),
    x: dates ? { tick: (v) => dateTick.format(v), value: (v) => dateValue.format(v) } : undefined,
  };
};

/** Room for the longest y tick label, so values like 1.2M never run past the left edge on a phone. */
const leftPadding = (values: number[], tick: (value: number) => string, axisLabel: boolean) => {
  const finite = values.filter(Number.isFinite);
  const extremes = finite.length ? [Math.min(0, ...finite), Math.max(...finite)] : [0];
  // Nice ticks can exceed the data a little; one extra character covers that.
  const longest = Math.max(...extremes.map((value) => tick(value).length)) + 1;
  return Math.max(40, Math.ceil((longest * CHAR + 8 + (axisLabel ? 16 : 0)) * NARROW));
};

type ChartAxisInput = { label?: string; domain?: [number, number]; ticks?: number; scale?: "linear" | "log" };
const axis = (value: ChartAxisInput | undefined, format: (value: number) => string) => ({ ...value, format });

/**
 * Category labels never shorten: when they would overlap in the narrowest column, every n-th label shows in full and
 * the others stay empty, as in `cloud.chart()`. Table and tooltips keep every label.
 */
const thinned = <T extends { label: string }>(data: T[], left: number): T[] => {
  const longest = Math.max(1, ...data.map((item) => item.label.length));
  const plot = Math.max(WIDTH - left - 16, 1) / NARROW;
  const step = Math.max(1, Math.ceil(((longest + 1) * CHAR * data.length) / plot));
  return step === 1 ? data : data.map((item, index) => (index % step === 0 ? item : { ...item, label: "" }));
};

/** Options for `@k2b/ui` Chart and `prepareChartSnapshot`; the chat block draws the title itself. */
export function cloudAiChartRenderOptions(input: CloudAiChartInput, locale: string): ChartRenderOptions {
  const format = formats(input, locale);
  switch (input.kind) {
    case "bar": {
      const left = leftPadding(
        [...input.data.map((item) => item.value), ...(input.yAxis?.domain ?? [])],
        format.tick,
        Boolean(input.yAxis?.label),
      );
      return {
        kind: "bar",
        data: input.colorByBar && input.legend ? input.data : thinned(input.data, left),
        yAxis: axis(input.yAxis, format.tick),
        colorByBar: input.colorByBar,
        showValues: input.showValues,
        legend: input.legend,
        padding: { left },
      };
    }
    case "line":
    case "scatter": {
      const series = input.series.map((entry) => ({
        label: entry.label,
        data: entry.data.map((point) => ({ x: dateTime(point.x), y: point.y })),
      }));
      const xs = series.flatMap((entry) => entry.data.map((point) => point.x));
      const common = {
        series,
        xAxis: axis(input.xAxis, format.x?.tick ?? format.tick),
        yAxis: axis(input.yAxis, format.tick),
        legend: input.legend ?? input.series.length > 1,
        padding: {
          left: leftPadding(
            [...series.flatMap((entry) => entry.data.map((point) => point.y)), ...(input.yAxis?.domain ?? [])],
            format.tick,
            Boolean(input.yAxis?.label),
          ),
          // Date labels are wide: room for half of the last one right of the plot.
          ...(format.x ? { right: Math.ceil(((format.x.tick(Math.max(...xs)).length * CHAR) / 2 + 4) * NARROW) } : {}),
        },
      };
      return input.kind === "line" ? { kind: "line", ...common, area: input.area, smooth: input.smooth } : { kind: "scatter", ...common };
    }
    case "pie":
    case "donut":
      return { kind: input.kind, data: input.data, legend: input.legend ?? !input.showLabels, showLabels: input.showLabels };
    case "histogram":
      return {
        kind: "histogram",
        data: input.data,
        bins: input.bins,
        xAxis: { format: format.tick },
        yAxis: { format: format.tick },
        padding: { left: leftPadding([input.data.length], format.tick, false) },
      };
    case "gauge":
      return {
        kind: "gauge",
        value: input.value,
        min: input.min,
        max: input.max,
        label: input.label,
        unit: input.unit,
        format: format.value,
      };
    case "sparkline":
      return { kind: "sparkline", data: input.data, area: input.area };
  }
}

const decode = (value: string) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** Draw the options once with inspection metadata; throws what the renderer would throw in the chat. */
const marks = (options: ChartRenderOptions): ChartDatum[] => {
  const { kind, ...rest } = options;
  const svg = (charts[kind] as (value: object) => string)({ ...rest, width: WIDTH, height: HEIGHT, inspect: true });
  return [...svg.matchAll(/data-chart-datum="([^"]*)"/g)].map((match) => JSON.parse(decode(match[1]!)) as ChartDatum);
};

/** One mark, as `prepareChartSnapshot` keys it: series and position in the input. */
export const cloudAiChartMarkKey = (datum: Pick<ChartDatum, "index" | "seriesIndex">) => `${datum.seriesIndex ?? 0}:${datum.index}`;

export type CloudAiChartColumn = { id: string; label: string; numeric: boolean };
export type CloudAiChartRow = { key: string; cells: Record<string, string>; values: Record<string, string | number> };
export type CloudAiChartTable = { columns: CloudAiChartColumn[]; rows: CloudAiChartRow[] };

/** The data behind every mark of the chart as a table: the accessible alternative and what Copy data copies. */
export function cloudAiChartTable(input: CloudAiChartInput, locale: string): CloudAiChartTable {
  const t = labels.resolve([locale]).t;
  const format = formats(input, locale);
  const series = seriesOf(input);
  const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
  const unit = input.kind === "gauge" && input.unit ? ` ${input.unit}` : "";
  const columns = new Map<string, CloudAiChartColumn>();
  const rows: CloudAiChartRow[] = [];
  const named = series.some((entry) => entry.label);
  for (const datum of marks(cloudAiChartRenderOptions(input, locale))) {
    const cells: Record<string, string> = {};
    const values: Record<string, string | number> = {};
    const add = (id: string, label: string, value: string | number, text: string) => {
      if (!columns.has(id)) columns.set(id, { id, label, numeric: typeof value === "number" });
      cells[id] = text;
      values[id] = value;
    };
    if (input.kind === "line" || input.kind === "scatter") {
      if (named || series.length > 1) {
        const name = series[datum.seriesIndex ?? 0]?.label ?? `${t.series} ${(datum.seriesIndex ?? 0) + 1}`;
        add("series", t.series, name, name);
      }
    } else {
      // Bars may hide some axis labels; the table names every category.
      const label = input.kind === "bar" || input.kind === "pie" || input.kind === "donut" ? input.data[datum.index]?.label : datum.label;
      if (label) add("label", t.category, label, label);
    }
    for (const field of datum.values) {
      const value = field.value;
      if (typeof value !== "number" || field.key === "total") continue;
      if (field.key === "x") {
        const header = (input.kind === "line" || input.kind === "scatter" ? input.xAxis?.label : undefined) ?? "X";
        add(
          "x",
          input.kind === "sparkline" ? "#" : header,
          value,
          input.kind === "sparkline" ? String(value + 1) : (format.x?.value ?? format.value)(value),
        );
      } else if (field.key === "y") {
        const header =
          (input.kind === "line" || input.kind === "scatter" ? input.yAxis?.label : undefined) ??
          (input.kind === "sparkline" ? t.value : "Y");
        add("y", header, value, format.value(value));
      } else if (field.key === "value")
        add("value", (input.kind === "bar" ? input.yAxis?.label : undefined) ?? t.value, value, `${format.value(value)}${unit}`);
      else if (field.key === "percent") add("percent", t.share, value, percent.format(value / 100));
      else if (field.key === "from" || field.key === "to" || field.key === "count" || field.key === "min" || field.key === "max")
        add(field.key, t[field.key], value, `${format.value(value)}${field.key === "min" || field.key === "max" ? unit : ""}`);
    }
    rows.push({ key: cloudAiChartMarkKey(datum), cells, values });
  }
  return { columns: [...columns.values()], rows };
}

/** Why valid-looking input would not render, in words the model can act on; undefined when it renders. */
export function chartInputIssue(input: CloudAiChartInput): string | undefined {
  const points = seriesOf(input).flatMap((series) => series.data);
  // The date check reports its own issue.
  if (points.some((point) => !Number.isFinite(dateTime(point.x)))) return undefined;
  if (new Set(points.map((point) => typeof point.x)).size > 1) return "Use either numbers or dates for x in all series, not both.";
  if ((input.kind === "pie" || input.kind === "donut") && !input.data.some((slice) => slice.value > 0))
    return "Pie and donut slices must add up to more than zero.";
  try {
    if (marks(cloudAiChartRenderOptions(input, "en")).length === 0)
      return "None of the values can be drawn; a log axis needs values above zero.";
    return undefined;
  } catch (error) {
    return `The chart cannot be drawn: ${error instanceof Error ? error.message : String(error)}`;
  }
}
