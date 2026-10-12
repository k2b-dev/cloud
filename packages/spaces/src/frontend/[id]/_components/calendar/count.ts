import { type DateContext, dates } from "@k2b/stdlib";
import type { CalendarItem } from "@/contracts";

/**
 * How many items the calendar shows on the days from `firstKey` to `lastKey`, both `YYYY-MM-DD`, from midnight to
 * midnight in the grid's time zone: events and all-day ranges that overlap the days, and tasks due on them.
 */
export const countCalendarItems = (items: readonly CalendarItem[], firstKey: string, lastKey: string, dateConfig?: DateContext): number => {
  const from = dates.parseCalendarDate(firstKey, dateConfig).getTime();
  const to = dates.addDays(dates.parseCalendarDate(lastKey, dateConfig), 1, dateConfig).getTime();
  return items.filter((item) => {
    const startsAt = item.startsAt ?? item.deadline;
    if (!startsAt) return false;
    const start = Date.parse(startsAt);
    const end = Date.parse(item.endsAt ?? item.deadline ?? startsAt);
    // A task without an event time is a point at its deadline; an all-day range ends at the midnight after its last day.
    return end > start ? start < to && end > from : start >= from && start < to;
  }).length;
};
