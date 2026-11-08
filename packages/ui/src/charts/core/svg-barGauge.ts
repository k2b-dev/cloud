// Ported SVG algorithm, kept verbatim; separate module for per-kind frame loading.
import {
  type BarGaugeOptions,
  chartDatumSvg,
  clamp,
  escapeXml,
  fmt,
  formatNumberValue,
  normalizeMinMax,
  renderHeader,
  svgRoot,
  thresholdFillAttr,
  thresholdForIndex,
  thresholdIndexForValue,
} from "./svg-renderers";
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
