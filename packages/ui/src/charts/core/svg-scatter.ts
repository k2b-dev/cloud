// Ported SVG algorithm, kept verbatim; separate module for per-kind frame loading.

import {
  chartDatumSvg,
  collectAxisValues,
  collectSeriesLegend,
  computeAxisScale,
  computeDomain,
  computePlotArea,
  DEFAULT_HEIGHT,
  DEFAULT_MARKERS,
  DEFAULT_WIDTH,
  emptyChart,
  fmt,
  isOnAxis,
  linearRegression,
  mapRange,
  markerPath,
  normalizePadding,
  pickMapper,
  pointValues,
  renderErrorBars,
  renderHeader,
  renderLegend,
  renderReferenceLines,
  renderXAxisNumeric,
  renderYAxis,
  type ScatterOptions,
  svgRoot,
} from "./svg-renderers";
import type { ChartDatum } from "./types";
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
