import { chartTextWidth, fmt, headerHeight, renderHeader, tickFormat, wrapLabel } from "../charts/core/bar-common";
import { barPercent, visibleCategoryLabels } from "../charts/core/bar-labels";
import { nestedDotOptions } from "../charts/core/dot-options";

import {
  type AxisOptions,
  type BarItem,
  chartDatumSvg,
  computeDomain,
  escapeXml,
  extendDomainToNice,
  MAX_AXIS_TICKS,
  mapLog,
  mapRange,
  niceLogTicks,
  niceStep,
  type ReferenceLine,
  referenceLineAttributes,
  svgRoot,
} from "../charts/core/svg-renderers";
import { chartMessages } from "./chart-message-catalog";

export { chartTextWidth, headerHeight, renderHeader, wrapLabel } from "../charts/core/bar-common";

/**
 * Bar chart options: stdlib's `charts.bar` options plus a title for the category axis and a separate value format.
 * The wrapper owns size and inspection.
 */
export type BarChartOptions = {
  data?: BarItem[];
  /** Aligned categories and series. Null observations are gaps. */
  x?: string[];
  series?: { label: string; data: (number | null)[] }[];
  layout?: "columns" | "rows" | "grouped" | "stacked" | "nested";
  normalize?: boolean;
  /** Initial/restored legend: sum counts, or show the last category for rates and shares. */
  legendValues?: "total" | "latest";
  marks?: "bars" | "dots";
  /** Dot matrix capacity in source units and an even mark budget (default 100). */
  total?: number;
  dots?: number;
  /** Unordered nonnegative rows without legacy drawing options form a ranked list. */
  share?: boolean;
  limit?: number;
  tone?: "in" | "out";

  locale?: string;
  compare?: { label: string; data: (number | null)[] };

  /** Value axis. `label` titles it, `format` writes its ticks and, without `valueFormat`, the printed values. */
  yAxis?: AxisOptions;
  /**
   * Category axis. `label` titles it. `ordered` marks categories that follow each other, such as days or steps: they
   * stay columns, and only every n-th label shows when they would not fit, as on a time axis. Unordered categories each
   * keep their label and turn into rows instead.
   */
  xAxis?: { label?: string; ordered?: boolean };
  /** Writes printed values and tooltip values. Defaults to `yAxis.format`. */
  valueFormat?: (value: number) => string;
  colorByBar?: boolean;
  references?: ReferenceLine[];
  /** Print every value at its bar. Default: whenever the values stay readable; rows always print them. */
  showValues?: boolean;
  /** A legend of the bar colors; used only with `colorByBar` in columns, where labels sit below the plot. */
  legend?: boolean;
  className?: string;
  title?: string;
  subtitle?: string;
  /**
   * The narrowest width in CSS pixels at which the drawing is shown; labels are laid out to fit it. Defaults to a
   * 320px phone column. A host that draws at its measured width passes that width.
   */
  displayWidth?: number;
  /** Logical insets of the column layout. Rows place their labels and values themselves. */
  padding?: number | { top?: number; right?: number; bottom?: number; left?: number };
};

export type BarChartLayout = "columns" | "rows";

/**
 * Text keeps its pixel size while the drawing stretches to its box, and the drawing is never measured. Labels are
 * laid out for the narrowest chart, a 320px phone column, so they fit in every wider one.
 */
const NARROW_PX = 296;
/** A label column takes at most this share of the narrowest chart; longer labels wrap to a second line. */
const LABEL_SHARE = 0.4;
const ROW_MIN = 22;
const ROW_TWO_LINES = 32;
const ROW_MAX = 36;
/** Rows aim for the height of the other Cartesian charts before they grow. */
const ROWS_TARGET_HEIGHT = 280;
const BAR_MAX = 20;
const COLUMN_MAX = 40;
const GAP_PX = 6;
const LEGEND_ROW = 20;
/** Rows keep at least this share of the narrowest chart for their bars; wider values go to the tooltip and table. */
const MIN_PLOT_SHARE = 0.3;

const narrow = (opts: BarChartOptions) => opts.displayWidth ?? NARROW_PX;
const signedRows = (opts: BarChartOptions) => opts.data?.some((d) => Number.isFinite(d.value) && d.value < 0);
/** Ranking cannot replace the 0.69 row drawing when it would discard ordering, marks or axes. */
const rankedRows = (opts: BarChartOptions) =>
  opts.layout === "rows" &&
  !opts.series &&
  !signedRows(opts) &&
  !opts.xAxis?.ordered &&
  opts.xAxis?.label === undefined &&
  opts.references === undefined &&
  opts.colorByBar === undefined &&
  opts.showValues === undefined &&
  opts.yAxis?.label === undefined &&
  opts.yAxis?.domain === undefined &&
  opts.yAxis?.scale === undefined &&
  opts.yAxis?.ticks === undefined;
type Scale = { domain: [number, number]; ticks: number[]; log: boolean };

/** The value scale of stdlib's bar chart: nice linear ticks including zero, or decades on a log axis. */
const valueScale = (values: number[], axis: AxisOptions | undefined, nice: boolean): Scale => {
  const log = axis?.scale === "log";
  if (axis?.domain) {
    const [lo, hi] = axis.domain;
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi || (log && lo <= 0))
      throw new RangeError("Chart axis domain must have finite increasing bounds (positive for log scales)");
    // Bars rest on zero, so a linear domain must contain it like every value.
    if ((log ? values : [...values, 0]).some((value) => (!log || value > 0) && (value < lo || value > hi)))
      throw new RangeError("Chart axis domain must contain all plotted values and bounds");
    if (log) return { domain: [lo, hi], ticks: niceLogTicks(lo, hi).ticks.filter((tick) => tick >= lo && tick <= hi), log };
    const step = niceStep(hi - lo, axis.ticks ?? 5);
    const ticks = [lo];
    if (step > 0 && Number.isFinite(step) && (hi - lo) / step <= MAX_AXIS_TICKS)
      for (let value = Math.ceil(lo / step) * step; value < hi; ) {
        if (value > lo) ticks.push(value);
        const next = value + step;
        if (next <= value) break;
        value = next;
      }
    return { domain: [lo, hi], ticks: [...ticks, hi], log };
  }
  if (log) {
    const positive = values.filter((value) => value > 0);
    if (!positive.length) return { domain: [1, 10], ticks: [1, 10], log };
    return { ...niceLogTicks(Math.min(...positive), Math.max(...positive)), log };
  }
  const [min, max] = computeDomain([...values, 0]);
  if (!nice) return { domain: [min, max], ticks: [], log };
  return { ...extendDomainToNice(min, max, niceStep(max - min, axis?.ticks ?? 5)), log };
};

const project = (scale: Scale, value: number, range: [number, number]) => (scale.log ? mapLog : mapRange)(value, scale.domain, range);

type Plan = {
  layout: BarChartLayout;
  height: number;
  finite: { item: BarItem; index: number }[];
  header: number;
};

const finiteItems = (data: BarItem[]) => data.flatMap((item, index) => (Number.isFinite(item.value) ? [{ item, index }] : []));
const valueFormat = (opts: BarChartOptions) => opts.valueFormat ?? opts.yAxis?.format ?? ((value: number) => String(value));

/** Columns, when every category label fits below its column on the narrowest chart; rows otherwise. */
const columnsFit = (opts: BarChartOptions, finite: Plan["finite"], width: number) => {
  const units = width / narrow(opts);
  const columns = columnGeometry(opts, finite, width, 280);
  const slotPx = (columns.x1 - columns.x0) / finite.length / units;
  if (finite.some(({ item }) => chartTextWidth(item.label) + GAP_PX > slotPx)) return false;
  // Asked-for values must stay readable too; rows always have room for them.
  return opts.showValues !== true || columns.valuesFit;
};

/** The renderer's plan for a chart: its layout and logical height at `width`, derived from the data alone. */
const barChartPlan = (opts: BarChartOptions, width = 480): Plan => {
  const finite = finiteItems(opts.data ?? []);
  if (rankedRows(opts))
    return { layout: "rows", height: rankedBarLayout(opts, { width, height: 280 }).height, finite, header: headerHeight(opts) };
  if (opts.series) return { layout: "columns", height: 280, finite, header: headerHeight(opts) };
  const header = headerHeight(opts);
  if (!finite.length) return { layout: "columns", height: 280, finite, header };
  if (opts.layout === "columns" || (opts.layout !== "rows" && (opts.xAxis?.ordered || columnsFit(opts, finite, width))))
    return { layout: "columns", height: 280, finite, header };
  const rows = rowGeometry(opts, finite, width, header);
  return { layout: "rows", height: rows.height, finite, header };
};

/** The layout a bar chart takes and its logical height, so server and browser reserve the same box. */
export const barChartLayout = (opts: BarChartOptions, width = 480): { layout: BarChartLayout; height: number } => {
  const { layout, height } = barChartPlan(opts, width);
  return { layout, height };
};

const columnGeometry = (opts: BarChartOptions, finite: Plan["finite"], width: number, height: number) => {
  const units = width / narrow(opts);
  const given =
    typeof opts.padding === "number" ? { top: opts.padding, right: opts.padding, bottom: opts.padding, left: opts.padding } : opts.padding;
  const values = finite.map(({ item }) => item.value);
  const scale = valueScale(values, opts.yAxis, true);
  const ticks = tickFormat(opts);
  const longestTick = Math.max(0, ...scale.ticks.map((tick) => chartTextWidth(ticks(tick))));
  const legendRows = opts.colorByBar && opts.legend ? legendLayout(opts, finite, width).rows : 0;
  const header = headerHeight(opts);
  const x0 = given?.left ?? Math.max(40, Math.ceil((longestTick + GAP_PX + 2) * units));
  const x1 = width - (given?.right ?? 16);
  const y0 = header + (given?.top ?? 16) + (opts.yAxis?.label ? 16 : 0);
  const y1 = height - (given?.bottom ?? 22) - (opts.xAxis?.label ? 16 : 0) - legendRows * LEGEND_ROW;
  const slotPx = (x1 - x0) / Math.max(1, finite.length) / units;
  const format = valueFormat(opts);
  const valuesFit = finite.every(({ item }) => chartTextWidth(format(item.value)) + 2 <= slotPx);
  const printValues = opts.showValues ?? valuesFit;
  // A printed negative value hangs below its bar: the plot ends a line above the category labels.
  const plotBottom = y1 - (printValues && values.some((value) => value < 0) ? 14 : 0);
  return { x0, x1, y0, y1, plotBottom, scale, valuesFit, printValues, legendRows };
};

const rowGeometry = (opts: BarChartOptions, finite: Plan["finite"], width: number, header: number) => {
  const printed = rowGeometryWith(opts, finite, width, header, opts.showValues !== false);
  // Values too wide to leave the bars room stay in the tooltip and table; a value axis replaces them.
  if (printed.showValues && (printed.x1 - printed.x0) / (width / narrow(opts)) < narrow(opts) * MIN_PLOT_SHARE)
    return rowGeometryWith(opts, finite, width, header, false);
  return printed;
};

const rowGeometryWith = (opts: BarChartOptions, finite: Plan["finite"], width: number, header: number, showValues: boolean) => {
  const units = width / narrow(opts);
  const maxLabelPx = narrow(opts) * LABEL_SHARE;
  const labels = finite.map(({ item }) => wrapLabel(item.label, maxLabelPx, 2));
  const twoLines = labels.some((label) => label.lines.length > 1);
  const labelPx = Math.min(maxLabelPx, Math.max(0, ...labels.flatMap((label) => label.lines.map((line) => chartTextWidth(line)))));
  const format = valueFormat(opts);
  const positivePx = showValues
    ? Math.max(0, ...finite.filter(({ item }) => item.value >= 0).map(({ item }) => chartTextWidth(format(item.value))))
    : 0;
  const negativePx = showValues
    ? Math.max(0, ...finite.filter(({ item }) => item.value < 0).map(({ item }) => chartTextWidth(format(item.value))))
    : 0;
  const refLabels = (opts.references ?? []).some((ref) => (ref.axis ?? "y") === "y" && ref.label);
  const titled = !!(opts.xAxis?.label || opts.yAxis?.label || refLabels);
  const top = header + (titled ? 20 : 4);
  const bottom = showValues ? 4 : 24;
  const minimum = twoLines ? ROW_TWO_LINES : ROW_MIN;
  const pitch = Math.min(ROW_MAX, Math.max(minimum, (ROWS_TARGET_HEIGHT - top - bottom) / finite.length));
  const labelEnd = Math.ceil(labelPx * units);
  const x0 = labelEnd + GAP_PX * units + (negativePx ? (negativePx + GAP_PX) * units : 0);
  const x1 = width - (positivePx ? (positivePx + GAP_PX) * units : 8 * units);
  return { labels, labelEnd, x0, x1, top, pitch, twoLines, showValues, height: Math.ceil(top + pitch * finite.length + bottom) };
};

const legendLayout = (opts: BarChartOptions, finite: Plan["finite"], width: number) => {
  const units = width / narrow(opts);
  const rows: { label: string; color: number; x: number }[][] = [[]];
  let cursor = 0;
  finite.forEach(({ item }, index) => {
    const itemWidth = (8 + 4 + chartTextWidth(item.label)) * units;
    if (cursor > 0 && cursor + 12 * units + itemWidth > width) {
      rows.push([]);
      cursor = 0;
    }
    const x = cursor ? cursor + 12 * units : 0;
    rows.at(-1)!.push({ label: item.label, color: colorIndex(item, index), x });
    cursor = x + itemWidth;
  });
  return { rows: rows.length, items: rows };
};

const colorIndex = (item: BarItem, fallback: number) => {
  const index = item.colorIndex ?? fallback;
  if (!Number.isInteger(index) || index < 0) throw new RangeError("Chart colorIndex must be a nonnegative integer");
  return index % 8;
};

const datum = (item: BarItem, index: number, anchor: [number, number], format: (value: number) => string) => ({
  index,
  role: "item" as const,
  label: item.label,
  anchor,
  values: [{ key: "value", value: item.value, formatted: format(item.value) }],
});

const renderColumns = (opts: BarChartOptions, plan: Plan, width: number, height: number, inspect: boolean) => {
  const { finite } = plan;
  const units = width / narrow(opts);
  const g = columnGeometry(opts, finite, width, height);
  const ticks = tickFormat(opts);
  const format = valueFormat(opts);
  const showValues = g.printValues;
  const parts: string[] = [renderHeader(opts, width)];
  const y = (value: number) => project(g.scale, value, [g.plotBottom, g.y0]);
  if (opts.yAxis?.label)
    parts.push(
      `<text class="stdlib-chart-axis-label" x="0" y="${fmt(g.y0 - 8)}" text-anchor="start">${escapeXml(opts.yAxis.label)}</text>`,
    );
  for (const tick of g.scale.ticks) {
    const ty = y(tick);
    parts.push(`<line class="stdlib-chart-grid" x1="${fmt(g.x0)}" y1="${fmt(ty)}" x2="${fmt(g.x1)}" y2="${fmt(ty)}"/>`);
    parts.push(
      `<text class="stdlib-chart-tick-label" x="${fmt(g.x0 - GAP_PX * units)}" y="${fmt(ty)}" dy="4" text-anchor="end">${escapeXml(ticks(tick))}</text>`,
    );
  }
  if (opts.yAxis?.minorTicks && !g.scale.log)
    g.scale.ticks.slice(1).forEach((tick, index) => {
      const previous = g.scale.ticks[index]!;
      for (let step = 1; step < 5; step++) {
        const ty = y(previous + ((tick - previous) * step) / 5);
        parts.push(`<line class="stdlib-chart-minor-tick" x1="${fmt(g.x0 - 3)}" y1="${fmt(ty)}" x2="${fmt(g.x0)}" y2="${fmt(ty)}"/>`);
      }
    });
  const baseline = g.scale.log ? g.plotBottom : y(0);
  parts.push(`<line class="stdlib-chart-axis" x1="${fmt(g.x0)}" y1="${fmt(baseline)}" x2="${fmt(g.x1)}" y2="${fmt(baseline)}"/>`);
  const slot = (g.x1 - g.x0) / finite.length;
  const barWidth = Math.min(slot * 0.8, COLUMN_MAX);
  // Text keeps its pixel size around its x/y anchor (`.k2b-chart` CSS), and so does a `dy` offset: labels anchored on
  // the plot's bottom edge stay clear of the axis in a box shorter than the drawing.
  const labelY = g.y1;
  // Unordered columns fit every label (see columnsFit); ordered ones label every n-th column that leaves room, from
  // the first column whose label stays inside the drawing.
  const visibleLabels = visibleCategoryLabels(
    finite.map(({ item }) => item.label),
    g.x0,
    slot,
    width,
    units,
  );
  finite.forEach(({ item, index }, position) => {
    const center = g.x0 + slot * (position + 0.5);
    if (visibleLabels.has(position))
      parts.push(
        `<text class="stdlib-chart-tick-label stdlib-chart-category-label" x="${fmt(center)}" y="${fmt(labelY)}" dy="16" text-anchor="middle">${escapeXml(item.label)}</text>`,
      );
    if (g.scale.log && item.value <= 0) return;
    const valueY = y(item.value);
    const top = Math.min(valueY, baseline);
    const barHeight = Math.abs(valueY - baseline);
    const x = center - barWidth / 2;
    const series = opts.colorByBar ? colorIndex(item, position) : 0;
    parts.push(
      chartDatumSvg(
        `<rect class="stdlib-chart-bar stdlib-chart-series-${series}" x="${fmt(x)}" y="${fmt(top)}" width="${fmt(barWidth)}" height="${fmt(barHeight)}"/>`,
        datum(item, index, [center, top + barHeight / 2], format),
        inspect,
      ),
    );
    if (showValues)
      parts.push(
        `<text class="stdlib-chart-bar-value" x="${fmt(center)}" y="${fmt(item.value < 0 ? top + barHeight + 13 : top - 4)}" text-anchor="middle">${escapeXml(format(item.value))}</text>`,
      );
  });
  for (const ref of opts.references ?? []) {
    if ((ref.axis ?? "y") !== "y" || !Number.isFinite(ref.value) || ref.value < g.scale.domain[0] || ref.value > g.scale.domain[1])
      continue;
    const ry = y(ref.value);
    parts.push(
      `<line class="stdlib-chart-reference"${referenceLineAttributes(ref)} x1="${fmt(g.x0)}" y1="${fmt(ry)}" x2="${fmt(g.x1)}" y2="${fmt(ry)}"/>`,
    );
    if (ref.label)
      parts.push(
        `<text class="stdlib-chart-reference-label"${referenceLineAttributes(ref, true)} x="${fmt(g.x1 - 4)}" y="${fmt(ry - 4)}" text-anchor="end">${escapeXml(ref.label)}</text>`,
      );
  }
  if (opts.xAxis?.label)
    parts.push(
      `<text class="stdlib-chart-axis-label" x="${fmt((g.x0 + g.x1) / 2)}" y="${fmt(labelY)}" dy="34" text-anchor="middle">${escapeXml(opts.xAxis.label)}</text>`,
    );
  if (g.legendRows) {
    const legend = legendLayout(opts, finite, width);
    const top = height - g.legendRows * LEGEND_ROW;
    parts.push('<g class="stdlib-chart-legend">');
    legend.items.forEach((row, rowIndex) => {
      const middle = top + rowIndex * LEGEND_ROW + LEGEND_ROW / 2;
      for (const entry of row)
        parts.push(
          `<g class="stdlib-chart-legend-item stdlib-chart-series-${entry.color}"><rect class="stdlib-chart-legend-swatch" x="${fmt(entry.x)}" y="${fmt(middle - 4)}" width="${fmt(8 * units)}" height="8" rx="1"/><text class="stdlib-chart-legend-label" x="${fmt(entry.x + 12 * units)}" y="${fmt(middle + 4)}">${escapeXml(entry.label)}</text></g>`,
        );
    });
    parts.push("</g>");
  }
  return parts.join("");
};

const renderRows = (opts: BarChartOptions, plan: Plan, width: number, inspect: boolean) => {
  const { finite, header } = plan;
  const units = width / narrow(opts);
  const g = rowGeometry(opts, finite, width, header);
  const format = valueFormat(opts);
  const scale = valueScale(
    finite.map(({ item }) => item.value),
    opts.yAxis,
    !g.showValues,
  );
  const x = (value: number) => project(scale, value, [g.x0, g.x1]);
  const baseline = scale.log ? g.x0 : x(0);
  const plotBottom = g.top + g.pitch * finite.length;
  const thickness = Math.min(BAR_MAX, g.pitch - (g.twoLines ? 14 : 8));
  const parts: string[] = [renderHeader(opts, width)];
  if (opts.xAxis?.label)
    parts.push(
      `<text class="stdlib-chart-axis-label" x="0" y="${fmt(g.top - 8)}" text-anchor="start">${escapeXml(opts.xAxis.label)}</text>`,
    );
  if (opts.yAxis?.label)
    parts.push(
      `<text class="stdlib-chart-axis-label" x="${width}" y="${fmt(g.top - 8)}" text-anchor="end">${escapeXml(opts.yAxis.label)}</text>`,
    );
  if (!g.showValues) {
    const ticks = tickFormat(opts);
    for (const tick of scale.ticks) {
      const tx = x(tick);
      parts.push(`<line class="stdlib-chart-grid" x1="${fmt(tx)}" y1="${fmt(g.top)}" x2="${fmt(tx)}" y2="${fmt(plotBottom)}"/>`);
      parts.push(
        `<text class="stdlib-chart-tick-label" x="${fmt(tx)}" y="${fmt(plotBottom + 16)}" text-anchor="middle">${escapeXml(ticks(tick))}</text>`,
      );
    }
  }
  finite.forEach(({ item, index }, position) => {
    const rowTop = g.top + g.pitch * position;
    const middle = rowTop + g.pitch / 2;
    const label = g.labels[position]!;
    const title = label.truncated ? `<title>${escapeXml(item.label)}</title>` : "";
    label.lines.forEach((line, lineIndex) => {
      const lineY = middle + 4 + (label.lines.length > 1 ? (lineIndex === 0 ? -6.5 : 6.5) : 0);
      parts.push(
        `<text class="stdlib-chart-tick-label stdlib-chart-category-label" x="${fmt(g.labelEnd)}" y="${fmt(lineY)}" text-anchor="end">${title}${escapeXml(line)}</text>`,
      );
    });
    if (scale.log && item.value <= 0) return;
    const valueX = x(item.value);
    const left = Math.min(valueX, baseline);
    const barWidth = Math.abs(valueX - baseline);
    const series = opts.colorByBar ? colorIndex(item, position) : 0;
    parts.push(
      chartDatumSvg(
        `<rect class="stdlib-chart-bar stdlib-chart-series-${series}" x="${fmt(left)}" y="${fmt(middle - thickness / 2)}" width="${fmt(barWidth)}" height="${fmt(thickness)}"/>`,
        datum(item, index, [left + barWidth / 2, middle], format),
        inspect,
      ),
    );
    if (g.showValues) {
      const negative = item.value < 0;
      parts.push(
        `<text class="stdlib-chart-bar-value" x="${fmt(valueX + (negative ? -GAP_PX : GAP_PX) * units)}" y="${fmt(middle + 4)}" text-anchor="${negative ? "end" : "start"}">${escapeXml(format(item.value))}</text>`,
      );
    }
  });
  parts.push(`<line class="stdlib-chart-axis" x1="${fmt(baseline)}" y1="${fmt(g.top)}" x2="${fmt(baseline)}" y2="${fmt(plotBottom)}"/>`);
  for (const ref of opts.references ?? []) {
    if ((ref.axis ?? "y") !== "y" || !Number.isFinite(ref.value) || ref.value < scale.domain[0] || ref.value > scale.domain[1]) continue;
    const rx = x(ref.value);
    parts.push(
      `<line class="stdlib-chart-reference"${referenceLineAttributes(ref)} x1="${fmt(rx)}" y1="${fmt(g.top)}" x2="${fmt(rx)}" y2="${fmt(plotBottom)}"/>`,
    );
    if (ref.label)
      parts.push(
        `<text class="stdlib-chart-reference-label"${referenceLineAttributes(ref, true)} x="${fmt(rx)}" y="${fmt(g.top - 8)}" text-anchor="middle">${escapeXml(ref.label)}</text>`,
      );
  }
  return parts.join("");
};

/** Internal legacy/category drawing; the series drawing entry loads separately from frame sizing. */
export const renderBarDataSvg = (opts: BarChartOptions & { width: number; height: number; inspect?: boolean }): string => {
  if (rankedRows(opts)) return renderRankedBars(opts);
  const plan = barChartPlan(opts, opts.width);
  // The empty drawing of stdlib's bar chart, written here so bundles leave out stdlib's whole bar renderer.
  if (!plan.finite.length)
    return svgRoot(
      { width: opts.width, height: opts.height, className: opts.className },
      `<text class="stdlib-chart-empty-text" x="${fmt(opts.width / 2)}" y="${fmt(opts.height / 2)}" text-anchor="middle" dominant-baseline="middle">no data</text>`,
    );
  const body =
    plan.layout === "rows"
      ? renderRows(opts, plan, opts.width, opts.inspect ?? false)
      : renderColumns(opts, plan, opts.width, opts.height, opts.inspect ?? false);
  return svgRoot({ width: opts.width, height: opts.height, className: opts.className }, body).replace(
    "<svg ",
    `<svg data-bar-layout="${plan.layout}" `,
  );
};

/** Stable wrapping legend slots reserve the widest total or category value before interaction. */
export function barSeriesLegend(
  entries: { label: string; data: (number | null)[] }[],
  format: (v: number) => string,
  width = 480,
  displayWidth = 296,
  maxHeight = Infinity,
  summary: "total" | "latest" = "total",
) {
  const unit = width / displayWidth;
  let x = 0,
    row = 0;
  const items = entries.map((entry) => {
    const finite = entry.data.filter((v): v is number => v !== null && Number.isFinite(v));
    const latest = entry.data.at(-1);
    const total =
      summary === "latest"
        ? latest != null && Number.isFinite(latest)
          ? latest
          : null
        : finite.length
          ? finite.reduce((sum, v) => sum + v, 0)
          : null;
    const valueWidth = Math.max(chartTextWidth(total === null ? "–" : format(total)), ...finite.map((v) => chartTextWidth(format(v))));
    const labelWidth = Math.max(8, Math.min(96, displayWidth - valueWidth - 32, chartTextWidth(entry.label)));
    const slot = Math.min(width, (14 + labelWidth + 6 + valueWidth + 16) * unit);
    if (x && x + slot > width) {
      x = 0;
      row++;
    }
    const item = { ...entry, total, x, y: row * 20 + 12, labelWidth, valueX: x + slot - 16 * unit };
    x += slot;
    return item;
  });
  const rows = Math.max(1, Math.floor(maxHeight / 20));
  const overflow = row + 1 > rows;
  const visible = overflow ? items.filter((item) => item.y <= (rows - 1) * 20) : items;
  return { items: visible, hidden: items.length - visible.length, height: entries.length ? Math.min(row + 1, rows) * 20 : 0 };
}

/** Category geometry shared by SVG, server snapshots and browser inspection. */
export function seriesBarLayout(opts: BarChartOptions, size = { width: 480, height: 280 }) {
  const categories = opts.x ?? [];
  const series = opts.series ?? [];
  if (series.some((s) => s.data.length !== categories.length) || (opts.compare && opts.compare.data.length !== categories.length))
    throw new RangeError("Bar series must have the same length as x");
  if (opts.compare && series.length !== 1) throw new RangeError("Bar comparison needs exactly one current series");
  if (opts.normalize && opts.layout !== "stacked") throw new RangeError("Normalized bars must be stacked");
  const dot = nestedDotOptions(opts);
  if (opts.layout === "stacked" && opts.yAxis?.scale === "log") throw new RangeError("Stacked bars need a linear axis");
  if (opts.layout === "stacked" && series.some((s) => s.data.some((v) => v !== null && v < 0)))
    throw new RangeError("Stacked bars require nonnegative values");
  const totals = categories.map((_, i) =>
    series.some((s) => Number.isFinite(s.data[i]))
      ? series.reduce((sum, s) => sum + (Number.isFinite(s.data[i]) ? s.data[i]! : 0), 0)
      : null,
  );
  const values =
    opts.layout === "stacked"
      ? totals.filter((v): v is number => v !== null)
      : series.flatMap((s) => s.data.filter((v): v is number => v !== null));
  const scale: Scale = dot
    ? { domain: [0, dot.total], ticks: [0, 0.25, 0.5, 0.75, 1].map((v) => v * dot.total), log: false }
    : valueScale(
        opts.normalize ? [0, 1] : [...values, ...(opts.compare?.data.filter((v): v is number => v !== null) ?? [])],
        opts.yAxis,
        true,
      );
  const format = valueFormat(opts);
  const units = size.width / narrow(opts);
  const messages = chartMessages.resolve([opts.locale ?? "en"]).t;
  const labels = { delta: messages.chartFields({ key: "delta" }), total: messages.chartFields({ key: "total" }) };
  const legend = opts.legend !== false;
  // Keep the legend within one quarter of the frame, leaving room for the plot.
  const entries = [...series, ...(opts.compare ? [opts.compare] : [])];
  const legendLayout = barSeriesLegend(entries, format, size.width, narrow(opts), size.height * 0.25, opts.legendValues);
  const top = headerHeight(opts) + 8 + (legend ? legendLayout.height : 0) + (opts.yAxis?.label ? 16 : 0);
  const left = Math.max(
    40,
    ...scale.ticks.map((v) => (chartTextWidth(opts.normalize ? `${Math.round(v * 100)}%` : tickFormat(opts)(v)) + 8) * units),
  );
  const right = size.width - 4;
  const bottom = size.height - 24 - (opts.xAxis?.label ? 18 : 0);
  const slot = (right - left) / Math.max(1, categories.length);
  const y = (value: number) => project(scale, value, [bottom, top]);
  const columns = categories.map((label, index) => {
    const center = left + slot * (index + 0.5);
    let acc = 0;
    const current = series.map((s, seriesIndex) => {
      const raw = s.data[index];
      const value =
        raw === null || !Number.isFinite(raw) || (opts.normalize && totals[index] === 0)
          ? null
          : opts.normalize
            ? raw! / totals[index]!
            : raw!;
      const base = opts.layout === "stacked" ? acc : 0;
      if (value !== null && opts.layout === "stacked") acc += value;
      return { seriesIndex, raw, value, base };
    });
    const matrix =
      dot && current.every((v) => v.raw !== null && Number.isFinite(v.raw))
        ? Array.from({ length: dot.count }, (_, k) => {
            const rowHeight = Math.max(0, bottom - top) / (dot.count / 2),
              cell = Math.min(rowHeight, (slot * 0.8) / 2);
            const matched = current.findLastIndex((v) => k < Math.round((v.raw! / dot.total) * dot.count));
            const seriesIndex = matched < 0 ? null : matched;
            return {
              x: center + ((k % 2) - 0.5) * cell * 1.05,
              y: bottom - (Math.floor(k / 2) + 0.5) * rowHeight,
              radius: Math.min(cell, rowHeight) * 0.36,
              seriesIndex,
            };
          })
        : [];
    return { label, index, center, current, total: totals[index]!, previous: opts.compare?.data[index], matrix };
  });
  const barWidthPx =
    (opts.compare
      ? Math.min(slot * 0.32, 26)
      : Math.min(slot * (opts.layout === "stacked" ? 0.56 : 0.8 / Math.max(1, entries.length)), opts.layout === "stacked" ? 40 : 22)) /
    units;
  return {
    ...size,
    columns,
    totals,
    scale,
    left,
    right,
    top,
    bottom,
    slot,
    y,
    format,
    labels,
    units,
    entries,
    legend,
    legendLayout,
    barWidthPx,
    dot,
  };
}

export type SeriesBarLayout = ReturnType<typeof seriesBarLayout>;

/** Ranked rows retain original indices. A limit changes the drawing, never the denominator or source data. */
export function rankedBarLayout(opts: BarChartOptions, size = { width: 480, height: 280 }) {
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1))
    throw new RangeError("Bar list limit must be a positive integer");
  if (opts.data?.some((d) => Number.isFinite(d.value) && d.value < 0)) throw new RangeError("Ranked bar lists require nonnegative values");
  const sorted = (opts.data ?? [])
    .map((item, index) => ({ ...item, index }))
    .sort((a, b) => (Number.isFinite(b.value) ? b.value : -Infinity) - (Number.isFinite(a.value) ? a.value : -Infinity));
  const total = sorted.reduce((sum, d) => sum + (Number.isFinite(d.value) ? d.value : 0), 0);
  const shown = sorted.slice(0, opts.limit),
    rest = sorted.slice(shown.length);
  const top = headerHeight(opts),
    unit = size.width / narrow(opts),
    format = opts.valueFormat ?? opts.yAxis?.format ?? ((v: number) => new Intl.NumberFormat(opts.locale ?? "en").format(v)),
    percent = barPercent(opts.locale);
  const shareWidth = opts.share ? 48 * unit : 0;
  const valueWidth = Math.max(20, ...shown.map((d) => chartTextWidth(Number.isFinite(d.value) ? format(d.value) : "–"))) * unit;
  const labelWidth = Math.max(8, (size.width - shareWidth - valueWidth - 36 * unit) / unit);
  const max = Math.max(0, ...sorted.map((d) => (Number.isFinite(d.value) ? d.value : 0)));
  const rows = shown.map((d, rank) => ({
    ...d,
    rank: rank + 1,
    y: top + rank * 36,
    width: Number.isFinite(d.value) && max > 0 ? (d.value / max) * size.width : 0,
    share: Number.isFinite(d.value) && total > 0 ? d.value / total : null,
  }));
  return {
    ...size,
    height: Math.max(size.height, top + rows.length * 36 + (rest.length ? 24 : 0)),
    rows,
    total,
    rest,
    restValue: rest.some((d) => Number.isFinite(d.value))
      ? rest.reduce((sum, d) => sum + (Number.isFinite(d.value) ? d.value : 0), 0)
      : null,
    top,
    unit,
    format,
    percent,
    shareWidth,
    labelWidth,
  };
}

const renderRankedBars = (opts: BarChartOptions & { width: number; height: number; inspect?: boolean }) => {
  const g = rankedBarLayout(opts, opts),
    labels = chartMessages.resolve([opts.locale ?? "en"]).t;
  const parts = [renderHeader(opts, opts.width)];
  const color = opts.tone ? `var(--k2b-flow-${opts.tone}-mark,var(--stdlib-chart-c1,#3b82f6))` : "var(--stdlib-chart-c1,#3b82f6)";
  const text = (x: number, y: number, value: string, anchor = "start", cls = "stdlib-chart-tick-label") =>
    `<text class="${cls}" x="${x}" y="${y}" text-anchor="${anchor}">${escapeXml(value)}</text>`;
  for (const row of g.rows) {
    const value = Number.isFinite(row.value) ? row.value : null,
      written = value === null ? "–" : g.format(value);
    const share = row.share === null ? "–" : g.percent.format(row.share);
    const label = wrapLabel(row.label, (g.labelWidth * 11) / 13, 1).lines[0] ?? row.label;
    const marks = `<rect class="k2b-chart-category-band" fill="none" pointer-events="all" x="0" y="${row.y}" width="${g.width}" height="32" rx="6"/><rect x="0" y="${row.y}" width="${row.width}" height="32" rx="6" style="fill:${color};fill-opacity:.16;pointer-events:none"/>${text(10 * g.unit, row.y + 20, label)}${text(g.width - 10 * g.unit - g.shareWidth, row.y + 20, written, "end", "stdlib-chart-bar-value")}${opts.share ? text(g.width - 10 * g.unit, row.y + 20, share, "end") : ""}`;
    parts.push(
      chartDatumSvg(
        marks,
        {
          role: "item",
          index: row.index,
          label: row.label,
          anchor: [g.width / 2, row.y],
          values: [
            { key: "value", value: value ?? "–", formatted: written },
            { key: "percent", value: row.share === null ? "–" : row.share * 100, formatted: share },
            { key: "rank", value: row.rank },
          ],
        },
        opts.inspect ?? false,
        `${row.label} · ${written} · ${share} · ${labels.chartFields({ key: "rank" })}: ${row.rank}`,
      ),
    );
  }
  if (g.rest.length)
    parts.push(
      text(
        10 * g.unit,
        g.top + g.rows.length * 36 + 16,
        `${labels.chartBarMore({ n: g.rest.length })} · ${g.restValue === null ? "–" : g.format(g.restValue)}`,
      ),
    );
  return svgRoot({ ...opts, height: g.height, className: [opts.className, "k2b-chart-ranked"].filter(Boolean).join(" ") }, parts.join(""))
    .replace("</style>", ".k2b-chart-ranked :is(.stdlib-chart-tick-label,.stdlib-chart-bar-value){font-size:13px}</style>")
    .replace("<svg ", '<svg data-bar-layout="rows" ');
};
