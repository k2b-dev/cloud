import { type ChartOptions, type HeatmapOptions, renderHeader } from "./svg-common";

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
export const DAY = 86400000;
/** Bound sparse inputs too: three leap years of daily observations. */
export const CALENDAR_MAX_DAYS = 1098;
export function calendarDay(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RangeError("Calendar dates must be YYYY-MM-DD.");
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new RangeError("Invalid calendar date.");
  return date.getTime();
}
/** Intl uses 1..7, JS dates use 0..6. Old engines use an explicit locale fallback. */
export function calendarWeekStart(locale = "en"): number {
  const info: Intl.Locale & { weekInfo?: { firstDay: number }; getWeekInfo?: () => { firstDay: number } } = new Intl.Locale(locale);
  const fallback: Record<string, number> = { "en-US": 0 };
  const key = `${info.language}-${info.region ?? info.maximize().region}`;
  return (info.getWeekInfo?.().firstDay ?? info.weekInfo?.firstDay ?? fallback[key] ?? 1) % 7;
}
export const calendarWords = (locale = "en") =>
  locale.split("-")[0] === "de"
    ? { day: "Tag", less: "weniger", more: "mehr", moreIn: "mehr rein", moreOut: "mehr raus" }
    : { day: "Day", less: "less", more: "more", moreIn: "more in", moreOut: "more out" };
export const calendarColor = (scale: CalendarHeatmapOptions["scale"], value: number) =>
  scale === "diverging"
    ? value < 0
      ? "var(--k2b-flow-out-mark,#8b5cf6)"
      : "var(--k2b-flow-in-mark,#0891b2)"
    : "var(--stdlib-chart-c1,#3b82f6)";
export const pixels = (value: number) => `${+value.toPrecision(6)}px`;
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
  // A minimum-size coordinate space scales uniformly in CSS, including on the
  // first server frame. Height follows the seven rows, never a host's fixed box.
  const gap = 3,
    left = 32;
  const cell = Math.max(14, Math.min(32, Math.floor(((spec.displayWidth ?? size.width) - left - 4) / Math.max(1, weeks) - gap)));
  const width = Math.max(240, left + weeks * (cell + gap) + 4);
  const top = 32 + renderHeader(width, spec.title, spec.subtitle).height;
  const min = Math.min(...points.map((p) => p.value), 0),
    max = Math.max(...points.map((p) => p.value), 0);
  const absMax = Math.max(-min, max);
  return {
    width,
    height: top + 7 * (cell + gap) + 18,
    minWidth: Math.max(240, (width * 14) / cell),
    maxWidth: (width * 32) / cell,
    firstMonday: monday,
    lastDay: dates.at(-1)?.time ?? first,
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
      const color = calendarColor(spec.scale, p.value);
      return { ...p, week, weekday, x: left + week * (cell + gap), y: top + weekday * (cell + gap), intensity, color };
    }),
  };
}
/** A calendar viewport reserves the same content height in every request state. */
export function calendarViewportHeight(
  size: { width: number; height: number; minWidth: number; maxWidth: number },
  availableWidth = "100cqw",
): string {
  return `calc(16px + (${size.height / size.width} * clamp(${pixels(size.minWidth)}, ${availableWidth}, ${pixels(size.maxWidth)})))`;
}
