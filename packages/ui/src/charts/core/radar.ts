import { type ChartOptions, chartDatumSvg, escapeXml, renderHeader, svgRoot } from "./svg";
export type RadarOptions = ChartOptions & {
  axes: string[];
  max: number;
  unit?: string;
  series: { label: string; data: number[] }[];
  legend?: boolean;
  locale?: string;
  format?: (value: number) => string;
  displayWidth?: number;
};
const palette = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6"];
const color = (index: number) => `var(--stdlib-chart-c${index + 1},${palette[index]})`;
export function radarLayout(spec: RadarOptions, size = { width: spec.width ?? 480, height: spec.height ?? 280 }) {
  if (spec.axes.length < 3 || spec.axes.length > 8 || !Number.isFinite(spec.max) || spec.max <= 0 || spec.series.length > 4)
    throw new RangeError("Radar needs 3 to 8 axes, at most 4 series and one positive maximum.");
  for (const series of spec.series)
    if (series.data.length !== spec.axes.length || series.data.some((value) => !Number.isFinite(value) || value < 0 || value > spec.max))
      throw new RangeError("Radar series need one value per axis, between zero and the common maximum.");
  const width = spec.displayWidth ?? Math.min(size.width, 296),
    height = size.height,
    header = renderHeader(width, spec.title, spec.subtitle);
  const legend: { label: string; index: number; x: number; row: number }[] = [];
  let lx = 0,
    row = 0;
  if (spec.legend !== false)
    spec.series.forEach((series, index) => {
      const space = Math.min(width, series.label.length * 12 + 28);
      if (lx && lx + space > width) {
        lx = 0;
        row++;
      }
      legend.push({ label: series.label, index, x: lx, row });
      lx += space;
    });
  const bottom = legend.length ? (row + 1) * 20 + 4 : 4,
    plotHeight = height - header.height - bottom,
    cx = width / 2,
    cy = header.height + plotHeight / 2;
  const labelRoom =
    Math.min(
      width * 0.28,
      Math.max(
        0,
        ...spec.axes.map((label, index) =>
          Math.abs(Math.cos(-Math.PI / 2 + (index * Math.PI * 2) / spec.axes.length)) > 0.2 ? label.length * 7 : 0,
        ),
      ),
    ) + 18;
  const radius = Math.max(0, Math.min(width / 2 - labelRoom, plotHeight / 2 - 24));
  const point = (axis: number, value: number) => {
    const angle = -Math.PI / 2 + (axis * Math.PI * 2) / spec.axes.length;
    return [cx + Math.cos(angle) * radius * (value / spec.max), cy + Math.sin(angle) * radius * (value / spec.max)] as [number, number];
  };
  const axes = spec.axes.map((label, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / spec.axes.length,
      c = Math.cos(angle),
      x = cx + (radius + 12) * c,
      y = cy + (radius + 12) * Math.sin(angle) + 4,
      anchor = Math.abs(c) < 0.2 ? "middle" : c > 0 ? "start" : "end";
    const room = anchor === "middle" ? width - 16 : anchor === "start" ? width - x - 6 : x - 6;
    const length = Math.max(1, Math.floor(room / 7));
    return {
      label,
      index,
      x,
      y,
      anchor,
      text: label.length > length ? label.slice(0, Math.max(1, length - 1)) + "…" : label,
      end: point(index, spec.max),
      points: spec.series.map((series) => point(index, series.data[index]!)),
    };
  });
  return { width, height, header, cx, cy, radius, axes, point, legend, bottom };
}
export function renderRadarSvg(spec: RadarOptions): string {
  const s = radarLayout(spec),
    number = spec.format ?? new Intl.NumberFormat(spec.locale ?? "en", { maximumSignificantDigits: 15 }).format;
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
  for (let ring = 1; ring <= 4; ring++)
    body.push(
      `<polygon points="${s.axes.map((axis) => s.point(axis.index, spec.max * (ring / 4)).join(",")).join(" ")}" fill="none" stroke="${border}"/>`,
    );
  for (const axis of s.axes)
    body.push(
      `<line x1="${s.cx}" y1="${s.cy}" x2="${axis.end[0]}" y2="${axis.end[1]}" stroke="${border}"/><text class="k2b-chart-radar-label" x="${axis.x}" y="${axis.y}" text-anchor="${axis.anchor}" font-size="12" fill="${text}">${escapeXml(axis.text)}</text>`,
    );
  body.push(
    `<text x="${s.cx + 5}" y="${s.cy - s.radius + 13}" font-size="10" fill="${text}">${escapeXml(number(spec.max))}${spec.unit ? " " + escapeXml(spec.unit) : ""}</text>`,
  );
  spec.series.forEach((series, index) =>
    body.push(
      `<polygon points="${series.data.map((value, axis) => s.point(axis, value).join(",")).join(" ")}" fill="${color(index)}" fill-opacity="0.18" stroke="${color(index)}" stroke-width="2" stroke-linejoin="round"/>`,
    ),
  );
  for (const axis of s.axes)
    body.push(
      chartDatumSvg(
        axis.points
          .map((point, index) => `<circle cx="${point[0]}" cy="${point[1]}" r="3" fill="${color(index)}" stroke="none"/>`)
          .join("") +
          `<path class="k2b-chart-category-band k2b-chart-radar-axis" d="M${s.cx},${s.cy}L${axis.end[0]},${axis.end[1]}" fill="none" stroke="transparent" stroke-width="16"/>`,
        {
          role: "item",
          index: axis.index,
          label: axis.label,
          anchor: axis.end,
          values: spec.series.map((series, index) => ({
            key: `series:${index}`,
            value: series.data[axis.index]!,
            formatted: `${number(series.data[axis.index]!)} / ${number(spec.max)}${spec.unit ? " " + spec.unit : ""}`,
          })),
        },
        spec.inspect,
      ),
    );
  for (const item of s.legend)
    body.push(
      `<rect x="${item.x}" y="${s.height - (s.legend.at(-1)!.row - item.row) * 20 - 14}" width="8" height="8" rx="2" fill="${color(item.index)}"/><text x="${item.x + 13}" y="${s.height - (s.legend.at(-1)!.row - item.row) * 20 - 6}" font-size="11" fill="${text}">${escapeXml(item.label.slice(0, Math.floor((s.width - 28) / 12)))}</text>`,
    );
  return svgRoot({ ...s, className: spec.className }, body.join(""));
}
