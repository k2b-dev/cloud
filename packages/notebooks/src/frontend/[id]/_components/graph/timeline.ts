import type { GraphNote } from "./model";

/** Invalid change dates stay at the end in either direction; ties retain notebook order. */
export function sortByChange(notes: readonly GraphNote[], direction: "asc" | "desc"): GraphNote[] {
  return notes.toSorted((a, b) => {
    const left = Date.parse(a.updatedAt);
    const right = Date.parse(b.updatedAt);
    if (Number.isNaN(left) || Number.isNaN(right)) {
      return Number.isNaN(left) === Number.isNaN(right) ? a.order - b.order : Number.isNaN(left) ? 1 : -1;
    }
    return (direction === "desc" ? right - left : left - right) || a.order - b.order;
  });
}
export const timelineOrder = (notes: readonly GraphNote[]): GraphNote[] => sortByChange(notes, "desc");

export type TimelineGroup = { key: string; year: number; notes: GraphNote[] } & (
  | { kind: "today" | "yesterday" | "thisWeek" | "lastWeek" | "year" }
  | { kind: "month"; month: number }
);

const dayFormatters = new Map<string, Intl.DateTimeFormat>();
const DAY = 86_400_000;
function calendarDay(value: string, timeZone: string) {
  let formatter = dayFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "numeric", day: "numeric" });
    dayFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)!.value);
  const year = part("year");
  const month = part("month");
  return { year, month, day: Date.UTC(year, month - 1, part("day")) / DAY };
}

/** Calendar days, rather than elapsed hours, keep week groups correct across DST changes. */
export function timelineGroups(notes: readonly GraphNote[], options: { now: string; timeZone: string }): TimelineGroup[] {
  const today = calendarDay(options.now, options.timeZone);
  // 1970-01-01 was a Thursday: Monday is index zero.
  const monday = today.day - ((((today.day + 3) % 7) + 7) % 7);
  const groups = new Map<string, TimelineGroup>();
  for (const note of timelineOrder(notes)) {
    const date = calendarDay(note.updatedAt, options.timeZone);
    const kind =
      date.day >= today.day
        ? "today"
        : date.day === today.day - 1
          ? "yesterday"
          : date.day >= monday
            ? "thisWeek"
            : date.day >= monday - 7
              ? "lastWeek"
              : date.year === today.year
                ? "month"
                : "year";
    const key =
      kind === "month" ? `month-${date.year}-${String(date.month).padStart(2, "0")}` : kind === "year" ? `year-${date.year}` : kind;
    const group = groups.get(key);
    if (group) group.notes.push(note);
    else
      groups.set(
        key,
        kind === "month" ? { key, kind, month: date.month, year: date.year, notes: [note] } : { key, kind, year: date.year, notes: [note] },
      );
  }
  return [...groups.values()];
}

export function timelineGroupLabel(
  group: TimelineGroup,
  options: { locale: string; timeZone: string; labels: Record<"today" | "yesterday" | "thisWeek" | "lastWeek", string> },
): string {
  if (group.kind === "year") return String(group.year);
  if (group.kind === "month") {
    // A date in the middle of the month stays in that month in every IANA zone.
    return new Intl.DateTimeFormat(options.locale, { timeZone: options.timeZone, month: "long" }).format(
      new Date(Date.UTC(group.year, group.month - 1, 15)),
    );
  }
  return options.labels[group.kind];
}

/** An arc bows left of the dots by at most `lane - 8`, so even links across the whole notebook stay inside the lane. */
export const timelineArcWidth = (dy: number, lane: number): number => Math.min(lane - 8, 10 + Math.abs(dy) * 0.45);
const RECIPROCAL_INSET = 5;
/**
 * Two notes that link to each other would get the same curve twice, so the solid outgoing arc would hide the dashed
 * incoming one. The upward arc of such a pair bows a little less, staying inside the other.
 */
export function timelineArc(x: number, y1: number, y2: number, lane: number, reciprocal = false): string {
  const w = timelineArcWidth(y2 - y1, lane) - (reciprocal && y1 > y2 ? Math.min(RECIPROCAL_INSET, timelineArcWidth(0, lane) / 2) : 0);
  const f = (n: number) => n.toFixed(1);
  return `M ${f(x)},${f(y1)} C ${f(x - w)},${f(y1)} ${f(x - w)},${f(y2)} ${f(x)},${f(y2)}`;
}
