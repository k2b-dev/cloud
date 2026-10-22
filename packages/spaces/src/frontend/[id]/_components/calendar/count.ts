import { type DateContext, dates } from "@k2b/stdlib";
import type { CalendarEvent } from "@k2b/ui";
import { calendarItemsEnd } from "./range";

const HOUR = 60 * 60 * 1000;

/** Local midnight of a `YYYY-MM-DD` key; when it repeats the earlier one, when it is skipped the first valid instant. */
const midnight = (key: string, dateConfig?: DateContext): number =>
  dateConfig?.timeZone
    ? Date.parse(dates.zonedDateTimeToInstant(`${key}T00:00`, dateConfig.timeZone, { disambiguation: "compatible" }))
    : dates.parseCalendarDate(key, dateConfig).getTime();

/**
 * How many of the grid's events it paints from local midnight of `firstKey` up to local midnight of `endKey`, both
 * `YYYY-MM-DD`: ranges that overlap the span, with an end at midnight exclusive, and markers whose point lies in it.
 */
export const countCalendarEvents = (
  events: readonly CalendarEvent[],
  firstKey: string,
  endKey: string,
  dateConfig?: DateContext,
): number => {
  const from = midnight(firstKey, dateConfig);
  const to = midnight(endKey, dateConfig);
  return events.filter((event) => {
    const start = new Date(event.start).getTime();
    if (Number.isNaN(start)) return false;
    const end = event.end ? new Date(event.end).getTime() : Number.NaN;
    if (event.display !== "marker" && end > start) return start < to && end > from;
    // The grid gives a timed event without a valid end one hour.
    if (event.display !== "marker" && !event.allDay) return start < to && start + HOUR > from;
    return start >= from && start < to;
  }).length;
};

/** Timed blocks follow the day grid's 06:00 boundary, including its following night. */
export const countTimeBlocks = (
  blocks: readonly { startsAt: string; endsAt: string }[],
  firstKey: string,
  lastKey: string,
  dateConfig?: DateContext,
): number => {
  const start = dates.parseCalendarDate(firstKey, dateConfig);
  const end = dates.addDays(dates.parseCalendarDate(lastKey, dateConfig), 1, dateConfig);
  const from = Date.parse(calendarItemsEnd(start.toISOString(), dateConfig));
  const to = Date.parse(calendarItemsEnd(end.toISOString(), dateConfig));
  return blocks.filter((block) => Date.parse(block.startsAt) < to && Date.parse(block.endsAt) > from).length;
};
