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

import {
  WORLD_LAND_PATH,
  WORLD_MAP_HEIGHT,
  WORLD_MAP_WIDTH,
} from "./chart-map-data";

// ==========================
// PUBLIC TYPES
// ==========================

export type Point = {
  x: number;
  y: number;
  /** Optional third dimension. Honored by `scatter` (controls dot radius);
   *  ignored by `line` and `sparkline`. */
  size?: number;
  /** Symmetric ±error on the y value. Used by error-bar rendering on
   *  `scatter` and `line`. Overridden by `errYHigh`/`errYLow` if set. */
  errY?: number;
  /** Asymmetric upper bound on y (relative magnitude added to y). */
  errYHigh?: number;
  /** Asymmetric lower bound on y (relative magnitude subtracted from y). */
  errYLow?: number;
  /** Symmetric ±error on the x value. Renders horizontal error bars. */
  errX?: number;
  /** Asymmetric upper bound on x. */
  errXHigh?: number;
  /** Asymmetric lower bound on x. */
  errXLow?: number;
};

/** Marker shapes for `scatter` data points. Auto-cycles per series when
 *  `autoVariant` is enabled on the chart. */
export type MarkerShape =
  | "circle"
  | "square"
  | "triangle"
  | "diamond"
  | "plus"
  | "cross";

/** Line dash patterns for `line` series. Auto-cycles per series when
 *  `autoVariant` is enabled. */
export type LineStyle = "solid" | "dashed" | "dotted" | "dashdot";

export type Series = {
  /** Optional label for this series. Used by `legend` rendering. */
  label?: string;
  data: Point[];
  /** Override the marker shape for this series. Default: `circle`, or
   *  cycled from `DEFAULT_MARKERS` when the chart's `autoVariant` is true. */
  marker?: MarkerShape;
  /** Override the line dash pattern for this series. Default: `solid`, or
   *  cycled from `DEFAULT_LINE_STYLES` when the chart's `autoVariant` is true. */
  lineStyle?: LineStyle;
};

export type MapPoint = {
  /** Latitude in decimal degrees, from -90 to 90. */
  latitude: number;
  /** Longitude in decimal degrees, from -180 to 180. */
  longitude: number;
  /** Optional label emitted as an escaped SVG `<title>`. */
  label?: string;
  /** Optional magnitude used to scale the point radius. */
  size?: number;
};

export type MapSeries = {
  /** Optional label used by the legend. */
  label?: string;
  data: MapPoint[];
};

export type MapViewport = {
  /** Latitude at the center of the viewport. */
  latitude: number;
  /** Longitude at the center of the viewport. */
  longitude: number;
  /** Zoom level from 0 (full world) to 5. Each level doubles the scale. */
  zoom: number;
};

export type MapOptions = ChartOptions & {
  series: MapSeries[];
  /** Deterministic map center and zoom. Values are normalized to the map bounds. */
  viewport?: MapViewport;
  /** Pixel-radius range used when at least one finite `size` exists. */
  sizeRange?: [number, number];
  /** Render a series legend below the map. Default false. */
  legend?: boolean;
};

export type BarItem = { label: string; value: number; colorIndex?: number };

export type SliceItem = { label: string; value: number; colorIndex?: number };

const itemColorIndex = (item: { colorIndex?: number }, fallback: number): number => {
  const index = item.colorIndex ?? fallback;
  if (!Number.isInteger(index) || index < 0) throw new RangeError("Chart colorIndex must be a nonnegative integer");
  return index % 8;
};

export type AxisOptions = {
  /** Exact inclusive bounds for comparisons. Must contain all finite plotted
   * values (including error bounds/baselines); invalid bounds throw RangeError. */
  domain?: [number, number];
  /** Suggested tick count. Actual count may differ to keep ticks "nice". */
  ticks?: number;
  /** Format a tick value into a label string. Default: `String(v)`. */
  format?: (value: number) => string;
  /** Optional axis title rendered alongside the axis. */
  label?: string;
  /** Axis scale. `"linear"` (default) or `"log"`. Log axis requires all
   *  data on this axis to be strictly positive; non-positive values are
   *  filtered out before domain computation. */
  scale?: "linear" | "log";
  /** Render small subdivision ticks between major ticks. Default false. */
  minorTicks?: boolean;
};

export type Padding = { top: number; right: number; bottom: number; left: number };

/** One selectable datum in an inspected SVG. Indices refer to the source arrays.
 * `anchor` uses the containing SVG coordinate system, including nested map SVGs.
 * Values are raw data; `formatted` contains the renderer's axis/value formatting.
 */
export type ChartDatum = {
  index: number;
  seriesIndex?: number;
  role: "point" | "item" | "bin" | "box" | "outlier" | "value" | "cell" | "interval";
  label?: string;
  anchor: [number, number];
  grid?: [number, number];
  values: { key: string; value: string | number; formatted?: string }[];
};

/** Wrap renderer-owned geometry with escaped, inert inspection metadata. */
export const chartDatumSvg = (svg: string, datum: ChartDatum, inspect?: boolean): string => {
  if (!inspect || !datum.anchor.every(Number.isFinite)) return svg;
  const title = [datum.label, ...datum.values.map((field) => `${field.key}: ${field.formatted ?? field.value}`)].filter(Boolean).join(" · ");
  return `<g data-chart-role="${escapeXml(datum.role)}" data-chart-datum="${escapeXml(JSON.stringify(datum))}"><title>${escapeXml(title)}</title>${svg}</g>`;
};

const inspectionPoint = (datum: ChartDatum, inspect?: boolean): string => inspect
  ? chartDatumSvg(`<circle class="stdlib-chart-inspection-point" cx="${fmt(datum.anchor[0])}" cy="${fmt(datum.anchor[1])}" r="3" fill="transparent" stroke="none"/>`, datum, true)
  : "";

const pointValues = (p: Point, xAxis?: AxisOptions, yAxis?: AxisOptions): ChartDatum["values"] => [
  { key: "x", value: p.x, formatted: xAxis?.format?.(p.x) },
  { key: "y", value: p.y, formatted: yAxis?.format?.(p.y) },
  ...Object.entries(p).filter(([key, value]) => key !== "x" && key !== "y" && typeof value === "number" && Number.isFinite(value)).map(([key, value]) => ({ key, value })),
];

export type ChartOptions = {
  /** Emit inert datum metadata and SVG titles for progressive inspection. */
  inspect?: boolean;
  /** Default 400. */
  width?: number;
  /** Default 240. */
  height?: number;
  /** Default `{ top: 16, right: 16, bottom: 32, left: 40 }`. A single number
   *  is applied to all four sides. */
  padding?: number | Partial<Padding>;
  /** Appended to the root `<svg>`'s class attribute (after `stdlib-chart`). */
  className?: string;
  /** Optional centered title rendered above the plot area. */
  title?: string;
  /** Optional centered subtitle rendered below the title. */
  subtitle?: string;
};

/**
 * A horizontal or vertical reference line drawn on a cartesian chart, e.g.
 * for thresholds, targets, or averages.
 */
export type ReferenceLine = {
  /** Data value at which to draw the line. */
  value: number;
  /** Axis the line is anchored to. `"y"` (default) draws a horizontal line
   *  at the given y-value; `"x"` draws a vertical line at the x-value. */
  axis?: "x" | "y";
  /** Optional inline label rendered at the end of the line. */
  label?: string;
};

// ==========================
// CONSTANTS
// ==========================

const DEFAULT_WIDTH = 400;
const DEFAULT_HEIGHT = 240;
const DEFAULT_PADDING: Padding = { top: 16, right: 16, bottom: 32, left: 40 };
const DEFAULT_TICKS = 5;

const DEFAULT_MARKERS: readonly MarkerShape[] = [
  "circle",
  "square",
  "triangle",
  "diamond",
  "plus",
  "cross",
];

const DEFAULT_LINE_STYLES: readonly LineStyle[] = [
  "solid",
  "dashed",
  "dotted",
  "dashdot",
];

/** SVG `stroke-dasharray` values per line style. Empty string = no dasharray. */
const LINE_DASH_PATTERNS: Record<LineStyle, string> = {
  solid: "",
  dashed: "6 4",
  dotted: "2 3",
  dashdot: "6 3 2 3",
};

// CSS rule order is significant. Series-N rules emit first so shape-specific
// rules below can override (e.g. line's `fill: none` beats series fill, and
// slice/point's `stroke: white` beats series stroke).
const DEFAULT_STYLES = `
/* font-family is intentionally not set here so the chart inherits the app's
   font from its surrounding HTML context. For standalone SVG usage, set
   font-family on a wrapping element or override .stdlib-chart in your CSS. */
.stdlib-chart {
  color: #1f2937;
  --stdlib-chart-c1: #3b82f6; --stdlib-chart-c2: #10b981;
  --stdlib-chart-c3: #f59e0b; --stdlib-chart-c4: #ef4444;
  --stdlib-chart-c5: #8b5cf6; --stdlib-chart-c6: #ec4899;
  --stdlib-chart-c7: #14b8a6; --stdlib-chart-c8: #f97316;
}
.stdlib-chart-series-0 { fill: var(--stdlib-chart-c1); stroke: var(--stdlib-chart-c1); }
.stdlib-chart-series-1 { fill: var(--stdlib-chart-c2); stroke: var(--stdlib-chart-c2); }
.stdlib-chart-series-2 { fill: var(--stdlib-chart-c3); stroke: var(--stdlib-chart-c3); }
.stdlib-chart-series-3 { fill: var(--stdlib-chart-c4); stroke: var(--stdlib-chart-c4); }
.stdlib-chart-series-4 { fill: var(--stdlib-chart-c5); stroke: var(--stdlib-chart-c5); }
.stdlib-chart-series-5 { fill: var(--stdlib-chart-c6); stroke: var(--stdlib-chart-c6); }
.stdlib-chart-series-6 { fill: var(--stdlib-chart-c7); stroke: var(--stdlib-chart-c7); }
.stdlib-chart-series-7 { fill: var(--stdlib-chart-c8); stroke: var(--stdlib-chart-c8); }
.stdlib-chart-axis { stroke: currentColor; opacity: 0.4; fill: none; }
.stdlib-chart-tick-label { font-size: 10px; fill: currentColor; opacity: 0.6; }
.stdlib-chart-axis-label { font-size: 11px; fill: currentColor; opacity: 0.85; }
.stdlib-chart-grid { stroke: currentColor; opacity: 0.08; stroke-dasharray: 2 2; fill: none; }
.stdlib-chart-title { font-size: 14px; font-weight: 600; fill: currentColor; }
.stdlib-chart-subtitle { font-size: 11px; fill: currentColor; opacity: 0.7; }
.stdlib-chart-reference { stroke: currentColor; opacity: 0.5; stroke-dasharray: 4 4; fill: none; }
.stdlib-chart-reference-label { font-size: 10px; fill: currentColor; opacity: 0.7; }
.stdlib-chart-line { fill: none; stroke-width: 2; }
.stdlib-chart-area { fill-opacity: 0.18; stroke: none; }
.stdlib-chart-sparkline { fill: none; stroke-width: 1.5; stroke: currentColor; }
.stdlib-chart-sparkline-area { stroke: none; }
.stdlib-chart-sparkline-last { fill: currentColor; stroke: none; }
.stdlib-chart-sparkline-max { fill: #10b981; stroke: none; }
.stdlib-chart-sparkline-min { fill: #ef4444; stroke: none; }
.stdlib-chart-point { stroke: white; stroke-width: 1.5; }
.stdlib-chart-slice { stroke: white; stroke-width: 2; stroke-linejoin: round; }
.stdlib-chart-label { font-size: 11px; fill: currentColor; }
.stdlib-chart-bar-value { font-size: 10px; fill: currentColor; opacity: 0.8; }
.stdlib-chart-errorbar { stroke: currentColor; opacity: 0.55; fill: none; stroke-width: 1; }
.stdlib-chart-error-band { fill-opacity: 0.15; stroke: none; }
.stdlib-chart-trendline { stroke: currentColor; opacity: 0.55; stroke-width: 1.5; fill: none; stroke-dasharray: 5 4; }
.stdlib-chart-minor-tick { stroke: currentColor; opacity: 0.25; }
.stdlib-chart-box { fill-opacity: 0.4; stroke-width: 1; }
.stdlib-chart-box-median { stroke: currentColor; stroke-width: 1.5; fill: none; }
.stdlib-chart-box-whisker { stroke: currentColor; opacity: 0.6; fill: none; }
.stdlib-chart-box-cap { stroke: currentColor; opacity: 0.6; fill: none; }
.stdlib-chart-box-outlier { fill: currentColor; opacity: 0.5; stroke: white; stroke-width: 1; }
.stdlib-chart-legend-swatch { stroke: none; }
.stdlib-chart-legend-label { font-size: 11px; font-weight: 400; fill: currentColor; stroke: none; }
.stdlib-chart-empty-text { font-size: 11px; fill: currentColor; opacity: 0.5; }
.stdlib-chart-gauge-track { stroke: currentColor; stroke-width: 10; opacity: 0.12; fill: none; stroke-linecap: round; }
.stdlib-chart-gauge-fill { stroke-width: 10; fill: none; stroke-linecap: round; }
.stdlib-chart-gauge-gradient-segment { stroke-width: 10; fill: none; stroke-linecap: butt; }
.stdlib-chart-gauge-gradient-scale { opacity: 0.22; }
.stdlib-chart-gauge-needle { stroke-width: 2; fill: none; stroke-linecap: round; }
.stdlib-chart-gauge-hub { fill: currentColor; stroke: none; }
.stdlib-chart-gauge-value { font-size: 28px; font-weight: 700; fill: currentColor; }
.stdlib-chart-gauge-label { font-size: 12px; fill: currentColor; opacity: 0.72; }
.stdlib-chart-gauge-unit { font-size: 11px; fill: currentColor; opacity: 0.6; }
.stdlib-chart-bar-gauge-track { fill: currentColor; opacity: 0.1; }
.stdlib-chart-bar-gauge-fill { stroke: none; }
.stdlib-chart-bar-gauge-label { font-size: 11px; fill: currentColor; opacity: 0.75; }
.stdlib-chart-bar-gauge-value { font-size: 11px; font-weight: 600; fill: currentColor; }
.stdlib-chart-stat-label { font-size: 12px; fill: currentColor; opacity: 0.72; }
.stdlib-chart-stat-value { font-size: 30px; font-weight: 700; fill: currentColor; }
.stdlib-chart-stat-unit { font-size: 14px; font-weight: 600; fill: currentColor; opacity: 0.72; }
.stdlib-chart-stat-delta { font-size: 12px; font-weight: 600; fill: currentColor; opacity: 0.72; }
.stdlib-chart-stat-delta-up { fill: #10b981; opacity: 1; }
.stdlib-chart-stat-delta-down { fill: #ef4444; opacity: 1; }
.stdlib-chart-stat-sparkline { fill: none; stroke: currentColor; stroke-width: 1.6; opacity: 0.86; }
.stdlib-chart-stat-sparkline-area { stroke: none; opacity: 0.18; }
.stdlib-chart-heatmap-cell { stroke: white; stroke-width: 1; }
.stdlib-chart-heatmap-label { font-size: 10px; fill: currentColor; opacity: 0.68; }
.stdlib-chart-map-land { fill: currentColor; opacity: var(--stdlib-chart-map-land-opacity, 0.12); stroke: currentColor; stroke-width: 0.5; stroke-linejoin: round; }
.stdlib-chart-map-point { stroke: var(--stdlib-chart-map-point-stroke, white); stroke-width: 1.5; }
.stdlib-chart-map-empty { font-size: 11px; fill: currentColor; opacity: 0.55; }
.stdlib-chart-state-region { stroke: white; stroke-width: 1; }
.stdlib-chart-state-label { font-size: 11px; fill: currentColor; opacity: 0.75; }
`.trim();

// ==========================
// HELPERS (pure)
// ==========================

/** XML-escape a string for safe inclusion in attribute values or text content. */
export const escapeXml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Normalize a `Padding` input (number or partial object) to a full `Padding`. */
export const normalizePadding = (p: number | Partial<Padding> | undefined): Padding => {
  if (p === undefined) return { ...DEFAULT_PADDING };
  if (typeof p === "number") return { top: p, right: p, bottom: p, left: p };
  return {
    top: p.top ?? DEFAULT_PADDING.top,
    right: p.right ?? DEFAULT_PADDING.right,
    bottom: p.bottom ?? DEFAULT_PADDING.bottom,
    left: p.left ?? DEFAULT_PADDING.left,
  };
};

/**
 * Compute `[min, max]` from a list of numeric values, ignoring non-finite
 * entries. Returns `[0, 1]` for an empty/all-non-finite list and pads ±1
 * around a single finite value.
 */
export const computeDomain = (values: readonly number[]): [number, number] => {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) return [min - 1, max + 1];
  return [min, max];
};

/**
 * Pick a "nice" axis step (1, 2, 5, 10, 20, 50, ...) that splits `range`
 * into roughly `target` intervals. Avoids ugly tick labels like 0.473.
 */
export const niceStep = (range: number, target: number): number => {
  if (range <= 0 || target <= 0) return 1;
  const rough = range / target;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const nice = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return nice * mag;
};

/**
 * Round `min` down and `max` up to the nearest multiples of `step`, so the
 * domain edges fall on tick boundaries. Returns the extended domain plus the
 * tick values within it (inclusive of both ends).
 */
export const extendDomainToNice = (
  min: number,
  max: number,
  step: number,
): { domain: [number, number]; ticks: number[] } => {
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  // Use rounding to avoid floating-point drift at tick positions.
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const round = (v: number): number =>
    Number(v.toFixed(Math.min(decimals + 2, 12)));
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(round(v));
  return { domain: [lo, hi], ticks };
};

/** Linear map of `value` from input domain `[d0, d1]` to output range `[r0, r1]`. */
export const mapRange = (
  value: number,
  [d0, d1]: readonly [number, number],
  [r0, r1]: readonly [number, number],
): number => {
  if (d1 === d0) return (r0 + r1) / 2;
  return r0 + ((value - d0) / (d1 - d0)) * (r1 - r0);
};

/**
 * Logarithmic (base-10) map of `value` from input domain `[d0, d1]` to
 * output range `[r0, r1]`. Both domain endpoints must be strictly positive.
 * Non-positive values are clamped to a small epsilon to avoid `-Infinity`.
 */
export const mapLog = (
  value: number,
  [d0, d1]: readonly [number, number],
  [r0, r1]: readonly [number, number],
): number => {
  if (d0 <= 0 || d1 <= 0) return (r0 + r1) / 2;
  const v = Math.max(value, 1e-300);
  const logD0 = Math.log10(d0);
  const logD1 = Math.log10(d1);
  if (logD0 === logD1) return (r0 + r1) / 2;
  return r0 + ((Math.log10(v) - logD0) / (logD1 - logD0)) * (r1 - r0);
};

/**
 * Compute logarithmic ticks (powers of 10) within `[min, max]`. The
 * returned array always includes both decade boundaries enclosing the
 * domain so the axis line spans the data.
 */
export const niceLogTicks = (
  min: number,
  max: number,
): { domain: [number, number]; ticks: number[] } => {
  const safeMin = Math.max(min, 1e-300);
  const safeMax = Math.max(max, safeMin);
  // Clamp the log-tick range to a finite, SVG-safe span so callers passing
  // Number.MAX_VALUE (or non-finite extremes) don't trigger an infinite loop.
  // 1e-30 .. 1e30 covers every real-world scientific magnitude.
  const MIN_EXP = -30;
  const MAX_EXP = 30;
  const loExp = Math.max(MIN_EXP, Math.floor(Math.log10(safeMin)));
  const hiExp = Math.min(MAX_EXP, Math.ceil(Math.log10(safeMax)));
  const lo = Math.pow(10, loExp);
  const hi = Math.pow(10, Math.max(loExp, hiExp));
  const ticks: number[] = [];
  // Iterate by exponent to avoid floating-point drift at extreme ranges.
  for (let e = loExp; e <= Math.max(loExp, hiExp); e++) {
    ticks.push(Math.pow(10, e));
  }
  return { domain: [lo, hi], ticks };
};

/**
 * Least-squares linear regression. Returns slope, intercept, and r² for the
 * regression line `y = slope * x + intercept`. Returns null for fewer than
 * two finite points or all-x-equal input.
 */
export const linearRegression = (
  points: ReadonlyArray<{ x: number; y: number }>,
): { slope: number; intercept: number; r2: number } | null => {
  const finite = points.filter(
    (p) => Number.isFinite(p.x) && Number.isFinite(p.y),
  );
  const n = finite.length;
  if (n < 2) return null;
  let sumX = 0;
  let sumY = 0;
  for (const p of finite) {
    sumX += p.x;
    sumY += p.y;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let num = 0;
  let denom = 0;
  let totalSS = 0;
  for (const p of finite) {
    const dx = p.x - meanX;
    const dy = p.y - meanY;
    num += dx * dy;
    denom += dx * dx;
    totalSS += dy * dy;
  }
  if (denom === 0) return null;
  const slope = num / denom;
  const intercept = meanY - slope * meanX;
  // r² via 1 - SSres / SStot
  let resSS = 0;
  for (const p of finite) {
    const predicted = slope * p.x + intercept;
    const resid = p.y - predicted;
    resSS += resid * resid;
  }
  const r2 = totalSS === 0 ? 1 : 1 - resSS / totalSS;
  return { slope, intercept, r2 };
};

/**
 * Compute box-plot statistics for a set of observations:
 * min/max, quartiles (q1/q2/q3 via R-7 linear interpolation), Tukey whiskers
 * (1.5×IQR rule clamped to data extents), and outliers beyond the whiskers.
 *
 * Returns null for an empty/all-non-finite input.
 */
export const computeBoxStats = (
  values: readonly number[],
): {
  min: number;
  max: number;
  q1: number;
  q2: number;
  q3: number;
  whiskerLow: number;
  whiskerHigh: number;
  outliers: number[];
} | null => {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  const sorted = [...finite].sort((a, b) => a - b);
  const quantile = (q: number): number => {
    // R-7 (linear interpolation between consecutive order statistics).
    const pos = q * (sorted.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo]!;
    return sorted[lo]! + (pos - lo) * (sorted[hi]! - sorted[lo]!);
  };
  const q1 = quantile(0.25);
  const q2 = quantile(0.5);
  const q3 = quantile(0.75);
  const iqr = q3 - q1;
  const fenceLow = q1 - 1.5 * iqr;
  const fenceHigh = q3 + 1.5 * iqr;
  // Whiskers extend to the most-extreme data point still inside the fences.
  let whiskerLow = q1;
  let whiskerHigh = q3;
  for (const v of sorted) {
    if (v >= fenceLow && v < whiskerLow) whiskerLow = v;
    if (v <= fenceHigh && v > whiskerHigh) whiskerHigh = v;
  }
  const outliers = sorted.filter((v) => v < fenceLow || v > fenceHigh);
  return {
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    q1,
    q2,
    q3,
    whiskerLow,
    whiskerHigh,
    outliers,
  };
};

/**
 * Bin a numeric dataset into a histogram. `bins` may be:
 * - undefined → Sturges' formula `ceil(log2(n)) + 1`
 * - a number → that many equal-width bins
 * - an array of edges (length k+1 → k bins)
 *
 * Non-finite input values are filtered. Returns bin edges and per-bin counts.
 */
export const autoBin = (
  values: readonly number[],
  bins?: number | readonly number[],
): { edges: number[]; counts: number[] } => {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return { edges: [0, 1], counts: [0] };

  // Cap bin count so a malicious / mistyped `bins: 1e9` doesn't allocate
  // gigabytes. 1024 is generous: 30 is Sturges' for 1e9 samples.
  const MAX_BINS = 1024;

  let edges: number[];
  if (Array.isArray(bins)) {
    const sorted = [...(bins as number[])]
      .filter((e) => Number.isFinite(e))
      .sort((a, b) => a - b);
    if (sorted.length >= 2) {
      edges = sorted;
    } else {
      // Empty or single-edge input → fall back to a single auto-bin span over
      // the data so we never emit `[undefined, NaN]` edges.
      const dmin = Math.min(...finite);
      const dmax = Math.max(...finite);
      edges = dmin === dmax ? [dmin - 0.5, dmin + 0.5] : [dmin, dmax];
    }
  } else {
    // Single-loop min/max — `Math.min(...arr)` fails with RangeError on huge
    // arrays (call-stack overflow) and is also O(n) anyway.
    let min = Infinity;
    let max = -Infinity;
    for (const v of finite) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const range = max - min;
    let k: number;
    if (typeof bins === "number" && bins > 0) {
      k = Math.min(MAX_BINS, Math.floor(bins));
    } else {
      k = Math.max(1, Math.min(MAX_BINS, Math.ceil(Math.log2(finite.length)) + 1));
    }
    if (range === 0) {
      edges = [min - 0.5, min + 0.5];
    } else {
      const step = range / k;
      edges = Array.from({ length: k + 1 }, (_, i) => min + i * step);
    }
  }

  const counts = new Array(edges.length - 1).fill(0) as number[];
  for (const v of finite) {
    // Right-open intervals [e_i, e_{i+1}); last bin closed-closed.
    let bin = -1;
    for (let i = 0; i < counts.length; i++) {
      const isLast = i === counts.length - 1;
      if (v >= edges[i]! && (isLast ? v <= edges[i + 1]! : v < edges[i + 1]!)) {
        bin = i;
        break;
      }
    }
    if (bin >= 0) counts[bin]! += 1;
  }
  return { edges, counts };
};

// ==========================
// SVG SKELETON
// ==========================

type PlotArea = { x0: number; y0: number; x1: number; y1: number };

const computePlotArea = (
  width: number,
  height: number,
  padding: Padding,
  hasXAxisLabel: boolean,
  hasYAxisLabel: boolean,
  headerHeight = 0,
  legendHeight = 0,
): PlotArea => {
  // Reserve extra space when axis labels are present.
  const extraBottom = hasXAxisLabel ? 14 : 0;
  const extraLeft = hasYAxisLabel ? 14 : 0;
  return {
    x0: padding.left + extraLeft,
    y0: padding.top + headerHeight,
    x1: width - padding.right,
    y1: height - padding.bottom - extraBottom - legendHeight,
  };
};

/**
 * Render an optional centered header (title + subtitle) at the top of an
 * SVG. Returns the SVG fragment plus the pixel height it consumed so the
 * caller can shift the plot area down accordingly.
 */
const renderHeader = (
  width: number,
  title: string | undefined,
  subtitle: string | undefined,
): { svg: string; height: number } => {
  if (!title && !subtitle) return { svg: "", height: 0 };
  const cx = width / 2;
  const parts: string[] = [];
  let y = 16;
  if (title) {
    parts.push(
      `<text class="stdlib-chart-title" x="${fmt(cx)}" y="${fmt(y)}" text-anchor="middle">${escapeXml(title)}</text>`,
    );
    y += 14;
  }
  if (subtitle) {
    parts.push(
      `<text class="stdlib-chart-subtitle" x="${fmt(cx)}" y="${fmt(y)}" text-anchor="middle">${escapeXml(subtitle)}</text>`,
    );
    y += 6;
  }
  return { svg: parts.join(""), height: y };
};

/**
 * Render reference lines (horizontal or vertical thresholds) within the plot
 * area. Out-of-domain values are silently skipped. Honors per-axis scale
 * (linear or log).
 */
const renderReferenceLines = (
  refs: ReadonlyArray<ReferenceLine>,
  xAxis: { domain: [number, number]; scale: "linear" | "log" },
  yAxis: { domain: [number, number]; scale: "linear" | "log" },
  area: PlotArea,
): string => {
  const xMap = pickMapper(xAxis.scale);
  const yMap = pickMapper(yAxis.scale);
  const parts: string[] = [];
  for (const ref of refs) {
    if (!Number.isFinite(ref.value)) continue;
    const axis = ref.axis ?? "y";
    if (axis === "y") {
      if (ref.value < yAxis.domain[0] || ref.value > yAxis.domain[1]) continue;
      const y = yMap(ref.value, yAxis.domain, [area.y1, area.y0]);
      parts.push(
        `<line class="stdlib-chart-reference" x1="${fmt(area.x0)}" y1="${fmt(y)}" x2="${fmt(area.x1)}" y2="${fmt(y)}"/>`,
      );
      if (ref.label) {
        parts.push(
          `<text class="stdlib-chart-reference-label" x="${fmt(area.x1 - 4)}" y="${fmt(y - 4)}" text-anchor="end">${escapeXml(ref.label)}</text>`,
        );
      }
    } else {
      if (ref.value < xAxis.domain[0] || ref.value > xAxis.domain[1]) continue;
      const x = xMap(ref.value, xAxis.domain, [area.x0, area.x1]);
      parts.push(
        `<line class="stdlib-chart-reference" x1="${fmt(x)}" y1="${fmt(area.y0)}" x2="${fmt(x)}" y2="${fmt(area.y1)}"/>`,
      );
      if (ref.label) {
        parts.push(
          `<text class="stdlib-chart-reference-label" x="${fmt(x + 4)}" y="${fmt(area.y0 + 12)}">${escapeXml(ref.label)}</text>`,
        );
      }
    }
  }
  return parts.join("");
};

/**
 * Resolve a point's effective error extents into `[low, high]` magnitudes
 * (relative deltas, both ≥ 0). Asymmetric `errYHigh`/`errYLow` take precedence
 * over symmetric `errY`. Returns null when no error info is set.
 */
const resolveErrorY = (p: Point): [number, number] | null => {
  const high = p.errYHigh ?? p.errY;
  const low = p.errYLow ?? p.errY;
  if (high === undefined && low === undefined) return null;
  return [
    Number.isFinite(low) ? Math.abs(low!) : 0,
    Number.isFinite(high) ? Math.abs(high!) : 0,
  ];
};

const resolveErrorX = (p: Point): [number, number] | null => {
  const high = p.errXHigh ?? p.errX;
  const low = p.errXLow ?? p.errX;
  if (high === undefined && low === undefined) return null;
  return [
    Number.isFinite(low) ? Math.abs(low!) : 0,
    Number.isFinite(high) ? Math.abs(high!) : 0,
  ];
};

/** Build the SVG fragment for the per-point error bars across all series. */
const renderErrorBars = (
  series: ReadonlyArray<Series>,
  xAxis: AxisScale,
  yAxis: AxisScale,
  area: PlotArea,
): string => {
  const xMap = pickMapper(xAxis.scale);
  const yMap = pickMapper(yAxis.scale);
  const CAP = 4; // half-width of error bar caps in pixels
  const parts: string[] = [];
  for (const s of series) {
    for (const p of s.data) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      const cx = xMap(p.x, xAxis.domain, [area.x0, area.x1]);
      const cy = yMap(p.y, yAxis.domain, [area.y1, area.y0]);

      const yErr = resolveErrorY(p);
      if (yErr) {
        const [low, high] = yErr;
        const yHi = yMap(p.y + high, yAxis.domain, [area.y1, area.y0]);
        const yLo = yMap(p.y - low, yAxis.domain, [area.y1, area.y0]);
        parts.push(
          `<line class="stdlib-chart-errorbar" x1="${fmt(cx)}" y1="${fmt(yHi)}" x2="${fmt(cx)}" y2="${fmt(yLo)}"/>`,
        );
        parts.push(
          `<line class="stdlib-chart-errorbar" x1="${fmt(cx - CAP)}" y1="${fmt(yHi)}" x2="${fmt(cx + CAP)}" y2="${fmt(yHi)}"/>`,
        );
        parts.push(
          `<line class="stdlib-chart-errorbar" x1="${fmt(cx - CAP)}" y1="${fmt(yLo)}" x2="${fmt(cx + CAP)}" y2="${fmt(yLo)}"/>`,
        );
        // Mark we need cy to match data point — ensure we use it (silences unused warnings if any).
        void cy;
      }

      const xErr = resolveErrorX(p);
      if (xErr) {
        const [low, high] = xErr;
        const xHi = xMap(p.x + high, xAxis.domain, [area.x0, area.x1]);
        const xLo = xMap(p.x - low, xAxis.domain, [area.x0, area.x1]);
        parts.push(
          `<line class="stdlib-chart-errorbar" x1="${fmt(xLo)}" y1="${fmt(cy)}" x2="${fmt(xHi)}" y2="${fmt(cy)}"/>`,
        );
        parts.push(
          `<line class="stdlib-chart-errorbar" x1="${fmt(xLo)}" y1="${fmt(cy - CAP)}" x2="${fmt(xLo)}" y2="${fmt(cy + CAP)}"/>`,
        );
        parts.push(
          `<line class="stdlib-chart-errorbar" x1="${fmt(xHi)}" y1="${fmt(cy - CAP)}" x2="${fmt(xHi)}" y2="${fmt(cy + CAP)}"/>`,
        );
      }
    }
  }
  return parts.join("");
};

/** Collect all values relevant for axis-domain computation, including error
 *  extents so error bars don't get clipped. */
const collectAxisValues = (
  series: ReadonlyArray<Series>,
  axis: "x" | "y",
): number[] => {
  const out: number[] = [];
  for (const s of series) {
    for (const p of s.data) {
      const v = axis === "x" ? p.x : p.y;
      if (!Number.isFinite(v)) continue;
      out.push(v);
      const err = axis === "x" ? resolveErrorX(p) : resolveErrorY(p);
      if (err) {
        out.push(v - err[0]);
        out.push(v + err[1]);
      }
    }
  }
  return out;
};

/**
 * Render a single-row centered legend at the bottom of the SVG. Returns the
 * SVG fragment plus the height it consumed so callers can shift the plot
 * area up accordingly. Empty input yields height 0.
 */
const renderLegend = (
  items: ReadonlyArray<{ label: string; seriesIndex: number }>,
  width: number,
  yTop: number,
): { svg: string; height: number } => {
  if (items.length === 0) return { svg: "", height: 0 };

  const ROW_HEIGHT = 20;
  const ITEM_GAP = 16;
  const SWATCH = 8;
  const SWATCH_GAP = 4;
  const SIDE_PADDING = 4;
  // Approximate text width per character at 11px — good enough for centering.
  const charWidth = 6.5;

  const itemWidths = items.map(
    (it) => SWATCH + SWATCH_GAP + Math.max(it.label.length, 1) * charWidth,
  );

  // Greedy line-break: pack items into rows so each row fits inside the
  // available width. Single-row legends (≤ a few short labels) still render
  // on one line — no visual change for the line/scatter/bar callers that
  // typically have only 2-4 series. Pie/donut with long "Label (XX%)" entries
  // and 5+ slices wrap to multiple rows instead of overflowing the viewBox.
  const availableWidth = Math.max(40, width - 2 * SIDE_PADDING);
  const rows: { items: typeof items; widths: number[]; totalWidth: number }[] = [];
  let cur: typeof items = [];
  let curW = 0;
  items.forEach((item, i) => {
    const w = itemWidths[i]!;
    const projected = cur.length === 0 ? w : curW + ITEM_GAP + w;
    if (cur.length > 0 && projected > availableWidth) {
      rows.push({
        items: cur,
        widths: cur.map((_, j) => itemWidths[i - cur.length + j]!),
        totalWidth: curW,
      });
      cur = [item];
      curW = w;
    } else {
      cur = [...cur, item];
      curW = projected;
    }
  });
  if (cur.length > 0) {
    rows.push({
      items: cur,
      widths: cur.map((_, j) => itemWidths[items.length - cur.length + j]!),
      totalWidth: curW,
    });
  }

  const parts: string[] = [`<g class="stdlib-chart-legend">`];
  rows.forEach((row, rowIdx) => {
    let cursor = Math.max(SIDE_PADDING, (width - row.totalWidth) / 2);
    const baseY = yTop + ROW_HEIGHT / 2 + rowIdx * ROW_HEIGHT;
    row.items.forEach((item, i) => {
      parts.push(
        `<g class="stdlib-chart-legend-item stdlib-chart-series-${item.seriesIndex % 8}">`,
      );
      parts.push(
        `<rect class="stdlib-chart-legend-swatch" x="${fmt(cursor)}" y="${fmt(baseY - SWATCH / 2)}" width="${SWATCH}" height="${SWATCH}" rx="1"/>`,
      );
      parts.push(
        `<text class="stdlib-chart-legend-label" x="${fmt(cursor + SWATCH + SWATCH_GAP)}" y="${fmt(baseY)}" dominant-baseline="middle">${escapeXml(item.label)}</text>`,
      );
      parts.push(`</g>`);
      cursor += row.widths[i]! + ITEM_GAP;
    });
  });
  parts.push(`</g>`);
  return { svg: parts.join(""), height: rows.length * ROW_HEIGHT };
};

/** Measure the total height a legend with `items` will consume in `width`,
 *  without actually rendering. Used by chart functions to reserve vertical
 *  space before computing the plot area. */
const measureLegendHeight = (
  items: ReadonlyArray<{ label: string; seriesIndex: number }>,
  width: number,
): number => {
  if (items.length === 0) return 0;
  const ROW_HEIGHT = 20;
  const ITEM_GAP = 16;
  const SWATCH = 8;
  const SWATCH_GAP = 4;
  const charWidth = 6.5;
  const availableWidth = Math.max(40, width - 8);
  let curW = 0;
  let rows = 1;
  items.forEach((it, i) => {
    const w = SWATCH + SWATCH_GAP + Math.max(it.label.length, 1) * charWidth;
    const projected = i === 0 ? w : curW + ITEM_GAP + w;
    if (i > 0 && projected > availableWidth) {
      rows++;
      curW = w;
    } else {
      curW = projected;
    }
  });
  return rows * ROW_HEIGHT;
};

/** Wrap chart body in a root `<svg>` with embedded default styles. */
export const svgRoot = (
  opts: { width: number; height: number; className?: string },
  body: string,
): string => {
  const cls = opts.className
    ? `stdlib-chart ${escapeXml(opts.className)}`
    : "stdlib-chart";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${opts.width} ${opts.height}" class="${cls}"><style>${DEFAULT_STYLES}</style>${body}</svg>`;
};

// ==========================
// GEOMETRY HELPERS
// ==========================

/** Format an SVG path `d` attribute for a polyline through `points`. */
export const linePathD = (points: ReadonlyArray<{ x: number; y: number }>): string => {
  if (points.length === 0) return "";
  let d = `M ${fmt(points[0]!.x)} ${fmt(points[0]!.y)}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L ${fmt(points[i]!.x)} ${fmt(points[i]!.y)}`;
  }
  return d;
};

/**
 * Format an SVG path `d` for a smooth curve through `points` using cubic
 * Bezier segments with Catmull-Rom-derived vertical control points.
 *
 * Vertical control points use neighboring `points[i-1]` and `points[i+2]`
 * (reflecting the end points at boundaries) with the standard Catmull-Rom
 * tension factor of 1/6. Horizontal control points stay at the segment's
 * thirds, so x progresses linearly and never doubles back when point spacing
 * is uneven.
 */
export const smoothPathD = (points: ReadonlyArray<{ x: number; y: number }>): string => {
  const n = points.length;
  if (n === 0) return "";
  if (n === 1) return `M ${fmt(points[0]!.x)} ${fmt(points[0]!.y)}`;
  if (n === 2) return linePathD(points);

  let d = `M ${fmt(points[0]!.x)} ${fmt(points[0]!.y)}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = i > 0 ? points[i - 1]! : points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = i + 2 < n ? points[i + 2]! : points[i + 1]!;
    const dx = p2.x - p1.x;
    const cp1x = p1.x + dx / 3;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - dx / 3;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${fmt(cp1x)} ${fmt(cp1y)} ${fmt(cp2x)} ${fmt(cp2y)} ${fmt(p2.x)} ${fmt(p2.y)}`;
  }
  return d;
};

/**
 * Build an SVG path `d` attribute for a pie slice (or donut sector).
 *
 * Angles are in radians, measured from the +X axis. Slices grow clockwise,
 * which in SVG's y-down coordinate space means `a1 > a0` produces a clockwise
 * arc when drawn with the large-arc and sweep flags set appropriately.
 *
 * Full-circle (a1 - a0 ≈ 2π) is split into two 180° arcs because a single
 * `A` command can't draw a complete circle unambiguously.
 */
export const arcPathD = (
  cx: number,
  cy: number,
  r: number,
  a0: number,
  a1: number,
  innerR = 0,
): string => {
  const sweep = a1 - a0;
  // Full circle: split into two halves to avoid degenerate `A` command.
  if (sweep >= Math.PI * 2 - 1e-9) {
    const aMid = a0 + Math.PI;
    if (innerR <= 0) {
      const ox0 = cx + r * Math.cos(a0), oy0 = cy + r * Math.sin(a0);
      const oxM = cx + r * Math.cos(aMid), oyM = cy + r * Math.sin(aMid);
      return `M ${fmt(ox0)} ${fmt(oy0)} A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(oxM)} ${fmt(oyM)} A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(ox0)} ${fmt(oy0)} Z`;
    }
    const ox0 = cx + r * Math.cos(a0), oy0 = cy + r * Math.sin(a0);
    const oxM = cx + r * Math.cos(aMid), oyM = cy + r * Math.sin(aMid);
    const ix0 = cx + innerR * Math.cos(a0), iy0 = cy + innerR * Math.sin(a0);
    const ixM = cx + innerR * Math.cos(aMid), iyM = cy + innerR * Math.sin(aMid);
    // Outer ring CW, inner ring CCW (using even-odd fill rule via SVG default).
    return (
      `M ${fmt(ox0)} ${fmt(oy0)} A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(oxM)} ${fmt(oyM)} A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(ox0)} ${fmt(oy0)} Z` +
      ` M ${fmt(ix0)} ${fmt(iy0)} A ${fmt(innerR)} ${fmt(innerR)} 0 0 0 ${fmt(ixM)} ${fmt(iyM)} A ${fmt(innerR)} ${fmt(innerR)} 0 0 0 ${fmt(ix0)} ${fmt(iy0)} Z`
    );
  }
  const large = sweep > Math.PI ? 1 : 0;
  const ox0 = cx + r * Math.cos(a0), oy0 = cy + r * Math.sin(a0);
  const ox1 = cx + r * Math.cos(a1), oy1 = cy + r * Math.sin(a1);
  if (innerR <= 0) {
    return `M ${fmt(cx)} ${fmt(cy)} L ${fmt(ox0)} ${fmt(oy0)} A ${fmt(r)} ${fmt(r)} 0 ${large} 1 ${fmt(ox1)} ${fmt(oy1)} Z`;
  }
  const ix0 = cx + innerR * Math.cos(a0), iy0 = cy + innerR * Math.sin(a0);
  const ix1 = cx + innerR * Math.cos(a1), iy1 = cy + innerR * Math.sin(a1);
  return `M ${fmt(ox0)} ${fmt(oy0)} A ${fmt(r)} ${fmt(r)} 0 ${large} 1 ${fmt(ox1)} ${fmt(oy1)} L ${fmt(ix1)} ${fmt(iy1)} A ${fmt(innerR)} ${fmt(innerR)} 0 ${large} 0 ${fmt(ix0)} ${fmt(iy0)} Z`;
};

/**
 * SVG path `d` for a marker shape centered at `(cx, cy)` with circumradius `r`.
 *
 * The shapes are sized so a typical visual radius matches `r`:
 *  - circle: full radius
 *  - square: side = sqrt(2)·r so the diagonal equals 2·r (visually balanced
 *    next to a circle of the same r)
 *  - triangle: equilateral pointing up, circumradius r
 *  - diamond: square rotated 45°, half-diagonal = r
 *  - plus: cross-shape at thickness r·0.5
 *  - cross: X-shape at thickness r·0.4
 */
export const markerPath = (
  shape: MarkerShape,
  cx: number,
  cy: number,
  r: number,
): string => {
  switch (shape) {
    case "circle":
      // Single arc command pair to draw a closed circle.
      return `M ${fmt(cx - r)} ${fmt(cy)} A ${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(cx + r)} ${fmt(cy)} A ${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(cx - r)} ${fmt(cy)} Z`;
    case "square": {
      const s = (r * Math.SQRT2) / 2; // half-side
      return `M ${fmt(cx - s)} ${fmt(cy - s)} L ${fmt(cx + s)} ${fmt(cy - s)} L ${fmt(cx + s)} ${fmt(cy + s)} L ${fmt(cx - s)} ${fmt(cy + s)} Z`;
    }
    case "triangle": {
      // Equilateral pointing up. Circumradius r.
      const h = r * Math.sin(Math.PI / 3) * 1.5; // altitude from base to apex
      return `M ${fmt(cx)} ${fmt(cy - r)} L ${fmt(cx + h * Math.cos(Math.PI / 6))} ${fmt(cy + r * 0.5)} L ${fmt(cx - h * Math.cos(Math.PI / 6))} ${fmt(cy + r * 0.5)} Z`;
    }
    case "diamond":
      return `M ${fmt(cx)} ${fmt(cy - r)} L ${fmt(cx + r)} ${fmt(cy)} L ${fmt(cx)} ${fmt(cy + r)} L ${fmt(cx - r)} ${fmt(cy)} Z`;
    case "plus": {
      const t = r * 0.32; // half-thickness
      return `M ${fmt(cx - r)} ${fmt(cy - t)} L ${fmt(cx - t)} ${fmt(cy - t)} L ${fmt(cx - t)} ${fmt(cy - r)} L ${fmt(cx + t)} ${fmt(cy - r)} L ${fmt(cx + t)} ${fmt(cy - t)} L ${fmt(cx + r)} ${fmt(cy - t)} L ${fmt(cx + r)} ${fmt(cy + t)} L ${fmt(cx + t)} ${fmt(cy + t)} L ${fmt(cx + t)} ${fmt(cy + r)} L ${fmt(cx - t)} ${fmt(cy + r)} L ${fmt(cx - t)} ${fmt(cy + t)} L ${fmt(cx - r)} ${fmt(cy + t)} Z`;
    }
    case "cross": {
      // X shape — same as plus rotated 45°. Build by composing two oriented bars.
      const a = r * 0.7;
      const t = r * 0.28;
      return (
        `M ${fmt(cx - a + t)} ${fmt(cy - a - t)} L ${fmt(cx - a - t)} ${fmt(cy - a + t)} L ${fmt(cx + a - t)} ${fmt(cy + a + t)} L ${fmt(cx + a + t)} ${fmt(cy + a - t)} Z` +
        ` M ${fmt(cx + a - t)} ${fmt(cy - a - t)} L ${fmt(cx + a + t)} ${fmt(cy - a + t)} L ${fmt(cx - a + t)} ${fmt(cy + a + t)} L ${fmt(cx - a - t)} ${fmt(cy + a - t)} Z`
      );
    }
  }
};

/**
 * SVG path `d` for a step (stair) line. `mode` controls where the vertical
 * step happens relative to the data points:
 *  - `before` — vertical step at the new x BEFORE the value updates (state
 *    machine "Mealy" style: change at input)
 *  - `after`  — value updates at the data point's x and persists until next x
 *  - `middle` — vertical step at the midpoint between consecutive x-values
 */
export const stepPathD = (
  points: ReadonlyArray<{ x: number; y: number }>,
  mode: "before" | "after" | "middle",
): string => {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${fmt(points[0]!.x)} ${fmt(points[0]!.y)}`;

  let d = `M ${fmt(points[0]!.x)} ${fmt(points[0]!.y)}`;
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    const prev = points[i - 1]!;
    if (mode === "before") {
      // step at next-x: extend horizontally to new x at OLD y, then jump to new y.
      d += ` L ${fmt(p.x)} ${fmt(prev.y)} L ${fmt(p.x)} ${fmt(p.y)}`;
    } else if (mode === "after") {
      // step at current-x: jump to new y immediately, persist until next x.
      d += ` L ${fmt(prev.x)} ${fmt(p.y)} L ${fmt(p.x)} ${fmt(p.y)}`;
    } else {
      // middle: step at midpoint of x.
      const mx = (prev.x + p.x) / 2;
      d += ` L ${fmt(mx)} ${fmt(prev.y)} L ${fmt(mx)} ${fmt(p.y)} L ${fmt(p.x)} ${fmt(p.y)}`;
    }
  }
  return d;
};

/** Format a number for SVG attributes — short, no scientific notation. */
const fmt = (n: number): string => {
  if (!Number.isFinite(n)) return "0";
  // 2 decimals is enough for sub-pixel precision at typical sizes.
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? `${rounded}` : `${rounded}`;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const normalizeMinMax = (min: number | undefined, max: number | undefined): [number, number] => {
  const lo = Number.isFinite(min) ? min! : 0;
  const hi = Number.isFinite(max) ? max! : 100;
  return lo === hi ? [lo, lo + 1] : lo < hi ? [lo, hi] : [hi, lo];
};

const formatNumberValue = (
  value: number,
  format: ((value: number) => string) | undefined,
  unit = "",
): string => {
  if (!Number.isFinite(value)) return "";
  return `${format ? format(value) : fmt(value)}${unit}`;
};

const thresholdFillAttr = (
  color: string | undefined,
): string => color ? ` fill="${escapeXml(color)}"` : "";

const thresholdStrokeAttr = (
  color: string | undefined,
): string => color ? ` stroke="${escapeXml(color)}"` : "";

const polarPoint = (cx: number, cy: number, r: number, angleRad: number) => ({
  x: cx + r * Math.cos(angleRad),
  y: cy + r * Math.sin(angleRad),
});

const arcLinePathD = (
  cx: number,
  cy: number,
  r: number,
  a0: number,
  a1: number,
): string => {
  const start = polarPoint(cx, cy, r, a0);
  const end = polarPoint(cx, cy, r, a1);
  const large = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
  const sweep = a1 >= a0 ? 1 : 0;
  return `M ${fmt(start.x)} ${fmt(start.y)} A ${fmt(r)} ${fmt(r)} 0 ${large} ${sweep} ${fmt(end.x)} ${fmt(end.y)}`;
};

type RgbColor = { r: number; g: number; b: number };

const parseHexColor = (color: string): RgbColor | null => {
  const short = /^#([0-9a-f]{3})$/i.exec(color);
  if (short) {
    const [r, g, b] = short[1]!.split("").map((c) => Number.parseInt(c + c, 16));
    return { r: r!, g: g!, b: b! };
  }
  const long = /^#([0-9a-f]{6})$/i.exec(color);
  if (!long) return null;
  const value = long[1]!;
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
};

const hexColor = (color: RgbColor): string =>
  `#${[color.r, color.g, color.b]
    .map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0"))
    .join("")}`;

const interpolateColor = (from: string, to: string, t: number): string => {
  const a = parseHexColor(from);
  const b = parseHexColor(to);
  if (!a || !b) return t < 0.5 ? from : to;
  return hexColor({
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  });
};

const gaugeThresholdStops = (
  thresholds: readonly Threshold[] | undefined,
  min: number,
  max: number,
): Array<{ value: number; color: string }> => {
  if (!thresholds || thresholds.length === 0) return [];
  const sorted = [...thresholds]
    .filter((t) => Number.isFinite(t.value))
    .sort((a, b) => a.value - b.value);
  if (sorted.length === 0) return [];
  const colorFor = (threshold: Threshold, index: number) =>
    threshold.color ?? `var(--stdlib-chart-c${(index % 8) + 1})`;
  return [
    { value: min, color: colorFor(sorted[0]!, 0) },
    ...sorted.map((threshold, index) => ({
      value: clamp(threshold.value, min, max),
      color: colorFor(threshold, index),
    })),
  ];
};

const gaugeColorAt = (
  stops: readonly { value: number; color: string }[],
  value: number,
): string => {
  if (stops.length === 0) return "currentColor";
  for (let i = 1; i < stops.length; i++) {
    const prev = stops[i - 1]!;
    const next = stops[i]!;
    if (value <= next.value) {
      const t = next.value === prev.value ? 1 : clamp((value - prev.value) / (next.value - prev.value), 0, 1);
      return interpolateColor(prev.color, next.color, t);
    }
  }
  return stops[stops.length - 1]!.color;
};

const renderGaugeGradientSegments = (opts: {
  stops: readonly { value: number; color: string }[];
  min: number;
  max: number;
  cx: number;
  cy: number;
  radius: number;
  startAngle: number;
  endAngle: number;
  progress?: number;
  className: string;
}): string => {
  if (opts.stops.length === 0) return "";
  const segments = 72;
  const maxProgress = opts.progress ?? 100;
  const parts: string[] = [];
  for (let i = 0; i < segments; i++) {
    const p0 = (i / segments) * 100;
    const p1 = Math.min(((i + 1) / segments) * 100, maxProgress);
    if (p0 >= maxProgress || p1 <= p0) break;
    const v0 = mapRange(p0, [0, 100], [opts.min, opts.max]);
    const v1 = mapRange(p1, [0, 100], [opts.min, opts.max]);
    const color = gaugeColorAt(opts.stops, (v0 + v1) / 2);
    const a0 = mapRange(p0, [0, 100], [opts.startAngle, opts.endAngle]);
    const a1 = mapRange(p1, [0, 100], [opts.startAngle, opts.endAngle]);
    parts.push(
      `<path class="${opts.className}" stroke="${escapeXml(color)}" d="${arcLinePathD(opts.cx, opts.cy, opts.radius, a0, a1)}"/>`,
    );
  }
  return parts.join("");
};

// ==========================
// AXIS RENDERERS
// ==========================

type AxisScale = {
  domain: [number, number];
  ticks: number[];
  minorTicks: number[];
  scale: "linear" | "log";
};

const pickMapper = (scale: "linear" | "log") =>
  scale === "log" ? mapLog : mapRange;

/**
 * Whether a value is renderable on the given axis. Log axes reject zero and
 * negative values (since `log(<=0)` is undefined). Used to filter data
 * points before rendering so we don't emit huge off-plot SVG coordinates.
 */
const isOnAxis = (axis: { scale: "linear" | "log" }, v: number): boolean =>
  Number.isFinite(v) && (axis.scale !== "log" || v > 0);

/**
 * Compute the domain, major ticks, and (optional) minor ticks for an axis,
 * choosing linear or log scale per `axisOpts`. Filters non-positive values
 * out under log scale and falls back to `[1, 10]` if none remain.
 */
const computeAxisScale = (
  values: readonly number[],
  axisOpts: AxisOptions | undefined,
  fallbackTicks = DEFAULT_TICKS,
): AxisScale => {
  const scale: "linear" | "log" = axisOpts?.scale === "log" ? "log" : "linear";

  if (axisOpts?.domain) {
    const [lo, hi] = axisOpts.domain;
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi || !Number.isFinite(hi - lo) || (scale === "log" && lo <= 0)) {
      throw new RangeError("Chart axis domain must have finite increasing bounds (positive for log scales)");
    }
    if (values.some((v) => Number.isFinite(v) && (scale !== "log" || v > 0) && (v < lo || v > hi))) {
      throw new RangeError("Chart axis domain must contain all plotted values and bounds");
    }
    const ticks: number[] = [];
    if (scale === "log") {
      for (let exponent = Math.floor(Math.log10(lo)); exponent <= Math.ceil(Math.log10(hi)); exponent++) {
        const value = 10 ** exponent;
        if (value > lo && value < hi) ticks.push(value);
      }
    } else {
      const step = niceStep(hi - lo, axisOpts.ticks ?? fallbackTicks);
      // At extreme magnitudes the step may be smaller than one representable
      // increment. Keep endpoint ticks instead of entering a non-advancing loop.
      if (step > 0 && Number.isFinite(step)) {
        for (let value = Math.ceil(lo / step) * step; value < hi;) {
          if (value > lo) ticks.push(value);
          const next = value + step;
          if (next <= value) break;
          value = next;
        }
      }
    }
    return { domain: [lo, hi], ticks: [...new Set([lo, ...ticks.filter((v) => v > lo && v < hi), hi])], minorTicks: [], scale };
  }

  if (scale === "log") {
    const positive = values.filter((v) => Number.isFinite(v) && v > 0);
    if (positive.length === 0) {
      return { domain: [1, 10], ticks: [1, 10], minorTicks: [], scale };
    }
    const min = Math.min(...positive);
    const max = Math.max(...positive);
    const r = niceLogTicks(min, max);
    const minorTicks: number[] = [];
    if (axisOpts?.minorTicks) {
      for (let i = 0; i < r.ticks.length - 1; i++) {
        const decade = r.ticks[i]!;
        for (let m = 2; m <= 9; m++) minorTicks.push(decade * m);
      }
    }
    return { domain: r.domain, ticks: r.ticks, minorTicks, scale };
  }

  const [minRaw, maxRaw] = computeDomain(values);
  const step = niceStep(maxRaw - minRaw, axisOpts?.ticks ?? fallbackTicks);
  const r = extendDomainToNice(minRaw, maxRaw, step);
  const minorTicks: number[] = [];
  if (axisOpts?.minorTicks && r.ticks.length > 1) {
    const SUBDIVISIONS = 5;
    for (let i = 0; i < r.ticks.length - 1; i++) {
      const a = r.ticks[i]!;
      const b = r.ticks[i + 1]!;
      const sub = (b - a) / SUBDIVISIONS;
      for (let m = 1; m < SUBDIVISIONS; m++) minorTicks.push(a + sub * m);
    }
  }
  return { domain: r.domain, ticks: r.ticks, minorTicks, scale };
};

const renderYAxis = (
  axis: AxisScale,
  area: PlotArea,
  opts: AxisOptions | undefined,
): string => {
  const format = opts?.format ?? ((v: number) => String(v));
  const map = pickMapper(axis.scale);
  const parts: string[] = [];
  for (const t of axis.ticks) {
    const y = map(t, axis.domain, [area.y1, area.y0]);
    parts.push(
      `<line class="stdlib-chart-grid" x1="${fmt(area.x0)}" y1="${fmt(y)}" x2="${fmt(area.x1)}" y2="${fmt(y)}"/>`,
    );
    parts.push(
      `<text class="stdlib-chart-tick-label" x="${fmt(area.x0 - 6)}" y="${fmt(y + 3)}" text-anchor="end">${escapeXml(format(t))}</text>`,
    );
  }
  for (const mt of axis.minorTicks) {
    const y = map(mt, axis.domain, [area.y1, area.y0]);
    parts.push(
      `<line class="stdlib-chart-minor-tick" x1="${fmt(area.x0 - 3)}" y1="${fmt(y)}" x2="${fmt(area.x0)}" y2="${fmt(y)}"/>`,
    );
  }
  parts.push(
    `<line class="stdlib-chart-axis" x1="${fmt(area.x0)}" y1="${fmt(area.y0)}" x2="${fmt(area.x0)}" y2="${fmt(area.y1)}"/>`,
  );
  if (opts?.label) {
    const cx = 12;
    const cy = (area.y0 + area.y1) / 2;
    parts.push(
      `<text class="stdlib-chart-axis-label" x="${fmt(cx)}" y="${fmt(cy)}" text-anchor="middle" transform="rotate(-90 ${fmt(cx)} ${fmt(cy)})">${escapeXml(opts.label)}</text>`,
    );
  }
  return parts.join("");
};

const renderXAxisNumeric = (
  axis: AxisScale,
  area: PlotArea,
  height: number,
  opts: AxisOptions | undefined,
): string => {
  const format = opts?.format ?? ((v: number) => String(v));
  const map = pickMapper(axis.scale);
  const parts: string[] = [];
  for (const t of axis.ticks) {
    const x = map(t, axis.domain, [area.x0, area.x1]);
    parts.push(
      `<text class="stdlib-chart-tick-label" x="${fmt(x)}" y="${fmt(area.y1 + 14)}" text-anchor="middle">${escapeXml(format(t))}</text>`,
    );
  }
  for (const mt of axis.minorTicks) {
    const x = map(mt, axis.domain, [area.x0, area.x1]);
    parts.push(
      `<line class="stdlib-chart-minor-tick" x1="${fmt(x)}" y1="${fmt(area.y1)}" x2="${fmt(x)}" y2="${fmt(area.y1 + 3)}"/>`,
    );
  }
  parts.push(
    `<line class="stdlib-chart-axis" x1="${fmt(area.x0)}" y1="${fmt(area.y1)}" x2="${fmt(area.x1)}" y2="${fmt(area.y1)}"/>`,
  );
  if (opts?.label) {
    parts.push(
      `<text class="stdlib-chart-axis-label" x="${fmt((area.x0 + area.x1) / 2)}" y="${fmt(height - 4)}" text-anchor="middle">${escapeXml(opts.label)}</text>`,
    );
  }
  return parts.join("");
};

const renderXAxisCategorical = (
  labels: readonly string[],
  area: PlotArea,
  height: number,
  axisLabel?: string,
): string => {
  const parts: string[] = [];
  if (labels.length > 0) {
    const step = (area.x1 - area.x0) / labels.length;
    for (let i = 0; i < labels.length; i++) {
      const cx = area.x0 + step * (i + 0.5);
      parts.push(
        `<text class="stdlib-chart-tick-label" x="${fmt(cx)}" y="${fmt(area.y1 + 14)}" text-anchor="middle">${escapeXml(labels[i]!)}</text>`,
      );
    }
  }
  parts.push(
    `<line class="stdlib-chart-axis" x1="${fmt(area.x0)}" y1="${fmt(area.y1)}" x2="${fmt(area.x1)}" y2="${fmt(area.y1)}"/>`,
  );
  if (axisLabel) {
    parts.push(
      `<text class="stdlib-chart-axis-label" x="${fmt((area.x0 + area.x1) / 2)}" y="${fmt(height - 4)}" text-anchor="middle">${escapeXml(axisLabel)}</text>`,
    );
  }
  return parts.join("");
};

const emptyChart = (
  width: number,
  height: number,
  className: string | undefined,
  message = "no data",
): string =>
  svgRoot(
    { width, height, className },
    `<text class="stdlib-chart-empty-text" x="${fmt(width / 2)}" y="${fmt(height / 2)}" text-anchor="middle" dominant-baseline="middle">${escapeXml(message)}</text>`,
  );

// ==========================
// CHART FUNCTIONS
// ==========================

type SeriesChartOptions = ChartOptions & {
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

type ScatterOptions = SeriesChartOptions & {
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

type LineOptions = SeriesChartOptions & {
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

  const finitePoints = opts.series
    .flatMap((s) => s.data)
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (finitePoints.length === 0) return emptyChart(width, height, opts.className);

  const area = computePlotArea(
    width,
    height,
    padding,
    !!opts.xAxis?.label,
    !!opts.yAxis?.label,
    header.height,
    legendHeight,
  );

  const xAxis = computeAxisScale(collectAxisValues(opts.series, "x"), opts.xAxis);
  const yAxis = computeAxisScale(collectAxisValues(opts.series, "y"), opts.yAxis);
  const xMap = pickMapper(xAxis.scale);
  const yMap = pickMapper(yAxis.scale);

  // Size dimension: if any point has a finite `size`, normalize across all
  // points to the configured pixel range; points without size fall back to
  // the midpoint so they remain visible.
  const sizes = finitePoints
    .map((p) => p.size)
    .filter((s): s is number => typeof s === "number" && Number.isFinite(s));
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
    const shape =
      s.marker ??
      (opts.autoVariant ? DEFAULT_MARKERS[i % DEFAULT_MARKERS.length]! : "circle");
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
        const datum: ChartDatum = { index, seriesIndex: i, role: "point", label: s.label, anchor: [cx, cy], values: pointValues(p, opts.xAxis, opts.yAxis) };
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
      body.push(
        `<line class="stdlib-chart-trendline" x1="${fmt(px0)}" y1="${fmt(py0)}" x2="${fmt(px1)}" y2="${fmt(py1)}"/>`,
      );
    }
  }

  // References render AFTER data so labels stay on top (z-order matters in SVG).
  if (opts.references && opts.references.length > 0) {
    body.push(renderReferenceLines(opts.references, xAxis, yAxis, area));
  }

  const legend = renderLegend(legendItems, width, height - legendHeight);
  return svgRoot(
    { width, height, className: opts.className },
    header.svg + body.join("") + legend.svg,
  );
};

const collectSeriesLegend = (opts: {
  series: Series[];
  legend?: boolean;
}): Array<{ label: string; seriesIndex: number }> => {
  if (!opts.legend) return [];
  return opts.series.map((s, i) => ({
    label: s.label && s.label.length > 0 ? s.label : `Series ${i + 1}`,
    seriesIndex: i,
  }));
};

/**
 * Render a line chart. Each series becomes a `<path class="stdlib-chart-line">`
 * connecting its points (sorted by `x`). Multi-series charts get distinct
 * `stdlib-chart-series-N` classes.
 *
 * Non-finite points are filtered. A series with fewer than 2 finite points
 * is skipped (no path can be drawn). An empty/all-non-finite chart renders
 * an empty-state SVG.
 *
 * @example
 * charts.line({ series: [{ data: [{x:1,y:10},{x:2,y:25},{x:3,y:18}] }] });
 *
 * @example
 * charts.line({
 *   series: [
 *     { label: "Revenue", data: [...] },
 *     { label: "Costs",   data: [...] },
 *   ],
 *   yAxis: { format: v => `$${v}k` },
 * });
 */
export const line = (opts: LineOptions): string => {
  const width = opts.width ?? DEFAULT_WIDTH;
  const height = opts.height ?? DEFAULT_HEIGHT;
  const padding = normalizePadding(opts.padding);
  const header = renderHeader(width, opts.title, opts.subtitle);
  const legendItems = collectSeriesLegend(opts);
  const legendHeight = legendItems.length > 0 ? 20 : 0;

  const finitePoints = opts.series
    .flatMap((s) => s.data)
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (finitePoints.length === 0) return emptyChart(width, height, opts.className);

  const area = computePlotArea(
    width,
    height,
    padding,
    !!opts.xAxis?.label,
    !!opts.yAxis?.label,
    header.height,
    legendHeight,
  );
  const xAxis = computeAxisScale(collectAxisValues(opts.series, "x"), opts.xAxis);
  const yAxis = computeAxisScale(collectAxisValues(opts.series, "y"), opts.yAxis);
  const xMap = pickMapper(xAxis.scale);
  const yMap = pickMapper(yAxis.scale);

  const body: string[] = [];
  body.push(renderYAxis(yAxis, area, opts.yAxis));
  body.push(renderXAxisNumeric(xAxis, area, height - legendHeight, opts.xAxis));

  // Compute the area baseline (zero if it's in the y-domain, otherwise the
  // bottom of the plot area). Log axes always start at the bottom.
  const baselineY =
    yAxis.scale === "linear" && yAxis.domain[0] <= 0 && yAxis.domain[1] >= 0
      ? yMap(0, yAxis.domain, [area.y1, area.y0])
      : area.y1;

  // Step plot takes precedence over smooth (treppe with curves doesn't make
  // sense). Otherwise smooth is the default; explicit `smooth: false` opts out.
  const pathFn = opts.step
    ? (pts: Array<{ x: number; y: number }>) => stepPathD(pts, opts.step!)
    : opts.smooth === false
      ? linePathD
      : smoothPathD;

  opts.series.forEach((s, i) => {
    const finite = s.data.filter(
      (p) => isOnAxis(xAxis, p.x) && isOnAxis(yAxis, p.y),
    );
    if (opts.inspect) s.data.forEach((p, index) => {
      if (!isOnAxis(xAxis, p.x) || !isOnAxis(yAxis, p.y)) return;
      body.push(inspectionPoint({ index, seriesIndex: i, role: "point", label: s.label,
        anchor: [xMap(p.x, xAxis.domain, [area.x0, area.x1]), yMap(p.y, yAxis.domain, [area.y1, area.y0])],
        values: pointValues(p, opts.xAxis, opts.yAxis) }, opts.inspect));
    });
    if (finite.length < 2) return;
    const sorted = [...finite].sort((a, b) => a.x - b.x);
    const mapped = sorted.map((p) => ({
      x: xMap(p.x, xAxis.domain, [area.x0, area.x1]),
      y: yMap(p.y, yAxis.domain, [area.y1, area.y0]),
    }));
    const linePath = pathFn(mapped);

    // Error band: filled translucent area between errYHigh and errYLow.
    if (opts.errorBand) {
      const upper: Array<{ x: number; y: number }> = [];
      const lower: Array<{ x: number; y: number }> = [];
      for (const p of sorted) {
        const err = resolveErrorY(p);
        if (!err) continue;
        const [low, high] = err;
        upper.push({
          x: xMap(p.x, xAxis.domain, [area.x0, area.x1]),
          y: yMap(p.y + high, yAxis.domain, [area.y1, area.y0]),
        });
        lower.push({
          x: xMap(p.x, xAxis.domain, [area.x0, area.x1]),
          y: yMap(p.y - low, yAxis.domain, [area.y1, area.y0]),
        });
      }
      if (upper.length >= 2) {
        const upperPath = pathFn(upper);
        const lowerReversed = lower.slice().reverse();
        const lowerSegments = lowerReversed
          .map((pt) => ` L ${fmt(pt.x)} ${fmt(pt.y)}`)
          .join("");
        const bandPath = `${upperPath}${lowerSegments} Z`;
        body.push(
          `<path class="stdlib-chart-error-band stdlib-chart-series-${i % 8}" d="${bandPath}"/>`,
        );
      }
    }

    if (opts.area) {
      const last = mapped[mapped.length - 1]!;
      const first = mapped[0]!;
      const areaPath = `${linePath} L ${fmt(last.x)} ${fmt(baselineY)} L ${fmt(first.x)} ${fmt(baselineY)} Z`;
      body.push(
        `<path class="stdlib-chart-area stdlib-chart-series-${i % 8}" d="${areaPath}"/>`,
      );
    }

    const dashStyle =
      s.lineStyle ??
      (opts.autoVariant ? DEFAULT_LINE_STYLES[i % DEFAULT_LINE_STYLES.length]! : "solid");
    const dashAttr = LINE_DASH_PATTERNS[dashStyle];
    const cls = `stdlib-chart-line stdlib-chart-series-${i % 8}`;
    const dashAttrStr = dashAttr ? ` stroke-dasharray="${dashAttr}"` : "";
    body.push(`<path class="${cls}" d="${linePath}"${dashAttrStr}/>`);
  });

  // Error bars render after lines so caps don't disappear behind the stroke.
  body.push(renderErrorBars(opts.series, xAxis, yAxis, area));

  // References render AFTER data so labels stay on top.
  if (opts.references && opts.references.length > 0) {
    body.push(renderReferenceLines(opts.references, xAxis, yAxis, area));
  }

  const legend = renderLegend(legendItems, width, height - legendHeight);
  return svgRoot(
    { width, height, className: opts.className },
    header.svg + body.join("") + legend.svg,
  );
};

// ==========================
// BAR
// ==========================

type BarChartOptions = ChartOptions & {
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

  const sourceIndices = opts.data.flatMap((d, index) => Number.isFinite(d.value) ? [index] : []);
  const finite = opts.data.filter((d) => Number.isFinite(d.value));
  if (finite.length === 0) return emptyChart(width, height, opts.className);

  // Legend only useful when bars have distinct colors. Otherwise it's a
  // redundant single-entry box, so silently drop it.
  const legendItems =
    opts.legend && opts.colorByBar
      ? finite.map((d, i) => ({ label: d.label, seriesIndex: itemColorIndex(d, i) }))
      : [];
  const legendHeight = legendItems.length > 0 ? 20 : 0;

  const area = computePlotArea(
    width,
    height,
    padding,
    false,
    !!opts.yAxis?.label,
    header.height,
    legendHeight,
  );
  const values = finite.map((d) => d.value);

  // For linear scale: include zero so bars rest on a baseline.
  // For log scale: zero isn't representable; just use the data extent.
  const yScale = opts.yAxis?.scale === "log" ? "log" : "linear";
  const valuesForDomain =
    yScale === "log" ? values : [...values, 0];
  const yAxis = computeAxisScale(valuesForDomain, opts.yAxis);
  const yMap = pickMapper(yAxis.scale);

  const body: string[] = [];
  body.push(renderYAxis(yAxis, area, opts.yAxis));
  body.push(
    renderXAxisCategorical(finite.map((d) => d.label), area, height - legendHeight, undefined),
  );

  // If domain spans negative and positive (linear only), draw the zero
  // baseline as a dedicated line on top of the gridlines.
  if (yAxis.scale === "linear" && yAxis.domain[0] < 0 && yAxis.domain[1] > 0) {
    const zeroY = yMap(0, yAxis.domain, [area.y1, area.y0]);
    body.push(
      `<line class="stdlib-chart-axis" x1="${fmt(area.x0)}" y1="${fmt(zeroY)}" x2="${fmt(area.x1)}" y2="${fmt(zeroY)}"/>`,
    );
  }

  const slot = (area.x1 - area.x0) / finite.length;
  const barWidth = slot * 0.8;
  const barOffset = slot * 0.1;
  // Bar baseline: zero on linear scale, bottom of plot for log scale (since
  // log can't represent zero).
  const zeroPx =
    yAxis.scale === "log" ? area.y1 : yMap(0, yAxis.domain, [area.y1, area.y0]);
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
      chartDatumSvg(`<rect class="stdlib-chart-bar stdlib-chart-series-${seriesIdx}" x="${fmt(x)}" y="${fmt(top)}" width="${fmt(barWidth)}" height="${fmt(h)}"/>`, { index: sourceIndices[i]!, role: "item", label: d.label, anchor: [x + barWidth / 2, top + h / 2], values: [{ key: "value", value: d.value, formatted: fmtValue(d.value) }] }, opts.inspect),
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
      body.push(
        renderReferenceLines(
          yRefs,
          { domain: [0, 1], scale: "linear" },
          yAxis,
          area,
        ),
      );
    }
  }

  const legend = renderLegend(legendItems, width, height - legendHeight);
  return svgRoot(
    { width, height, className: opts.className },
    header.svg + body.join("") + legend.svg,
  );
};

// ==========================
// PIE / DONUT
// ==========================

type PieChartOptions = ChartOptions & {
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

  const sourceIndices = opts.data.flatMap((d, index) => Number.isFinite(d.value) && d.value > 0 ? [index] : []);
  const finite = opts.data.filter(
    (d) => Number.isFinite(d.value) && d.value > 0,
  );
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
    body.push(chartDatumSvg(`<path class="${cls}" d="${arcPathD(cx, cy, r, a, a1, innerR)}"/>`, { index: sourceIndices[i]!, role: "item", label: d.label, anchor: [cx + (r + innerR) / 2 * Math.cos(a + sweep / 2), cy + (r + innerR) / 2 * Math.sin(a + sweep / 2)], values: [{ key: "value", value: d.value }, { key: "percent", value: d.value / total * 100 }, { key: "total", value: total }] }, opts.inspect));
    if (opts.showLabels) {
      const mid = a + sweep / 2;
      // Place label slightly outside the outer radius.
      const lr = r + 14;
      const lx = cx + lr * Math.cos(mid);
      const ly = cy + lr * Math.sin(mid);
      const pct = ((d.value / total) * 100).toFixed(d.value / total < 0.1 ? 1 : 0);
      const anchor =
        Math.cos(mid) > 0.2 ? "start" : Math.cos(mid) < -0.2 ? "end" : "middle";
      body.push(
        `<text class="stdlib-chart-label" x="${fmt(lx)}" y="${fmt(ly + 3)}" text-anchor="${anchor}">${escapeXml(d.label)} (${pct}%)</text>`,
      );
    }
    a = a1;
  });

  const legend = renderLegend(legendItems, width, height - legendHeight);

  return svgRoot(
    { width, height, className: opts.className },
    header.svg + body.join("") + legend.svg,
  );
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

type HistogramOptions = ChartOptions & {
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
  const area = computePlotArea(
    width,
    height,
    padding,
    !!opts.xAxis?.label,
    !!opts.yAxis?.label,
    header.height,
    0,
  );

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
      chartDatumSvg(`<rect class="stdlib-chart-bar stdlib-chart-series-0" x="${fmt(left)}" y="${fmt(top)}" width="${fmt(right - left)}" height="${fmt(zeroPx - top)}"/>`, { index: i, role: "bin", anchor: [(left + right) / 2, (top + zeroPx) / 2], values: [{ key: "from", value: edges[i]!, formatted: opts.xAxis?.format?.(edges[i]!) }, { key: "to", value: edges[i + 1]!, formatted: opts.xAxis?.format?.(edges[i + 1]!) }, { key: "upperInclusive", value: i === counts.length - 1 ? "true" : "false" }, { key: "count", value: c }] }, opts.inspect),
    );
  }

  if (opts.references && opts.references.length > 0) {
    body.push(renderReferenceLines(opts.references, xAxis, yAxis, area));
  }

  return svgRoot(
    { width, height, className: opts.className },
    header.svg + body.join(""),
  );
};

// ==========================
// BOX PLOT
// ==========================

type BoxPlotItem = { label: string; values: number[] };

type BoxPlotOptions = ChartOptions & {
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

  const area = computePlotArea(
    width,
    height,
    padding,
    false,
    !!opts.yAxis?.label,
    header.height,
    0,
  );

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
    renderXAxisCategorical(valid.map((g) => g.label), area, height, undefined),
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
      chartDatumSvg(`<rect class="stdlib-chart-box ${seriesCls}" x="${fmt(x)}" y="${fmt(yQ3)}" width="${fmt(boxWidth)}" height="${fmt(yQ1 - yQ3)}"/>`, { index: g.index, role: "box", label: g.label, anchor: [cx, yQ2], values: [{ key: "count", value: g.count }, ...(["q1", "q2", "q3", "whiskerLow", "whiskerHigh"] as const).map((key) => ({ key, value: g.s[key] })).map((field) => ({ ...field, formatted: opts.yAxis?.format?.(field.value) }))] }, opts.inspect),
    );
    // Median line.
    body.push(
      `<line class="stdlib-chart-box-median" x1="${fmt(x)}" y1="${fmt(yQ2)}" x2="${fmt(x + boxWidth)}" y2="${fmt(yQ2)}"/>`,
    );
    // Outliers.
    if (showOutliers) {
      const sourceIndices = new Map<number, number[]>();
      if (opts.inspect) opts.groups[g.index]!.values.forEach((value, index) => {
        const indices = sourceIndices.get(value) ?? [];
        indices.push(index); sourceIndices.set(value, indices);
      });
      for (const v of g.s.outliers) {
        const sourceIndex = sourceIndices.get(v)?.shift() ?? 0;
        const oy = yMap(v, yAxis.domain, [area.y1, area.y0]);
        body.push(
          chartDatumSvg(`<circle class="stdlib-chart-box-outlier ${seriesCls}" cx="${fmt(cx)}" cy="${fmt(oy)}" r="2.5"/>`, { index: sourceIndex, seriesIndex: g.index, role: "outlier", label: g.label, anchor: [cx, oy], values: [{ key: "value", value: v, formatted: opts.yAxis?.format?.(v) }] }, opts.inspect),
        );
      }
    }
  }

  if (opts.references && opts.references.length > 0) {
    const yRefs = opts.references.filter((r) => (r.axis ?? "y") === "y");
    if (yRefs.length > 0) {
      body.push(
        renderReferenceLines(
          yRefs,
          { domain: [0, 1], scale: "linear" },
          yAxis,
          area,
        ),
      );
    }
  }

  return svgRoot(
    { width, height, className: opts.className },
    header.svg + body.join(""),
  );
};

// ==========================
// DASHBOARD PANELS
// ==========================

type Threshold = {
  /** Inclusive upper bound for this threshold segment. */
  value: number;
  /** Optional label for legends or future consumers. */
  label?: string;
  /** Optional SVG color. When omitted, the series CSS variables are used. */
  color?: string;
};

type GaugeOptions = ChartOptions & {
  value: number;
  min?: number;
  max?: number;
  label?: string;
  unit?: string;
  format?: (value: number) => string;
  thresholds?: Threshold[];
  showNeedle?: boolean;
};

type BarGaugeItem = {
  label: string;
  value: number;
  min?: number;
  max?: number;
  unit?: string;
};

type BarGaugeOptions = ChartOptions & {
  data: BarGaugeItem[];
  min?: number;
  max?: number;
  unit?: string;
  format?: (value: number) => string;
  thresholds?: Threshold[];
};

type StatOptions = ChartOptions & {
  label: string;
  value: number | string;
  unit?: string;
  delta?: number | string;
  deltaFormat?: (value: number) => string;
  trend?: "up" | "down" | "neutral";
  sparkline?: number[] | Point[];
  format?: (value: number) => string;
};

type HeatmapDatum = { x: string; y: string; value: number };

type HeatmapOptions = ChartOptions & {
  data: HeatmapDatum[];
  xLabels?: string[];
  yLabels?: string[];
  min?: number;
  max?: number;
  format?: (value: number) => string;
  showValues?: boolean;
};

type StateInterval = {
  from: number;
  to: number;
  state: string;
  label?: string;
};

type StateTimelineRow = {
  label: string;
  intervals: StateInterval[];
};

type StateStyle = {
  state: string;
  label?: string;
  color?: string;
};

type StateTimelineOptions = ChartOptions & {
  rows: StateTimelineRow[];
  states?: StateStyle[];
  xAxis?: Pick<AxisOptions, "format" | "label">;
  legend?: boolean;
};

const thresholdIndexForValue = (
  value: number,
  thresholds: readonly Threshold[] | undefined,
  min: number,
  max: number,
): number => {
  if (!thresholds || thresholds.length === 0) return 0;
  const sorted = [...thresholds]
    .filter((t) => Number.isFinite(t.value))
    .sort((a, b) => a.value - b.value);
  const clamped = clamp(value, min, max);
  const idx = sorted.findIndex((t) => clamped <= t.value);
  return idx >= 0 ? idx : Math.max(0, sorted.length - 1);
};

const thresholdForIndex = (
  thresholds: readonly Threshold[] | undefined,
  index: number,
): Threshold | undefined => {
  if (!thresholds || thresholds.length === 0) return undefined;
  const sorted = [...thresholds]
    .filter((t) => Number.isFinite(t.value))
    .sort((a, b) => a.value - b.value);
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
  const fillStroke = gradientStops.length > 0
    ? ` stroke="${escapeXml(gaugeColorAt(gradientStops, clamped))}"`
    : thresholdStrokeAttr(thresholdColor);
  const fillClass = gradientStops.length > 0 || thresholdColor
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
      body.push(
        `<path class="${fillClass}"${fillStroke} pathLength="100" stroke-dasharray="${fmt(progress)} 100" d="${gaugePath}"/>`,
      );
    }
  }

  if (opts.showNeedle) {
    const tip = polarPoint(cx, cy, radius - 8, valueAngle);
    const needleClass = thresholdColor || gradientStops.length > 0
      ? "stdlib-chart-gauge-needle"
      : `stdlib-chart-gauge-needle stdlib-chart-series-${thresholdIdx % 8}`;
    body.push(
      `<line class="${needleClass}"${fillStroke} x1="${fmt(cx)}" y1="${fmt(cy)}" x2="${fmt(tip.x)}" y2="${fmt(tip.y)}"/>`,
    );
    body.push(`<circle class="stdlib-chart-gauge-hub" cx="${fmt(cx)}" cy="${fmt(cy)}" r="3"/>`);
  }

  body.push(
    `<text class="stdlib-chart-gauge-value" x="${fmt(cx)}" y="${fmt(cy - 2)}" text-anchor="middle">${escapeXml(valueText)}</text>`,
  );
  if (label) {
    body.push(
      `<text class="stdlib-chart-gauge-label" x="${fmt(cx)}" y="${fmt(cy + 20)}" text-anchor="middle">${escapeXml(label)}</text>`,
    );
  }
  body.push(
    `<text class="stdlib-chart-gauge-unit" x="${fmt(startPoint.x)}" y="${fmt(endpointLabelY)}" text-anchor="middle">${escapeXml(formatNumberValue(min, opts.format, opts.unit))}</text>`,
  );
  body.push(
    `<text class="stdlib-chart-gauge-unit" x="${fmt(endPoint.x)}" y="${fmt(endpointLabelY)}" text-anchor="middle">${escapeXml(formatNumberValue(max, opts.format, opts.unit))}</text>`,
  );

  return svgRoot({ width, height, className: opts.className }, chartDatumSvg(body.join(""), { index: 0, role: "value", label, anchor: [cx, cy], values: [{ key: "value", value, formatted: valueText }, { key: "min", value: min }, { key: "max", value: max }, ...(threshold ? [{ key: "threshold", value: threshold.label ?? threshold.value }] : [])] }, opts.inspect));
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
  const sourceIndices = opts.data.flatMap((d, index) => Number.isFinite(d.value) ? [index] : []);
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
    body.push(chartDatumSvg(shapes, { index: sourceIndices[i]!, role: "item", label: d.label, anchor: [trackX + trackW / 2, y + 12], values: [{ key: "value", value: d.value, formatted: formatNumberValue(d.value, opts.format, unit) }, { key: "min", value: min }, { key: "max", value: max }, ...(threshold ? [{ key: "threshold", value: threshold.label ?? threshold.value }] : [])] }, opts.inspect));
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
    (inspect ? [...points].sort((a, b) => a.x - b.x).map((p, index) => inspectionPoint({ index: entries[index]!.index, role: "point", anchor: [mapped[index]!.x, mapped[index]!.y], values: pointValues(p) }, inspect)).join("") : "")
  );
};

/** Render a large value panel with optional delta and inline sparkline. */
export const stat = (opts: StatOptions): string => {
  const width = opts.width ?? 260;
  const height = opts.height ?? 150;
  const value =
    typeof opts.value === "number"
      ? formatNumberValue(opts.value, opts.format, opts.unit)
      : `${opts.value}${opts.unit ?? ""}`;
  const trend =
    opts.trend ??
    (typeof opts.delta === "number"
      ? opts.delta > 0
        ? "up"
        : opts.delta < 0
          ? "down"
          : "neutral"
      : "neutral");
  const deltaText =
    typeof opts.delta === "number"
      ? `${opts.delta > 0 ? "+" : ""}${opts.deltaFormat ? opts.deltaFormat(opts.delta) : fmt(opts.delta)}`
      : opts.delta;
  const deltaClass =
    trend === "up"
      ? " stdlib-chart-stat-delta-up"
      : trend === "down"
        ? " stdlib-chart-stat-delta-down"
        : "";
  const body: string[] = [];
  body.push(
    `<text class="stdlib-chart-stat-label" x="16" y="24">${escapeXml(opts.label)}</text>`,
  );
  body.push(
    `<text class="stdlib-chart-stat-value" x="16" y="70">${escapeXml(value)}</text>`,
  );
  if (deltaText !== undefined) {
    body.push(
      `<text class="stdlib-chart-stat-delta${deltaClass}" x="${fmt(width - 16)}" y="70" text-anchor="end">${escapeXml(String(deltaText))}</text>`,
    );
  }
  const summary = chartDatumSvg((opts.inspect ? `<rect x="0" y="0" width="${fmt(width)}" height="${fmt(Math.max(80, height - 48))}" fill="transparent" stroke="none"/>` : "") + body.join(""), { index: 0, role: "value", label: opts.label, anchor: [width / 2, 50], values: [{ key: "value", value: opts.value, formatted: value }, ...(opts.delta !== undefined ? [{ key: "delta", value: opts.delta, formatted: deltaText }] : [])] }, opts.inspect);
  return svgRoot({ width, height, className: opts.className }, summary + renderInlineSparkline(opts.sparkline, 16, height - 42, width - 32, 26, opts.inspect));

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
        chartDatumSvg(`<rect class="stdlib-chart-heatmap-cell stdlib-chart-series-0" x="${fmt(x)}" y="${fmt(y)}" width="${fmt(Math.max(0, cellW - 1))}" height="${fmt(Math.max(0, cellH - 1))}" opacity="${fmt(intensity)}"/>`, { index: indexMap.get(`${xLabels[xi]}\u0000${yLabels[yi]}`)!, role: "cell", anchor: [x + cellW / 2, y + cellH / 2], grid: [xi, yi], values: [{ key: "x", value: xLabels[xi]! }, { key: "y", value: yLabels[yi]! }, { key: "value", value: valueAtCell!, formatted: format(valueAtCell!) }] }, opts.inspect),
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

const isMapPoint = (point: MapPoint): boolean =>
  Number.isFinite(point.latitude) &&
  Number.isFinite(point.longitude) &&
  point.latitude >= -90 &&
  point.latitude <= 90 &&
  point.longitude >= -180 &&
  point.longitude <= 180;

const MAP_MIN_ZOOM = 0;
const MAP_MAX_ZOOM = 5;

const normalizeMapViewport = (viewport: MapViewport | undefined): MapViewport => {
  const zoom = clamp(
    viewport && Number.isFinite(viewport.zoom) ? viewport.zoom : MAP_MIN_ZOOM,
    MAP_MIN_ZOOM,
    MAP_MAX_ZOOM,
  );
  const zoomScale = 2 ** zoom;
  const latitudeLimit = 90 - 90 / zoomScale;
  const longitudeLimit = 180 - 180 / zoomScale;

  return {
    latitude: clamp(
      viewport && Number.isFinite(viewport.latitude) ? viewport.latitude : 0,
      -latitudeLimit,
      latitudeLimit,
    ),
    longitude: clamp(
      viewport && Number.isFinite(viewport.longitude) ? viewport.longitude : 0,
      -longitudeLimit,
      longitudeLimit,
    ),
    zoom,
  };
};

/** Render geographic point series over a dependency-free world land map. */
export const map = (opts: MapOptions): string => {
  const width = opts.width ?? 640;
  const height = opts.height ?? 340;
  const padding = normalizePadding(
    opts.padding ?? { top: 12, right: 16, bottom: 12, left: 16 },
  );
  const header = renderHeader(width, opts.title, opts.subtitle);
  const legendItems = opts.legend
    ? opts.series.map((series, index) => ({
        label: series.label && series.label.length > 0
          ? series.label
          : `Series ${index + 1}`,
        seriesIndex: index,
      }))
    : [];
  const legendHeight = measureLegendHeight(legendItems, width);
  const area = computePlotArea(
    width,
    height,
    padding,
    false,
    false,
    header.height,
    legendHeight,
  );
  const availableWidth = Math.max(0, area.x1 - area.x0);
  const availableHeight = Math.max(0, area.y1 - area.y0);
  const scale = Math.max(
    0,
    Math.min(
      availableWidth / WORLD_MAP_WIDTH,
      availableHeight / WORLD_MAP_HEIGHT,
    ),
  );
  const mapWidth = WORLD_MAP_WIDTH * scale;
  const mapHeight = WORLD_MAP_HEIGHT * scale;
  const mapX = area.x0 + (availableWidth - mapWidth) / 2;
  const mapY = area.y0 + (availableHeight - mapHeight) / 2;
  const viewport = normalizeMapViewport(opts.viewport);
  const zoomScale = 2 ** viewport.zoom;
  const projectedScale = scale * zoomScale;
  const centerWorldX = ((viewport.longitude + 180) / 360) * WORLD_MAP_WIDTH;
  const centerWorldY = ((90 - viewport.latitude) / 180) * WORLD_MAP_HEIGHT;

  const finitePoints = opts.series.flatMap((series, seriesIndex) =>
    series.data
      .map((point, index) => ({ point, seriesIndex, index }))
      .filter(({ point }) => isMapPoint(point)),
  );

  let sizeMin = Number.POSITIVE_INFINITY;
  let sizeMax = Number.NEGATIVE_INFINITY;
  for (const { point } of finitePoints) {
    if (typeof point.size !== "number" || !Number.isFinite(point.size) || point.size < 0) {
      continue;
    }
    if (point.size < sizeMin) sizeMin = point.size;
    if (point.size > sizeMax) sizeMax = point.size;
  }
  const hasSizes = Number.isFinite(sizeMin) && Number.isFinite(sizeMax);
  const requestedSizeRange = opts.sizeRange ?? [3, 12];
  const firstRadius = Number.isFinite(requestedSizeRange[0])
    ? Math.max(0, requestedSizeRange[0])
    : 3;
  const secondRadius = Number.isFinite(requestedSizeRange[1])
    ? Math.max(0, requestedSizeRange[1])
    : 12;
  const radiusRange: [number, number] = firstRadius <= secondRadius
    ? [firstRadius, secondRadius]
    : [secondRadius, firstRadius];

  const body: string[] = [header.svg];
  if (scale > 0) {
    body.push(
      `<svg class="stdlib-chart-map-viewport" x="${fmt(mapX)}" y="${fmt(mapY)}" width="${fmt(mapWidth)}" height="${fmt(mapHeight)}" viewBox="0 0 ${fmt(mapWidth)} ${fmt(mapHeight)}" overflow="hidden">`,
      `<path class="stdlib-chart-map-land" fill-rule="evenodd" transform="translate(${fmt(mapWidth / 2)} ${fmt(mapHeight / 2)}) scale(${fmt(projectedScale)}) translate(${fmt(-centerWorldX)} ${fmt(-centerWorldY)})" d="${WORLD_LAND_PATH}"/>`,
    );

    for (const { point, seriesIndex, index } of finitePoints) {
      const pointWorldX = ((point.longitude + 180) / 360) * WORLD_MAP_WIDTH;
      const pointWorldY = ((90 - point.latitude) / 180) * WORLD_MAP_HEIGHT;
      const x = mapWidth / 2 + (pointWorldX - centerWorldX) * projectedScale;
      const y = mapHeight / 2 + (pointWorldY - centerWorldY) * projectedScale;
      const radius =
        hasSizes && typeof point.size === "number" && Number.isFinite(point.size) && point.size >= 0
          ? sizeMin === sizeMax
            ? (radiusRange[0] + radiusRange[1]) / 2
            : mapRange(point.size, [sizeMin, sizeMax], radiusRange)
          : 4;
      const title = point.label && point.label.length > 0
        ? `<title>${escapeXml(point.label)}</title>`
        : "";
      body.push(
        chartDatumSvg(`<circle class="stdlib-chart-map-point stdlib-chart-series-${seriesIndex % 8}" cx="${fmt(x)}" cy="${fmt(y)}" r="${fmt(radius)}">${title}</circle>`, { index, seriesIndex, role: "point", label: point.label ?? opts.series[seriesIndex]?.label, anchor: [x, y], values: [{ key: "latitude", value: point.latitude }, { key: "longitude", value: point.longitude }, ...(point.size !== undefined && Number.isFinite(point.size) ? [{ key: "size", value: point.size }] : [])] }, opts.inspect && x >= 0 && y >= 0 && x <= mapWidth && y <= mapHeight),
      );
    }
    body.push("</svg>");
  }

  if (finitePoints.length === 0) {
    body.push(
      `<text class="stdlib-chart-map-empty" x="${fmt(area.x0 + availableWidth / 2)}" y="${fmt(area.y0 + availableHeight / 2)}" text-anchor="middle" dominant-baseline="middle">No data</text>`,
    );
  }
  if (legendItems.length > 0) {
    body.push(renderLegend(legendItems, width, height - legendHeight).svg);
  }

  return svgRoot({ width, height, className: opts.className }, body.join(""));
};

/**
 * Render state regions over a numeric timeline for services, jobs, deploys, or
 * health checks.
 */
export const stateTimeline = (opts: StateTimelineOptions): string => {
  const width = opts.width ?? 560;
  const rowHeight = 24;
  const legendItems =
    opts.legend === false
      ? []
      : (opts.states ?? []).map((s, i) => ({ label: s.label ?? s.state, seriesIndex: i }));
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
        chartDatumSvg(`<rect class="stdlib-chart-state-region stdlib-chart-series-${idx % 8}"${thresholdFillAttr(color)} x="${fmt(x)}" y="${fmt(y + 3)}" width="${fmt(Math.max(1, x2 - x))}" height="${fmt(rowHeight - 6)}" rx="2"/>`, { index, seriesIndex: rowIdx, role: "interval", label: row.label, anchor: [(x + x2) / 2, y + rowHeight / 2], grid: [index, rowIdx], values: [{ key: "state", value: interval.state, formatted: stateStyles.get(interval.state)?.label }, { key: "from", value: from, formatted: format(from) }, { key: "to", value: to, formatted: format(to) }, { key: "duration", value: to - from }] }, opts.inspect),
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

type SparklineOptions = {
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

const sparklineEntries = (data: readonly (number | Point)[]) => data
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
    body.push(
      `<path class="stdlib-chart-sparkline-area" fill="url(#${gradId})" d="${areaPath}"/>`,
    );
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
      body.push(
        `<circle class="stdlib-chart-sparkline-max" cx="${fmt(max.x)}" cy="${fmt(max.y)}" r="2"/>`,
      );
      body.push(
        `<circle class="stdlib-chart-sparkline-min" cx="${fmt(min.x)}" cy="${fmt(min.y)}" r="2"/>`,
      );
    }
  }

  if (opts.showLast && mapped.length > 0) {
    const last = mapped[mapped.length - 1]!;
    body.push(
      `<circle class="stdlib-chart-sparkline-last" cx="${fmt(last.x)}" cy="${fmt(last.y)}" r="2"/>`,
    );
  }

  if (opts.inspect) sorted.forEach((p, index) => body.push(inspectionPoint({ index: entries[index]!.index, role: "point", anchor: [mapped[index]!.x, mapped[index]!.y], values: pointValues(p) }, opts.inspect)));
  return svgRoot({ width, height, className: opts.className }, body.join(""));
};

// ==========================
// NAMESPACE
// ==========================

export const charts = {
  scatter,
  line,
  bar,
  pie,
  donut,
  sparkline,
  histogram,
  boxplot,
  gauge,
  barGauge,
  stat,
  heatmap,
  map,
  stateTimeline,
} as const;
