import { autoBin, type ChartDatum, charts, computeDomain, extendDomainToNice, i18n, niceLogTicks, niceStep } from "@k2b/stdlib";
import { z } from "zod";
import type { CloudAiChartInput, CloudAiFormat, CloudAiNumberFormat } from "./default-tool-contracts";

type RenderOptions = {
  [K in CloudAiChartInput["kind"]]: { kind: K } & Omit<Parameters<(typeof charts)[K]>[0], "width" | "height" | "inspect">;
}[CloudAiChartInput["kind"]];

/**
 * The chart chat block: the plain-data `cloud.chart()` options of the `chart` tool become the options of the shared
 * renderer (`@k2b/ui` Chart and `stdlib.charts`) and a data table with the same rows the chart marks. Pure, so the
 * schema, the browser, and the CLI read a chart the same way.
 */

// Marked pure so a bundle that does not read charts, such as a Studio app frame, can leave the labels out.
const labels = /* @__PURE__ */ i18n.define({
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
      q1: "Q1",
      q2: "Median",
      q3: "Q3",
      whiskerLow: "Whisker low",
      whiskerHigh: "Whisker high",
      delta: "Change",
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
      q1: "Q1",
      q2: "Median",
      q3: "Q3",
      whiskerLow: "Unterer Whisker",
      whiskerHigh: "Oberer Whisker",
      delta: "Änderung",
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
/** Heatmap labels are 11px high; 13 units per row leave readable space at the 18rem frame height. */
const HEATMAP_ROW_HEIGHT = 13;
/** The mapping sets only left padding, so the renderer supplies 16 top and 32 bottom units. */
const HEATMAP_MAX_ROWS = Math.floor((HEIGHT - 16 - 32) / HEATMAP_ROW_HEIGHT);
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

type ChartAxisInput = { label?: string; domain?: number[]; ticks?: number; scale?: "linear" | "log"; format?: CloudAiFormat };

const bounds = (domain: number[] | undefined): [number, number] | undefined => {
  const [min, max] = domain ?? [];
  return min === undefined || max === undefined ? undefined : [min, max];
};

const axis = ({ domain, format: _format, ...value }: ChartAxisInput = {}, format: (value: number) => string) => ({
  ...value,
  ...(domain ? { domain: bounds(domain) } : {}),
  format,
});

const referencesOf = (input: CloudAiChartInput, name: "x" | "y") =>
  "references" in input ? (input.references ?? []).filter((ref) => (ref.axis ?? "y") === name).map((ref) => dateTime(ref.value)) : [];

/** The value axes of a chart with what they show: the data checks and the label room read them alike. */
const valueAxes = (input: CloudAiChartInput): { values: number[]; axis?: ChartAxisInput; zero?: boolean; name: "x" | "y" }[] => {
  if (input.kind === "bar") return [{ values: input.data.map((item) => item.value), axis: input.yAxis, zero: true, name: "y" }];
  if (input.kind === "boxplot") return [{ values: input.data.flatMap((item) => item.values), axis: input.yAxis, name: "y" }];
  if (input.kind === "histogram") {
    if (!input.references?.length) return [{ values: input.data, name: "x" }];
    const { edges, counts } = autoBin(input.data, input.bins);
    return [
      { values: edges, name: "x" },
      { values: counts, zero: true, name: "y" },
    ];
  }
  if (input.kind !== "line" && input.kind !== "scatter") return [];
  const points = input.series.flatMap((series) => series.data);
  return [
    { values: points.map((point) => dateTime(point.x)), axis: input.xAxis, name: "x" },
    { values: points.map((point) => point.y), axis: input.yAxis, name: "y" },
  ];
};

/** Only references add a fixed domain; charts without them keep the renderer's existing defaults. */
const referencedAxis = (input: CloudAiChartInput, name: "x" | "y"): ChartAxisInput | undefined => {
  const entry = valueAxes(input).find((entry) => entry.name === name);
  if (!entry) return undefined;
  const refs = referencesOf(input, name);
  if (!refs.length || entry.axis?.domain) return entry.axis;
  const values = [...entry.values, ...refs, ...(entry.zero && entry.axis?.scale !== "log" ? [0] : [])].filter(Number.isFinite);
  if (entry.axis?.scale === "log") {
    const positive = values.filter((value) => value > 0);
    return { ...entry.axis, domain: positive.length ? niceLogTicks(Math.min(...positive), Math.max(...positive)).domain : [1, 10] };
  }
  const [min, max] = computeDomain(values);
  return { ...entry.axis, domain: extendDomainToNice(min, max, niceStep(max - min, entry.axis?.ticks ?? TICKS)).domain };
};
const renderReferences = (input: CloudAiChartInput) =>
  "references" in input ? input.references?.map((ref) => ({ ...ref, value: dateTime(ref.value) })) : undefined;

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
    const positive = values.filter((entry) => Number.isFinite(entry) && entry > 0);
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

/** Value precision and tick precision share the same style and units; ticks must remain distinct. */
export const cloudAiNumberFormatters = (format: CloudAiNumberFormat | undefined, locale: string) => {
  const common: Intl.NumberFormatOptions = {
    style: format?.style === "number" ? "decimal" : format?.style,
    currency: format?.currency,
  };
  const value = new Intl.NumberFormat(
    locale,
    format
      ? {
          ...common,
          ...(format.decimals === undefined ? {} : { minimumFractionDigits: format.decimals, maximumFractionDigits: format.decimals }),
          ...(format.compact ? { notation: "compact" } : {}),
        }
      : { maximumSignificantDigits: 15 },
  );
  let tick: Intl.NumberFormat | undefined;
  const tickValue = (v: number) => {
    tick ??= new Intl.NumberFormat(locale, {
      ...common,
      notation: !format || format.compact ? "compact" : "standard",
      maximumSignificantDigits: 15,
    });
    return tick.format(v);
  };
  const unit = format?.unit ? ` ${format.unit}` : "";
  return { value: (v: number) => `${value.format(v)}${unit}`, tick: (v: number) => `${tickValue(v)}${unit}` };
};
const numberFormat = (format: CloudAiFormat | undefined) => (format && !("date" in format) ? format : undefined);
const formats = (input: CloudAiChartInput, locale: string): Formats => {
  const yFormat = "yAxis" in input ? numberFormat(input.yAxis?.format) : "format" in input ? input.format : undefined;
  const y = cloudAiNumberFormatters(yFormat, locale);
  const xFormat = "xAxis" in input ? input.xAxis?.format : undefined;
  const x = cloudAiNumberFormatters(numberFormat(xFormat), locale);
  // An unformatted x axis often counts years or steps, which compact notation would turn into 2.02K.
  const xTick = new Intl.NumberFormat(locale, { maximumSignificantDigits: 15, useGrouping: "min2" });
  const written = seriesOf(input).flatMap((series) => series.data.flatMap((point) => (typeof point.x === "string" ? [point.x] : [])));
  if (!written.length) return { ...y, x: { tick: xFormat ? x.tick : (v) => xTick.format(v), value: x.value } };
  const dateFormat = xFormat && "date" in xFormat ? xFormat.date : undefined;
  const times = dateFormat ? dateFormat !== "day" : written.some((date) => date.length > 10);
  const seconds = dateFormat ? dateFormat === "second" : written.some((date) => date.length > 16);
  const clock: Intl.DateTimeFormatOptions = times ? { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) } : {};
  const dateTick = new Intl.DateTimeFormat(locale, { timeZone: "UTC", day: "numeric", month: "short", ...clock });
  const dateValue = new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    dateStyle: "medium",
    ...(times ? { timeStyle: seconds ? "medium" : "short" } : {}),
  });
  return { ...y, x: { tick: (v) => dateTick.format(v), value: (v) => dateValue.format(v) } };
};

/** The table's x formatter also titles the shared cursor. */
export const cloudAiChartXValueFormat = (input: CloudAiChartInput, locale: string): ((x: number) => string) =>
  formats(input, locale).x.value;

/** Room for the longest y tick label, so values like 1.2M never run past the left edge on a phone. */
const leftPadding = (values: number[], value: ChartAxisInput | undefined, tick: (value: number) => string, factor = NARROW) => {
  // A tick between the ends can carry one more digit than they do.
  const longest = Math.max(...tickCandidates(values, value).map((entry) => tick(entry).length)) + 1;
  return Math.max(40, Math.ceil((longest * CHAR + 8 + (value?.label ? 16 : 0)) * factor));
};

/**
 * Category labels never shorten: when they would overlap in the narrowest column, every n-th label shows in full and
 * the others stay empty, as in `cloud.chart()`. Table and tooltips keep every label.
 */
const thinned = <T extends { label: string }>(data: T[], left: number, width = WIDTH, factor = NARROW): T[] => {
  const longest = Math.max(1, ...data.map((item) => item.label.length));
  const plot = Math.max(width - left - 16, 1) / factor;
  const step = Math.max(1, Math.ceil(((longest + 1) * CHAR * data.length) / plot));
  return step === 1 ? data : data.map((item, index) => (index % step === 0 ? item : { ...item, label: "" }));
};

/** Entries of the renderer's legend, also usable when the chat lays it out outside the SVG. */
export function cloudAiChartLegend(
  input: CloudAiChartInput,
  locale: string,
): { label: string; color: number; style?: "solid" | "dashed" | "dotted"; reference?: boolean }[] {
  if (input.kind === "bar")
    return input.colorByBar && input.legend ? input.data.map((entry, index) => ({ label: entry.label, color: index % 8 })) : [];
  if (input.kind !== "line" && input.kind !== "scatter") return [];
  if (!(input.legend ?? input.series.length > 1)) return [];
  const t = labels.resolve([locale]).t;
  return input.series.map((entry, index) => ({
    label: entry.label ?? `${t.series} ${index + 1}`,
    color: index % 8,
    ...(input.kind === "line" ? { style: input.series[index]?.style ?? (entry.role === "reference" ? "dashed" : "solid") } : {}),
    ...(entry.role === "reference" ? { reference: true } : {}),
  }));
}

/**
 * Whether a scatter point belongs to a comparison series, for hollow snapshot marks. A line's comparison series is
 * dashed instead: hollow marks would show every one of its points.
 */
export const cloudAiChartReferenceMark = (input: CloudAiChartInput, datum: ChartDatum): boolean =>
  input.kind === "scatter" && input.series[datum.seriesIndex ?? 0]?.role === "reference";

/** Options for the shared renderer; the chat block draws the title itself. */
export function cloudAiChartRenderOptions(
  input: CloudAiChartInput,
  locale: string,
  options: {
    width?: number;
    legend?: "svg" | "outside";
    formats?: { x?: (v: number) => string; y?: (v: number) => string; value?: (v: number) => string };
  } = {},
): RenderOptions {
  const defaults = formats(input, locale);
  // Function formats must be measured with the same text the renderer will print.
  const format = {
    ...defaults,
    tick: options.formats?.y ?? defaults.tick,
    value: options.formats?.value ?? defaults.value,
    x: { ...defaults.x, tick: options.formats?.x ?? defaults.x.tick },
  };
  const factor = options.width === undefined ? NARROW : 1;
  const width = options.width ?? WIDTH;
  const references = renderReferences(input);
  switch (input.kind) {
    case "bar":
    case "boxplot": {
      const values = input.kind === "bar" ? input.data.map((item) => item.value) : input.data.flatMap((item) => item.values);
      const yAxis = referencedAxis(input, "y");
      // The renderer prints bar values with the axis format, so printed values take the value precision for both.
      const yFormat = options.formats?.y ?? (input.kind === "bar" && input.showValues ? format.value : format.tick);
      const left = leftPadding(
        [...values, ...referencesOf(input, "y"), ...(input.kind === "bar" && input.yAxis?.scale !== "log" ? [0] : [])],
        yAxis,
        yFormat,
        factor,
      );
      if (input.kind === "boxplot")
        return {
          kind: "boxplot",
          groups: thinned(input.data, left, width, factor),
          yAxis: axis(yAxis, format.tick),
          references,
          padding: { left },
        };
      return {
        kind: "bar",
        data: input.colorByBar && input.legend && options.legend !== "outside" ? input.data : thinned(input.data, left, width, factor),
        yAxis: axis(yAxis, yFormat),
        colorByBar: input.colorByBar,
        showValues: input.showValues,
        legend: options.legend === "outside" ? false : input.legend,
        references,
        padding: { left },
      };
    }
    case "line":
    case "scatter": {
      const t = labels.resolve([locale]).t;
      const series = input.series.map((entry, index) => ({
        label: entry.label ?? `${t.series} ${index + 1}`,
        data: entry.data.map((point) => ({ x: dateTime(point.x), y: point.y })),
        ...(input.kind === "line" ? { lineStyle: input.series[index]?.style ?? (entry.role === "reference" ? "dashed" : undefined) } : {}),
      }));
      const points = series.flatMap((entry) => entry.data);
      const xAxis = referencedAxis(input, "x");
      const yAxis = referencedAxis(input, "y");
      const candidates = tickCandidates([...points.map((point) => point.x), ...referencesOf(input, "x")], xAxis).filter(Number.isFinite);
      const lastTick = candidates.length ? Math.max(...candidates) : 0;
      const common = {
        series,
        xAxis: axis(xAxis, format.x.tick),
        yAxis: axis(yAxis, format.tick),
        references,
        legend: options.legend === "outside" ? false : (input.legend ?? input.series.length > 1),
        padding: {
          left: leftPadding([...points.map((point) => point.y), ...referencesOf(input, "y")], yAxis, format.tick, factor),
          // Labels center on their tick: room for half of the last one right of the plot.
          right: Math.max(16, Math.ceil(((format.x.tick(lastTick).length * CHAR) / 2 + 4) * factor)),
        },
      };
      return input.kind === "line" ? { kind: "line", ...common, area: input.area, smooth: input.smooth } : { kind: "scatter", ...common };
    }
    case "pie":
    case "donut":
      return {
        kind: input.kind,
        data: input.data,
        legend: input.legend ?? !input.showLabels,
        showLabels: input.showLabels,
        ...(options.formats?.value ? { format: options.formats.value } : {}),
      };
    case "histogram": {
      const xAxis = referencedAxis(input, "x");
      const xFormat = options.formats?.x ?? defaults.tick;
      const xLabels = options.formats?.x
        ? tickCandidates([...input.data, ...referencesOf(input, "x")], xAxis).map((value) => xFormat(value).length)
        : undefined;
      return {
        kind: "histogram",
        data: input.data,
        bins: input.bins,
        references,
        xAxis: axis(xAxis, xFormat),
        yAxis: axis(referencedAxis(input, "y"), format.tick),
        // No bin counts more than every observation.
        padding: {
          left: leftPadding([0, input.data.length, ...referencesOf(input, "y")], referencedAxis(input, "y"), format.tick, factor),
          ...(xLabels ? { right: Math.max(16, Math.ceil(((Math.max(...xLabels) * CHAR) / 2 + 4) * factor)) } : {}),
        },
      };
    }
    case "gauge":
      return {
        kind: "gauge",
        value: input.value,
        min: input.min,
        max: input.max,
        label: input.label,
        unit: input.unit,
        format: format.value,
        thresholds: input.thresholds,
      };
    case "barGauge":
      return {
        kind: "barGauge",
        data: input.data,
        min: input.min,
        max: input.max,
        unit: input.unit,
        format: format.value,
        thresholds: input.thresholds,
      };
    case "heatmap":
      return {
        kind: "heatmap",
        data: input.data,
        min: input.min,
        max: input.max,
        format: format.value,
        showValues: input.showValues,
        padding: { left: Math.max(40, Math.ceil((Math.max(0, ...input.data.map((item) => item.y.length)) * CHAR + 8) * factor)) },
      };
    case "stat":
      return {
        kind: "stat",
        label: "",
        value: input.value,
        unit: input.unit,
        format: format.value,
        delta: Number.isFinite(input.delta) ? input.delta : undefined,
        deltaFormat: format.value,
        trend:
          !input.better || !input.delta || !Number.isFinite(input.delta)
            ? "neutral"
            : input.delta > 0 === (input.better === "up")
              ? "up"
              : "down",
        sparkline: input.sparkline,
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
const draw = (options: RenderOptions): string => {
  const common = { width: WIDTH, height: HEIGHT, inspect: true };
  switch (options.kind) {
    case "bar":
      return charts.bar({ ...options, ...common });
    case "line":
      return charts.line({ ...options, ...common });
    case "scatter":
      return charts.scatter({ ...options, ...common });
    case "pie":
      return charts.pie({ ...options, ...common });
    case "donut":
      return charts.donut({ ...options, ...common });
    case "histogram":
      return charts.histogram({ ...options, ...common });
    case "boxplot":
      return charts.boxplot({ ...options, ...common });
    case "gauge":
      return charts.gauge({ ...options, ...common });
    case "barGauge":
      return charts.barGauge({ ...options, ...common });
    case "stat":
      return charts.stat({ ...options, ...common });
    case "heatmap":
      return charts.heatmap({ ...options, ...common });
    case "sparkline":
      return charts.sparkline({ ...options, ...common });
  }
};
const datumSchema = () =>
  z.object({
    index: z.number(),
    seriesIndex: z.number().optional(),
    role: z.enum(["point", "item", "bin", "box", "outlier", "value", "cell", "interval"]),
    label: z.string().optional(),
    anchor: z.tuple([z.number(), z.number()]),
    values: z.array(z.object({ key: z.string(), value: z.union([z.string(), z.number()]), formatted: z.string().optional() })),
  });
const DatumSchema = /* @__PURE__ */ datumSchema();
const marks = (svg: string): ChartDatum[] =>
  [...svg.matchAll(/data-chart-datum="([^"]*)"/g)].map((match) => DatumSchema.parse(JSON.parse(decode(match[1]!))));

/** The outer radius of a drawn pie or donut: the first arc of its first slice. */
const pieRadius = (svg: string) => Number(/class="stdlib-chart-slice[^"]*" d="[^"A]*A ([\d.]+)/.exec(svg)?.[1] ?? 0);

/** One mark, as `prepareChartSnapshot` keys it: series and position in the input. */
export const cloudAiChartMarkKey = (datum: Pick<ChartDatum, "index" | "seriesIndex"> & Partial<Pick<ChartDatum, "role">>) =>
  `${datum.role === "outlier" ? "outlier:" : datum.role === "value" ? "value:" : ""}${datum.seriesIndex ?? 0}:${datum.index}`;

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
  const countFormat = cloudAiNumberFormatters(undefined, locale).value;
  const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
  const unit = "unit" in input && input.unit ? ` ${input.unit}` : "";
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
      const label =
        input.kind === "bar" || input.kind === "pie" || input.kind === "donut" || input.kind === "boxplot" || input.kind === "barGauge"
          ? input.data[datum.role === "outlier" ? (datum.seriesIndex ?? 0) : datum.index]?.label
          : datum.label;
      if (label) cell("label", t.category, label, label);
    }
    for (const field of datum.values) {
      const value = field.value;
      if (typeof value === "string" && input.kind === "heatmap" && (field.key === "x" || field.key === "y")) {
        cell(field.key, field.key.toUpperCase(), value, value);
        continue;
      }
      if (typeof value !== "number" || field.key === "total") continue;
      if (field.key === "x") {
        const header = (input.kind === "line" || input.kind === "scatter" ? input.xAxis?.label : undefined) ?? "X";
        cell(
          "x",
          input.kind === "sparkline" || input.kind === "stat" ? "#" : header,
          value,
          input.kind === "sparkline" || input.kind === "stat" ? String(value + 1) : format.x.value(value),
        );
      } else if (field.key === "y") {
        const header =
          (input.kind === "line" || input.kind === "scatter" ? input.yAxis?.label : undefined) ??
          (input.kind === "sparkline" || input.kind === "stat" ? t.value : "Y");
        cell("y", header, value, format.value(value));
      } else if (field.key === "value")
        cell("value", (input.kind === "bar" ? input.yAxis?.label : undefined) ?? t.value, value, `${format.value(value)}${unit}`);
      else if (field.key === "delta") cell("delta", t.delta, value, `${value > 0 ? "+" : ""}${format.value(value)}`);
      else if (field.key === "q1" || field.key === "q2" || field.key === "q3" || field.key === "whiskerLow" || field.key === "whiskerHigh")
        cell(field.key, t[field.key], value, format.value(value));
      else if (field.key === "percent") cell("percent", t.share, value, percent.format(value / 100));
      else if (field.key === "from" || field.key === "to" || field.key === "count" || field.key === "min" || field.key === "max")
        cell(
          field.key,
          t[field.key],
          value,
          `${field.key === "count" ? countFormat(value) : format.value(value)}${field.key === "min" || field.key === "max" ? unit : ""}`,
        );
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

/** Input values count against the budget, including observations summarized into boxes or bins. */
export const cloudAiChartMarks = (input: CloudAiChartInput): number => {
  switch (input.kind) {
    case "line":
    case "scatter":
      return input.series.reduce((sum, series) => sum + series.data.length, 0);
    case "boxplot":
      return input.data.reduce((sum, box) => sum + box.values.length, 0);
    case "gauge":
      return 1;
    case "stat":
      return 1 + (input.sparkline?.length ?? 0);
    default:
      return input.data.length;
  }
};

/** Rejects only precision ranges that would make the renderer count ticks forever. */
export function chartSteppingIssue(input: CloudAiChartInput): string | undefined {
  // Check raw observations before autoBin computes histogram edges.
  if (input.kind === "histogram" && !steppable(input.data))
    return "The values differ too little for their size to label an axis; subtract a common offset first.";
  for (const { values: data, axis, zero, name } of valueAxes(input)) {
    const values = [...data, ...referencesOf(input, name)];
    if (axis?.scale !== "log" && !axis?.domain && !steppable(zero ? [...values, 0] : values, axis?.ticks))
      return "The values differ too little for their size to label an axis; subtract a common offset first.";
  }
  return undefined;
}

/** Both dimensions must fit before suggesting a heatmap orientation change. */
const heatmapLabelFit = (columns: string[], rows: string[]) => {
  const left = Math.max(40, Math.ceil((Math.max(0, ...rows.map((label) => label.length)) * CHAR + 8) * NARROW));
  const characters = Math.floor((WIDTH - left - 16) / NARROW / columns.length / CHAR) - 1;
  return { characters, columns: columns.every((label) => label.length <= characters), rows: rows.length <= HEATMAP_MAX_ROWS };
};

/** Why chart options would not draw, found without drawing them; undefined when nothing is wrong. */
export function chartDataIssue(input: CloudAiChartInput): string | undefined {
  const points = seriesOf(input).flatMap((series) => series.data);
  if (new Set(points.map((point) => typeof point.x)).size > 1) return "Use either numbers or dates for x in all series, not both.";
  if ((input.kind === "pie" || input.kind === "donut") && !input.data.some((slice) => slice.value > 0))
    return "Pie and donut slices must add up to more than zero.";
  if ("references" in input)
    for (const ref of input.references ?? []) {
      const name = ref.axis ?? "y";
      if (name === "x" && input.kind !== "line" && input.kind !== "scatter" && input.kind !== "histogram")
        return "Use y references for bar and boxplot charts.";
      const type = name === "x" && points.length ? typeof points[0]!.x : "number";
      if (typeof ref.value !== type) return `Use ${type === "string" ? "dates" : "numbers"} for ${name} references, like the axis values.`;
    }
  const stepping = chartSteppingIssue(input);
  if (stepping) return stepping;
  for (const { values: data, axis, name } of valueAxes(input)) {
    const values = [...data, ...referencesOf(input, name)];
    const dates = name === "x" && typeof points[0]?.x === "string";
    const dateFormat = axis?.format && "date" in axis.format;
    if (axis?.format && dateFormat !== dates) return `Use a ${dates ? "date" : "number"} format for the ${name} axis.`;
    const domain = bounds(axis?.domain);
    if (domain && referencesOf(input, name).some((value) => value < domain[0] || value > domain[1]))
      return `Extend the ${name} domain to include every reference.`;
    if (axis?.scale === "log") {
      if (values.some((value) => value <= 0))
        return "A log axis shows only values above zero; use a linear axis or leave out the values at or below zero.";
    }
  }
  if (input.kind === "heatmap") {
    if (new Set(input.data.map((cell) => JSON.stringify([cell.x, cell.y]))).size !== input.data.length)
      return "Use each heatmap x/y pair once.";
    if (input.min !== undefined && input.max !== undefined && input.min >= input.max) return "Set heatmap min below max.";
  }
  // These renderers key or place labels by their text, so labels cannot be thinned like bars.
  if (input.kind === "heatmap") {
    const columns = [...new Set(input.data.map((item) => item.x))];
    const rows = [...new Set(input.data.map((item) => item.y))];
    const fit = heatmapLabelFit(columns, rows);
    const swapped = heatmapLabelFit(rows, columns);
    const swap = swapped.columns && swapped.rows;
    if (!fit.columns)
      return fit.characters < 1
        ? `${columns.length} columns do not fit a phone-wide chart; ${swap ? "swap x and y or use fewer columns." : "use fewer columns or shorter labels."}`
        : `Use column labels of at most ${fit.characters} characters for ${columns.length} columns, ${swap ? "or swap x and y." : "or use fewer columns."}`;
    if (!fit.rows) return `Use at most ${HEATMAP_MAX_ROWS} heatmap rows; ${swap ? "swap x and y or use fewer rows." : "use fewer rows."}`;
  }
  // A bar gauge label sits in a 140-unit column that starts 12 units in.
  const gaugeLabel = Math.floor((140 - 12) / NARROW / CHAR) - 1;
  if (input.kind === "barGauge" && input.data.some((item) => item.label.length > gaugeLabel))
    return `Use bar gauge labels of at most ${gaugeLabel} characters, or a bar chart for longer names.`;
  if (input.kind === "gauge" || input.kind === "barGauge") {
    const ranges =
      input.kind === "gauge"
        ? [{ min: input.min ?? 0, max: input.max ?? 100 }]
        : input.data.map((item) => ({ min: item.min ?? input.min ?? 0, max: item.max ?? input.max ?? 100 }));
    // Existing gauges clamp their value and normalize the range; only new band boundaries impose these rules.
    if (input.thresholds) {
      if (input.thresholds.some((threshold, index) => index > 0 && threshold.value <= input.thresholds![index - 1]!.value))
        return "Set thresholds in strictly ascending order.";
      if (
        ranges.some(({ min, max }) => min >= max || input.thresholds!.some((threshold) => threshold.value < min || threshold.value > max))
      )
        return "Keep thresholds within every min..max range.";
    }
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
