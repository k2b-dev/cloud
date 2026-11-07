import { type ChartOptions, chartDatumSvg, escapeXml, type HeatmapOptions, heatmap, svgRoot } from "./svg";
export type CalendarHeatmapOptions = ChartOptions & {
  layout: "calendar";
  data: [string, number][];
  scale: "sequential" | "diverging";
  locale?: string;
  format?: (value: number) => string;
  displayWidth?: number;
};
export type HeatmapChartOptions = (HeatmapOptions & { layout?: undefined }) | CalendarHeatmapOptions;
const DAY = 86400000;
/** Strict ISO calendar days, with no local timezone or rollover. */
export function calendarDay(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RangeError("Calendar dates must be YYYY-MM-DD.");
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new RangeError("Invalid calendar date.");
  return date.getTime();
}
export function calendarLayout(spec: CalendarHeatmapOptions, size = { width: spec.width ?? 480, height: spec.height ?? 280 }) {
  const seen = new Set<string>();
  const points = spec.data
    .map(([date, value], index) => {
      if (seen.has(date)) throw new RangeError("Calendar dates must be unique.");
      seen.add(date);
      if (!Number.isFinite(value)) throw new RangeError("Calendar values must be finite.");
      return { date, value, index, time: calendarDay(date) };
    })
    .sort((a, b) => a.time - b.time);
  const first = points[0]?.time ?? 0;
  const monday = first - ((new Date(first).getUTCDay() + 6) % 7) * DAY;
  const weeks = points.length ? Math.floor((points.at(-1)!.time - monday) / DAY / 7) + 1 : 0;
  const left = 28,
    top = 22,
    gap = 3,
    minWidth = left + weeks * 15;
  const width = Math.max(spec.displayWidth ?? size.width, minWidth);
  const cellHeight = Math.max(9, Math.floor((size.height - top - 4 - gap * 6) / 7));
  const fit = weeks ? (width - left) / weeks - gap : 12;
  const cell = Math.max(9, Math.min(cellHeight, Math.max(12, fit)));
  const cellWidth = Math.max(cell, Math.min(cell * 2.4, fit));
  const min = Math.min(0, ...points.map((p) => p.value)),
    max = Math.max(0, ...points.map((p) => p.value));
  const absMax = Math.max(-min, max);
  return {
    width,
    height: size.height,
    minWidth,
    firstMonday: monday,
    weeks,
    min,
    max,
    absMax,
    cell,
    cellWidth,
    cells: points.map((p) => {
      const day = Math.round((p.time - monday) / DAY);
      const week = Math.floor(day / 7),
        weekday = day % 7;
      const intensity = spec.scale === "diverging" ? Math.abs(p.value) / (absMax || 1) : (p.value - min) / (max - min || 1);
      const color =
        spec.scale === "diverging"
          ? p.value < 0
            ? "var(--k2b-flow-out-mark,#8b5cf6)"
            : "var(--k2b-flow-in-mark,#0891b2)"
          : "var(--stdlib-chart-c1,#3b82f6)";
      return { ...p, week, weekday, x: left + week * (cellWidth + gap), y: top + weekday * (cell + gap), intensity, color };
    }),
  };
}
export function renderCalendarSvg(spec: CalendarHeatmapOptions): string {
  const s = calendarLayout(spec);
  const locale = spec.locale ?? "en";
  const number = spec.format ?? new Intl.NumberFormat(locale, { maximumSignificantDigits: 15 }).format;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "full", timeZone: "UTC" });
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  const month = new Intl.DateTimeFormat(locale, { month: "short", year: "numeric", timeZone: "UTC" });
  const body: string[] = [];
  for (const day of [0, 2, 4])
    body.push(
      `<text x="0" y="${22 + day * (s.cell + 3) + s.cell - 2}" fill="var(--k2b-text-muted,#45454e)" font-size="11">${escapeXml(weekday.format(Date.UTC(2026, 0, 5 + day)))}</text>`,
    );
  let lastLabel = -Infinity,
    lastMonth = "";
  for (const c of s.cells) {
    const ym = c.date.slice(0, 7);
    if (ym !== lastMonth && c.x - lastLabel > 75) {
      body.push(`<text x="${c.x}" y="12" font-size="11" fill="var(--k2b-text-muted,#45454e)">${escapeXml(month.format(c.time))}</text>`);
      lastLabel = c.x;
      lastMonth = ym;
    }
    const fill =
      c.value === 0
        ? "var(--k2b-surface-muted,#f4f4f5)"
        : `color-mix(in srgb,${c.color} ${12 + 88 * Math.sqrt(c.intensity)}%,var(--k2b-surface-muted,#f4f4f5))`;
    body.push(
      chartDatumSvg(
        `<rect x="${c.x}" y="${c.y}" width="${s.cellWidth}" height="${s.cell}" rx="2" fill="${fill}" stroke="none"/>`,
        {
          role: "cell",
          index: c.index,
          label: date.format(c.time),
          anchor: [c.x + s.cellWidth / 2, c.y + s.cell / 2],
          grid: [c.week, c.weekday],
          values: [{ key: "value", value: c.value, formatted: number(c.value) }],
        },
        spec.inspect,
      ),
    );
  }
  // Trailing unobserved days are outlines, never zero-valued observations.
  const last = s.cells.at(-1);
  if (last)
    for (let day = last.weekday + 1; day < 7; day++)
      body.push(
        `<rect x="${last.x + 0.5}" y="${22 + day * (s.cell + 3) + 0.5}" width="${s.cellWidth - 1}" height="${s.cell - 1}" rx="2" fill="none" stroke="var(--k2b-border,#e4e4e7)"/>`,
      );
  return svgRoot({ ...s, className: spec.className }, body.join("")).replace(
    "<svg ",
    `<svg data-calendar="true" data-chart-scroll="end" data-chart-min-width="${s.minWidth}" `,
  );
}
export const renderHeatmapSvg = (spec: HeatmapChartOptions): string =>
  spec.layout === "calendar" ? renderCalendarSvg(spec) : heatmap(spec);
