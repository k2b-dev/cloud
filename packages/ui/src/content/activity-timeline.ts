import { dates } from "@k2b/stdlib";

/**
 * Time rules of `ActivityList`: pure, with `now` as an input, so the server, the first browser render, and tests
 * compute the same rows. Days count in `timeZone`.
 *
 * - **Dividers:** "Today", "Yesterday", and each day up to seven days back; everything older sits under one divider
 *   "More than a week ago".
 * - **Time:** under a day divider the time alone ("10:20"); under the older divider the day and time
 *   ("21 Oct, 14:31"; another year adds the year).
 * - **Distance:** "12 min. ago", "6 hr. ago", "1 day ago", "9 days ago", weeks from 14 days, months from 60 days,
 *   years from 365 days.
 * - **Bundles:** equal entries (one key) directly after each other on the same day become one row with a count; the
 *   newest one leads.
 */

/** How many days back still have a divider of their own. */
export const ACTIVITY_DAYS_WITH_DIVIDER = 7;

export type ActivityGroup = { kind: "today" | "yesterday" | "day"; day: string } | { kind: "older"; day: null };

const dayMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);
/** Whole calendar days from `day` back to `today` (both `YYYY-MM-DD`); negative in the future. */
const daysBack = (day: string, today: string): number => Math.round((dayMs(today) - dayMs(day)) / 86_400_000);

/** The calendar day (`YYYY-MM-DD`) of an instant in a time zone. */
export const activityDay = (at: string | Date, timeZone: string): string => dates.formatDateKey(at, { timeZone });

/** The divider an instant stands under. Instants in the future (the device clock) count as today. */
export const activityGroup = (at: string, now: Date, timeZone: string): ActivityGroup => {
  const day = activityDay(at, timeZone);
  const back = daysBack(day, activityDay(now, timeZone));
  if (back <= 0) return { kind: "today", day };
  if (back === 1) return { kind: "yesterday", day };
  if (back <= ACTIVITY_DAYS_WITH_DIVIDER) return { kind: "day", day };
  return { kind: "older", day: null };
};

export const sameActivityGroup = (a: ActivityGroup, b: ActivityGroup): boolean => a.kind === b.kind && a.day === b.day;

/** A day divider's label, such as "Fri, Nov 6" (de "Fr., 6. Nov."); another year adds the year. */
export const activityDayLabel = (day: string, now: Date, locale: string, timeZone: string): string =>
  new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(day.slice(0, 4) === activityDay(now, timeZone).slice(0, 4) ? {} : { year: "numeric" }),
    timeZone: "UTC",
  }).format(new Date(dayMs(day)));

/** A short calendar day: "Oct 21" in the year of `now`, otherwise with the year ("Mar 3, 2025"). */
const shortDay = (day: string, now: Date, locale: string, timeZone: string): string =>
  day.slice(0, 4) === activityDay(now, timeZone).slice(0, 4)
    ? new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(dayMs(day)))
    : dates.formatDate(day, { locale, timeZone: "UTC" });

/** The time of the meta line: within the last week the time alone, before that the day and time. */
export const activityWhen = (at: string, now: Date, locale: string, timeZone: string): string => {
  const time = dates.formatTime(at, { timeZone });
  if (activityGroup(at, now, timeZone).kind !== "older") return time;
  return `${shortDay(activityDay(at, timeZone), now, locale, timeZone)}, ${time}`;
};

/** The full instant for the tooltip, such as "Oct 21, 2026, 14:31". */
export const activityInstant = (at: string, locale: string, timeZone: string): string => dates.formatDateTime(at, { locale, timeZone });

/** Distance to now in the interface language ("6 hr. ago", de "vor 6 Std."); never "yesterday", never in the future. */
export const activityAgo = (at: string, now: Date, locale: string, timeZone: string): string => {
  const minutes = (now.getTime() - new Date(at).getTime()) / 60_000;
  const short = new Intl.RelativeTimeFormat(locale, { style: "short", numeric: "always" });
  const long = new Intl.RelativeTimeFormat(locale, { numeric: "always" });
  if (minutes < 60) return short.format(-Math.max(1, Math.round(minutes)), "minute");
  const days = daysBack(activityDay(at, timeZone), activityDay(now, timeZone));
  if (days <= 0) return short.format(-Math.floor(minutes / 60), "hour");
  if (days < 14) return long.format(-days, "day");
  if (days < 60) return long.format(-Math.floor(days / 7), "week");
  if (days < 365) return long.format(-Math.floor(days / 30), "month");
  return long.format(-Math.floor(days / 365), "year");
};

/** One row: the newest entry of a bundle, all entries of the bundle (newest first), and the divider before it (only on a group's first row). */
export type ActivityRow<T> = { entry: T; all: T[]; divider: ActivityGroup | null };

/**
 * Entries as rows: newest first (stable for equal times), equal entries after each other on the same day bundled
 * (`key`; `null` never bundles), dividers by day or "older".
 */
export const activityRows = <T extends { at: string }>(
  entries: readonly T[],
  input: { now: Date; timeZone: string; key?: (entry: T) => string | null },
): ActivityRow<T>[] => {
  const sorted = entries
    .map((entry, index) => ({ entry, index, ms: Date.parse(entry.at) }))
    .sort((a, b) => b.ms - a.ms || a.index - b.index);
  const rows: ActivityRow<T>[] = [];
  let previous: { key: string | null; day: string; group: ActivityGroup } | null = null;
  for (const { entry } of sorted) {
    const key = input.key?.(entry) ?? null;
    const day = activityDay(entry.at, input.timeZone);
    const group = activityGroup(entry.at, input.now, input.timeZone);
    const last = rows.at(-1);
    if (last && previous && key !== null && key === previous.key && day === previous.day) {
      last.all.push(entry);
      continue;
    }
    rows.push({ entry, all: [entry], divider: previous && sameActivityGroup(previous.group, group) ? null : group });
    previous = { key, day, group };
  }
  return rows;
};
