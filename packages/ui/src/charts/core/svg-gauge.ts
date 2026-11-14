// Ported SVG algorithm, kept verbatim; separate module for per-kind frame loading.
import {
  chartDatumSvg,
  clamp,
  escapeXml,
  fmt,
  formatNumberValue,
  type GaugeOptions,
  mapRange,
  normalizeMinMax,
  type RgbColor,
  svgRoot,
  type Threshold,
  thresholdForIndex,
  thresholdIndexForValue,
  thresholdStrokeAttr,
} from "./svg-common";

const polarPoint = (cx: number, cy: number, r: number, angleRad: number) => ({
  x: cx + r * Math.cos(angleRad),
  y: cy + r * Math.sin(angleRad),
});

const arcLinePathD = (cx: number, cy: number, r: number, a0: number, a1: number): string => {
  const start = polarPoint(cx, cy, r, a0);
  const end = polarPoint(cx, cy, r, a1);
  const large = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
  const sweep = a1 >= a0 ? 1 : 0;
  return `M ${fmt(start.x)} ${fmt(start.y)} A ${fmt(r)} ${fmt(r)} 0 ${large} ${sweep} ${fmt(end.x)} ${fmt(end.y)}`;
};

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
  `#${[color.r, color.g, color.b].map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0")).join("")}`;

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

const gaugeColorAt = (stops: readonly { value: number; color: string }[], value: number): string => {
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
    parts.push(`<path class="${opts.className}" stroke="${escapeXml(color)}" d="${arcLinePathD(opts.cx, opts.cy, opts.radius, a0, a1)}"/>`);
  }
  return parts.join("");
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
