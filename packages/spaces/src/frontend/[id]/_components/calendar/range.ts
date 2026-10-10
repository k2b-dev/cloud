import { type DateContext, dates } from "@k2b/stdlib";
import type { CalendarItem } from "@/contracts";
import type { CalendarView } from "./types";

/** Waking hours of the day and week views: a day starts at 06:00, and the night after 22:00 belongs to it. */
export const CALENDAR_DAY_HOURS = [6, 22] as const;
/** Days the day and week views load at once when the reader nears either end. */
export const CALENDAR_BLOCK_DAYS = 7;
/** The widest range the day and week views hold, as one year view does; past it they stop loading. */
export const CALENDAR_MAX_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Instants of local midnights: the first loaded day and the day after the last one. */
export type CalendarRange = { from: string; to: string };

/** The day and week views scroll through their days and load them in blocks. */
export const isScrollingCalendarView = (view: CalendarView): view is "day" | "week" => view === "day" || view === "week";

const midnight = (date: Date, days: number, dateConfig?: DateContext) =>
  dates.addDays(dates.startOfDay(date, dateConfig), days, dateConfig).toISOString();

/**
 * The days the first snapshot of a day or week view loads around its date: a week before and three after the day, or
 * the week before and the two after the week, so the reader can scroll either way at once.
 */
export const calendarWindow = (view: "day" | "week", date: Date, dateConfig?: DateContext): CalendarRange => {
  if (view === "day") return { from: midnight(date, -7, dateConfig), to: midnight(date, 22, dateConfig) };
  const start = dates.startOfWeek(date, dateConfig);
  return { from: midnight(start, -7, dateConfig), to: midnight(start, 14, dateConfig) };
};

/** The week before or after the loaded days, or null where the range would grow past {@link CALENDAR_MAX_DAYS}. */
export const calendarBlock = (range: CalendarRange, edge: "earlier" | "later", dateConfig?: DateContext): CalendarRange | null => {
  const block =
    edge === "earlier"
      ? { from: midnight(new Date(range.from), -CALENDAR_BLOCK_DAYS, dateConfig), to: range.from }
      : { from: range.to, to: midnight(new Date(range.to), CALENDAR_BLOCK_DAYS, dateConfig) };
  const from = edge === "earlier" ? block.from : range.from;
  const to = edge === "earlier" ? range.to : block.to;
  return Date.parse(to) - Date.parse(from) > CALENDAR_MAX_DAYS * DAY_MS ? null : block;
};

/** Whether the calendar query placed an item in the range: events overlap it, tasks are due inside it. */
const touches = (item: CalendarItem, range: CalendarRange): boolean => {
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  if (item.startsAt && item.endsAt) return Date.parse(item.startsAt) < to && Date.parse(item.endsAt) > from;
  const due = item.deadline ? Date.parse(item.deadline) : Number.NaN;
  return due >= from && due < to;
};

/**
 * Adds freshly loaded items to the loaded days: they replace every item the fresh query covered, items of other days
 * stay, and the range grows to cover both.
 */
export const mergeCalendarItems = (
  current: CalendarRange & { items: CalendarItem[] },
  incoming: CalendarRange & { items: CalendarItem[] },
): CalendarRange & { items: CalendarItem[] } => {
  const fresh = new Set(incoming.items.map((item) => item.id));
  const kept = current.items.filter((item) => !fresh.has(item.id) && !touches(item, incoming));
  return {
    from: Date.parse(incoming.from) < Date.parse(current.from) ? incoming.from : current.from,
    to: Date.parse(incoming.to) > Date.parse(current.to) ? incoming.to : current.to,
    items: [...kept, ...incoming.items],
  };
};
