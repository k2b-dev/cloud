import {
  type AxisOptions,
  type BarItem,
  bar as emptyBarChart,
  chartDatumSvg,
  computeDomain,
  escapeXml,
  extendDomainToNice,
  mapLog,
  mapRange,
  niceLogTicks,
  niceStep,
  type ReferenceLine,
  svgRoot,
} from "@k2b/stdlib";

/**
 * Bar chart options: stdlib's `charts.bar` options plus a title for the category axis and a separate value format.
 * The wrapper owns size and inspection.
 */
export type BarChartOptions = {
  data: BarItem[];
  /** Value axis. `label` titles it, `format` writes its ticks and, without `valueFormat`, the printed values. */
  yAxis?: AxisOptions;
  /** Category axis. `label` titles it. */
  xAxis?: { label?: string };
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
const wrapLabel = (label: string, maxPx: number, lines: number): { lines: string[]; truncated: boolean } => {
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
const headerHeight = (opts: BarChartOptions) => (opts.title || opts.subtitle ? (opts.title ? 14 : 0) + (opts.subtitle ? 6 : 0) + 16 : 0);
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
  const finite = finiteItems(opts.data);
  const header = headerHeight(opts);
  if (!finite.length) return { layout: "columns", height: 280, finite, header };
  if (columnsFit(opts, finite, width)) return { layout: "columns", height: 280, finite, header };
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

const renderHeader = (opts: BarChartOptions, width: number) => {
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
      `<text class="stdlib-chart-tick-label" x="${fmt(g.x0 - GAP_PX * units)}" y="${fmt(ty + 4)}" text-anchor="end">${escapeXml(ticks(tick))}</text>`,
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
  const labelY = g.y1 + 16;
  finite.forEach(({ item, index }, position) => {
    const center = g.x0 + slot * (position + 0.5);
    parts.push(
      `<text class="stdlib-chart-tick-label stdlib-chart-category-label" x="${fmt(center)}" y="${fmt(labelY)}" text-anchor="middle">${escapeXml(item.label)}</text>`,
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
    parts.push(`<line class="stdlib-chart-reference" x1="${fmt(g.x0)}" y1="${fmt(ry)}" x2="${fmt(g.x1)}" y2="${fmt(ry)}"/>`);
    if (ref.label)
      parts.push(
        `<text class="stdlib-chart-reference-label" x="${fmt(g.x1 - 4)}" y="${fmt(ry - 4)}" text-anchor="end">${escapeXml(ref.label)}</text>`,
      );
  }
  if (opts.xAxis?.label)
    parts.push(
      `<text class="stdlib-chart-axis-label" x="${fmt((g.x0 + g.x1) / 2)}" y="${fmt(labelY + 18)}" text-anchor="middle">${escapeXml(opts.xAxis.label)}</text>`,
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
    parts.push(`<line class="stdlib-chart-reference" x1="${fmt(rx)}" y1="${fmt(g.top)}" x2="${fmt(rx)}" y2="${fmt(plotBottom)}"/>`);
    if (ref.label)
      parts.push(
        `<text class="stdlib-chart-reference-label" x="${fmt(rx)}" y="${fmt(g.top - 8)}" text-anchor="middle">${escapeXml(ref.label)}</text>`,
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
  const plan = barChartPlan(opts, opts.width);
  if (!plan.finite.length) return emptyBarChart({ data: [], width: opts.width, height: opts.height, className: opts.className });
  const body =
    plan.layout === "rows"
      ? renderRows(opts, plan, opts.width, opts.inspect ?? false)
      : renderColumns(opts, plan, opts.width, opts.height, opts.inspect ?? false);
  return svgRoot({ width: opts.width, height: opts.height, className: opts.className }, body).replace(
    "<svg ",
    `<svg data-bar-layout="${plan.layout}" `,
  );
};
