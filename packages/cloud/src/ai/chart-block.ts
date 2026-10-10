import { type ChartDatum, charts, computeDomain, i18n, niceStep } from "@k2b/stdlib";
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
/** The renderer's tick count when an axis sets none. */
const TICKS = 5;
/** Below this radius, about 30px on a 320px phone, a pie no longer reads as one. */
const MIN_PIE_RADIUS = 48;

const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * A chart date as UTC milliseconds, so calendar days and wall-clock times stay as written on every device. Impossible
 * dates such as February 30 are undefined: engines would move them into March or refuse them, each in its own way.
 */
export const chartDateTime = (value: string): number | undefined => {
  const match = DATE.exec(value);
  if (!match) return undefined;
  const [, year, month, day, hour = "00", minute = "00", second = "00"] = match;
  const date = new Date(0);
  date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  date.setUTCHours(Number(hour), Number(minute), Number(second));
  // Parts out of range roll over, so a date that does not read back as written does not exist.
  return date.toISOString().startsWith(`${year}-${month}-${day}T${hour}:${minute}:${second}`) ? date.getTime() : undefined;
};

const dateTime = (value: number | string) => (typeof value === "number" ? value : (chartDateTime(value) ?? Number.NaN));

const seriesOf = (input: CloudAiChartInput) => (input.kind === "line" || input.kind === "scatter" ? input.series : []);

type ChartAxisInput = { label?: string; domain?: number[]; ticks?: number; scale?: "linear" | "log" };

const bounds = (domain: number[] | undefined): [number, number] | undefined => {
  const [min, max] = domain ?? [];
  return min === undefined || max === undefined ? undefined : [min, max];
};

const axis = ({ domain, ...value }: ChartAxisInput = {}, format: (value: number) => string) => ({
  ...value,
  ...(domain ? { domain: bounds(domain) } : {}),
  format,
});

/** The value axes of a chart with what they show: the data checks and the label room read them alike. */
const valueAxes = (input: CloudAiChartInput): { values: number[]; axis?: ChartAxisInput; zero?: boolean }[] => {
  if (input.kind === "bar") return [{ values: input.data.map((item) => item.value), axis: input.yAxis, zero: true }];
  if (input.kind === "histogram") return [{ values: input.data }];
  if (input.kind !== "line" && input.kind !== "scatter") return [];
  const points = input.series.flatMap((series) => series.data);
  return [
    { values: points.map((point) => dateTime(point.x)), axis: input.xAxis },
    { values: points.map((point) => point.y), axis: input.yAxis },
  ];
};

/**
 * Whether the renderer can step from the lowest to the highest tick. Values that differ by less than the float
 * precision of their size, such as 1e17 and 1e17 + 16, would make it count forever.
 */
const steppable = (values: number[], ticks = TICKS) => {
  const [min, max] = computeDomain(values);
  const step = niceStep(max - min, ticks);
  return [Math.floor(min / step) * step, Math.ceil(max / step) * step].every((value) => value + step !== value && value - step !== value);
};

/**
 * The values whose labels are the widest on a value axis: its ends and the ticks next to them. The renderer puts ticks
 * on multiples of a nice step, or on powers of ten on a log axis, and adds the bounds of a fixed domain.
 */
const tickCandidates = (values: number[], value?: ChartAxisInput): number[] => {
  const domain = bounds(value?.domain);
  if (value?.scale === "log") {
    const positive = values.filter((entry) => entry > 0);
    const [min, max] = domain ?? (positive.length ? [Math.min(...positive), Math.max(...positive)] : [1, 10]);
    return [min, max, 10 ** Math.floor(Math.log10(min)), 10 ** Math.ceil(Math.log10(max))];
  }
  const [min, max] = domain ?? computeDomain(values);
  const step = niceStep(max - min, value?.ticks ?? TICKS);
  const low = Math.floor(min / step) * step;
  const high = Math.ceil(max / step) * step;
  return [...(domain ?? [low, high]), low + step, high - step];
};

type Formats = {
  tick: (value: number) => string;
  value: (value: number) => string;
  x: { tick: (value: number) => string; value: (value: number) => string };
};

const formats = (input: CloudAiChartInput, locale: string): Formats => {
  // Ticks are round numbers already; fifteen significant digits show them exactly (0.005, 1.25M) without float noise.
  const tick = new Intl.NumberFormat(locale, { notation: "compact", maximumSignificantDigits: 15 });
  // An x axis often counts years or steps, which compact notation would turn into 2.02K.
  const xTick = new Intl.NumberFormat(locale, { maximumSignificantDigits: 15, useGrouping: "min2" });
  // The table, tooltips and Copy data show the value as given.
  const value = new Intl.NumberFormat(locale, { maximumSignificantDigits: 15 });
  const points = seriesOf(input).flatMap((series) => series.data);
  const written = points.flatMap((point) => (typeof point.x === "string" ? [point.x] : []));
  if (written.length === 0)
    return {
      tick: (v) => tick.format(v),
      value: (v) => value.format(v),
      x: { tick: (v) => xTick.format(v), value: (v) => value.format(v) },
    };
  const times = written.some((date) => date.length > 10);
  const seconds = written.some((date) => date.length > 16);
  const clock: Intl.DateTimeFormatOptions = times ? { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) } : {};
  const dateTick = new Intl.DateTimeFormat(locale, { timeZone: "UTC", day: "numeric", month: "short", ...clock });
  const dateValue = new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    dateStyle: "medium",
    ...(times ? { timeStyle: seconds ? "medium" : "short" } : {}),
  });
  return {
    tick: (v) => tick.format(v),
    value: (v) => value.format(v),
    x: { tick: (v) => dateTick.format(v), value: (v) => dateValue.format(v) },
  };
};

/** Room for the longest y tick label, so values like 1.2M never run past the left edge on a phone. */
const leftPadding = (values: number[], value: ChartAxisInput | undefined, tick: (value: number) => string) => {
  // A tick between the ends can carry one more digit than they do.
  const longest = Math.max(...tickCandidates(values, value).map((entry) => tick(entry).length)) + 1;
  return Math.max(40, Math.ceil((longest * CHAR + 8 + (value?.label ? 16 : 0)) * NARROW));
};

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
      const values = input.data.map((item) => item.value);
      const left = leftPadding(input.yAxis?.scale === "log" ? values : [...values, 0], input.yAxis, format.tick);
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
      const t = labels.resolve([locale]).t;
      const series = input.series.map((entry, index) => ({
        // The renderer names unnamed series in English; the legend speaks the reader's language like the table.
        label: entry.label ?? `${t.series} ${index + 1}`,
        data: entry.data.map((point) => ({ x: dateTime(point.x), y: point.y })),
      }));
      const points = series.flatMap((entry) => entry.data);
      const lastTick = Math.max(
        ...tickCandidates(
          points.map((point) => point.x),
          input.xAxis,
        ),
      );
      const common = {
        series,
        xAxis: axis(input.xAxis, format.x.tick),
        yAxis: axis(input.yAxis, format.tick),
        legend: input.legend ?? input.series.length > 1,
        padding: {
          left: leftPadding(
            points.map((point) => point.y),
            input.yAxis,
            format.tick,
          ),
          // Labels center on their tick: room for half of the last one right of the plot.
          right: Math.max(16, Math.ceil(((format.x.tick(lastTick).length * CHAR) / 2 + 4) * NARROW)),
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
        // No bin counts more than every observation.
        padding: { left: leftPadding([0, input.data.length], undefined, format.tick) },
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

/** Draws the options with inspection metadata; throws what the renderer would throw in the chat. */
const draw = (options: ChartRenderOptions): string => {
  const { kind, ...rest } = options;
  return (charts[kind] as (value: object) => string)({ ...rest, width: WIDTH, height: HEIGHT, inspect: true });
};

const marks = (svg: string): ChartDatum[] =>
  [...svg.matchAll(/data-chart-datum="([^"]*)"/g)].map((match) => JSON.parse(decode(match[1]!)) as ChartDatum);

/** The outer radius of a drawn pie or donut: the first arc of its first slice. */
const pieRadius = (svg: string) => Number(/class="stdlib-chart-slice[^"]*" d="[^"A]*A ([\d.]+)/.exec(svg)?.[1] ?? 0);

/** One mark, as `prepareChartSnapshot` keys it: series and position in the input. */
export const cloudAiChartMarkKey = (datum: Pick<ChartDatum, "index" | "seriesIndex">) => `${datum.seriesIndex ?? 0}:${datum.index}`;

export type CloudAiChartColumn = { id: string; label: string; numeric: boolean };
export type CloudAiChartRow = { key: string; cells: Record<string, string>; values: Record<string, string | number> };
export type CloudAiChartTable = { columns: CloudAiChartColumn[]; rows: CloudAiChartRow[] };

/**
 * Builds the data table mark by mark, in the order the renderer emits them, so the chat block fills it from the same
 * drawing that shows the chart.
 */
export function cloudAiChartRows(input: CloudAiChartInput, locale: string) {
  const t = labels.resolve([locale]).t;
  const format = formats(input, locale);
  const series = seriesOf(input);
  const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
  const unit = input.kind === "gauge" && input.unit ? ` ${input.unit}` : "";
  const columns = new Map<string, CloudAiChartColumn>();
  const rows: CloudAiChartRow[] = [];
  const named = series.some((entry) => entry.label);
  const add = (datum: ChartDatum): CloudAiChartRow => {
    const cells: Record<string, string> = {};
    const values: Record<string, string | number> = {};
    const cell = (id: string, label: string, value: string | number, text: string) => {
      if (!columns.has(id)) columns.set(id, { id, label, numeric: typeof value === "number" });
      cells[id] = text;
      values[id] = value;
    };
    if (input.kind === "line" || input.kind === "scatter") {
      if (named || series.length > 1) {
        const name = series[datum.seriesIndex ?? 0]?.label ?? `${t.series} ${(datum.seriesIndex ?? 0) + 1}`;
        cell("series", t.series, name, name);
      }
    } else {
      // Bars may hide some axis labels; the table names every category.
      const label = input.kind === "bar" || input.kind === "pie" || input.kind === "donut" ? input.data[datum.index]?.label : datum.label;
      if (label) cell("label", t.category, label, label);
    }
    for (const field of datum.values) {
      const value = field.value;
      if (typeof value !== "number" || field.key === "total") continue;
      if (field.key === "x") {
        const header = (input.kind === "line" || input.kind === "scatter" ? input.xAxis?.label : undefined) ?? "X";
        cell("x", input.kind === "sparkline" ? "#" : header, value, input.kind === "sparkline" ? String(value + 1) : format.x.value(value));
      } else if (field.key === "y") {
        const header =
          (input.kind === "line" || input.kind === "scatter" ? input.yAxis?.label : undefined) ??
          (input.kind === "sparkline" ? t.value : "Y");
        cell("y", header, value, format.value(value));
      } else if (field.key === "value")
        cell("value", (input.kind === "bar" ? input.yAxis?.label : undefined) ?? t.value, value, `${format.value(value)}${unit}`);
      else if (field.key === "percent") cell("percent", t.share, value, percent.format(value / 100));
      else if (field.key === "from" || field.key === "to" || field.key === "count" || field.key === "min" || field.key === "max")
        cell(field.key, t[field.key], value, `${format.value(value)}${field.key === "min" || field.key === "max" ? unit : ""}`);
    }
    const row = { key: cloudAiChartMarkKey(datum), cells, values };
    rows.push(row);
    return row;
  };
  return { add, columns: () => [...columns.values()], table: (): CloudAiChartTable => ({ columns: [...columns.values()], rows }) };
}

/** The data behind every mark of the chart as a table: the accessible alternative and what Copy data copies. */
export function cloudAiChartTable(input: CloudAiChartInput, locale: string): CloudAiChartTable {
  const rows = cloudAiChartRows(input, locale);
  for (const datum of marks(draw(cloudAiChartRenderOptions(input, locale)))) rows.add(datum);
  return rows.table();
}

/** Why chart options would not draw, found without drawing them; undefined when nothing is wrong. */
export function chartDataIssue(input: CloudAiChartInput): string | undefined {
  if (new Set(seriesOf(input).flatMap((series) => series.data.map((point) => typeof point.x))).size > 1)
    return "Use either numbers or dates for x in all series, not both.";
  if ((input.kind === "pie" || input.kind === "donut") && !input.data.some((slice) => slice.value > 0))
    return "Pie and donut slices must add up to more than zero.";
  for (const { values, axis, zero } of valueAxes(input)) {
    if (axis?.scale === "log") {
      if (values.some((value) => value <= 0))
        return "A log axis shows only values above zero; use a linear axis or leave out the values at or below zero.";
    } else if (!axis?.domain && !steppable(zero ? [...values, 0] : values, axis?.ticks))
      return "The values differ too little for their size to label an axis; subtract a common offset first.";
  }
  return undefined;
}

/** Why chart options that pass the data checks still would not draw well; draws them once. */
export function chartDrawingIssue(input: CloudAiChartInput): string | undefined {
  try {
    const svg = draw(cloudAiChartRenderOptions(input, "en"));
    if (marks(svg).length === 0) return "None of the values can be drawn.";
    if ((input.kind === "pie" || input.kind === "donut") && pieRadius(svg) < MIN_PIE_RADIUS)
      return "The legend leaves too little room for the pie: combine small slices into one, shorten the labels, or use a bar chart.";
    return undefined;
  } catch (error) {
    return `The chart cannot be drawn: ${error instanceof Error ? error.message : String(error)}`;
  }
}
