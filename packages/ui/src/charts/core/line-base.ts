/** The established line drawing; kept independent of opt-in line details for small hosts. */

import type { LineOptions } from "./svg";
import {
  collectAxisValues,
  collectSeriesLegend,
  computeAxisScale,
  computePlotArea,
  DEFAULT_HEIGHT,
  DEFAULT_LINE_STYLES,
  DEFAULT_WIDTH,
  emptyChart,
  fmt,
  inspectionPoint,
  isOnAxis,
  LINE_DASH_PATTERNS,
  linePathD,
  normalizePadding,
  pickMapper,
  pointValues,
  renderErrorBars,
  renderHeader,
  renderLegend,
  renderReferenceLines,
  renderXAxisNumeric,
  renderYAxis,
  resolveErrorY,
  smoothPathD,
  stepPathD,
  svgRoot,
} from "./svg-common";

export const lineBase = (opts: LineOptions): string => {
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

  const body: string[] = [];
  body.push(renderYAxis(yAxis, area, opts.yAxis));
  body.push(renderXAxisNumeric(xAxis, area, height - legendHeight, opts.xAxis));

  // Compute the area baseline (zero if it's in the y-domain, otherwise the
  // bottom of the plot area). Log axes always start at the bottom.
  const baselineY =
    yAxis.scale === "linear" && yAxis.domain[0] <= 0 && yAxis.domain[1] >= 0 ? yMap(0, yAxis.domain, [area.y1, area.y0]) : area.y1;

  // Step plot takes precedence over smooth (treppe with curves doesn't make
  // sense). Otherwise smooth is the default; explicit `smooth: false` opts out.
  const pathFn = opts.step
    ? (pts: Array<{ x: number; y: number }>) => stepPathD(pts, opts.step!)
    : opts.smooth === false
      ? linePathD
      : smoothPathD;

  opts.series.forEach((s, i) => {
    const finite = s.data.filter((p) => isOnAxis(xAxis, p.x) && isOnAxis(yAxis, p.y));
    if (opts.inspect)
      s.data.forEach((p, index) => {
        if (!isOnAxis(xAxis, p.x) || !isOnAxis(yAxis, p.y)) return;
        body.push(
          inspectionPoint(
            {
              index,
              seriesIndex: i,
              role: "point",
              label: s.label,
              anchor: [xMap(p.x, xAxis.domain, [area.x0, area.x1]), yMap(p.y, yAxis.domain, [area.y1, area.y0])],
              values: pointValues(p, opts.xAxis, opts.yAxis),
            },
            opts.inspect,
          ),
        );
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
        const lowerSegments = lowerReversed.map((pt) => ` L ${fmt(pt.x)} ${fmt(pt.y)}`).join("");
        const bandPath = `${upperPath}${lowerSegments} Z`;
        body.push(`<path class="stdlib-chart-error-band stdlib-chart-series-${i % 8}" d="${bandPath}"/>`);
      }
    }

    if (opts.area) {
      const last = mapped[mapped.length - 1]!;
      const first = mapped[0]!;
      const areaPath = `${linePath} L ${fmt(last.x)} ${fmt(baselineY)} L ${fmt(first.x)} ${fmt(baselineY)} Z`;
      body.push(`<path class="stdlib-chart-area stdlib-chart-series-${i % 8}" d="${areaPath}"/>`);
    }

    const dashStyle = s.lineStyle ?? (opts.autoVariant ? DEFAULT_LINE_STYLES[i % DEFAULT_LINE_STYLES.length]! : "solid");
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
  return svgRoot({ width, height, className: opts.className }, header.svg + body.join("") + legend.svg);
};
