import {
  type AxisOptions,
  type BarItem,
  chartDatumSvg,
  computeDomain,
  escapeXml,
  extendDomainToNice,
  mapLog,
  mapRange,
  niceLogTicks,
  niceStep,
  type ReferenceLine,
  referenceLineAttributes,
  svgRoot,
} from "../charts/core/svg";

import { categoryLabels } from "../charts/core/category-labels";

/**
 * Bar chart options: stdlib's `charts.bar` options plus a title for the category axis and a separate value format.
 * The wrapper owns size and inspection.
 */
export type BarChartOptions = {
  data?: BarItem[];
  /** Aligned categories and series. Null observations are gaps. */
  x?: string[];
  series?: { label: string; data: (number | null)[] }[];
  layout?: "columns" | "rows" | "grouped" | "stacked";
  normalize?: boolean;
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
/** Tick, category and value labels are 11px (see the `.k2b-chart` rules). */
const FONT_PX = 11;
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
const fmt = (value: number) => (Number.isFinite(value) ? `${Math.round(value * 100) / 100}` : "0");

/** Estimated width of `text` at `size` pixels in the UI sans font with tabular figures; a little wide on purpose. */
export const chartTextWidth = (text: string, size = FONT_PX): number => {
  let em = 0;
  for (const char of text) {
    if (/[\s.,:;!|'’ilIjft()[\]-]/.test(char)) em += 0.34;
    else if (/[MWmw@%]/.test(char)) em += 0.86;
    else if (/[A-Z0-9#$€&]/.test(char)) em += 0.66;
    else if (char.codePointAt(0)! > 0x2e80) em += 1;
    else em += 0.56;
  }
  return em * size;
};

/** Split a label into at most `lines` lines of `maxPx`; the last line ends with an ellipsis when the label is longer. */
export const wrapLabel = (label: string, maxPx: number, lines: number): { lines: string[]; truncated: boolean } => {
  const words = label.trim().split(/\s+/);
  const result: string[] = [];
  let current = "";
  const breakWord = (word: string) => {
    // A word wider than a line breaks inside the word.
    let part = "";
    for (const char of word) {
      if (part && chartTextWidth(part + char) > maxPx) {
        result.push(part);
        part = "";
      }
      part += char;
    }
    return part;
  };
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (chartTextWidth(candidate) <= maxPx) current = candidate;
    else {
      if (current) result.push(current);
      current = chartTextWidth(word) > maxPx ? breakWord(word) : word;
    }
  }
  if (current) result.push(current);
  if (result.length <= lines) return { lines: result, truncated: false };
  let last = result[lines - 1]!;
  while (last && chartTextWidth(`${last}…`) > maxPx) last = last.slice(0, -1).trimEnd();
  return { lines: [...result.slice(0, lines - 1), `${last}…`], truncated: true };
};

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
    if (step > 0 && Number.isFinite(step))
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
export const headerHeight = (opts: BarChartOptions) =>
  opts.title || opts.subtitle ? (opts.title ? 14 : 0) + (opts.subtitle ? 6 : 0) + 16 : 0;
const valueFormat = (opts: BarChartOptions) => opts.valueFormat ?? opts.yAxis?.format ?? ((value: number) => String(value));
const tickFormat = (opts: BarChartOptions) => opts.yAxis?.format ?? ((value: number) => String(value));

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

export const renderHeader = (opts: BarChartOptions, width: number) => {
  const parts: string[] = [];
  let y = 16;
  if (opts.title) {
    parts.push(`<text class="stdlib-chart-title" x="${fmt(width / 2)}" y="${y}" text-anchor="middle">${escapeXml(opts.title)}</text>`);
    y += 14;
  }
  if (opts.subtitle)
    parts.push(
      `<text class="stdlib-chart-subtitle" x="${fmt(width / 2)}" y="${y}" text-anchor="middle">${escapeXml(opts.subtitle)}</text>`,
    );
  return parts.join("");
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
        `<rect class="k2b-chart-category-band" fill="none" pointer-events="all" x="${fmt(center - slot / 2)}" y="${fmt(g.y0)}" width="${fmt(slot)}" height="${fmt(g.plotBottom - g.y0)}" rx="6"/><rect class="stdlib-chart-bar stdlib-chart-series-${series}" x="${fmt(x)}" y="${fmt(top)}" width="${fmt(barWidth)}" height="${fmt(barHeight)}"/>`,
        datum(item, index, [center, g.y0], format),
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
        `<rect class="k2b-chart-category-band" fill="none" pointer-events="all" x="0" y="${fmt(rowTop)}" width="${width}" height="${fmt(g.pitch)}" rx="6"/><rect class="stdlib-chart-bar stdlib-chart-series-${series}" x="${fmt(left)}" y="${fmt(middle - thickness / 2)}" width="${fmt(barWidth)}" height="${fmt(thickness)}"/>`,
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

/**
 * Render a bar chart in which every category has its label. Few short labels stand below vertical columns; otherwise
 * each category becomes a horizontal row with its label left of the bar and its value at the bar's end. Rows grow the
 * drawing instead of dropping labels: use {@link barChartLayout} for its logical height.
 */
export const renderBarChartSvg = (opts: BarChartOptions & { width: number; height: number; inspect?: boolean }): string => {
  if (opts.series) return renderSeriesBars(opts);
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
) {
  const unit = width / displayWidth;
  let x = 0,
    row = 0;
  const items = entries.map((entry) => {
    const finite = entry.data.filter((v): v is number => v !== null && Number.isFinite(v));
    const total = finite.length ? finite.reduce((sum, v) => sum + v, 0) : null;
    const valueWidth = Math.max(
      chartTextWidth(total === null ? "–" : format(total)),
      ...entry.data.filter((v): v is number => v !== null && Number.isFinite(v)).map((v) => chartTextWidth(format(v))),
    );
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
  const scale = valueScale(
    opts.normalize ? [0, 1] : [...values, ...(opts.compare?.data.filter((v): v is number => v !== null) ?? [])],
    opts.yAxis,
    true,
  );
  const format = valueFormat(opts);
  const units = size.width / narrow(opts);
  const legend = opts.legend !== false;
  // Keep the legend within one quarter of the frame, leaving room for the plot.
  const entries = [...series, ...(opts.compare ? [opts.compare] : [])];
  const legendLayout = barSeriesLegend(entries, format, size.width, narrow(opts), size.height * 0.25);
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
    return { label, index, center, current, total: totals[index]!, previous: opts.compare?.data[index] };
  });
  const barWidthPx =
    (opts.compare
      ? Math.min(slot * 0.32, 26)
      : Math.min(slot * (opts.layout === "stacked" ? 0.56 : 0.8 / Math.max(1, entries.length)), opts.layout === "stacked" ? 40 : 22)) /
    units;
  return { ...size, columns, totals, scale, left, right, top, bottom, slot, y, format, units, entries, legend, legendLayout, barWidthPx };
}

const renderSeriesBars = (opts: BarChartOptions & { width: number; height: number; inspect?: boolean }) => {
  const g = seriesBarLayout(opts, opts);
  const parts = [renderHeader(opts, opts.width)];
  const labels = categoryLabels(opts.locale);
  const change = new Intl.NumberFormat(opts.locale ?? "en", { style: "percent", maximumFractionDigits: 1, signDisplay: "exceptZero" });
  const text = (x: number, y: number, value: string, cls = "stdlib-chart-tick-label", anchor = "start", extra = "") =>
    `<text class="${cls}" x="${fmt(x)}" y="${fmt(y)}" text-anchor="${anchor}" ${extra}>${escapeXml(value)}</text>`;
  if (g.legend)
    g.legendLayout.items.forEach((entry, i) => {
      const y = headerHeight(opts) + entry.y;
      const x = entry.x;
      parts.push(
        `<rect class="stdlib-chart-series-${i < (opts.series?.length ?? 0) ? i % 8 : 0}" x="${x}" y="${y - 8}" width="${8 * g.units}" height="8" ${i >= (opts.series?.length ?? 0) ? 'style="fill:none;stroke:var(--stdlib-chart-c1);"' : ""}/>`,
      );
      if (i >= (opts.series?.length ?? 0))
        parts.push(
          `<path d="M ${x} ${y - 4} l ${4 * g.units} -4 M ${x + 2 * g.units} ${y} l ${6 * g.units} -6 M ${x + 6 * g.units} ${y} l ${2 * g.units} -2" fill="none" stroke="var(--stdlib-chart-c1,#3b82f6)" stroke-width="1"/>`,
        );
      const label = wrapLabel(entry.label, Math.max(8, entry.labelWidth), 1).lines[0] ?? entry.label;
      parts.push(
        text(x + 14 * g.units, y, label),
        text(
          entry.valueX,
          y,
          entry.total === null ? "–" : g.format(entry.total),
          "stdlib-chart-bar-value",
          "end",
          `data-bar-legend="${i < (opts.series?.length ?? 0) ? `series:${i}` : "previous"}" data-bar-total="${escapeXml(entry.total === null ? "–" : g.format(entry.total))}"`,
        ),
      );
    });
  if (g.legend && g.legendLayout.hidden)
    parts.push(text(0, headerHeight(opts) + g.legendLayout.height - 8, `+${g.legendLayout.hidden}`, "stdlib-chart-tick-label"));
  if (opts.yAxis?.label) parts.push(text(0, g.top - 6, opts.yAxis.label, "stdlib-chart-axis-label"));
  for (const tick of g.scale.ticks) {
    parts.push(`<line class="stdlib-chart-grid" x1="${g.left}" x2="${g.right}" y1="${g.y(tick)}" y2="${g.y(tick)}"/>`);
    parts.push(
      text(g.left - 6 * g.units, g.y(tick) + 4, opts.normalize ? `${Math.round(tick * 100)}%` : tickFormat(opts)(tick), undefined, "end"),
    );
  }
  parts.push(`<line class="stdlib-chart-axis" x1="${g.left}" x2="${g.right}" y1="${g.bottom}" y2="${g.bottom}"/>`);
  const visibleLabels = visibleCategoryLabels(
    g.columns.map((c) => c.label),
    g.left,
    g.slot,
    opts.width,
    g.units,
  );
  for (const column of g.columns) {
    const fields = column.current.map((v, i) => ({
      key: `series:${i}`,
      value: v.raw === null || !Number.isFinite(v.raw) ? "–" : v.raw!,
      formatted: v.raw === null || !Number.isFinite(v.raw) ? "–" : g.format(v.raw!),
    }));
    if (opts.compare) {
      const previous = column.previous;
      fields.push({
        key: "previous",
        value: previous ?? "–",
        formatted: previous === null || !Number.isFinite(previous) ? "–" : g.format(previous!),
      });
      const current = column.current[0]?.raw;
      const delta =
        current == null || previous == null || !Number.isFinite(current) || !Number.isFinite(previous) ? null : current - previous;
      fields.push({
        key: "delta",
        value: delta ?? "–",
        formatted: delta === null || previous === 0 ? "–" : change.format(delta / Math.abs(previous!)),
      });
    } else if (opts.layout === "stacked") {
      fields.reverse();
      fields.push({ key: "total", value: column.total ?? "–", formatted: column.total === null ? "–" : g.format(column.total) });
    }
    let marks = `<rect class="k2b-chart-category-band" fill="none" pointer-events="all" x="${column.center - g.slot / 2}" y="${g.top}" width="${g.slot}" height="${Math.max(0, g.bottom - g.top)}" rx="6"/>`;
    const bar = (value: number, base: number, x: number, width: number, color: number, previous = false) => {
      const y0 = g.y(g.scale.log ? g.scale.domain[0] : base),
        y1 = g.y(base + value);
      const rect = `<rect class="stdlib-chart-bar stdlib-chart-series-${color % 8}" x="${fmt(x)}" y="${fmt(Math.min(y0, y1))}" width="${fmt(Math.max(0, width))}" height="${fmt(Math.abs(y0 - y1))}" rx="3"/>`;
      if (!previous) return rect;
      // Inline strokes avoid document-global SVG pattern IDs, including duplicate charts during SSR.
      const lines: string[] = [];
      for (let d = -Math.abs(y0 - y1); d < width; d += 6) {
        const lo = Math.max(0, -d),
          hi = Math.min(Math.abs(y0 - y1), width - d);
        if (hi > lo)
          lines.push(
            `<line x1="${x + d + lo}" y1="${Math.max(y0, y1) - lo}" x2="${x + d + hi}" y2="${Math.max(y0, y1) - hi}" stroke="var(--stdlib-chart-c1,#3b82f6)" stroke-width="1.5"/>`,
          );
      }
      return `<g class="k2b-chart-previous">${rect.replace("/>", ' style="fill:var(--stdlib-chart-c1,#3b82f6);fill-opacity:.14;stroke:var(--stdlib-chart-c1,#3b82f6);stroke-width:1"/>')}${lines.join("")}</g>`;
    };
    if (opts.compare) {
      const bw = Math.min(g.slot * 0.32, 26);
      const gap = Math.min(1.5, g.slot * 0.08);
      if (column.previous !== null && Number.isFinite(column.previous) && (!g.scale.log || column.previous! > 0))
        marks += bar(column.previous!, 0, column.center - bw - gap, bw, 0, true);
      const value = column.current[0]?.value;
      if (value != null && (!g.scale.log || value > 0)) marks += bar(value, 0, column.center + gap, bw, 0);
    } else
      column.current.forEach((v) => {
        if (v.value === null || (g.scale.log && v.value <= 0)) return;
        const stacked = opts.layout === "stacked";
        const bw = stacked ? Math.min(g.slot * 0.56, 40) : Math.min((g.slot * 0.8) / g.entries.length, 22);
        const gap = bw / g.units > 4 ? 2 : 0;
        const x = stacked ? column.center - bw / 2 : column.center - (g.entries.length * bw) / 2 + v.seriesIndex * bw + gap / 2;
        const segment = bar(v.value, v.base, x, stacked ? bw : bw - gap, v.seriesIndex);
        if (
          stacked &&
          v.value > 0 &&
          column.current.some((next) => next.seriesIndex > v.seriesIndex && next.value !== null && next.value > 0)
        ) {
          const fullHeight = Math.abs(g.y(v.base) - g.y(v.base + v.value));
          const gap = Math.min(1.5, fullHeight / 2);
          marks += segment
            .replace(/y="[^"]*"/, `y="${g.y(v.base + v.value) + gap}"`)
            .replace(/height="[^"]*"/, `height="${fullHeight - gap}"`);
        } else marks += segment;
      });
    parts.push(
      chartDatumSvg(
        marks,
        { role: "item", index: column.index, label: column.label, anchor: [column.center, g.top], values: fields },
        opts.inspect ?? false,
      ).replace(
        /<title>[\s\S]*?<\/title>/,
        `<title>${escapeXml([column.label, ...fields.map((field) => `${field.key.startsWith("series:") ? opts.series![Number(field.key.slice(7))]!.label : field.key === "previous" ? opts.compare!.label : field.key === "delta" ? labels.change : labels.total}: ${field.formatted}`)].join(" · "))}</title>`,
      ),
    );
    if (visibleLabels.has(column.index))
      parts.push(text(column.center, g.bottom, column.label, "stdlib-chart-tick-label stdlib-chart-category-label", "middle", 'dy="16"'));
  }
  for (const ref of opts.references ?? [])
    if ((ref.axis ?? "y") === "y" && Number.isFinite(ref.value) && ref.value >= g.scale.domain[0] && ref.value <= g.scale.domain[1]) {
      parts.push(`<line class="stdlib-chart-reference" x1="${g.left}" x2="${g.right}" y1="${g.y(ref.value)}" y2="${g.y(ref.value)}"/>`);
      if (ref.label) parts.push(text(g.right, g.y(ref.value) - 4, ref.label, "stdlib-chart-reference-label", "end"));
    }
  if (opts.xAxis?.label) parts.push(text((g.left + g.right) / 2, opts.height - 2, opts.xAxis.label, "stdlib-chart-axis-label", "middle"));
  return svgRoot(opts, parts.join("")).replace("<svg ", '<svg data-bar-layout="columns" ');
};

const visibleCategoryLabels = (labels: string[], left: number, slot: number, width: number, units: number) => {
  const labelPx = Math.max(0, ...labels.map((label) => chartTextWidth(label))) + GAP_PX;
  const step = Math.max(1, Math.ceil(labelPx / (slot / units)));
  const inside = (i: number) => {
    const half = (chartTextWidth(labels[i]!) * units) / 2,
      center = left + slot * (i + 0.5);
    return center - half >= 0 && center + half <= width;
  };
  const first = Math.max(
    0,
    labels.findIndex((_, i) => inside(i)),
  );
  return new Set(labels.flatMap((_, i) => (i >= first && (i - first) % step === 0 && inside(i) ? [i] : [])));
};
