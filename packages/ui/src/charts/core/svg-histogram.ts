// Ported SVG algorithm, kept verbatim; separate module for per-kind frame loading.
import {
  autoBin,
  chartDatumSvg,
  computeAxisScale,
  computePlotArea,
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  emptyChart,
  fmt,
  type HistogramOptions,
  normalizePadding,
  pickMapper,
  renderHeader,
  renderReferenceLines,
  renderXAxisNumeric,
  renderYAxis,
  svgRoot,
} from "./svg-renderers";
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
