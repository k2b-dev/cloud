import { sql } from "@k2b/cloud";

/** How many days a per-day count looks back, today included: the hero trends of Mail administration. */
export const PER_DAY_WINDOW = 30;

/** One calendar day of a per-day count, in the request's time zone. */
export type DayCount = { day: string; count: number };

/** A time zone PostgreSQL and `Intl` both read; an unknown one counts in UTC instead of failing the page. */
export const countingTimeZone = (timeZone: string | undefined): string => {
  if (!timeZone) return "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
};

/** The calendar day of `at` in `timeZone`, as `YYYY-MM-DD`. */
const dayOf = (at: Date, timeZone: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

/**
 * The window's days from the oldest to today, each with its count: days without a row count 0. The rows come from a
 * query grouped by the same days, so the series has exactly `PER_DAY_WINDOW` entries and invents nothing.
 */
export const fillDays = (rows: readonly DayCount[], now: Date, timeZone: string): DayCount[] => {
  const counts = new Map(rows.map((row) => [row.day, row.count]));
  // calendar arithmetic on today's date, so a day of 23 or 25 hours (summer time) is still one day
  const [year = 1970, month = 1, date = 1] = dayOf(now, timeZone).split("-").map(Number);
  return Array.from({ length: PER_DAY_WINDOW }, (_, index) => {
    const day = new Date(Date.UTC(year, month - 1, date - (PER_DAY_WINDOW - 1 - index))).toISOString().slice(0, 10);
    return { day, count: counts.get(day) ?? 0 };
  });
};

/**
 * The start of the window: midnight of the oldest day in `timeZone`, as a time PostgreSQL compares with stored
 * timestamps. Shared by the per-day counts, so each is one bounded statement over at most `PER_DAY_WINDOW` groups.
 */
export const windowStart = (now: Date, timeZone: string) =>
  sql`((date_trunc('day', ${now.toISOString()}::timestamptz AT TIME ZONE ${timeZone}) - ${`${PER_DAY_WINDOW - 1} days`}::interval) AT TIME ZONE ${timeZone})`;
