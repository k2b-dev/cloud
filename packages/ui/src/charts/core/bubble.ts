import { type ChartOptions, chartDatumSvg, escapeXml, renderHeader, svgRoot } from "./svg";

export type BubbleOptions = ChartOptions & {
  groups: string[];
  data: { label: string; group: string; x: number; y: number; size?: number }[];
  xLabel: string;
  yLabel: string;
  sizeLabel?: string;
  averages?: boolean;
  legend?: boolean;
  locale?: string;
  xFormat?: (value: number) => string;
  yFormat?: (value: number) => string;
  sizeFormat?: (value: number) => string;
  displayWidth?: number;
};
const palette = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#06b6d4", "#84cc16", "#f97316"];
const color = (index: number) => `var(--stdlib-chart-c${(index % 8) + 1},${palette[index % 8]})`;

export function bubbleLayout(spec: BubbleOptions, size = { width: spec.width ?? 480, height: spec.height ?? 280 }) {
  for (const p of spec.data) {
    if (![p.x, p.y].every(Number.isFinite) || (p.size !== undefined && (!Number.isFinite(p.size) || p.size < 0)))
      throw new RangeError("Bubble coordinates must be finite and sizes nonnegative.");
    if (!spec.groups.includes(p.group)) throw new RangeError("Bubble groups must contain every point group.");
  }
  const width = spec.displayWidth ?? size.width,
    height = size.height;
  const header = renderHeader(width, spec.title, spec.subtitle);
  const legend: { label: string; index: number; x: number; row: number }[] = [];
  let lx = 0,
    row = 0;
  if (spec.legend !== false)
    spec.groups.forEach((label, index) => {
      const space = Math.min(width, label.length * 12 + 28);
      if (lx && lx + space > width) {
        lx = 0;
        row++;
      }
      legend.push({ label, index, x: lx, row });
      lx += space;
    });
  const left = 48,
    right = width - 24,
    top = header.height + (spec.averages ? 72 : 20);
  const bottom = height - 36 - (legend.length ? (row + 1) * 20 : 0);
  const domain = (values: number[]) => {
    let lo = Math.min(0, ...values),
      hi = Math.max(0, ...values);
    if (!Number.isFinite(hi - lo)) throw new RangeError("Bubble coordinate ranges must be finite.");
    if (lo === hi) {
      lo = -1;
      hi = 1;
    }
    return [lo, hi] as const;
  };
  const xd = domain(spec.data.map((p) => p.x)),
    yd = domain(spec.data.map((p) => p.y));
  const physicalWidth = spec.displayWidth ?? Math.min(296, width),
    inverseX = width / physicalWidth;
  const maxRadius = Math.max(0, Math.min(21, physicalWidth / 20, (bottom - top - 4) / 2)),
    maxSize = Math.max(0, ...spec.data.map((p) => p.size ?? 0));
  const padding = Math.max(4.5, maxRadius) * inverseX + 2;
  const x = (value: number) => left + padding + ((value - xd[0]) / (xd[1] - xd[0])) * Math.max(0, right - left - padding * 2);
  const y = (value: number) => bottom - maxRadius - 2 - ((value - yd[0]) / (yd[1] - yd[0])) * Math.max(0, bottom - top - maxRadius * 2 - 4);
  const meanX = spec.data.reduce((sum, p) => sum + p.x / Math.max(1, spec.data.length), 0);
  const meanY = spec.data.reduce((sum, p) => sum + p.y / Math.max(1, spec.data.length), 0);
  const points = spec.data.map((p, index) => ({
    ...p,
    index,
    cx: x(p.x),
    cy: y(p.y),
    radius: p.size === undefined ? 4.5 : maxSize ? Math.sqrt(p.size / maxSize) * maxRadius : 0,
    labelBox: undefined as { x: number; y: number; width: number; height: number } | undefined,
  }));
  const placed: { x: number; y: number; width: number; height: number }[] = [];
  const overlap = (a: (typeof placed)[number], b: (typeof placed)[number]) =>
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  const boxes = points.map((p) => ({
    x: p.cx - p.radius * inverseX,
    y: p.cy - p.radius,
    width: p.radius * 2 * inverseX,
    height: p.radius * 2,
  }));
  for (const p of [...points].sort((a, b) => b.radius - a.radius || a.index - b.index)) {
    const box = { x: p.cx + (p.radius + 4) * inverseX, y: p.cy - 9, width: p.label.length * 12 * inverseX, height: 14 };
    if (
      box.x + box.width > right ||
      box.y < top ||
      box.y + box.height > bottom ||
      boxes.some((b, index) => index !== p.index && overlap(box, b)) ||
      placed.some((b) => overlap(box, b))
    )
      continue;
    p.labelBox = box;
    placed.push(box);
  }
  return { width, height, header, left, right, top, bottom, xd, yd, x, y, points, meanX, meanY, legend };
}

export function renderBubbleSvg(spec: BubbleOptions): string {
  const s = bubbleLayout(spec),
    locale = spec.locale ?? "en";
  const number = new Intl.NumberFormat(locale, { maximumSignificantDigits: 15 }).format;
  const xf = spec.xFormat ?? number,
    yf = spec.yFormat ?? number,
    sf = spec.sizeFormat ?? number;
  const compact = new Intl.NumberFormat(locale, { notation: "compact", maximumSignificantDigits: 3 }).format;
  const scientific = new Intl.NumberFormat(locale, { notation: "scientific", maximumSignificantDigits: 3 }).format;
  const tick = (v: number) => (v && (Math.abs(v) >= 1e12 || Math.abs(v) < 1e-6) ? scientific(v) : compact(v));
  const xt = spec.xFormat ?? tick,
    yt = spec.yFormat ?? tick;
  const text = "var(--k2b-text-muted,#45454e)",
    border = "var(--k2b-border,#e4e4e7)";
  const body = [
    s.header.svg
      .replace(/<text class="stdlib-chart-title"/g, '<text fill="var(--k2b-text,#27272a)" font-size="14" class="stdlib-chart-title"')
      .replace(
        /<text class="stdlib-chart-subtitle"/g,
        '<text fill="var(--k2b-text-muted,#45454e)" font-size="11" class="stdlib-chart-subtitle"',
      ),
  ];
  for (let i = 0; i <= 4; i++) {
    const xv = s.xd[0] + (s.xd[1] - s.xd[0]) * (i / 4),
      yv = s.yd[0] + (s.yd[1] - s.yd[0]) * (i / 4);
    body.push(
      `<line x1="${s.left}" x2="${s.right}" y1="${s.y(yv)}" y2="${s.y(yv)}" stroke="${border}"/><text x="${s.left - 7}" y="${s.y(yv) + 4}" text-anchor="end" font-size="10" fill="${text}">${escapeXml(yt(yv))}</text><text x="${s.x(xv)}" y="${s.bottom + 16}" text-anchor="middle" font-size="10" fill="${text}">${escapeXml(xt(xv))}</text>`,
    );
  }
  body.push(
    `<line class="stdlib-chart-axis" x1="${s.left}" x2="${s.left}" y1="${s.top}" y2="${s.bottom}" stroke="${border}"/><line class="stdlib-chart-axis" x1="${s.left}" x2="${s.right}" y1="${s.bottom}" y2="${s.bottom}" stroke="${border}"/><text x="${s.right}" y="${s.bottom + 30}" class="k2b-chart-bubble-x-title" text-anchor="end" font-size="11" fill="${text}">${escapeXml(spec.xLabel)} →</text><text x="${s.left}" y="${s.top - 7}" class="k2b-chart-bubble-y-title" font-size="11" fill="${text}">↑ ${escapeXml(spec.yLabel)}</text>`,
  );
  if (spec.averages) {
    const label = locale.startsWith("de") ? "Ungewichteter Durchschnitt" : "Unweighted average";
    body.push(
      `<line class="k2b-chart-average" x1="${s.x(s.meanX)}" x2="${s.x(s.meanX)}" y1="${s.top}" y2="${s.bottom}" stroke="${text}" stroke-dasharray="4 4"/><line class="k2b-chart-average" x1="${s.left}" x2="${s.right}" y1="${s.y(s.meanY)}" y2="${s.y(s.meanY)}" stroke="${text}" stroke-dasharray="4 4"/><text x="${s.left}" y="${s.header.height + 11}" class="k2b-chart-bubble-average-label" font-size="11" fill="${text}">${label}<title>X: ${escapeXml(xf(s.meanX))} · Y: ${escapeXml(yf(s.meanY))}</title></text><text x="${s.left}" y="${s.header.height + 25}" class="k2b-chart-bubble-average-value" font-size="11" fill="${text}">X: ${escapeXml(xf(s.meanX))} · Y: ${escapeXml(yf(s.meanY))}</text>`,
    );
  }
  for (const p of [...s.points].sort((a, b) => b.radius - a.radius || a.index - b.index)) {
    const paint = color(spec.groups.indexOf(p.group));
    body.push(
      chartDatumSvg(
        `<circle cx="${p.cx}" cy="${p.cy}" r="${p.radius}" fill="${paint}" fill-opacity="0.62" stroke="${paint}" stroke-width="1.2"/>${p.labelBox ? `<text class="k2b-chart-bubble-label" x="${p.labelBox.x}" y="${p.cy + 4}" font-size="11.5" fill="${text}" pointer-events="none">${escapeXml(p.label)}</text>` : ""}`,
        {
          role: "point",
          index: p.index,
          label: p.label,
          anchor: [p.cx, p.cy],
          values: [
            { key: "group", value: p.group },
            { key: "x", value: p.x, formatted: xf(p.x) },
            { key: "y", value: p.y, formatted: yf(p.y) },
            ...(p.size === undefined ? [] : [{ key: "size", value: p.size, formatted: sf(p.size) }]),
          ],
        },
        spec.inspect,
      ),
    );
  }
  for (const item of s.legend)
    body.push(
      `<rect x="${item.x}" y="${s.height - (s.legend.at(-1)!.row - item.row) * 20 - 14}" width="8" height="8" rx="2" fill="${color(item.index)}"/><text x="${item.x + 13}" y="${s.height - (s.legend.at(-1)!.row - item.row) * 20 - 6}" font-size="11" fill="${text}">${escapeXml(item.label.slice(0, Math.floor((s.width - 28) / 12)))}</text>`,
    );
  return svgRoot({ ...s, className: spec.className }, body.join(""));
}
