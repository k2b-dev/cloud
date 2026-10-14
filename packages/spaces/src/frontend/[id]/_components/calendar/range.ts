import { type DateContext, dates } from "@k2b/stdlib";
import type { CalendarItem } from "@/contracts";
import type { CalendarView } from "./types";

/** Waking hours of the day and week views: a day starts at 06:00, and the night after 22:00 belongs to it. */
export const CALENDAR_DAY_HOURS = [6, 22] as const;
/** Days the day and week views load at once when the reader nears either end. */
export const CALENDAR_BLOCK_DAYS = 7;
/** The widest range the scrolling views hold, as one year view does; past it they stop loading. */
export const CALENDAR_MAX_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Instants of local midnights: the first loaded day and the day after the last one. */
export type CalendarRange = { from: string; to: string };

/** The day and week views scroll through their days and load them in blocks. */
export const isScrollingCalendarView = (view: CalendarView): view is "day" | "week" => view === "day" || view === "week";

/** Views that load calendar days in blocks as the reader scrolls. Timed-day policy remains day/week only. */
export const isBlockLoadingCalendarView = (view: CalendarView): view is "day" | "week" | "month" =>
  isScrollingCalendarView(view) || view === "month";

/** Month loads eight weeks at once; timed views load one. */
export const calendarBlockDays = (view: "day" | "week" | "month") => (view === "month" ? 56 : CALENDAR_BLOCK_DAYS);

const midnight = (date: Date, days: number, dateConfig?: DateContext) =>
  dates.addDays(dates.startOfDay(date, dateConfig), days, dateConfig).toISOString();

/**
 * The days the first snapshot of a day or week view loads around its date: a week before and three after the day, or
 * the week before and the two after the week. Month loads five weeks before the first's week and eleven after it.
 */
export const calendarWindow = (view: "day" | "week" | "month", date: Date, dateConfig?: DateContext): CalendarRange => {
  if (view === "day") return { from: midnight(date, -7, dateConfig), to: midnight(date, 22, dateConfig) };
  if (view === "month") {
    const start = dates.startOfWeek(dates.startOfMonth(date, dateConfig), dateConfig);
    return { from: midnight(start, -35, dateConfig), to: midnight(start, 77, dateConfig) };
  }
  const start = dates.startOfWeek(date, dateConfig);
  return { from: midnight(start, -7, dateConfig), to: midnight(start, 14, dateConfig) };
};

/** The block before or after the loaded days, or null past {@link CALENDAR_MAX_DAYS}. */
export const calendarBlock = (
  range: CalendarRange,
  edge: "earlier" | "later",
  days: number,
  dateConfig?: DateContext,
): CalendarRange | null => {
  const block =
    edge === "earlier"
      ? { from: midnight(new Date(range.from), -days, dateConfig), to: range.from }
      : { from: range.to, to: midnight(new Date(range.to), days, dateConfig) };
  const from = edge === "earlier" ? block.from : range.from;
  const to = edge === "earlier" ? range.to : block.to;
  return Date.parse(to) - Date.parse(from) > CALENDAR_MAX_DAYS * DAY_MS ? null : block;
};

const nextDayKey = (key: string) => {
  const [year = 1970, month = 1, day = 1] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
};

/** The instant a day of the day and week views starts: its start hour on the wall clock, also on a clock change. */
const dayStart = (key: string, dateConfig?: DateContext): number => {
  const wall = `${key}T${String(CALENDAR_DAY_HOURS[0]).padStart(2, "0")}:00`;
  return dateConfig?.timeZone
    ? Date.parse(dates.zonedDateTimeToInstant(wall, dateConfig.timeZone, { disambiguation: "compatible" }))
    : new Date(wall).getTime();
};

/**
 * The end of what a day or week view loads for its days: the night after the last day belongs to it, so items up to
 * the start hour of the day after `to` count, on the wall clock.
 */
export const calendarItemsEnd = (to: string, dateConfig?: DateContext): string =>
  new Date(dayStart(dates.formatDateKey(new Date(to), dateConfig), dateConfig)).toISOString();

/**
 * Whether the calendar query placed an item in the range of a day or week view: events overlap it, tasks are due
 * inside it, and the night after its last day counts, as the server loads it.
 */
const touches = (item: CalendarItem, range: CalendarRange, dateConfig?: DateContext): boolean => {
  const from = Date.parse(range.from);
  const to = Date.parse(calendarItemsEnd(range.to, dateConfig));
  const due = item.deadline ? Date.parse(item.deadline) : Number.NaN;
  const overlaps = Boolean(item.startsAt && item.endsAt) && Date.parse(item.startsAt!) < to && Date.parse(item.endsAt!) > from;
  return overlaps || (due >= from && due < to);
};

/**
 * Adds freshly loaded items to the loaded days: they replace every item the fresh query covered, items of other days
 * stay, and the range grows to cover both.
 */
export const mergeCalendarItems = (
  current: CalendarRange & { items: CalendarItem[] },
  incoming: CalendarRange & { items: CalendarItem[] },
  dateConfig?: DateContext,
): CalendarRange & { items: CalendarItem[] } => {
  const fresh = new Set(incoming.items.map((item) => item.id));
  const kept = current.items.filter((item) => !fresh.has(item.id) && !touches(item, incoming, dateConfig));
  return {
    from: Date.parse(incoming.from) < Date.parse(current.from) ? incoming.from : current.from,
    to: Date.parse(incoming.to) > Date.parse(current.to) ? incoming.to : current.to,
    items: [...kept, ...incoming.items],
  };
};

/**
 * How many items the day or week view shows on the days from `first` to `last`, both `YYYY-MM-DD`: timed items from
 * the start hour of the first day to the start hour after the last, all-day ones by their dates.
 */
export const countCalendarDays = (items: readonly CalendarItem[], first: string, last: string, dateConfig?: DateContext): number => {
  const from = dayStart(first, dateConfig);
  const to = dayStart(nextDayKey(last), dateConfig);
  return items.filter((item) => {
    if (item.allDay) {
      const start = item.startsAt ?? item.deadline;
      if (!start) return false;
      const firstKey = dates.formatDateKey(new Date(start), dateConfig);
      // An all-day range ends at the midnight after its last day.
      const lastKey =
        item.endsAt && Date.parse(item.endsAt) > Date.parse(start)
          ? dates.formatDateKey(new Date(Date.parse(item.endsAt) - 1), dateConfig)
          : firstKey;
      return firstKey <= last && lastKey >= first;
    }
    if (item.startsAt && item.endsAt) return Date.parse(item.startsAt) < to && Date.parse(item.endsAt) > from;
    const due = item.deadline ? Date.parse(item.deadline) : Number.NaN;
    return due >= from && due < to;
  }).length;
};
