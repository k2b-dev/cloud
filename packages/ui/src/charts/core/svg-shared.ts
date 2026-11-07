/** Shared SVG geometry and presentation; independent of every chart renderer. */
import type { IntentTone } from "../../semantics";
import type { Threshold } from "./svg";
import type { ChartDatum } from "./types";

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
export type MarkerShape = "circle" | "square" | "triangle" | "diamond" | "plus" | "cross";

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

export const itemColorIndex = (item: { colorIndex?: number }, fallback: number): number => {
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

/** Wrap renderer-owned geometry with escaped, inert inspection metadata. */
export const chartDatumSvg = (svg: string, datum: ChartDatum, inspect?: boolean): string => {
  if (!inspect || !datum.anchor.every(Number.isFinite)) return svg;
  const title = [datum.label, ...datum.values.map((field) => `${field.key}: ${field.formatted ?? field.value}`)]
    .filter(Boolean)
    .join(" · ");
  return `<g data-chart-role="${escapeXml(datum.role)}" data-chart-datum="${escapeXml(JSON.stringify(datum))}"><title>${escapeXml(title)}</title>${svg}</g>`;
};

export const inspectionPoint = (datum: ChartDatum, inspect?: boolean): string =>
  inspect
    ? chartDatumSvg(
        `<circle class="stdlib-chart-inspection-point" cx="${fmt(datum.anchor[0])}" cy="${fmt(datum.anchor[1])}" r="3" fill="transparent" stroke="none"/>`,
        datum,
        true,
      )
    : "";

export const pointValues = (p: Point, xAxis?: AxisOptions, yAxis?: AxisOptions): ChartDatum["values"] => [
  { key: "x", value: p.x, formatted: xAxis?.format?.(p.x) },
  { key: "y", value: p.y, formatted: yAxis?.format?.(p.y) },
  ...Object.entries(p)
    .filter(([key, value]) => key !== "x" && key !== "y" && typeof value === "number" && Number.isFinite(value))
    .map(([key, value]) => ({ key, value })),
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
  /** Omit to retain the existing dashed line. */
  style?: "solid" | "dashed" | "dotted";
  /** Semantic color shared by the line and its label, with standalone SVG fallbacks. */
  tone?: IntentTone;
};

/** Internal shared attributes for raw cartesian charts and UI bar layouts. */
export const referenceLineAttributes = (ref: ReferenceLine, label = false): string => {
  const declarations: string[] = [];
  if (!label && ref.style !== undefined) {
    const styles = { solid: "none", dashed: "4 4", dotted: "1 3" };
    const dash = styles[ref.style];
    if (typeof dash !== "string") throw new RangeError("Invalid reference line style");
    declarations.push(`stroke-dasharray:${dash}`);
    if (ref.style === "dotted") declarations.push("stroke-linecap:round");
  }
  if (ref.tone !== undefined) {
    const tones: Record<IntentTone, string> = {
      neutral: "currentColor",
      info: "var(--k2b-info-text,#1d4ed8)",
      success: "var(--k2b-success-text,#047857)",
      warning: "var(--k2b-warning-text,#92400e)",
      danger: "var(--k2b-danger-text,#b91c1c)",
    };
    const color = tones[ref.tone];
    if (typeof color !== "string") throw new RangeError("Invalid reference line tone");
    declarations.push(`color:${color}`);
  }
  return declarations.length ? ` style="${declarations.join(";")}"` : "";
};

// ==========================
// CONSTANTS
// ==========================

export const DEFAULT_WIDTH = 400;
export const DEFAULT_HEIGHT = 240;
export const DEFAULT_PADDING: Padding = { top: 16, right: 16, bottom: 32, left: 40 };
export const DEFAULT_TICKS = 5;

export const DEFAULT_MARKERS: readonly MarkerShape[] = ["circle", "square", "triangle", "diamond", "plus", "cross"];

export const DEFAULT_LINE_STYLES: readonly LineStyle[] = ["solid", "dashed", "dotted", "dashdot"];

/** SVG `stroke-dasharray` values per line style. Empty string = no dasharray. */
export const LINE_DASH_PATTERNS: Record<LineStyle, string> = {
  solid: "",
  dashed: "6 4",
  dotted: "2 3",
  dashdot: "6 3 2 3",
};

// CSS rule order is significant. Series-N rules emit first so shape-specific
// rules below can override (e.g. line's `fill: none` beats series fill, and
// slice/point's `stroke: white` beats series stroke).
export const DEFAULT_STYLES = `
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
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

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
export const extendDomainToNice = (min: number, max: number, step: number): { domain: [number, number]; ticks: number[] } => {
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  // Use rounding to avoid floating-point drift at tick positions.
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const round = (v: number): number => Number(v.toFixed(Math.min(decimals + 2, 12)));
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(round(v));
  return { domain: [lo, hi], ticks };
};

/** Linear map of `value` from input domain `[d0, d1]` to output range `[r0, r1]`. */
export const mapRange = (value: number, [d0, d1]: readonly [number, number], [r0, r1]: readonly [number, number]): number => {
  if (d1 === d0) return (r0 + r1) / 2;
  return r0 + ((value - d0) / (d1 - d0)) * (r1 - r0);
};

/**
 * Logarithmic (base-10) map of `value` from input domain `[d0, d1]` to
 * output range `[r0, r1]`. Both domain endpoints must be strictly positive.
 * Non-positive values are clamped to a small epsilon to avoid `-Infinity`.
 */
export const mapLog = (value: number, [d0, d1]: readonly [number, number], [r0, r1]: readonly [number, number]): number => {
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
export const niceLogTicks = (min: number, max: number): { domain: [number, number]; ticks: number[] } => {
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
  const finite = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
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
export const autoBin = (values: readonly number[], bins?: number | readonly number[]): { edges: number[]; counts: number[] } => {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return { edges: [0, 1], counts: [0] };

  // Cap bin count so a malicious / mistyped `bins: 1e9` doesn't allocate
  // gigabytes. 1024 is generous: 30 is Sturges' for 1e9 samples.
  const MAX_BINS = 1024;

  let edges: number[];
  if (Array.isArray(bins)) {
    const sorted = [...(bins as number[])].filter((e) => Number.isFinite(e)).sort((a, b) => a - b);
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

export type PlotArea = { x0: number; y0: number; x1: number; y1: number };

export const computePlotArea = (
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
export const renderHeader = (width: number, title: string | undefined, subtitle: string | undefined): { svg: string; height: number } => {
  if (!title && !subtitle) return { svg: "", height: 0 };
  const cx = width / 2;
  const parts: string[] = [];
  let y = 16;
  if (title) {
    parts.push(`<text class="stdlib-chart-title" x="${fmt(cx)}" y="${fmt(y)}" text-anchor="middle">${escapeXml(title)}</text>`);
    y += 14;
  }
  if (subtitle) {
    parts.push(`<text class="stdlib-chart-subtitle" x="${fmt(cx)}" y="${fmt(y)}" text-anchor="middle">${escapeXml(subtitle)}</text>`);
    y += 6;
  }
  return { svg: parts.join(""), height: y };
};

/**
 * Render reference lines (horizontal or vertical thresholds) within the plot
 * area. Out-of-domain values are silently skipped. Honors per-axis scale
 * (linear or log).
 */
export const renderReferenceLines = (
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
        `<line class="stdlib-chart-reference"${referenceLineAttributes(ref)} x1="${fmt(area.x0)}" y1="${fmt(y)}" x2="${fmt(area.x1)}" y2="${fmt(y)}"/>`,
      );
      if (ref.label) {
        parts.push(
          `<text class="stdlib-chart-reference-label"${referenceLineAttributes(ref, true)} x="${fmt(area.x1 - 4)}" y="${fmt(y - 4)}" text-anchor="end">${escapeXml(ref.label)}</text>`,
        );
      }
    } else {
      if (ref.value < xAxis.domain[0] || ref.value > xAxis.domain[1]) continue;
      const x = xMap(ref.value, xAxis.domain, [area.x0, area.x1]);
      parts.push(
        `<line class="stdlib-chart-reference"${referenceLineAttributes(ref)} x1="${fmt(x)}" y1="${fmt(area.y0)}" x2="${fmt(x)}" y2="${fmt(area.y1)}"/>`,
      );
      if (ref.label) {
        parts.push(
          `<text class="stdlib-chart-reference-label"${referenceLineAttributes(ref, true)} x="${fmt(x + 4)}" y="${fmt(area.y0 + 12)}">${escapeXml(ref.label)}</text>`,
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
export const resolveErrorY = (p: Point): [number, number] | null => {
  const high = p.errYHigh ?? p.errY;
  const low = p.errYLow ?? p.errY;
  if (high === undefined && low === undefined) return null;
  return [Number.isFinite(low) ? Math.abs(low!) : 0, Number.isFinite(high) ? Math.abs(high!) : 0];
};

export const resolveErrorX = (p: Point): [number, number] | null => {
  const high = p.errXHigh ?? p.errX;
  const low = p.errXLow ?? p.errX;
  if (high === undefined && low === undefined) return null;
  return [Number.isFinite(low) ? Math.abs(low!) : 0, Number.isFinite(high) ? Math.abs(high!) : 0];
};

/** Build the SVG fragment for the per-point error bars across all series. */
export const renderErrorBars = (series: ReadonlyArray<Series>, xAxis: AxisScale, yAxis: AxisScale, area: PlotArea): string => {
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
        parts.push(`<line class="stdlib-chart-errorbar" x1="${fmt(cx)}" y1="${fmt(yHi)}" x2="${fmt(cx)}" y2="${fmt(yLo)}"/>`);
        parts.push(`<line class="stdlib-chart-errorbar" x1="${fmt(cx - CAP)}" y1="${fmt(yHi)}" x2="${fmt(cx + CAP)}" y2="${fmt(yHi)}"/>`);
        parts.push(`<line class="stdlib-chart-errorbar" x1="${fmt(cx - CAP)}" y1="${fmt(yLo)}" x2="${fmt(cx + CAP)}" y2="${fmt(yLo)}"/>`);
        // Mark we need cy to match data point — ensure we use it (silences unused warnings if any).
        void cy;
      }

      const xErr = resolveErrorX(p);
      if (xErr) {
        const [low, high] = xErr;
        const xHi = xMap(p.x + high, xAxis.domain, [area.x0, area.x1]);
        const xLo = xMap(p.x - low, xAxis.domain, [area.x0, area.x1]);
        parts.push(`<line class="stdlib-chart-errorbar" x1="${fmt(xLo)}" y1="${fmt(cy)}" x2="${fmt(xHi)}" y2="${fmt(cy)}"/>`);
        parts.push(`<line class="stdlib-chart-errorbar" x1="${fmt(xLo)}" y1="${fmt(cy - CAP)}" x2="${fmt(xLo)}" y2="${fmt(cy + CAP)}"/>`);
        parts.push(`<line class="stdlib-chart-errorbar" x1="${fmt(xHi)}" y1="${fmt(cy - CAP)}" x2="${fmt(xHi)}" y2="${fmt(cy + CAP)}"/>`);
      }
    }
  }
  return parts.join("");
};

/** Collect all values relevant for axis-domain computation, including error
 *  extents so error bars don't get clipped. */
export const collectAxisValues = (series: ReadonlyArray<Series>, axis: "x" | "y"): number[] => {
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
export const renderLegend = (
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

  const itemWidths = items.map((it) => SWATCH + SWATCH_GAP + Math.max(it.label.length, 1) * charWidth);

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
      parts.push(`<g class="stdlib-chart-legend-item stdlib-chart-series-${item.seriesIndex % 8}">`);
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
export const measureLegendHeight = (items: ReadonlyArray<{ label: string; seriesIndex: number }>, width: number): number => {
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
export const svgRoot = (opts: { width: number; height: number; className?: string }, body: string): string => {
  const cls = opts.className ? `stdlib-chart ${escapeXml(opts.className)}` : "stdlib-chart";
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
export const arcPathD = (cx: number, cy: number, r: number, a0: number, a1: number, innerR = 0): string => {
  const sweep = a1 - a0;
  // Full circle: split into two halves to avoid degenerate `A` command.
  if (sweep >= Math.PI * 2 - 1e-9) {
    const aMid = a0 + Math.PI;
    if (innerR <= 0) {
      const ox0 = cx + r * Math.cos(a0),
        oy0 = cy + r * Math.sin(a0);
      const oxM = cx + r * Math.cos(aMid),
        oyM = cy + r * Math.sin(aMid);
      return `M ${fmt(ox0)} ${fmt(oy0)} A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(oxM)} ${fmt(oyM)} A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(ox0)} ${fmt(oy0)} Z`;
    }
    const ox0 = cx + r * Math.cos(a0),
      oy0 = cy + r * Math.sin(a0);
    const oxM = cx + r * Math.cos(aMid),
      oyM = cy + r * Math.sin(aMid);
    const ix0 = cx + innerR * Math.cos(a0),
      iy0 = cy + innerR * Math.sin(a0);
    const ixM = cx + innerR * Math.cos(aMid),
      iyM = cy + innerR * Math.sin(aMid);
    // Outer ring CW, inner ring CCW (using even-odd fill rule via SVG default).
    return (
      `M ${fmt(ox0)} ${fmt(oy0)} A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(oxM)} ${fmt(oyM)} A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(ox0)} ${fmt(oy0)} Z` +
      ` M ${fmt(ix0)} ${fmt(iy0)} A ${fmt(innerR)} ${fmt(innerR)} 0 0 0 ${fmt(ixM)} ${fmt(iyM)} A ${fmt(innerR)} ${fmt(innerR)} 0 0 0 ${fmt(ix0)} ${fmt(iy0)} Z`
    );
  }
  const large = sweep > Math.PI ? 1 : 0;
  const ox0 = cx + r * Math.cos(a0),
    oy0 = cy + r * Math.sin(a0);
  const ox1 = cx + r * Math.cos(a1),
    oy1 = cy + r * Math.sin(a1);
  if (innerR <= 0) {
    return `M ${fmt(cx)} ${fmt(cy)} L ${fmt(ox0)} ${fmt(oy0)} A ${fmt(r)} ${fmt(r)} 0 ${large} 1 ${fmt(ox1)} ${fmt(oy1)} Z`;
  }
  const ix0 = cx + innerR * Math.cos(a0),
    iy0 = cy + innerR * Math.sin(a0);
  const ix1 = cx + innerR * Math.cos(a1),
    iy1 = cy + innerR * Math.sin(a1);
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
export const markerPath = (shape: MarkerShape, cx: number, cy: number, r: number): string => {
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
export const stepPathD = (points: ReadonlyArray<{ x: number; y: number }>, mode: "before" | "after" | "middle"): string => {
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
export const fmt = (n: number): string => {
  if (!Number.isFinite(n)) return "0";
  // 2 decimals is enough for sub-pixel precision at typical sizes.
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? `${rounded}` : `${rounded}`;
};

export const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

export const normalizeMinMax = (min: number | undefined, max: number | undefined): [number, number] => {
  const lo = Number.isFinite(min) ? min! : 0;
  const hi = Number.isFinite(max) ? max! : 100;
  return lo === hi ? [lo, lo + 1] : lo < hi ? [lo, hi] : [hi, lo];
};

export const formatNumberValue = (value: number, format: ((value: number) => string) | undefined, unit = ""): string => {
  if (!Number.isFinite(value)) return "";
  return `${format ? format(value) : fmt(value)}${unit}`;
};

export const thresholdFillAttr = (color: string | undefined): string => (color ? ` fill="${escapeXml(color)}"` : "");

export const thresholdStrokeAttr = (color: string | undefined): string => (color ? ` stroke="${escapeXml(color)}"` : "");

export const polarPoint = (cx: number, cy: number, r: number, angleRad: number) => ({
  x: cx + r * Math.cos(angleRad),
  y: cy + r * Math.sin(angleRad),
});

export const arcLinePathD = (cx: number, cy: number, r: number, a0: number, a1: number): string => {
  const start = polarPoint(cx, cy, r, a0);
  const end = polarPoint(cx, cy, r, a1);
  const large = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
  const sweep = a1 >= a0 ? 1 : 0;
  return `M ${fmt(start.x)} ${fmt(start.y)} A ${fmt(r)} ${fmt(r)} 0 ${large} ${sweep} ${fmt(end.x)} ${fmt(end.y)}`;
};

export type RgbColor = { r: number; g: number; b: number };

export const parseHexColor = (color: string): RgbColor | null => {
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

export const hexColor = (color: RgbColor): string =>
  `#${[color.r, color.g, color.b].map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0")).join("")}`;

export const interpolateColor = (from: string, to: string, t: number): string => {
  const a = parseHexColor(from);
  const b = parseHexColor(to);
  if (!a || !b) return t < 0.5 ? from : to;
  return hexColor({
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  });
};

export const gaugeThresholdStops = (
  thresholds: readonly Threshold[] | undefined,
  min: number,
  max: number,
): Array<{ value: number; color: string }> => {
  if (!thresholds || thresholds.length === 0) return [];
  const sorted = [...thresholds].filter((t) => Number.isFinite(t.value)).sort((a, b) => a.value - b.value);
  if (sorted.length === 0) return [];
  const colorFor = (threshold: Threshold, index: number) => threshold.color ?? `var(--stdlib-chart-c${(index % 8) + 1})`;
  return [
    { value: min, color: colorFor(sorted[0]!, 0) },
    ...sorted.map((threshold, index) => ({
      value: clamp(threshold.value, min, max),
      color: colorFor(threshold, index),
    })),
  ];
};

export const gaugeColorAt = (stops: readonly { value: number; color: string }[], value: number): string => {
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

export const renderGaugeGradientSegments = (opts: {
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
    parts.push(`<path class="${opts.className}" stroke="${escapeXml(color)}" d="${arcLinePathD(opts.cx, opts.cy, opts.radius, a0, a1)}"/>`);
  }
  return parts.join("");
};

// ==========================
// AXIS RENDERERS
// ==========================

export type AxisScale = {
  domain: [number, number];
  ticks: number[];
  minorTicks: number[];
  scale: "linear" | "log";
};

export const pickMapper = (scale: "linear" | "log") => (scale === "log" ? mapLog : mapRange);

/**
 * Whether a value is renderable on the given axis. Log axes reject zero and
 * negative values (since `log(<=0)` is undefined). Used to filter data
 * points before rendering so we don't emit huge off-plot SVG coordinates.
 */
export const isOnAxis = (axis: { scale: "linear" | "log" }, v: number): boolean => Number.isFinite(v) && (axis.scale !== "log" || v > 0);

/**
 * Compute the domain, major ticks, and (optional) minor ticks for an axis,
 * choosing linear or log scale per `axisOpts`. Filters non-positive values
 * out under log scale and falls back to `[1, 10]` if none remain.
 */
export const computeAxisScale = (
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
        for (let value = Math.ceil(lo / step) * step; value < hi; ) {
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

export const renderYAxis = (axis: AxisScale, area: PlotArea, opts: AxisOptions | undefined): string => {
  const format = opts?.format ?? ((v: number) => String(v));
  const map = pickMapper(axis.scale);
  const parts: string[] = [];
  for (const t of axis.ticks) {
    const y = map(t, axis.domain, [area.y1, area.y0]);
    parts.push(`<line class="stdlib-chart-grid" x1="${fmt(area.x0)}" y1="${fmt(y)}" x2="${fmt(area.x1)}" y2="${fmt(y)}"/>`);
    parts.push(
      `<text class="stdlib-chart-tick-label" x="${fmt(area.x0 - 6)}" y="${fmt(y + 3)}" text-anchor="end">${escapeXml(format(t))}</text>`,
    );
  }
  for (const mt of axis.minorTicks) {
    const y = map(mt, axis.domain, [area.y1, area.y0]);
    parts.push(`<line class="stdlib-chart-minor-tick" x1="${fmt(area.x0 - 3)}" y1="${fmt(y)}" x2="${fmt(area.x0)}" y2="${fmt(y)}"/>`);
  }
  parts.push(`<line class="stdlib-chart-axis" x1="${fmt(area.x0)}" y1="${fmt(area.y0)}" x2="${fmt(area.x0)}" y2="${fmt(area.y1)}"/>`);
  if (opts?.label) {
    const cx = 12;
    const cy = (area.y0 + area.y1) / 2;
    parts.push(
      `<text class="stdlib-chart-axis-label" x="${fmt(cx)}" y="${fmt(cy)}" text-anchor="middle" transform="rotate(-90 ${fmt(cx)} ${fmt(cy)})">${escapeXml(opts.label)}</text>`,
    );
  }
  return parts.join("");
};

export const renderXAxisNumeric = (axis: AxisScale, area: PlotArea, height: number, opts: AxisOptions | undefined): string => {
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
    parts.push(`<line class="stdlib-chart-minor-tick" x1="${fmt(x)}" y1="${fmt(area.y1)}" x2="${fmt(x)}" y2="${fmt(area.y1 + 3)}"/>`);
  }
  parts.push(`<line class="stdlib-chart-axis" x1="${fmt(area.x0)}" y1="${fmt(area.y1)}" x2="${fmt(area.x1)}" y2="${fmt(area.y1)}"/>`);
  if (opts?.label) {
    parts.push(
      `<text class="stdlib-chart-axis-label" x="${fmt((area.x0 + area.x1) / 2)}" y="${fmt(height - 4)}" text-anchor="middle">${escapeXml(opts.label)}</text>`,
    );
  }
  return parts.join("");
};

export const renderXAxisCategorical = (labels: readonly string[], area: PlotArea, height: number, axisLabel?: string): string => {
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
  parts.push(`<line class="stdlib-chart-axis" x1="${fmt(area.x0)}" y1="${fmt(area.y1)}" x2="${fmt(area.x1)}" y2="${fmt(area.y1)}"/>`);
  if (axisLabel) {
    parts.push(
      `<text class="stdlib-chart-axis-label" x="${fmt((area.x0 + area.x1) / 2)}" y="${fmt(height - 4)}" text-anchor="middle">${escapeXml(axisLabel)}</text>`,
    );
  }
  return parts.join("");
};

export const emptyChart = (width: number, height: number, className: string | undefined, message = "no data"): string =>
  svgRoot(
    { width, height, className },
    `<text class="stdlib-chart-empty-text" x="${fmt(width / 2)}" y="${fmt(height / 2)}" text-anchor="middle" dominant-baseline="middle">${escapeXml(message)}</text>`,
  );

export const collectSeriesLegend = (opts: { series: Series[]; legend?: boolean }): Array<{ label: string; seriesIndex: number }> => {
  if (!opts.legend) return [];
  return opts.series.map((s, i) => ({
    label: s.label && s.label.length > 0 ? s.label : `Series ${i + 1}`,
    seriesIndex: i,
  }));
};
