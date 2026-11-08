// Ported SVG algorithm, kept verbatim; separate module for per-kind frame loading.
import {
  chartDatumSvg,
  clamp,
  computeDomain,
  computePlotArea,
  escapeXml,
  fmt,
  type HeatmapOptions,
  mapRange,
  normalizePadding,
  renderHeader,
  svgRoot,
} from "./svg-renderers";
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
