/** Existing line renderer, separated so detailed drawing stays behind lazy chart boundaries. */
import { chartTimeLabel, chartTimeStep, chartTimeTicks } from "../../content/chart-time-axis";
import { coreChartMessages } from "./chart-messages";
import { lineBase } from "./line-base";
import { lineDetailsEnabled, lineForecastLayout, lineLegendX } from "./line-options";
import type { LineOptions } from "./svg-renderers";
import type { ChartDatum } from "./types";
import {
  collectAxisValues,
  collectSeriesLegend,
  computeAxisScale,
  computeDomain,
  computePlotArea,
  DEFAULT_HEIGHT,
  DEFAULT_LINE_STYLES,
  DEFAULT_WIDTH,
  emptyChart,
  escapeXml,
  fmt,
  inspectionPoint,
  isOnAxis,
  LINE_DASH_PATTERNS,
  linePathD,
  normalizePadding,
  type Point,
  pickMapper,
  pointValues,
  renderErrorBars,
  renderHeader,
  renderReferenceLines,
  renderXAxisNumeric,
  renderYAxis,
  resolveErrorY,
  smoothPathD,
  stepPathD,
  svgRoot,
} from "./svg-shared";

/**
 * Render a line chart. Each series becomes a `<path class="stdlib-chart-line">`
 * connecting its points (sorted by `x`). Multi-series charts get distinct
 * `stdlib-chart-series-N` classes.
 *
 * Detailed lines split missing observations into runs and show isolated points.
 * Existing descriptions retain their established filtering and gap behavior. An empty/all-non-finite chart renders
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
  if (!lineDetailsEnabled(opts)) return lineBase(opts);
  const forecast = lineForecastLayout(opts);
  if (opts.maxGap !== undefined && (!Number.isFinite(opts.maxGap) || opts.maxGap <= 0))
    throw new RangeError("Chart maxGap must be finite and positive");
  if (opts.maxGap !== undefined && (opts.area || opts.errorBand)) throw new Error("Chart maxGap does not support area or errorBand fills");
  if (opts.threshold && !isOnAxis({ scale: opts.yAxis?.scale ?? "linear" }, opts.threshold.value))
    throw new RangeError("Line threshold must be finite and positive on a log axis");
  if (opts.marker && !isOnAxis({ scale: opts.xAxis?.scale ?? "linear" }, opts.marker.at))
    throw new RangeError("Line marker must be finite and positive on a log axis");
  if (opts.marker && opts.xAxis?.domain && (opts.marker.at < opts.xAxis.domain[0] || opts.marker.at > opts.xAxis.domain[1]))
    throw new RangeError("Line marker must be inside the explicit X domain");
  const width = opts.width ?? DEFAULT_WIDTH;
  const height = opts.height ?? DEFAULT_HEIGHT;
  const padding = normalizePadding(opts.padding);
  const header = renderHeader(width, opts.title, opts.subtitle);
  const legendItems = collectSeriesLegend(opts);
  const legendHeight = legendItems.length > 2 ? 40 : legendItems.length ? 20 : 0;
  const finitePoints = opts.series.flatMap((s) => s.data).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (finitePoints.length === 0) return emptyChart(width, height, opts.className);
  const timeAxis = opts.timeAxis && { ...opts.timeAxis, locale: opts.timeAxis.locale ?? opts.locale };
  const xValues = [
    ...collectAxisValues(opts.series, "x"),
    ...(opts.marker ? [opts.marker.at] : []),
    ...(timeAxis ? (opts.references?.filter((ref) => ref.axis === "x").map((ref) => ref.value) ?? []) : []),
  ];
  const xAxis = computeAxisScale(xValues, timeAxis && !opts.xAxis?.domain ? { ...opts.xAxis, domain: computeDomain(xValues) } : opts.xAxis);
  const timeStep = timeAxis ? chartTimeStep(xAxis.domain[1] - xAxis.domain[0], (opts.xAxis?.ticks ?? 3) + 2) : undefined;
  if (timeAxis && timeStep) {
    xAxis.ticks = chartTimeTicks(xAxis.domain, timeAxis.timeZone, timeStep);
    xAxis.minorTicks = [];
  }
  const bandValues = forecast.flatMap((p) => (Number.isFinite(p.y) && p.lo !== undefined && p.hi !== undefined ? [p.lo, p.hi] : []));
  const yAxis = computeAxisScale(
    [...collectAxisValues(opts.series, "y"), ...bandValues, ...(opts.zero ? [0] : []), ...(opts.threshold ? [opts.threshold.value] : [])],
    opts.yAxis,
  );
  const labelRoom = Math.max(...yAxis.ticks.map((tick) => (opts.yAxis?.format?.(tick) ?? String(tick)).length * 6 + 12));
  if ((opts.forecast || opts.zero || opts.threshold || opts.marker) && typeof opts.padding !== "number" && opts.padding?.left === undefined)
    padding.left = Math.max(padding.left, labelRoom);
  const area = computePlotArea(width, height, padding, !!opts.xAxis?.label, !!opts.yAxis?.label, header.height, legendHeight);
  const xMap = pickMapper(xAxis.scale),
    yMap = pickMapper(yAxis.scale);
  const x = (value: number) => xMap(value, xAxis.domain, [area.x0, area.x1]);
  const y = (value: number) => yMap(value, yAxis.domain, [area.y1, area.y0]);
  const palette = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#06b6d4", "#84cc16", "#f97316"];
  const paint = (index: number) => `var(--stdlib-chart-c${(index % 8) + 1}, ${palette[index % 8]})`;
  const body: string[] = [];
  const inspectionMarks: string[] = [];
  if (opts.zero && yAxis.scale === "linear" && yAxis.domain[0] < 0) {
    const zeroY = y(Math.min(0, yAxis.domain[1]));
    body.push(
      `<rect class="k2b-line-negative-zone" x="${fmt(area.x0)}" y="${fmt(zeroY)}" width="${fmt(area.x1 - area.x0)}" height="${fmt(area.y1 - zeroY)}" fill="var(--k2b-danger-500, #ef4444)" fill-opacity=".09" stroke="none"/>`,
    );
  }
  body.push(renderYAxis(yAxis, area, opts.yAxis));
  let xLabels = renderXAxisNumeric(
    xAxis,
    area,
    height - legendHeight,
    timeAxis && timeStep
      ? { ...opts.xAxis, format: opts.xAxis?.format ?? ((value) => chartTimeLabel(value, timeStep, timeAxis)) }
      : opts.xAxis,
  );
  if (timeAxis) {
    let index = 0;
    // Edge labels point into the plot, keeping the first date clear of the Y ticks.
    xLabels = xLabels.replace(/<text class="stdlib-chart-tick-label"[^>]*>/g, (tag) => {
      const anchor = index === 0 ? "start" : index === xAxis.ticks.length - 1 ? "end" : "middle";
      index++;
      return tag
        .replace('class="stdlib-chart-tick-label"', 'class="stdlib-chart-tick-label k2b-line-time-tick"')
        .replace('text-anchor="middle"', `text-anchor="${anchor}"`);
    });
  }
  body.push(xLabels);
  const baselineY = yAxis.scale === "linear" && yAxis.domain[0] <= 0 && yAxis.domain[1] >= 0 ? y(0) : area.y1;
  const pathFn = opts.step
    ? (pts: Array<{ x: number; y: number }>) => stepPathD(pts, opts.step!)
    : opts.smooth === false
      ? linePathD
      : smoothPathD;
  // A missing observation ends a run before filtering; finite observations on either side never connect.
  const runsOf = <T extends Point>(points: T[]) => {
    const runs: T[][] = [];
    let run: T[] = [];
    for (const point of [...points].sort((a, b) => a.x - b.x)) {
      if (!isOnAxis(xAxis, point.x) || !isOnAxis(yAxis, point.y)) {
        if (run.length) runs.push(run);
        run = [];
        continue;
      }
      if (run.length && opts.maxGap !== undefined && point.x - run.at(-1)!.x > opts.maxGap) {
        runs.push(run);
        run = [];
      }
      run.push(point);
    }
    if (run.length) runs.push(run);
    return runs;
  };
  if (opts.forecast?.band)
    for (const run of runsOf(forecast)) {
      const valid = run.filter((p): p is typeof p & { lo: number; hi: number } => p.lo !== undefined && p.hi !== undefined);
      if (!valid.length) continue;
      if (valid.length === 1) {
        const point = valid[0]!,
          center = x(point.x);
        const slot = Math.min(12, (area.x1 - area.x0) / Math.max(1, opts.series[0]?.data.length ?? 1));
        body.push(
          `<rect class="k2b-line-forecast-band" x="${fmt(Math.max(area.x0, center - slot / 2))}" y="${fmt(y(point.hi))}" width="${fmt(Math.min(area.x1, center + slot / 2) - Math.max(area.x0, center - slot / 2))}" height="${fmt(Math.max(1, y(point.lo) - y(point.hi)))}" fill="${paint(0)}" fill-opacity=".15" stroke="none"/>`,
        );
        continue;
      }
      const upper = valid.map((p) => ({ x: x(p.x), y: y(p.hi) }));
      const lower = valid.map((p) => ({ x: x(p.x), y: y(p.lo) })).reverse();
      // Traversing the lower edge backwards also reverses the step direction.
      const lowerPath = opts.step
        ? stepPathD(lower, opts.step === "before" ? "after" : opts.step === "after" ? "before" : "middle")
        : pathFn(lower);
      body.push(
        `<path class="k2b-line-forecast-band" d="${pathFn(upper)} ${lowerPath.replace(/^M/, "L")} Z" fill="${paint(0)}" fill-opacity=".15" stroke="none"/>`,
      );
    }
  const boundsByPoint = new Map(forecast.map((point) => [point.source, point]));
  opts.series.forEach((s, i) => {
    const runs = runsOf(s.data);
    const isolated = new Set(runs.filter((run) => run.length === 1).map((run) => run[0]!));
    s.data.forEach((p, index) => {
      if (!isOnAxis(xAxis, p.x) || !isOnAxis(yAxis, p.y)) return;
      if (!opts.inspect && !isolated.has(p)) return;
      const bounds = i === 0 ? boundsByPoint.get(p) : undefined;
      const values = pointValues(p, opts.xAxis, opts.yAxis);
      if (bounds?.lo !== undefined && bounds.hi !== undefined)
        values.push(
          { key: "forecastLow", value: bounds.lo, formatted: opts.yAxis?.format?.(bounds.lo) },
          { key: "forecastHigh", value: bounds.hi, formatted: opts.yAxis?.format?.(bounds.hi) },
        );
      const datum: ChartDatum = { index, seriesIndex: i, role: "point", label: s.label, anchor: [x(p.x), y(p.y)], values };
      let mark = opts.inspect
        ? inspectionPoint(datum, true)
        : `<circle class="stdlib-chart-inspection-point" cx="${fmt(x(p.x))}" cy="${fmt(y(p.y))}" r="3" fill="transparent" stroke="none"/>`;
      if (isolated.has(p)) mark = mark.replace('fill="transparent"', `fill="${paint(i)}"`);
      inspectionMarks.push(mark);
    });
    for (const sorted of runs) {
      if (sorted.length < 2) continue;
      const mapped = sorted.map((p) => ({ x: x(p.x), y: y(p.y) }));
      const linePath = pathFn(mapped);
      if (opts.errorBand) {
        const upper: Array<{ x: number; y: number }> = [],
          lower: Array<{ x: number; y: number }> = [];
        for (const p of sorted) {
          const err = resolveErrorY(p);
          if (!err) continue;
          upper.push({ x: x(p.x), y: y(p.y + err[1]) });
          lower.push({ x: x(p.x), y: y(p.y - err[0]) });
        }
        if (upper.length >= 2)
          body.push(
            `<path class="stdlib-chart-error-band stdlib-chart-series-${i % 8}" d="${pathFn(upper)}${lower
              .reverse()
              .map((p) => ` L ${fmt(p.x)} ${fmt(p.y)}`)
              .join("")} Z" fill="${paint(i)}" fill-opacity=".15" stroke="none"/>`,
          );
      }
      if (opts.area) {
        const first = mapped[0]!,
          last = mapped.at(-1)!;
        body.push(
          `<path class="stdlib-chart-area stdlib-chart-series-${i % 8}" d="${linePath} L ${fmt(last.x)} ${fmt(baselineY)} L ${fmt(first.x)} ${fmt(baselineY)} Z" fill="${paint(i)}" fill-opacity=".18" stroke="none"/>`,
        );
      }
      const dashStyle = s.lineStyle ?? (opts.autoVariant ? DEFAULT_LINE_STYLES[i % DEFAULT_LINE_STYLES.length]! : "solid");
      const dash = LINE_DASH_PATTERNS[dashStyle];
      const path = (forecastDash = false) =>
        `<path class="stdlib-chart-line stdlib-chart-series-${i % 8}" d="${linePath}" fill="none" stroke="${paint(i)}" stroke-width="2"${forecastDash ? ' stroke-dasharray="5 4"' : dash ? ` stroke-dasharray="${dash}"` : ""}/>`;
      const from = opts.forecast?.from;
      if (from === undefined || sorted.at(-1)!.x <= from) body.push(path());
      else if (sorted[0]!.x >= from) body.push(`<g class="k2b-line-forecast">${path(true)}</g>`);
      else {
        const cut = x(from);
        const clipped = (left: number, right: number, content: string, cls: string) =>
          `<svg class="${cls}" x="${fmt(left)}" y="${fmt(area.y0)}" width="${fmt(right - left)}" height="${fmt(area.y1 - area.y0)}" viewBox="${fmt(left)} ${fmt(area.y0)} ${fmt(right - left)} ${fmt(area.y1 - area.y0)}" overflow="hidden">${content}</svg>`;
        body.push(clipped(area.x0, cut, path(), "k2b-line-observed"), clipped(cut, area.x1, path(true), "k2b-line-forecast"));
      }
    }
  });
  body.push(...inspectionMarks);
  body.push(renderErrorBars(opts.series, xAxis, yAxis, area));
  if (opts.references?.length) body.push(renderReferenceLines(opts.references, xAxis, yAxis, area));
  const annotation = (cx: number, cy: number, label: string, anchor: string, color: string, className = "") => {
    const room = anchor === "start" ? width - cx - 8 : anchor === "end" ? cx - 8 : 2 * Math.min(cx - 8, width - cx - 8);
    const limit = Math.max(1, Math.min(40, Math.floor(room / 6)));
    const shown = label.length > limit ? `${label.slice(0, Math.max(0, limit - 1))}…` : label;
    return `<text class="${className}" x="${fmt(cx)}" y="${fmt(cy)}" text-anchor="${anchor}" fill="${color}" stroke="none" font-size="11" font-weight="600"><title>${escapeXml(label)}</title>${escapeXml(shown)}</text>`;
  };
  if (opts.threshold) {
    const valueY = y(opts.threshold.value),
      color = "var(--k2b-warning-500, #f59e0b)";
    body.push(
      `<line class="k2b-line-threshold" x1="${fmt(area.x0)}" x2="${fmt(area.x1)}" y1="${fmt(valueY)}" y2="${fmt(valueY)}" stroke="${color}" stroke-width="1.2" stroke-dasharray="5 4"/>`,
      annotation(
        area.x1,
        area.y0 - 5,
        `${opts.threshold.label} ${opts.yAxis?.format?.(opts.threshold.value) ?? new Intl.NumberFormat(opts.locale ?? "en").format(opts.threshold.value)}`,
        "end",
        color,
        "k2b-line-threshold-label",
      ),
    );
  }
  if (opts.marker) {
    const markerX = x(opts.marker.at),
      color = "var(--k2b-text-secondary, #52525b)";
    body.push(
      `<line class="k2b-line-marker" x1="${fmt(markerX)}" x2="${fmt(markerX)}" y1="${fmt(area.y0)}" y2="${fmt(area.y1)}" stroke="${color}" stroke-width="1.2"/>`,
      annotation(
        markerX,
        area.y0 - 5,
        opts.marker.label,
        markerX - area.x0 < 50 ? "start" : area.x1 - markerX < 50 ? "end" : "middle",
        color,
      ),
    );
  }
  const defaultX = lineLegendX(opts);
  const legend: string[] = [];
  if (legendItems.length) {
    const entries = legendItems.slice(0, 4),
      cell = width / 2;
    entries.forEach((entry, i) => {
      const left = (i % 2) * cell + 4,
        baseY = height - legendHeight + 12 + Math.floor(i / 2) * 20;
      if (i === 3 && legendItems.length > 4) {
        legend.push(
          `<text x="${fmt(left)}" y="${fmt(baseY)}" fill="currentColor" stroke="none" font-size="11">+${legendItems.length - 3}</text>`,
        );
        return;
      }
      const series = opts.series[entry.seriesIndex]!,
        point = series.data.find((p) => p.x === defaultX);
      const amount =
        point && Number.isFinite(point.y)
          ? (opts.yAxis?.format?.(point.y) ?? new Intl.NumberFormat(opts.locale ?? "en", { maximumFractionDigits: 6 }).format(point.y))
          : "—";
      const label = series.label || `${coreChartMessages.resolve([opts.locale ?? "en"]).t.series} ${entry.seriesIndex + 1}`;
      const room = Math.max(1, Math.floor((cell * 296) / width / 6) - Math.min(14, amount.length) - 4);
      const shortened = label.length > room ? label.slice(0, Math.max(0, room - 1)) + "…" : label;
      legend.push(
        `<g class="stdlib-chart-legend-item"><rect class="stdlib-chart-legend-swatch" x="${fmt(left)}" y="${fmt(baseY - 8)}" width="8" height="8" rx="2" fill="${paint(entry.seriesIndex)}" stroke="none"/><text class="stdlib-chart-legend-label" aria-label="${escapeXml(label)}" x="${fmt(left + 12)}" y="${fmt(baseY)}" fill="currentColor" stroke="none" font-size="11">${escapeXml(shortened)}</text><text x="${fmt(left + cell - 8)}" y="${fmt(baseY)}" text-anchor="end" fill="currentColor" stroke="none" font-size="11" font-weight="600" data-chart-legend-value data-series-index="${entry.seriesIndex}" data-field="y" data-default="${escapeXml(amount)}">${escapeXml(amount)}</text></g>`,
      );
    });
  }
  const svg = svgRoot(
    { width, height, className: opts.className },
    header.svg + body.join("") + (legend.length ? `<g class="k2b-line-value-legend">${legend.join("")}</g>` : ""),
  );
  // CSS adds only the physical room missing in a narrow host. Its SVG transform is
  // visible to the shared inspector, and the server emits the same geometry.
  const fraction = Math.min(0.8, Math.max(0, area.x0 / width));
  return svg.replace(
    "<svg ",
    `<svg data-line-details="true" data-line-default-x="${defaultX}" data-line-axis-room="true" style="--k2b-line-label-room:${labelRoom}px;--k2b-line-axis-fraction:${fraction};--k2b-line-axis-expand:${1 / (1 - fraction)}" `,
  );
};
