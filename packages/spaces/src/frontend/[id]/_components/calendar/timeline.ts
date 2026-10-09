import { type DateContext, dates } from "@k2b/stdlib";
import type { CalendarItem } from "@/contracts";
import { defaultFilter, type FilterState, writeFilterParams } from "../filter/types";
import type { CalendarFilter } from "./filter";

/** Days the timeline loads at once when the reader nears either end. */
export const TIMELINE_BLOCK_DAYS = 7;
/** The widest range the timeline loads, as one year view does; past it the strip ends. */
export const TIMELINE_MAX_DAYS = 366;
/** The view opens on the evening before the anchor day, so the evening and the next morning stand side by side. */
const OPENING_TIME = "20:00";
/** Days after the anchor day that the first window covers, the anchor day included. */
const OPENING_DAYS = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

export type TimelineRange = { from: string; to: string };

const atLocalTime = (dateKey: string, time: string, dateConfig?: DateContext): string =>
  dateConfig?.timeZone
    ? new Date(dates.zonedDateTimeToInstant(`${dateKey}T${time}`, dateConfig.timeZone, { disambiguation: "compatible" })).toISOString()
    : new Date(`${dateKey}T${time}:00`).toISOString();

const shiftedKey = (instant: string, days: number, dateConfig?: DateContext): string =>
  dates.formatDateKey(dates.addDays(new Date(instant), days, dateConfig), dateConfig);

const localTime = (instant: string, dateConfig?: DateContext): string => dates.formatTime(instant, dateConfig);

/** The first window of the timeline around `anchor`: from the evening before it to the end of the seventh day after it. */
export const timelineWindow = (anchor: Date, dateConfig?: DateContext): TimelineRange => {
  const anchorKey = dates.formatDateKey(anchor, dateConfig);
  const anchorStart = atLocalTime(anchorKey, "00:00", dateConfig);
  return {
    from: atLocalTime(shiftedKey(anchorStart, -1, dateConfig), OPENING_TIME, dateConfig),
    to: atLocalTime(shiftedKey(anchorStart, OPENING_DAYS, dateConfig), "00:00", dateConfig),
  };
};

/**
 * The week before or after the loaded range, at the same local time of day, or null where the range would grow past
 * {@link TIMELINE_MAX_DAYS}.
 */
export const timelineBlock = (range: TimelineRange, edge: "earlier" | "later", dateConfig?: DateContext): TimelineRange | null => {
  const block =
    edge === "earlier"
      ? {
          from: atLocalTime(shiftedKey(range.from, -TIMELINE_BLOCK_DAYS, dateConfig), localTime(range.from, dateConfig), dateConfig),
          to: range.from,
        }
      : {
          from: range.to,
          to: atLocalTime(shiftedKey(range.to, TIMELINE_BLOCK_DAYS, dateConfig), localTime(range.to, dateConfig), dateConfig),
        };
  const from = edge === "earlier" ? block.from : range.from;
  const to = edge === "earlier" ? range.to : block.to;
  return Date.parse(to) - Date.parse(from) > TIMELINE_MAX_DAYS * DAY_MS ? null : block;
};

/** Whether the calendar query placed an item in the range: events overlap it, tasks are due inside it. */
const touches = (item: CalendarItem, range: TimelineRange): boolean => {
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  if (item.startsAt && item.endsAt) return Date.parse(item.startsAt) < to && Date.parse(item.endsAt) > from;
  const due = item.deadline ? Date.parse(item.deadline) : Number.NaN;
  return due >= from && due < to;
};

/**
 * Adds freshly loaded items to a loaded range: they replace every item the fresh query covered, items of other days
 * stay, and the range grows to cover both.
 */
export const mergeTimelineItems = (
  current: TimelineRange & { items: CalendarItem[] },
  incoming: TimelineRange & { items: CalendarItem[] },
): TimelineRange & { items: CalendarItem[] } => {
  const fresh = new Set(incoming.items.map((item) => item.id));
  const kept = current.items.filter((item) => !fresh.has(item.id) && !touches(item, incoming));
  return {
    from: Date.parse(incoming.from) < Date.parse(current.from) ? incoming.from : current.from,
    to: Date.parse(incoming.to) > Date.parse(current.to) ? incoming.to : current.to,
    items: [...kept, ...incoming.items],
  };
};

/**
 * Tasks each part of the tray below the timeline shows: one row to take in at a glance. The list view shows the rest,
 * with the same query.
 */
export const TIMELINE_TRAY_SIZE = 5;

export type TimelineTraySection = "overdue" | "undated";

/**
 * The list queries of the tray under the calendar's filter: open tasks whose deadline lies before today, most recent
 * first, and open tasks without a deadline assigned to the reader, most urgent first. A part the filter rules out is
 * null, and so is the whole tray while the calendar shows only events.
 */
export const timelineTrayFilters = (filter: CalendarFilter): Record<TimelineTraySection, FilterState | null> | null => {
  if (filter.type === "event") return null;
  const tasks: FilterState = {
    ...defaultFilter,
    type: "task",
    status: "active",
    priority: filter.priorities,
    tagIds: filter.tagIds,
    columnIds: filter.columnIds,
  };
  return {
    overdue: { ...tasks, assignedTo: filter.assignedTo, deadlineFilter: "overdue", sort: "deadline", sortDesc: true },
    undated: filter.assignedTo === "unassigned" ? null : { ...tasks, assignedTo: "me", deadlineFilter: "none", sort: "priority" },
  };
};

/** Whether the calendar's filter narrows the tray, so that an empty tray does not claim that nothing waits at all. */
export const timelineTrayFiltered = (filter: CalendarFilter): boolean =>
  filter.assignedTo !== "all" || filter.priorities.length > 0 || filter.columnIds.length > 0 || filter.tagIds.length > 0;

/** The list view of a Space with one query of the tray, where the reader finds every task it holds. */
export const timelineTrayListHref = (spacePath: string, query: FilterState): string => {
  const params = new URLSearchParams({ view: "list" });
  writeFilterParams(params, query);
  return `${spacePath}?${params.toString()}`;
};
