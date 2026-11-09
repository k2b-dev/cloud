import type { BarChartOptions, PieChartOptions, Point, SparklineOptions, StateTimelineOptions, StatOptions } from "./svg-common";
import {
  arcPathD,
  chartDatumSvg,
  clamp,
  computeAxisScale,
  computeDomain,
  computePlotArea,
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  emptyChart,
  escapeXml,
  extendDomainToNice,
  fmt,
  formatNumberValue,
  inspectionPoint,
  itemColorIndex,
  linePathD,
  mapRange,
  measureLegendHeight,
  niceStep,
  normalizePadding,
  pickMapper,
  pointValues,
  renderHeader,
  renderLegend,
  renderReferenceLines,
  renderXAxisCategorical,
  renderYAxis,
  smoothPathD,
  svgRoot,
  thresholdFillAttr,
} from "./svg-common";

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
export { line } from "./line";
export { barGauge } from "./svg-barGauge";
export { boxplot } from "./svg-boxplot";
export * from "./svg-common";
export { gauge } from "./svg-gauge";
export { heatmap } from "./svg-heatmap";
export { histogram } from "./svg-histogram";
// Preserve the portable exports while allowing bundlers to load each renderer independently.
export { scatter } from "./svg-scatter";
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

// ==========================
// STATE TIMELINE
// ==========================

/**
 * Render state regions over a numeric timeline for services, jobs, deploys, or
 * health checks.
 */
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
