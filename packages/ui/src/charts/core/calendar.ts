import { type ChartOptions, chartDatumSvg, escapeXml, type HeatmapOptions, heatmap, renderHeader, svgRoot } from "./svg";
export type CalendarHeatmapOptions = ChartOptions & {
  layout: "calendar";
  data: [string, number | null][];
  scale: "sequential" | "diverging";
  /** Unit shown beside each tooltip value. */
  label?: string;
  locale?: string;
  format?: (value: number) => string;
  displayWidth?: number;
};
export type HeatmapChartOptions = (HeatmapOptions & { layout?: undefined }) | CalendarHeatmapOptions;
const DAY = 86400000;
/** Bound sparse inputs too: three leap years of daily observations. */
export const CALENDAR_MAX_DAYS = 1098;
export function calendarDay(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RangeError("Calendar dates must be YYYY-MM-DD.");
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new RangeError("Invalid calendar date.");
  return date.getTime();
}
/** Intl uses 1..7, JS dates use 0..6. Older engines fall back to Monday. */
export function calendarWeekStart(locale = "en"): number {
  const info: Intl.Locale & { weekInfo?: { firstDay: number }; getWeekInfo?: () => { firstDay: number } } = new Intl.Locale(locale);
  return (info.getWeekInfo?.().firstDay ?? info.weekInfo?.firstDay ?? 1) % 7;
}
export const calendarWords = (locale = "en") =>
  locale.split("-")[0] === "de"
    ? { day: "Tag", less: "weniger", more: "mehr", moreIn: "mehr rein", moreOut: "mehr raus" }
    : { day: "Day", less: "less", more: "more", moreIn: "more in", moreOut: "more out" };
export function calendarLayout(spec: CalendarHeatmapOptions, size = { width: spec.width ?? 480, height: spec.height ?? 280 }) {
  const seen = new Set<string>();
  const dates = spec.data
    .map(([date, value], index) => {
      if (seen.has(date)) throw new RangeError("Calendar dates must be unique.");
      seen.add(date);
      const time = calendarDay(date);
      if (value !== null && !Number.isNaN(value) && !Number.isFinite(value)) throw new RangeError("Calendar values must be finite.");
      return { date, value, index, time };
    })
    .sort((a, b) => a.time - b.time);
  if (dates.length && (dates.at(-1)!.time - dates[0]!.time) / DAY >= CALENDAR_MAX_DAYS)
    throw new RangeError("Calendar span must not exceed three years.");
  const points = dates.filter((p): p is typeof p & { value: number } => p.value !== null && Number.isFinite(p.value));
  const weekStart = calendarWeekStart(spec.locale);
  const first = dates[0]?.time ?? 0;
  const monday = first - ((new Date(first).getUTCDay() - weekStart + 7) % 7) * DAY;
  const weeks = dates.length ? Math.floor((dates.at(-1)!.time - monday) / DAY / 7) + 1 : 0;
  const headerHeight = renderHeader(size.width, spec.title, spec.subtitle).height;
  // Seven square rows use the available panel height. Wider calendars scroll rather than flattening their cells.
  const cell = Math.max(14, Math.floor((size.height - headerHeight - 22 - 20 - 18) / 7)),
    gap = 3,
    left = 32;
  const width = Math.max(spec.displayWidth ?? size.width, left + weeks * (cell + gap) + 4);
  const top = 22 + renderHeader(width, spec.title, spec.subtitle).height;
  const min = Math.min(...points.map((p) => p.value), 0),
    max = Math.max(...points.map((p) => p.value), 0);
  const absMax = Math.max(-min, max);
  return {
    width,
    height: size.height,
    minWidth: width,
    firstMonday: monday,
    weekStart,
    weeks,
    min,
    max,
    absMax,
    cell,
    cellWidth: cell,
    top,
    cells: points.map((p) => {
      const day = Math.round((p.time - monday) / DAY),
        week = Math.floor(day / 7),
        weekday = day % 7;
      const intensity = spec.scale === "diverging" ? Math.abs(p.value) / (absMax || 1) : (p.value - min) / (max - min || 1);
      const color =
        spec.scale === "diverging"
          ? p.value < 0
            ? "var(--k2b-flow-out-mark,#8b5cf6)"
            : "var(--k2b-flow-in-mark,#0891b2)"
          : "var(--stdlib-chart-c1,#3b82f6)";
      return { ...p, week, weekday, x: left + week * (cell + gap), y: top + weekday * (cell + gap), intensity, color };
    }),
  };
}
const paint = (color: string, intensity: number) =>
  `color-mix(in srgb,${color} ${12 + 88 * Math.sqrt(intensity)}%,var(--k2b-surface-muted,#f4f4f5))`;
export function renderCalendarSvg(spec: CalendarHeatmapOptions): string {
  const s = calendarLayout(spec),
    locale = spec.locale ?? "en",
    words = calendarWords(locale);
  const number = spec.format ?? new Intl.NumberFormat(locale, { maximumSignificantDigits: 15 }).format;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "full", timeZone: "UTC" });
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  const month = new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" });
  // Left aligned direct-core header; interactive hosts keep it at the visible scroll edge.
  const header = renderHeader(s.width, spec.title, spec.subtitle)
    .svg.replace(/x="[^"]*"/g, 'x="0"')
    .replace(/text-anchor="middle"/g, 'text-anchor="start"')
    .replace(/<text /g, '<text fill="var(--k2b-text,#27272a)" font-size="12" ');
  const body: string[] = [`<g data-calendar-header="true" style="transform:translateX(var(--k2b-calendar-header-x,0px))">${header}</g>`];
  const days: string[] = [
    `<g data-calendar-weekdays="true" pointer-events="none" style="transform:translateX(var(--k2b-calendar-header-x,0px))"><rect x="-1" y="${s.top - 18}" width="33" height="${7 * (s.cell + 3) + 18}" fill="var(--k2b-surface,#fff)"/>`,
  ];
  for (const day of [0, 2, 4])
    days.push(
      `<text x="0" y="${s.top + day * (s.cell + 3) + s.cell - 2}" fill="var(--k2b-text-muted,#45454e)" font-size="11">${escapeXml(weekday.format(Date.UTC(2026, 0, 4 + s.weekStart + day)))}</text>`,
    );
  let lastRight = -Infinity,
    lastMonth = "";
  for (let week = 0; week < s.weeks; week++) {
    const time = s.firstMonday + week * 7 * DAY,
      next = time + 6 * DAY;
    const nextDate = new Date(next),
      ym = nextDate.toISOString().slice(0, 7);
    if (ym === lastMonth) continue;
    const firstLabel = lastMonth === "";
    lastMonth = ym;
    const text = `${month.format(next)}${firstLabel || nextDate.getUTCMonth() === 0 ? ` ${nextDate.getUTCFullYear()}` : ""}`;
    const textWidth = text.length * 7;
    const x = Math.max(32, Math.min(32 + week * (s.cell + 3), s.width - textWidth - 2));
    if (x < lastRight + 2) continue;
    body.push(
      `<text data-calendar-month="${week}" style="visibility:var(--k2b-calendar-month-${week},visible)" x="${x}" y="${s.top - 10}" textLength="${textWidth}" lengthAdjust="spacingAndGlyphs" font-size="11" fill="var(--k2b-text-muted,#45454e)">${escapeXml(text)}</text>`,
    );
    lastRight = x + textWidth;
  }
  for (const c of s.cells) {
    const fill = spec.scale === "diverging" && c.value === 0 ? "var(--k2b-surface-muted,#f4f4f5)" : paint(c.color, c.intensity);
    const value =
      spec.scale === "diverging" && c.value !== 0
        ? `${number(Math.abs(c.value))} ${c.value < 0 ? words.moreOut : words.moreIn}`
        : number(c.value);
    body.push(
      chartDatumSvg(
        `<rect x="${c.x}" y="${c.y}" width="${s.cell}" height="${s.cell}" rx="2" fill="${fill}" stroke="none"/>`,
        {
          role: "cell",
          index: c.index,
          label: date.format(c.time),
          anchor: [c.x + s.cell / 2, c.y + s.cell / 2],
          grid: [c.week, c.weekday],
          values: [{ key: "value", value: c.value, formatted: value }],
        },
        spec.inspect,
      ),
    );
  }
  days.push("</g>");
  body.push(days.join(""));
  const legendY = s.top + 7 * (s.cell + 3) + 12;
  const start = spec.scale === "diverging" ? words.moreOut : words.less,
    end = spec.scale === "diverging" ? words.moreIn : words.more;
  const swatches = spec.scale === "diverging" ? [-1, -0.5, 0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];
  const offset = 32 + start.length * 6 + 8;
  body.push(
    `<g data-calendar-legend="true" style="transform:translateX(var(--k2b-calendar-header-x,0px))"><text x="32" y="${legendY}" fill="var(--k2b-text-muted,#45454e)" font-size="11">${escapeXml(start)}</text>`,
  );
  swatches.forEach((v, i) => {
    const color =
      spec.scale === "diverging"
        ? v < 0
          ? "var(--k2b-flow-out-mark,#8b5cf6)"
          : "var(--k2b-flow-in-mark,#0891b2)"
        : "var(--stdlib-chart-c1,#3b82f6)";
    body.push(
      `<rect x="${offset + i * 14}" y="${legendY - 10}" width="11" height="11" rx="2" fill="${spec.scale === "diverging" && v === 0 ? "var(--k2b-surface-muted,#f4f4f5)" : paint(color, Math.abs(v))}"/>`,
    );
  });
  body.push(
    `<text x="${offset + swatches.length * 14 + 4}" y="${legendY}" fill="var(--k2b-text-muted,#45454e)" font-size="11">${escapeXml(end)}</text></g>`,
  );
  return svgRoot({ ...s, className: spec.className }, body.join("")).replace(
    "<svg ",
    `<svg data-calendar="true" data-chart-scroll="end" data-chart-min-width="${s.minWidth}" `,
  );
}
export const renderHeatmapSvg = (spec: HeatmapChartOptions): string =>
  spec.layout === "calendar" ? renderCalendarSvg(spec) : heatmap(spec);
