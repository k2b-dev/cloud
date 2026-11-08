// Ported from @k2b/stdlib 0.30.0 (ISC); retain SVG and numeric algorithms until parity proves changes.
// ==========================
// SVG Chart Generation
// ==========================
//
// Pure-native SVG generation for the four basic chart types: scatter, line,
// bar, and pie/donut. Returns SVG strings — inject directly into the DOM,
// write to disk, or send over the wire. No peer dependencies.
//
// Charts ship with embedded default CSS using semantic class names and CSS
// custom properties for colors. Consumers override styles via class selectors
// (their CSS wins on specificity) or CSS variables (`--stdlib-chart-c1` ...
// `--stdlib-chart-c8`). Axes and labels use `currentColor` so parent `color`
// drives theming (dark mode "just works").

import type { ChartTimeAxis } from "../../content/chart-time-axis";
import {
  type AxisOptions,
  arcLinePathD,
  arcPathD,
  autoBin,
  type BarItem,
  type ChartOptions,
  chartDatumSvg,
  clamp,
  collectAxisValues,
  collectSeriesLegend,
  computeAxisScale,
  computeBoxStats,
  computeDomain,
  computePlotArea,
  DEFAULT_HEIGHT,
  DEFAULT_MARKERS,
  DEFAULT_WIDTH,
  emptyChart,
  escapeXml,
  extendDomainToNice,
  fmt,
  formatNumberValue,
  gaugeColorAt,
  gaugeThresholdStops,
  inspectionPoint,
  isOnAxis,
  itemColorIndex,
  linearRegression,
  linePathD,
  mapRange,
  markerPath,
  measureLegendHeight,
  niceStep,
  normalizeMinMax,
  normalizePadding,
  type Point,
  pickMapper,
  pointValues,
  polarPoint,
  type ReferenceLine,
  renderErrorBars,
  renderGaugeGradientSegments,
  renderHeader,
  renderLegend,
  renderReferenceLines,
  renderXAxisCategorical,
  renderXAxisNumeric,
  renderYAxis,
  type Series,
  type SliceItem,
  smoothPathD,
  svgRoot,
  thresholdFillAttr,
  thresholdStrokeAttr,
} from "./svg-shared";
import type { ChartDatum } from "./types";

export {
  type AxisOptions,
  type AxisScale,
  arcPathD,
  autoBin,
  type BarItem,
  type ChartOptions,
  chartDatumSvg,
  clamp,
  collectAxisValues,
  collectSeriesLegend,
  computeAxisScale,
  computeBoxStats,
  computeDomain,
  computePlotArea,
  DEFAULT_HEIGHT,
  DEFAULT_LINE_STYLES,
  DEFAULT_WIDTH,
  emptyChart,
  escapeXml,
  extendDomainToNice,
  fmt,
  inspectionPoint,
  isOnAxis,
  LINE_DASH_PATTERNS,
  type LineStyle,
  linearRegression,
  linePathD,
  MAX_AXIS_TICKS,
  type MapOptions,
  type MapPoint,
  type MapSeries,
  type MapViewport,
  type MarkerShape,
  mapLog,
  mapRange,
  markerPath,
  measureLegendHeight,
  niceLogTicks,
  niceStep,
  normalizePadding,
  type Padding,
  type PlotArea,
  type Point,
  pickMapper,
  pointValues,
  type ReferenceLine,
  type RgbColor,
  referenceLineAttributes,
  renderErrorBars,
  renderHeader,
  renderLegend,
  renderReferenceLines,
  renderXAxisNumeric,
  renderYAxis,
  resolveErrorY,
  type Series,
  type SliceItem,
  smoothPathD,
  stepPathD,
  svgRoot,
} from "./svg-shared";

// ==========================
// CHART FUNCTIONS
// ==========================

export type SeriesChartOptions = ChartOptions & {
  series: Series[];
  xAxis?: AxisOptions;
  yAxis?: AxisOptions;
  /** Reference lines (thresholds, targets, averages) drawn on the plot. */
  references?: ReferenceLine[];
  /** Render a single-row legend at the bottom of the chart, listing each
   *  series's label with its color swatch. Series without a `label` are
   *  shown as `Series N` (1-indexed). Default false. */
  legend?: boolean;
};

export type ScatterOptions = SeriesChartOptions & {
  /** Pixel-radius range for the optional `size` dimension on points.
   *  Default `[3, 12]`. Only applied when at least one point has a finite
   *  `size`; otherwise all points use the default radius (3px). */
  sizeRange?: [number, number];
  /** When true, automatically vary marker shape per series (cycling through
   *  `circle, square, triangle, diamond, plus, cross`) so series remain
   *  distinguishable in B/W or color-blind contexts. Default false. */
  autoVariant?: boolean;
  /** Overlay a least-squares linear regression line across all data points.
   *  Default false. */
  trendline?: boolean;
};

export type LineOptions = SeriesChartOptions & {
  /** Render smooth Catmull-Rom curves. Default `true`. Pass `false` for
   *  straight segments between points. */
  smooth?: boolean;
  /** Fill the area below each line with the series color (translucent).
   *  Renders as a separate path so the line stroke remains crisp. Default false. */
  area?: boolean;
  /** Render a step (stair) line instead of a smooth/straight one. Implies
   *  `smooth: false`. */
  step?: "before" | "after" | "middle";
  /** When true, automatically vary line dash pattern per series (cycling
   *  through `solid, dashed, dotted, dashdot`). Default false. */
  autoVariant?: boolean;
  /** Render a translucent confidence band between each point's `errYLow` and
   *  `errYHigh`. Points without explicit error fields are skipped. Default false. */
  errorBand?: boolean;
  /** Dashed from this existing first-series X coordinate; bounds follow its sorted suffix. */
  forecast?: { from: number; band?: [number, number][] };
  /** Opt in to bounded legends with values at the cursor. Annotations also enable this. */
  legendValues?: boolean;
  /** Tint the plot below zero. */
  zero?: boolean;
  threshold?: { value: number; label: string };
  marker?: { at: number; label: string };
  /** Opted-in lines use round calendar ticks over the exact instant range. */
  timeAxis?: ChartTimeAxis;
  maxGap?: number;
  locale?: string;
};

/**
 * Render a scatter plot. Each series produces a group of circles, one per
 * data point, classed `stdlib-chart-series-N` so series colors stay
 * consistent across charts.
 *
 * Non-finite x or y values are filtered out. An empty `series` (or one with
 * no finite points) renders an empty-state SVG with a "no data" label.
 *
 * @example
 * charts.scatter({ series: [{ data: [{x:1,y:2},{x:2,y:5},{x:3,y:3}] }] });
 *
 * @example
 * charts.scatter({
 *   series: [
 *     { label: "Group A", data: [...] },
 *     { label: "Group B", data: [...] },
 *   ],
 *   xAxis: { label: "Time (s)" },
 *   yAxis: { label: "Value", format: v => `${v}k` },
 * });
 */
export const scatter = (opts: ScatterOptions): string => {
  const width = opts.width ?? DEFAULT_WIDTH;
  const height = opts.height ?? DEFAULT_HEIGHT;
  const padding = normalizePadding(opts.padding);
  const header = renderHeader(width, opts.title, opts.subtitle);
  const legendItems = collectSeriesLegend(opts);
  const legendHeight = legendItems.length > 0 ? 20 : 0;

  const finitePoints = opts.series.flatMap((s) => s.data).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (finitePoints.length === 0) return emptyChart(width, height, opts.className);

  const area = computePlotArea(width, height, padding, !!opts.xAxis?.label, !!opts.yAxis?.label, header.height, legendHeight);

  const xAxis = computeAxisScale(collectAxisValues(opts.series, "x"), opts.xAxis);
  const yAxis = computeAxisScale(collectAxisValues(opts.series, "y"), opts.yAxis);
  const xMap = pickMapper(xAxis.scale);
  const yMap = pickMapper(yAxis.scale);

  // Size dimension: if any point has a finite `size`, normalize across all
  // points to the configured pixel range; points without size fall back to
  // the midpoint so they remain visible.
  const sizes = finitePoints.map((p) => p.size).filter((s): s is number => typeof s === "number" && Number.isFinite(s));
  const sizeRange = opts.sizeRange ?? [3, 12];
  const useSizes = sizes.length > 0;
  const sizeDomain = useSizes ? computeDomain(sizes) : ([0, 1] as [number, number]);
  const fallbackR = (sizeRange[0] + sizeRange[1]) / 2;

  const body: string[] = [];
  body.push(renderYAxis(yAxis, area, opts.yAxis));
  body.push(renderXAxisNumeric(xAxis, area, height - legendHeight, opts.xAxis));

  // Error bars render under the points so the points sit on top of the bar
  // intersections — easier to read.
  body.push(renderErrorBars(opts.series, xAxis, yAxis, area));

  opts.series.forEach((s, i) => {
    const cls = `stdlib-chart-series-${i % 8}`;
    const shape = s.marker ?? (opts.autoVariant ? DEFAULT_MARKERS[i % DEFAULT_MARKERS.length]! : "circle");
    const elements = s.data
      .map((p, index) => ({ p, index }))
      .filter(({ p }) => isOnAxis(xAxis, p.x) && isOnAxis(yAxis, p.y))
      .map(({ p, index }) => {
        const cx = xMap(p.x, xAxis.domain, [area.x0, area.x1]);
        const cy = yMap(p.y, yAxis.domain, [area.y1, area.y0]);
        const r = useSizes
          ? typeof p.size === "number" && Number.isFinite(p.size)
            ? mapRange(p.size, sizeDomain, sizeRange)
            : fallbackR
          : 3;
        const datum: ChartDatum = {
          index,
          seriesIndex: i,
          role: "point",
          label: s.label,
          anchor: [cx, cy],
          values: pointValues(p, opts.xAxis, opts.yAxis),
        };
        if (shape === "circle") {
          return chartDatumSvg(`<circle class="stdlib-chart-point" cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r)}"/>`, datum, opts.inspect);
        }
        return chartDatumSvg(`<path class="stdlib-chart-point" d="${markerPath(shape, cx, cy, r)}"/>`, datum, opts.inspect);
      })
      .join("");
    if (elements) body.push(`<g class="${cls}">${elements}</g>`);
  });

  // Optional trend line (across all series). Renders after data so it's visible.
  if (opts.trendline) {
    const reg = linearRegression(finitePoints);
    if (reg !== null) {
      const x0 = xAxis.domain[0];
      const x1 = xAxis.domain[1];
      const y0 = reg.slope * x0 + reg.intercept;
      const y1 = reg.slope * x1 + reg.intercept;
      // Clip to plot area in pixel space (visible portion of the regression).
      const px0 = xMap(x0, xAxis.domain, [area.x0, area.x1]);
      const px1 = xMap(x1, xAxis.domain, [area.x0, area.x1]);
      const py0 = yMap(y0, yAxis.domain, [area.y1, area.y0]);
      const py1 = yMap(y1, yAxis.domain, [area.y1, area.y0]);
      body.push(`<line class="stdlib-chart-trendline" x1="${fmt(px0)}" y1="${fmt(py0)}" x2="${fmt(px1)}" y2="${fmt(py1)}"/>`);
    }
  }

  // References render AFTER data so labels stay on top (z-order matters in SVG).
  if (opts.references && opts.references.length > 0) {
    body.push(renderReferenceLines(opts.references, xAxis, yAxis, area));
  }

  const legend = renderLegend(legendItems, width, height - legendHeight);
  return svgRoot({ width, height, className: opts.className }, header.svg + body.join("") + legend.svg);
};

export { line } from "./line";

// ==========================
// BAR
// ==========================

export type BarChartOptions = ChartOptions & {
  data: BarItem[];
  yAxis?: AxisOptions;
  /** When true, each bar gets its own series color (`series-0` ... `series-7`,
   *  cyclic). When false (default), all bars share `series-0`. */
  colorByBar?: boolean;
  /** Reference lines on the y-axis (e.g. target threshold). x-axis references
   *  are ignored on bar charts since the x-axis is categorical. */
  references?: ReferenceLine[];
  /** Render the formatted value above (positive) or below (negative) each bar.
   *  Uses `yAxis.format` if provided, otherwise `String(value)`. Default false. */
  showValues?: boolean;
  /** Render a legend mapping each bar's label to its color. Only meaningful
   *  when `colorByBar` is true; ignored otherwise (the default single-color
   *  bar chart needs no legend). Default false. */
  legend?: boolean;
};

/**
 * Render a categorical bar chart. The y-domain always includes zero so bars
 * rest on a visible baseline. Negative values produce bars below the zero
 * line; mixed positive/negative inputs render the zero line as the X axis.
 *
 * Bars use class `stdlib-chart-bar stdlib-chart-series-0` (single-series
 * only in v1 — grouped/stacked bars are out of scope).
 *
 * Non-finite values are filtered. Empty input renders an empty-state SVG.
 *
 * @example
 * charts.bar({ data: [{label:"Q1",value:120},{label:"Q2",value:180}] });
 *
 * @example
 * charts.bar({
 *   data: [{label:"Profit",value:50},{label:"Loss",value:-20}],
 *   yAxis: { format: v => `${v}k` },
 * });
 */
export const bar = (opts: BarChartOptions): string => {
  const width = opts.width ?? DEFAULT_WIDTH;
  const height = opts.height ?? DEFAULT_HEIGHT;
  const padding = normalizePadding(opts.padding);
  const header = renderHeader(width, opts.title, opts.subtitle);

  const sourceIndices = opts.data.flatMap((d, index) => (Number.isFinite(d.value) ? [index] : []));
  const finite = opts.data.filter((d) => Number.isFinite(d.value));
  if (finite.length === 0) return emptyChart(width, height, opts.className);

  // Legend only useful when bars have distinct colors. Otherwise it's a
  // redundant single-entry box, so silently drop it.
  const legendItems = opts.legend && opts.colorByBar ? finite.map((d, i) => ({ label: d.label, seriesIndex: itemColorIndex(d, i) })) : [];
  const legendHeight = legendItems.length > 0 ? 20 : 0;

  const area = computePlotArea(width, height, padding, false, !!opts.yAxis?.label, header.height, legendHeight);
  const values = finite.map((d) => d.value);

  // For linear scale: include zero so bars rest on a baseline.
  // For log scale: zero isn't representable; just use the data extent.
  const yScale = opts.yAxis?.scale === "log" ? "log" : "linear";
  const valuesForDomain = yScale === "log" ? values : [...values, 0];
  const yAxis = computeAxisScale(valuesForDomain, opts.yAxis);
  const yMap = pickMapper(yAxis.scale);

  const body: string[] = [];
  body.push(renderYAxis(yAxis, area, opts.yAxis));
  body.push(
    renderXAxisCategorical(
      finite.map((d) => d.label),
      area,
      height - legendHeight,
      undefined,
    ),
  );

  // If domain spans negative and positive (linear only), draw the zero
  // baseline as a dedicated line on top of the gridlines.
  if (yAxis.scale === "linear" && yAxis.domain[0] < 0 && yAxis.domain[1] > 0) {
    const zeroY = yMap(0, yAxis.domain, [area.y1, area.y0]);
    body.push(`<line class="stdlib-chart-axis" x1="${fmt(area.x0)}" y1="${fmt(zeroY)}" x2="${fmt(area.x1)}" y2="${fmt(zeroY)}"/>`);
  }

  const slot = (area.x1 - area.x0) / finite.length;
  const barWidth = slot * 0.8;
  const barOffset = slot * 0.1;
  // Bar baseline: zero on linear scale, bottom of plot for log scale (since
  // log can't represent zero).
  const zeroPx = yAxis.scale === "log" ? area.y1 : yMap(0, yAxis.domain, [area.y1, area.y0]);
  const fmtValue = opts.yAxis?.format ?? ((v: number) => String(v));

  for (let i = 0; i < finite.length; i++) {
    const d = finite[i]!;
    const x = area.x0 + slot * i + barOffset;
    if (yAxis.scale === "log" && d.value <= 0) continue; // log can't render
    const valuePx = yMap(d.value, yAxis.domain, [area.y1, area.y0]);
    const top = Math.min(valuePx, zeroPx);
    const h = Math.abs(valuePx - zeroPx);
    const seriesIdx = opts.colorByBar ? itemColorIndex(d, i) : 0;
    body.push(
      chartDatumSvg(
        `<rect class="stdlib-chart-bar stdlib-chart-series-${seriesIdx}" x="${fmt(x)}" y="${fmt(top)}" width="${fmt(barWidth)}" height="${fmt(h)}"/>`,
        {
          index: sourceIndices[i]!,
          role: "item",
          label: d.label,
          anchor: [x + barWidth / 2, top + h / 2],
          values: [{ key: "value", value: d.value, formatted: fmtValue(d.value) }],
        },
        opts.inspect,
      ),
    );
    if (opts.showValues) {
      const labelY = d.value < 0 ? top + h + 12 : top - 4;
      const labelX = x + barWidth / 2;
      body.push(
        `<text class="stdlib-chart-bar-value" x="${fmt(labelX)}" y="${fmt(labelY)}" text-anchor="middle">${escapeXml(fmtValue(d.value))}</text>`,
      );
    }
  }

  // y-axis references render AFTER bars so labels stay on top.
  // x-axis refs are ignored on bar (the x-axis is categorical).
  if (opts.references && opts.references.length > 0) {
    const yRefs = opts.references.filter((r) => (r.axis ?? "y") === "y");
    if (yRefs.length > 0) {
      body.push(renderReferenceLines(yRefs, { domain: [0, 1], scale: "linear" }, yAxis, area));
    }
  }

  const legend = renderLegend(legendItems, width, height - legendHeight);
  return svgRoot({ width, height, className: opts.className }, header.svg + body.join("") + legend.svg);
};

// ==========================
// PIE / DONUT
// ==========================

export type PieChartOptions = ChartOptions & {
  data: SliceItem[];
  /** Render slice labels with percentages outside the chart area. Default false.
   *  Note: for many small slices or one dominant slice, prefer `legend: true`
   *  to avoid overlapping labels. */
  showLabels?: boolean;
  /** Render a wrapping legend below the chart with `Label (XX%)` entries.
   *  Recommended when slices are many or when one slice dominates — outside
   *  labels collide in those cases. Default false. */
  legend?: boolean;
  /** Inner radius as a fraction of outer radius (0..1). 0 = pie, 0.6 = donut.
   *  Values outside `[0, 0.95]` are clamped. */
  innerRadius?: number;
};

const renderPie = (opts: PieChartOptions, defaultInnerRadius: number): string => {
  const width = opts.width ?? DEFAULT_WIDTH;
  const height = opts.height ?? DEFAULT_HEIGHT;
  const header = renderHeader(width, opts.title, opts.subtitle);

  const sourceIndices = opts.data.flatMap((d, index) => (Number.isFinite(d.value) && d.value > 0 ? [index] : []));
  const finite = opts.data.filter((d) => Number.isFinite(d.value) && d.value > 0);
  const total = finite.reduce((sum, d) => sum + d.value, 0);
  if (finite.length === 0 || total <= 0) {
    return emptyChart(width, height, opts.className);
  }

  // Build legend items up-front (need to measure height before laying out pie).
  const legendItems = opts.legend
    ? finite.map((d, i) => {
        const ratio = d.value / total;
        const pct = (ratio * 100).toFixed(ratio < 0.1 ? 1 : 0);
        return { label: `${d.label} (${pct}%)`, seriesIndex: itemColorIndex(d, i) };
      })
    : [];
  const legendHeight = measureLegendHeight(legendItems, width);
  const LEGEND_GAP = legendHeight > 0 ? 8 : 0;

  const innerRatio = Math.max(0, Math.min(0.95, opts.innerRadius ?? defaultInnerRadius));
  // Reserve outer margin for labels if requested.
  const baseMargin = 8;
  const labelMargin = opts.showLabels ? 60 : 0;
  const margin = baseMargin + labelMargin;
  // Center vertically in the space below the header, above the legend.
  const availableHeight = height - header.height - legendHeight - LEGEND_GAP;
  const cx = width / 2;
  const cy = header.height + availableHeight / 2;
  const r = Math.max(0, Math.min(width, availableHeight) / 2 - margin);
  const innerR = r * innerRatio;

  const body: string[] = [];
  // Slices clockwise from 12 o'clock (-π/2).
  let a = -Math.PI / 2;
  finite.forEach((d, i) => {
    const sweep = (d.value / total) * Math.PI * 2;
    const a1 = a + sweep;
    const cls = `stdlib-chart-slice stdlib-chart-series-${itemColorIndex(d, i)}`;
    body.push(
      chartDatumSvg(
        `<path class="${cls}" d="${arcPathD(cx, cy, r, a, a1, innerR)}"/>`,
        {
          index: sourceIndices[i]!,
          role: "item",
          label: d.label,
          anchor: [cx + ((r + innerR) / 2) * Math.cos(a + sweep / 2), cy + ((r + innerR) / 2) * Math.sin(a + sweep / 2)],
          values: [
            { key: "value", value: d.value },
            { key: "percent", value: (d.value / total) * 100 },
            { key: "total", value: total },
          ],
        },
        opts.inspect,
      ),
    );
    if (opts.showLabels) {
      const mid = a + sweep / 2;
      // Place label slightly outside the outer radius.
      const lr = r + 14;
      const lx = cx + lr * Math.cos(mid);
      const ly = cy + lr * Math.sin(mid);
      const pct = ((d.value / total) * 100).toFixed(d.value / total < 0.1 ? 1 : 0);
      const anchor = Math.cos(mid) > 0.2 ? "start" : Math.cos(mid) < -0.2 ? "end" : "middle";
      body.push(
        `<text class="stdlib-chart-label" x="${fmt(lx)}" y="${fmt(ly + 3)}" text-anchor="${anchor}">${escapeXml(d.label)} (${pct}%)</text>`,
      );
    }
    a = a1;
  });

  const legend = renderLegend(legendItems, width, height - legendHeight);

  return svgRoot({ width, height, className: opts.className }, header.svg + body.join("") + legend.svg);
};

/**
 * Render a pie chart. Slices are drawn clockwise starting at 12 o'clock,
 * proportional to each item's `value`. Pass `showLabels: true` to render
 * `Label (XX%)` outside each slice, or `legend: true` to render a wrapping
 * legend below the chart.
 *
 * Use `legend` (not `showLabels`) when slices are many or one slice dominates —
 * outside labels collide in those cases.
 *
 * Non-positive and non-finite values are filtered. A 100%-single-slice draws
 * a complete circle. Empty/all-zero input renders an empty-state SVG.
 *
 * @example
 * charts.pie({ data: [{label:"A",value:30},{label:"B",value:50},{label:"C",value:20}] });
 *
 * @example
 * charts.pie({ data: [...], showLabels: true });
 *
 * @example
 * charts.pie({ data: [...], legend: true }); // recommended for many small slices
 */
export const pie = (opts: PieChartOptions): string => renderPie(opts, 0);

/**
 * Render a donut chart. Identical to {@link pie} but with a hollow center
 * (default `innerRadius: 0.6`). Override `innerRadius` for a thicker or
 * thinner ring.
 *
 * @example
 * charts.donut({ data: [{label:"Used",value:67},{label:"Free",value:33}] });
 *
 * @example
 * charts.donut({ data: [...], innerRadius: 0.4, showLabels: true });
 *
 * @example
 * charts.donut({ data: [...], legend: true }); // wrapping legend below the ring
 */
export const donut = (opts: PieChartOptions): string => renderPie(opts, 0.6);

// ==========================
// HISTOGRAM
// ==========================

export type HistogramOptions = ChartOptions & {
  /** Raw observations. Non-finite entries are filtered. */
  data: number[];
  /** Bin specification:
   *   - undefined → Sturges' formula `ceil(log2(n)) + 1`
   *   - number → that many equal-width bins
   *   - array of bin edges (length k+1 → k bins) */
  bins?: number | number[];
  yAxis?: AxisOptions;
  xAxis?: AxisOptions;
  references?: ReferenceLine[];
};

/**
 * Render a histogram (frequency distribution) of the given observations.
 * Uses Sturges' formula by default for bin count, or accepts an explicit
 * count or list of bin edges.
 *
 * Bars are adjacent (no inter-bar gap) since a histogram represents a
 * continuous distribution. The x-axis is numeric (bin edges as ticks).
 *
 * @example
 * charts.histogram({ data: observations, title: "Reaction times (ms)" });
 *
 * @example
 * charts.histogram({ data: scores, bins: 20, yAxis: { label: "Count" } });
 */
export const histogram = (opts: HistogramOptions): string => {
  const width = opts.width ?? DEFAULT_WIDTH;
  const height = opts.height ?? DEFAULT_HEIGHT;
  const padding = normalizePadding(opts.padding);
  const header = renderHeader(width, opts.title, opts.subtitle);

  const finite = opts.data.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return emptyChart(width, height, opts.className);

  const { edges, counts } = autoBin(finite, opts.bins);
  const area = computePlotArea(width, height, padding, !!opts.xAxis?.label, !!opts.yAxis?.label, header.height, 0);

  const xAxis = computeAxisScale(edges, opts.xAxis);
  const yAxis = computeAxisScale([0, ...counts], opts.yAxis);
  const xMap = pickMapper(xAxis.scale);
  const yMap = pickMapper(yAxis.scale);

  const body: string[] = [];
  body.push(renderYAxis(yAxis, area, opts.yAxis));
  body.push(renderXAxisNumeric(xAxis, area, height, opts.xAxis));

  const zeroPx = yAxis.scale === "log" ? area.y1 : yMap(0, yAxis.domain, [area.y1, area.y0]);
  for (let i = 0; i < counts.length; i++) {
    const left = xMap(edges[i]!, xAxis.domain, [area.x0, area.x1]);
    const right = xMap(edges[i + 1]!, xAxis.domain, [area.x0, area.x1]);
    const c = counts[i]!;
    if (yAxis.scale === "log" && c <= 0) continue;
    const top = yMap(c, yAxis.domain, [area.y1, area.y0]);
    body.push(
      chartDatumSvg(
        `<rect class="stdlib-chart-bar stdlib-chart-series-0" x="${fmt(left)}" y="${fmt(top)}" width="${fmt(right - left)}" height="${fmt(zeroPx - top)}"/>`,
        {
          index: i,
          role: "bin",
          anchor: [(left + right) / 2, (top + zeroPx) / 2],
          values: [
            { key: "from", value: edges[i]!, formatted: opts.xAxis?.format?.(edges[i]!) },
            { key: "to", value: edges[i + 1]!, formatted: opts.xAxis?.format?.(edges[i + 1]!) },
            { key: "upperInclusive", value: i === counts.length - 1 ? "true" : "false" },
            { key: "count", value: c },
          ],
        },
        opts.inspect,
      ),
    );
  }

  if (opts.references && opts.references.length > 0) {
    body.push(renderReferenceLines(opts.references, xAxis, yAxis, area));
  }

  return svgRoot({ width, height, className: opts.className }, header.svg + body.join(""));
};

// ==========================
// BOX PLOT
// ==========================

export type BoxPlotItem = { label: string; values: number[] };

export type BoxPlotOptions = ChartOptions & {
  /** Groups of observations, one box per group. */
  groups: BoxPlotItem[];
  yAxis?: AxisOptions;
  /** When true (default), render outliers as individual dots beyond the
   *  whiskers (1.5×IQR fences). */
  showOutliers?: boolean;
  references?: ReferenceLine[];
  /** When true, each box gets its own series color. Default false (all use
   *  series-0). */
  colorByBox?: boolean;
};

/**
 * Render a box plot (Tukey style): box for the IQR (Q1-Q3), median line,
 * whiskers extending to 1.5×IQR fences, and individual outlier dots.
 *
 * Useful for comparing distributions across categorical groups (e.g. test
 * scores per class, reaction times per condition).
 *
 * @example
 * charts.boxplot({
 *   groups: [
 *     { label: "Class A", values: scoresA },
 *     { label: "Class B", values: scoresB },
 *   ],
 *   yAxis: { label: "Score" },
 * });
 */
export const boxplot = (opts: BoxPlotOptions): string => {
  const width = opts.width ?? DEFAULT_WIDTH;
  const height = opts.height ?? DEFAULT_HEIGHT;
  const padding = normalizePadding(opts.padding);
  const header = renderHeader(width, opts.title, opts.subtitle);

  const showOutliers = opts.showOutliers ?? true;

  const stats = opts.groups.map((g, index) => ({
    index,
    count: g.values.filter(Number.isFinite).length,
    label: g.label,
    s: computeBoxStats(g.values),
  }));
  const valid = stats.filter((g) => g.s !== null) as Array<{
    label: string;
    index: number;
    count: number;
    s: NonNullable<ReturnType<typeof computeBoxStats>>;
  }>;
  if (valid.length === 0) return emptyChart(width, height, opts.className);

  const area = computePlotArea(width, height, padding, false, !!opts.yAxis?.label, header.height, 0);

  // Collect all values relevant for the y-domain: whisker extremes + outliers.
  const axisValues: number[] = [];
  for (const g of valid) {
    axisValues.push(g.s.whiskerLow, g.s.whiskerHigh);
    if (showOutliers) axisValues.push(...g.s.outliers);
  }
  const yAxis = computeAxisScale(axisValues, opts.yAxis);
  const yMap = pickMapper(yAxis.scale);

  const body: string[] = [];
  body.push(renderYAxis(yAxis, area, opts.yAxis));
  body.push(
    renderXAxisCategorical(
      valid.map((g) => g.label),
      area,
      height,
      undefined,
    ),
  );

  const slot = (area.x1 - area.x0) / valid.length;
  const boxWidth = slot * 0.6;
  const boxOffset = slot * 0.2;

  for (let i = 0; i < valid.length; i++) {
    const g = valid[i]!;
    const cx = area.x0 + slot * i + slot / 2;
    const x = area.x0 + slot * i + boxOffset;
    const seriesIdx = opts.colorByBox ? i % 8 : 0;
    const seriesCls = `stdlib-chart-series-${seriesIdx}`;
    const yQ1 = yMap(g.s.q1, yAxis.domain, [area.y1, area.y0]);
    const yQ2 = yMap(g.s.q2, yAxis.domain, [area.y1, area.y0]);
    const yQ3 = yMap(g.s.q3, yAxis.domain, [area.y1, area.y0]);
    const yWhiskerLow = yMap(g.s.whiskerLow, yAxis.domain, [area.y1, area.y0]);
    const yWhiskerHigh = yMap(g.s.whiskerHigh, yAxis.domain, [area.y1, area.y0]);

    // Whisker line (vertical) from low whisker to high whisker, behind the box.
    body.push(
      `<line class="stdlib-chart-box-whisker" x1="${fmt(cx)}" y1="${fmt(yWhiskerHigh)}" x2="${fmt(cx)}" y2="${fmt(yWhiskerLow)}"/>`,
    );
    // Whisker caps.
    const capW = boxWidth * 0.4;
    body.push(
      `<line class="stdlib-chart-box-cap" x1="${fmt(cx - capW / 2)}" y1="${fmt(yWhiskerHigh)}" x2="${fmt(cx + capW / 2)}" y2="${fmt(yWhiskerHigh)}"/>`,
    );
    body.push(
      `<line class="stdlib-chart-box-cap" x1="${fmt(cx - capW / 2)}" y1="${fmt(yWhiskerLow)}" x2="${fmt(cx + capW / 2)}" y2="${fmt(yWhiskerLow)}"/>`,
    );
    // Box (Q1 to Q3).
    body.push(
      chartDatumSvg(
        `<rect class="stdlib-chart-box ${seriesCls}" x="${fmt(x)}" y="${fmt(yQ3)}" width="${fmt(boxWidth)}" height="${fmt(yQ1 - yQ3)}"/>`,
        {
          index: g.index,
          role: "box",
          label: g.label,
          anchor: [cx, yQ2],
          values: [
            { key: "count", value: g.count },
            ...(["q1", "q2", "q3", "whiskerLow", "whiskerHigh"] as const)
              .map((key) => ({ key, value: g.s[key] }))
              .map((field) => ({ ...field, formatted: opts.yAxis?.format?.(field.value) })),
          ],
        },
        opts.inspect,
      ),
    );
    // Median line.
    body.push(`<line class="stdlib-chart-box-median" x1="${fmt(x)}" y1="${fmt(yQ2)}" x2="${fmt(x + boxWidth)}" y2="${fmt(yQ2)}"/>`);
    // Outliers.
    if (showOutliers) {
      const sourceIndices = new Map<number, number[]>();
      if (opts.inspect)
        opts.groups[g.index]!.values.forEach((value, index) => {
          const indices = sourceIndices.get(value) ?? [];
          indices.push(index);
          sourceIndices.set(value, indices);
        });
      for (const v of g.s.outliers) {
        const sourceIndex = sourceIndices.get(v)?.shift() ?? 0;
        const oy = yMap(v, yAxis.domain, [area.y1, area.y0]);
        body.push(
          chartDatumSvg(
            `<circle class="stdlib-chart-box-outlier ${seriesCls}" cx="${fmt(cx)}" cy="${fmt(oy)}" r="2.5"/>`,
            {
              index: sourceIndex,
              seriesIndex: g.index,
              role: "outlier",
              label: g.label,
              anchor: [cx, oy],
              values: [{ key: "value", value: v, formatted: opts.yAxis?.format?.(v) }],
            },
            opts.inspect,
          ),
        );
      }
    }
  }

  if (opts.references && opts.references.length > 0) {
    const yRefs = opts.references.filter((r) => (r.axis ?? "y") === "y");
    if (yRefs.length > 0) {
      body.push(renderReferenceLines(yRefs, { domain: [0, 1], scale: "linear" }, yAxis, area));
    }
  }

  return svgRoot({ width, height, className: opts.className }, header.svg + body.join(""));
};

// ==========================
// DASHBOARD PANELS
// ==========================

export type Threshold = {
  /** Inclusive upper bound for this threshold segment. */
  value: number;
  /** Optional label for legends or future consumers. */
  label?: string;
  /** Optional SVG color. When omitted, the series CSS variables are used. */
  color?: string;
};

export type GaugeOptions = ChartOptions & {
  value: number;
  min?: number;
  max?: number;
  label?: string;
  unit?: string;
  format?: (value: number) => string;
  thresholds?: Threshold[];
  showNeedle?: boolean;
};

export type BarGaugeItem = {
  label: string;
  value: number;
  min?: number;
  max?: number;
  unit?: string;
};

export type BarGaugeOptions = ChartOptions & {
  data: BarGaugeItem[];
  min?: number;
  max?: number;
  unit?: string;
  format?: (value: number) => string;
  thresholds?: Threshold[];
};

export type StatOptions = ChartOptions & {
  label: string;
  value: number | string;
  unit?: string;
  delta?: number | string;
  deltaFormat?: (value: number) => string;
  trend?: "up" | "down" | "neutral";
  sparkline?: number[] | Point[];
  format?: (value: number) => string;
};

export type HeatmapDatum = { x: string; y: string; value: number };

export type HeatmapOptions = ChartOptions & {
  data: HeatmapDatum[];
  xLabels?: string[];
  yLabels?: string[];
  min?: number;
  max?: number;
  format?: (value: number) => string;
  showValues?: boolean;
};

export type StateInterval = {
  from: number;
  to: number;
  state: string;
  label?: string;
};

export type StateTimelineRow = {
  label: string;
  intervals: StateInterval[];
};

export type StateStyle = {
  state: string;
  label?: string;
  color?: string;
};

export type StateTimelineOptions = ChartOptions & {
  rows: StateTimelineRow[];
  states?: StateStyle[];
  xAxis?: Pick<AxisOptions, "format" | "label">;
  legend?: boolean;
};

const thresholdIndexForValue = (value: number, thresholds: readonly Threshold[] | undefined, min: number, max: number): number => {
  if (!thresholds || thresholds.length === 0) return 0;
  const sorted = [...thresholds].filter((t) => Number.isFinite(t.value)).sort((a, b) => a.value - b.value);
  const clamped = clamp(value, min, max);
  const idx = sorted.findIndex((t) => clamped <= t.value);
  return idx >= 0 ? idx : Math.max(0, sorted.length - 1);
};

const thresholdForIndex = (thresholds: readonly Threshold[] | undefined, index: number): Threshold | undefined => {
  if (!thresholds || thresholds.length === 0) return undefined;
  const sorted = [...thresholds].filter((t) => Number.isFinite(t.value)).sort((a, b) => a.value - b.value);
  return sorted[index];
};

/**
 * Render a radial single-value gauge for KPI, quota, saturation, or SLO style
 * dashboard panels.
 */
export const gauge = (opts: GaugeOptions): string => {
  const width = opts.width ?? 260;
  const height = opts.height ?? 180;
  const [min, max] = normalizeMinMax(opts.min, opts.max);
  const value = Number.isFinite(opts.value) ? opts.value : min;
  const clamped = clamp(value, min, max);
  const startAngle = (Math.PI * 5) / 6;
  const endAngle = (Math.PI * 13) / 6;
  const valueAngle = mapRange(clamped, [min, max], [startAngle, endAngle]);
  const cx = width / 2;
  const cy = height * 0.64;
  const radius = Math.min(width * 0.34, height * 0.43);
  const startPoint = polarPoint(cx, cy, radius, startAngle);
  const endPoint = polarPoint(cx, cy, radius, endAngle);
  const endpointLabelY = Math.min(height - 10, Math.max(cy + 32, startPoint.y + 16));
  const progress = clamp(mapRange(clamped, [min, max], [0, 100]), 0, 100);
  const gaugePath = arcLinePathD(cx, cy, radius, startAngle, endAngle);
  const gradientStops = gaugeThresholdStops(opts.thresholds, min, max);
  const thresholdIdx = thresholdIndexForValue(clamped, opts.thresholds, min, max);
  const threshold = thresholdForIndex(opts.thresholds, thresholdIdx);
  const thresholdColor = threshold?.color;
  const valueText = formatNumberValue(value, opts.format, opts.unit);
  const label = opts.label ?? opts.title;
  const fillStroke =
    gradientStops.length > 0 ? ` stroke="${escapeXml(gaugeColorAt(gradientStops, clamped))}"` : thresholdStrokeAttr(thresholdColor);
  const fillClass =
    gradientStops.length > 0 || thresholdColor
      ? "stdlib-chart-gauge-fill"
      : `stdlib-chart-gauge-fill stdlib-chart-series-${thresholdIdx % 8}`;
  const body: string[] = [];

  if (gradientStops.length > 0) {
    body.push(
      renderGaugeGradientSegments({
        stops: gradientStops,
        min,
        max,
        cx,
        cy,
        radius,
        startAngle,
        endAngle,
        className: "stdlib-chart-gauge-gradient-segment stdlib-chart-gauge-gradient-scale",
      }),
    );
    body.push(
      renderGaugeGradientSegments({
        stops: gradientStops,
        min,
        max,
        cx,
        cy,
        radius,
        startAngle,
        endAngle,
        progress,
        className: "stdlib-chart-gauge-gradient-segment",
      }),
    );
  } else {
    body.push(`<path class="stdlib-chart-gauge-track" d="${gaugePath}"/>`);
    if (progress > 0) {
      body.push(`<path class="${fillClass}"${fillStroke} pathLength="100" stroke-dasharray="${fmt(progress)} 100" d="${gaugePath}"/>`);
    }
  }

  if (opts.showNeedle) {
    const tip = polarPoint(cx, cy, radius - 8, valueAngle);
    const needleClass =
      thresholdColor || gradientStops.length > 0
        ? "stdlib-chart-gauge-needle"
        : `stdlib-chart-gauge-needle stdlib-chart-series-${thresholdIdx % 8}`;
    body.push(`<line class="${needleClass}"${fillStroke} x1="${fmt(cx)}" y1="${fmt(cy)}" x2="${fmt(tip.x)}" y2="${fmt(tip.y)}"/>`);
    body.push(`<circle class="stdlib-chart-gauge-hub" cx="${fmt(cx)}" cy="${fmt(cy)}" r="3"/>`);
  }

  body.push(`<text class="stdlib-chart-gauge-value" x="${fmt(cx)}" y="${fmt(cy - 2)}" text-anchor="middle">${escapeXml(valueText)}</text>`);
  if (label) {
    body.push(`<text class="stdlib-chart-gauge-label" x="${fmt(cx)}" y="${fmt(cy + 20)}" text-anchor="middle">${escapeXml(label)}</text>`);
  }
  body.push(
    `<text class="stdlib-chart-gauge-unit" x="${fmt(startPoint.x)}" y="${fmt(endpointLabelY)}" text-anchor="middle">${escapeXml(formatNumberValue(min, opts.format, opts.unit))}</text>`,
  );
  body.push(
    `<text class="stdlib-chart-gauge-unit" x="${fmt(endPoint.x)}" y="${fmt(endpointLabelY)}" text-anchor="middle">${escapeXml(formatNumberValue(max, opts.format, opts.unit))}</text>`,
  );

  return svgRoot(
    { width, height, className: opts.className },
    chartDatumSvg(
      body.join(""),
      {
        index: 0,
        role: "value",
        label,
        anchor: [cx, cy],
        values: [
          { key: "value", value, formatted: valueText },
          { key: "min", value: min },
          { key: "max", value: max },
          ...(threshold ? [{ key: "threshold", value: threshold.label ?? threshold.value }] : []),
        ],
      },
      opts.inspect,
    ),
  );
};

/** Render compact horizontal bar gauges for multiple reduced metrics. */
export const barGauge = (opts: BarGaugeOptions): string => {
  const width = opts.width ?? 420;
  const rowHeight = 28;
  const top = opts.title || opts.subtitle ? 42 : 16;
  const height = opts.height ?? Math.max(80, top + opts.data.length * rowHeight + 14);
  const header = renderHeader(width, opts.title, opts.subtitle);
  const body: string[] = [header.svg];
  const labelW = Math.min(140, Math.max(74, width * 0.34));
  const valueW = 56;
  const trackX = labelW + 14;
  const trackW = Math.max(24, width - trackX - valueW - 14);
  const trackH = 10;
  const sourceIndices = opts.data.flatMap((d, index) => (Number.isFinite(d.value) ? [index] : []));
  const data = opts.data.filter((d) => Number.isFinite(d.value));

  if (data.length === 0) {
    body.push(`<text class="stdlib-chart-empty-text" x="${fmt(width / 2)}" y="${fmt(height / 2)}" text-anchor="middle">No data</text>`);
    return svgRoot({ width, height, className: opts.className }, body.join(""));
  }

  data.forEach((d, i) => {
    const [min, max] = normalizeMinMax(d.min ?? opts.min, d.max ?? opts.max);
    const pct = clamp((d.value - min) / (max - min), 0, 1);
    const y = top + i * rowHeight;
    const thresholdIdx = thresholdIndexForValue(d.value, opts.thresholds, min, max);
    const threshold = thresholdForIndex(opts.thresholds, thresholdIdx);
    const thresholdColor = threshold?.color;
    const unit = d.unit ?? opts.unit ?? "";
    const start = body.length;
    body.push(
      `<text class="stdlib-chart-bar-gauge-label" x="12" y="${fmt(y + 12)}" dominant-baseline="middle">${escapeXml(d.label)}</text>`,
    );
    body.push(
      `<rect class="stdlib-chart-bar-gauge-track" x="${fmt(trackX)}" y="${fmt(y + 7)}" width="${fmt(trackW)}" height="${fmt(trackH)}" rx="2"/>`,
    );
    body.push(
      `<rect class="stdlib-chart-bar-gauge-fill stdlib-chart-series-${thresholdIdx % 8}"${thresholdFillAttr(thresholdColor)} x="${fmt(trackX)}" y="${fmt(y + 7)}" width="${fmt(trackW * pct)}" height="${fmt(trackH)}" rx="2"/>`,
    );
    body.push(
      `<text class="stdlib-chart-bar-gauge-value" x="${fmt(width - 12)}" y="${fmt(y + 12)}" text-anchor="end" dominant-baseline="middle">${escapeXml(formatNumberValue(d.value, opts.format, unit))}</text>`,
    );
    const shapes = body.splice(start).join("");
    body.push(
      chartDatumSvg(
        shapes,
        {
          index: sourceIndices[i]!,
          role: "item",
          label: d.label,
          anchor: [trackX + trackW / 2, y + 12],
          values: [
            { key: "value", value: d.value, formatted: formatNumberValue(d.value, opts.format, unit) },
            { key: "min", value: min },
            { key: "max", value: max },
            ...(threshold ? [{ key: "threshold", value: threshold.label ?? threshold.value }] : []),
          ],
        },
        opts.inspect,
      ),
    );
  });

  return svgRoot({ width, height, className: opts.className }, body.join(""));
};

const renderInlineSparkline = (
  values: number[] | Point[] | undefined,
  x: number,
  y: number,
  width: number,
  height: number,
  inspect?: boolean,
): string => {
  if (!values || values.length < 2) return "";
  const entries = sparklineEntries(values);
  const points = entries.map((entry) => entry.point);
  if (points.length < 2) return "";
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const xDomain = computeDomain(xs);
  const yDomain = computeDomain(ys);
  const mapped = [...points]
    .sort((a, b) => a.x - b.x)
    .map((p) => ({
      x: mapRange(p.x, xDomain, [x, x + width]),
      y: mapRange(p.y, yDomain, [y + height, y]),
    }));
  const linePath = smoothPathD(mapped);
  const first = mapped[0]!;
  const last = mapped[mapped.length - 1]!;
  const areaPath = `${linePath} L ${fmt(last.x)} ${fmt(y + height)} L ${fmt(first.x)} ${fmt(y + height)} Z`;
  return (
    `<path class="stdlib-chart-stat-sparkline-area" d="${areaPath}"/>` +
    `<path class="stdlib-chart-stat-sparkline" d="${linePath}"/>` +
    (inspect
      ? [...points]
          .sort((a, b) => a.x - b.x)
          .map((p, index) =>
            inspectionPoint(
              { index: entries[index]!.index, role: "point", anchor: [mapped[index]!.x, mapped[index]!.y], values: pointValues(p) },
              inspect,
            ),
          )
          .join("")
      : "")
  );
};

/** Render a large value panel with optional delta and inline sparkline. */
export const stat = (opts: StatOptions): string => {
  const width = opts.width ?? 260;
  const height = opts.height ?? 150;
  const value = typeof opts.value === "number" ? formatNumberValue(opts.value, opts.format, opts.unit) : `${opts.value}${opts.unit ?? ""}`;
  const trend = opts.trend ?? (typeof opts.delta === "number" ? (opts.delta > 0 ? "up" : opts.delta < 0 ? "down" : "neutral") : "neutral");
  const deltaText =
    typeof opts.delta === "number"
      ? `${opts.delta > 0 ? "+" : ""}${opts.deltaFormat ? opts.deltaFormat(opts.delta) : fmt(opts.delta)}`
      : opts.delta;
  const deltaClass = trend === "up" ? " stdlib-chart-stat-delta-up" : trend === "down" ? " stdlib-chart-stat-delta-down" : "";
  const body: string[] = [];
  body.push(`<text class="stdlib-chart-stat-label" x="16" y="24">${escapeXml(opts.label)}</text>`);
  body.push(`<text class="stdlib-chart-stat-value" x="16" y="70">${escapeXml(value)}</text>`);
  if (deltaText !== undefined) {
    body.push(
      `<text class="stdlib-chart-stat-delta${deltaClass}" x="${fmt(width - 16)}" y="70" text-anchor="end">${escapeXml(String(deltaText))}</text>`,
    );
  }
  const summary = chartDatumSvg(
    (opts.inspect
      ? `<rect x="0" y="0" width="${fmt(width)}" height="${fmt(Math.max(80, height - 48))}" fill="transparent" stroke="none"/>`
      : "") + body.join(""),
    {
      index: 0,
      role: "value",
      label: opts.label,
      anchor: [width / 2, 50],
      values: [
        { key: "value", value: opts.value, formatted: value },
        ...(opts.delta !== undefined ? [{ key: "delta", value: opts.delta, formatted: deltaText }] : []),
      ],
    },
    opts.inspect,
  );
  return svgRoot(
    { width, height, className: opts.className },
    summary + renderInlineSparkline(opts.sparkline, 16, height - 42, width - 32, 26, opts.inspect),
  );
};

/**
 * Render a categorical two-dimensional heatmap. Cell opacity represents value
 * intensity; labels are derived from first occurrence order unless provided.
 */
export const heatmap = (opts: HeatmapOptions): string => {
  const width = opts.width ?? 460;
  const height = opts.height ?? 260;
  const padding = normalizePadding(opts.padding ?? { top: 36, right: 16, bottom: 32, left: 54 });
  const header = renderHeader(width, opts.title, opts.subtitle);
  const xLabels = opts.xLabels ?? [...new Set(opts.data.map((d) => d.x))];
  const yLabels = opts.yLabels ?? [...new Set(opts.data.map((d) => d.y))];
  if (xLabels.length === 0 || yLabels.length === 0) {
    return svgRoot(
      { width, height, className: opts.className },
      header.svg + `<text class="stdlib-chart-empty-text" x="${fmt(width / 2)}" y="${fmt(height / 2)}" text-anchor="middle">No data</text>`,
    );
  }
  const area = computePlotArea(width, height, padding, false, false, header.height, 0);
  const values = opts.data.map((d) => d.value).filter(Number.isFinite);
  const [autoMin, autoMax] = computeDomain(values);
  const min = Number.isFinite(opts.min) ? opts.min! : autoMin;
  const max = Number.isFinite(opts.max) ? opts.max! : autoMax;
  const indexMap = new Map(opts.data.map((d, index) => [`${d.x}\u0000${d.y}`, index]));
  const valueMap = new Map(opts.data.map((d) => [`${d.x}\u0000${d.y}`, d.value]));
  const cellW = (area.x1 - area.x0) / xLabels.length;
  const cellH = (area.y1 - area.y0) / yLabels.length;
  const body: string[] = [header.svg];
  const format = opts.format ?? ((v: number) => fmt(v));

  xLabels.forEach((label, i) => {
    const x = area.x0 + cellW * (i + 0.5);
    body.push(
      `<text class="stdlib-chart-heatmap-label" x="${fmt(x)}" y="${fmt(area.y1 + 14)}" text-anchor="middle">${escapeXml(label)}</text>`,
    );
  });
  yLabels.forEach((label, i) => {
    const y = area.y0 + cellH * (i + 0.5);
    body.push(
      `<text class="stdlib-chart-heatmap-label" x="${fmt(area.x0 - 8)}" y="${fmt(y)}" text-anchor="end" dominant-baseline="middle">${escapeXml(label)}</text>`,
    );
  });

  for (let yi = 0; yi < yLabels.length; yi++) {
    for (let xi = 0; xi < xLabels.length; xi++) {
      const valueAtCell = valueMap.get(`${xLabels[xi]}\u0000${yLabels[yi]}`);
      if (!Number.isFinite(valueAtCell)) continue;
      const intensity = clamp(mapRange(valueAtCell!, [min, max], [0.12, 1]), 0.12, 1);
      const x = area.x0 + xi * cellW;
      const y = area.y0 + yi * cellH;
      body.push(
        chartDatumSvg(
          `<rect class="stdlib-chart-heatmap-cell stdlib-chart-series-0" x="${fmt(x)}" y="${fmt(y)}" width="${fmt(Math.max(0, cellW - 1))}" height="${fmt(Math.max(0, cellH - 1))}" opacity="${fmt(intensity)}"/>`,
          {
            index: indexMap.get(`${xLabels[xi]}\u0000${yLabels[yi]}`)!,
            role: "cell",
            anchor: [x + cellW / 2, y + cellH / 2],
            grid: [xi, yi],
            values: [
              { key: "x", value: xLabels[xi]! },
              { key: "y", value: yLabels[yi]! },
              { key: "value", value: valueAtCell!, formatted: format(valueAtCell!) },
            ],
          },
          opts.inspect,
        ),
      );
      if (opts.showValues) {
        body.push(
          `<text class="stdlib-chart-heatmap-label" x="${fmt(x + cellW / 2)}" y="${fmt(y + cellH / 2)}" text-anchor="middle" dominant-baseline="middle">${escapeXml(format(valueAtCell!))}</text>`,
        );
      }
    }
  }

  return svgRoot({ width, height, className: opts.className }, body.join(""));
};

// ==========================
// WORLD MAP
// ==========================

export const stateTimeline = (opts: StateTimelineOptions): string => {
  const width = opts.width ?? 560;
  const rowHeight = 24;
  const legendItems = opts.legend === false ? [] : (opts.states ?? []).map((s, i) => ({ label: s.label ?? s.state, seriesIndex: i }));
  const legendHeight = measureLegendHeight(legendItems, width);
  const height = opts.height ?? Math.max(120, 56 + opts.rows.length * rowHeight + legendHeight);
  const padding = normalizePadding(opts.padding ?? { top: 36, right: 16, bottom: 28, left: 74 });
  const header = renderHeader(width, opts.title, opts.subtitle);
  const allIntervals = opts.rows.flatMap((r) => r.intervals);
  const timeValues = allIntervals.flatMap((i) => [i.from, i.to]).filter(Number.isFinite);
  if (opts.rows.length === 0 || timeValues.length === 0) {
    return svgRoot(
      { width, height, className: opts.className },
      header.svg + `<text class="stdlib-chart-empty-text" x="${fmt(width / 2)}" y="${fmt(height / 2)}" text-anchor="middle">No data</text>`,
    );
  }
  const [minT, maxT] = computeDomain(timeValues);
  const area = computePlotArea(width, height, padding, !!opts.xAxis?.label, false, header.height, legendHeight);
  const stateKeys = opts.states?.map((s) => s.state) ?? [...new Set(allIntervals.map((i) => i.state))];
  const stateStyles = new Map((opts.states ?? []).map((s, i) => [s.state, { ...s, index: i }]));
  const stateIndex = (state: string) => {
    const explicit = stateStyles.get(state)?.index;
    if (explicit !== undefined) return explicit;
    const idx = stateKeys.indexOf(state);
    return idx >= 0 ? idx : 0;
  };
  const body: string[] = [header.svg];
  const format = opts.xAxis?.format ?? ((v: number) => fmt(v));
  const ticks = extendDomainToNice(minT, maxT, niceStep(maxT - minT, 4)).ticks.slice(0, 6);

  opts.rows.forEach((row, rowIdx) => {
    const y = area.y0 + rowIdx * rowHeight;
    body.push(
      `<text class="stdlib-chart-state-label" x="${fmt(area.x0 - 8)}" y="${fmt(y + rowHeight / 2)}" text-anchor="end" dominant-baseline="middle">${escapeXml(row.label)}</text>`,
    );
    for (const [index, interval] of row.intervals.entries()) {
      if (!Number.isFinite(interval.from) || !Number.isFinite(interval.to)) continue;
      const from = clamp(Math.min(interval.from, interval.to), minT, maxT);
      const to = clamp(Math.max(interval.from, interval.to), minT, maxT);
      const x = mapRange(from, [minT, maxT], [area.x0, area.x1]);
      const x2 = mapRange(to, [minT, maxT], [area.x0, area.x1]);
      const idx = stateIndex(interval.state);
      const color = stateStyles.get(interval.state)?.color;
      body.push(
        chartDatumSvg(
          `<rect class="stdlib-chart-state-region stdlib-chart-series-${idx % 8}"${thresholdFillAttr(color)} x="${fmt(x)}" y="${fmt(y + 3)}" width="${fmt(Math.max(1, x2 - x))}" height="${fmt(rowHeight - 6)}" rx="2"/>`,
          {
            index,
            seriesIndex: rowIdx,
            role: "interval",
            label: row.label,
            anchor: [(x + x2) / 2, y + rowHeight / 2],
            grid: [index, rowIdx],
            values: [
              { key: "state", value: interval.state, formatted: stateStyles.get(interval.state)?.label },
              { key: "from", value: from, formatted: format(from) },
              { key: "to", value: to, formatted: format(to) },
              { key: "duration", value: to - from },
            ],
          },
          opts.inspect,
        ),
      );
    }
  });

  for (const tick of ticks) {
    if (tick < minT || tick > maxT) continue;
    const x = mapRange(tick, [minT, maxT], [area.x0, area.x1]);
    body.push(
      `<text class="stdlib-chart-heatmap-label" x="${fmt(x)}" y="${fmt(area.y1 + 15)}" text-anchor="middle">${escapeXml(format(tick))}</text>`,
    );
  }
  if (opts.xAxis?.label) {
    body.push(
      `<text class="stdlib-chart-axis-label" x="${fmt((area.x0 + area.x1) / 2)}" y="${fmt(height - legendHeight - 4)}" text-anchor="middle">${escapeXml(opts.xAxis.label)}</text>`,
    );
  }
  if (legendItems.length > 0) {
    body.push(renderLegend(legendItems, width, height - legendHeight).svg);
  }

  return svgRoot({ width, height, className: opts.className }, body.join(""));
};

// ==========================
// SPARKLINE
// ==========================

export type SparklineOptions = {
  inspect?: boolean;
  /** Series of values. Bare numbers auto-x to their array index. */
  data: number[] | Point[];
  /** Default 80. */
  width?: number;
  /** Default 20. */
  height?: number;
  /** Render with smooth Catmull-Rom curves. Default `true`. */
  smooth?: boolean;
  /** Render a small dot at the last data point. Default false. */
  showLast?: boolean;
  /** Render dots at the highest and lowest data points. Skipped when all
   *  values are equal. Default false. */
  showMinMax?: boolean;
  /** Render a soft gradient fill below the stroke line, fading from a
   *  translucent `currentColor` at the top to fully transparent at the
   *  bottom — the classic dashboard-tile look. The stroke line stays
   *  visible on top, and dots from `showLast`/`showMinMax` compose over
   *  the fill. Default false. */
  area?: boolean;
  /** Appended to the root `<svg>`'s class attribute. */
  className?: string;
};

// Monotonically incrementing counter for per-instance gradient IDs. Using a
// module-level counter (vs. random) keeps output stable enough that repeated
// renders of the same input in a process produce predictable IDs in sequence,
// while still being unique within a document.
let sparklineGradientCounter = 0;

const sparklineEntries = (data: readonly (number | Point)[]) =>
  data
    .map((value, index) => ({ point: typeof value === "number" ? { x: index, y: value } : value, index }))
    .filter(({ point }) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .sort((a, b) => a.point.x - b.point.x);

/**
 * Render a minimalist sparkline — a tiny inline chart with no axes, no
 * labels, and minimal padding. Designed to fit alongside text or in dense
 * tables.
 *
 * Stroke uses `currentColor` by default, so it adopts the surrounding text
 * color. Pass `className` to scope a different color.
 *
 * @example
 * charts.sparkline({ data: [3, 7, 5, 9, 12, 10, 14] });
 *
 * @example
 * charts.sparkline({
 *   data: [3, 7, 5, 9, 12, 10, 14],
 *   smooth: true,
 *   showLast: true,
 *   width: 120,
 * });
 *
 * @example
 * // Dashboard-tile look: stroke + soft gradient fill fading to transparent.
 * charts.sparkline({ data: [3, 7, 5, 9, 12, 10, 14], area: true });
 */
export const sparkline = (opts: SparklineOptions): string => {
  const width = opts.width ?? 80;
  const height = opts.height ?? 20;
  const entries = sparklineEntries(opts.data);
  const points = entries.map((entry) => entry.point);

  if (points.length < 2) {
    // Empty spark — return a same-sized invisible svg so layout stays stable.
    return svgRoot({ width, height, className: opts.className }, "");
  }

  // Inset reserves space so the stroke and any dots sit fully inside the
  // viewBox. Dots have r=2; without dots the line stroke (1.5px wide) only
  // needs ~0.75px of breathing room.
  const DOT_R = 2;
  const hasDots = !!(opts.showLast || opts.showMinMax);
  const inset = hasDots ? DOT_R + 0.75 : 1.5;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const xDomain = computeDomain(xs);
  const yDomain = computeDomain(ys);

  const sorted = [...points].sort((a, b) => a.x - b.x);
  const mapped = sorted.map((p) => ({
    x: mapRange(p.x, xDomain, [inset, width - inset]),
    y: mapRange(p.y, yDomain, [height - inset, inset]),
  }));

  const pathFn = opts.smooth === false ? linePathD : smoothPathD;
  const linePath = pathFn(mapped);
  const body: string[] = [];

  if (opts.area) {
    // Gradient-fill area UNDER the stroke line: fades from a translucent
    // currentColor at the top to fully transparent at the bottom. The fill
    // path extends all the way down to the bottom of the viewBox; the
    // gradient handles the visual fade-out — no need for special bottom
    // padding. Stroke renders on top via the regular `.sparkline` path below.
    const gradId = `stdlib-spark-grad-${++sparklineGradientCounter}`;
    const first = mapped[0]!;
    const last = mapped[mapped.length - 1]!;
    const areaPath = `${linePath} L ${fmt(last.x)} ${fmt(height)} L ${fmt(first.x)} ${fmt(height)} Z`;
    body.push(
      `<defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">` +
        `<stop offset="0%" stop-color="currentColor" stop-opacity="0.28"/>` +
        `<stop offset="100%" stop-color="currentColor" stop-opacity="0"/>` +
        `</linearGradient></defs>`,
    );
    body.push(`<path class="stdlib-chart-sparkline-area" fill="url(#${gradId})" d="${areaPath}"/>`);
  }
  body.push(`<path class="stdlib-chart-sparkline" d="${linePath}"/>`);

  if (opts.showMinMax) {
    let minIdx = 0;
    let maxIdx = 0;
    let minV = Number.POSITIVE_INFINITY;
    let maxV = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < sorted.length; i++) {
      const v = sorted[i]!.y;
      if (v < minV) {
        minV = v;
        minIdx = i;
      }
      if (v > maxV) {
        maxV = v;
        maxIdx = i;
      }
    }
    if (minV < maxV) {
      const max = mapped[maxIdx]!;
      const min = mapped[minIdx]!;
      body.push(`<circle class="stdlib-chart-sparkline-max" cx="${fmt(max.x)}" cy="${fmt(max.y)}" r="2"/>`);
      body.push(`<circle class="stdlib-chart-sparkline-min" cx="${fmt(min.x)}" cy="${fmt(min.y)}" r="2"/>`);
    }
  }

  if (opts.showLast && mapped.length > 0) {
    const last = mapped[mapped.length - 1]!;
    body.push(`<circle class="stdlib-chart-sparkline-last" cx="${fmt(last.x)}" cy="${fmt(last.y)}" r="2"/>`);
  }

  if (opts.inspect)
    sorted.forEach((p, index) =>
      body.push(
        inspectionPoint(
          { index: entries[index]!.index, role: "point", anchor: [mapped[index]!.x, mapped[index]!.y], values: pointValues(p) },
          opts.inspect,
        ),
      ),
    );
  return svgRoot({ width, height, className: opts.className }, body.join(""));
};

// ==========================
// NAMESPACE
// ==========================
