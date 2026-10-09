import { dates as calendar, type DateContext } from "@k2b/stdlib";
import { z } from "zod";
import { AssignedToFilterSchema, ItemTypeSchema, PrioritySchema } from "@/contracts";
import type { CalendarView } from "./types";

/** What an item's calendar color shows; `tag` is the default. */
export const CalendarColorBySchema = z.enum(["tag", "status", "priority", "person"]);
export type CalendarColorBy = z.infer<typeof CalendarColorBySchema>;

export const CalendarFilterSchema = z.object({
  type: ItemTypeSchema,
  assignedTo: AssignedToFilterSchema,
  priorities: z.array(PrioritySchema),
  columnIds: z.array(z.string()),
  tagIds: z.array(z.string()),
  /** Presentation only: the server ignores it, and a change re-colors the loaded items without a reload. */
  colorBy: CalendarColorBySchema,
});

export type CalendarFilter = z.infer<typeof CalendarFilterSchema>;

export const defaultCalendarFilter: CalendarFilter = {
  type: "all",
  assignedTo: "all",
  priorities: [],
  columnIds: [],
  tagIds: [],
  colorBy: "tag",
};

const PARAMS = {
  type: "ctype",
  assignedTo: "cassigned",
  priorities: "cpriority",
  columns: "ccolumns",
  tags: "ctags",
  colorBy: "ccolor",
} as const;

/** The URL parameter of the color choice, which needs no new calendar data. */
export const CALENDAR_COLOR_PARAM = PARAMS.colorBy;

export const parseCalendarColorBy = (url: URL): CalendarColorBy =>
  CalendarColorBySchema.catch(defaultCalendarFilter.colorBy).parse(url.searchParams.get(PARAMS.colorBy));

const values = (url: URL, key: string) => url.searchParams.get(key)?.split(",").filter(Boolean) ?? [];
/** An unknown view, such as the removed `timeline` of an old link, falls back to the month view. */
const isCalendarView = (value: string | null): value is CalendarView =>
  value === "day" || value === "week" || value === "month" || value === "year";

/** Parses only known values; malformed or stale URL filters degrade to safe defaults. */
export const parseCalendarFilter = (url: URL): CalendarFilter => ({
  type: ItemTypeSchema.catch(defaultCalendarFilter.type).parse(url.searchParams.get(PARAMS.type)),
  assignedTo: AssignedToFilterSchema.catch(defaultCalendarFilter.assignedTo).parse(url.searchParams.get(PARAMS.assignedTo)),
  priorities: z.array(PrioritySchema).catch([]).parse(values(url, PARAMS.priorities)),
  columnIds: values(url, PARAMS.columns),
  tagIds: values(url, PARAMS.tags),
  colorBy: parseCalendarColorBy(url),
});

/** Mirrors the server's safe calendar route defaults for immediate client previews. */
export const parseCalendarRoute = (url: URL, dateConfig?: DateContext) => {
  const view = url.searchParams.get("cv");
  return {
    view: isCalendarView(view) ? view : "month",
    date: calendar.parseCalendarDate(url.searchParams.get("cd") ?? undefined, dateConfig).toISOString(),
    filter: parseCalendarFilter(url),
  };
};

export const writeCalendarFilter = (url: URL, filter: CalendarFilter): void => {
  for (const key of Object.values(PARAMS)) url.searchParams.delete(key);
  if (filter.type !== defaultCalendarFilter.type) url.searchParams.set(PARAMS.type, filter.type);
  if (filter.assignedTo !== defaultCalendarFilter.assignedTo) url.searchParams.set(PARAMS.assignedTo, filter.assignedTo);
  if (filter.priorities.length > 0) url.searchParams.set(PARAMS.priorities, filter.priorities.join(","));
  if (filter.columnIds.length > 0) url.searchParams.set(PARAMS.columns, filter.columnIds.join(","));
  if (filter.tagIds.length > 0) url.searchParams.set(PARAMS.tags, filter.tagIds.join(","));
  if (filter.colorBy !== defaultCalendarFilter.colorBy) url.searchParams.set(PARAMS.colorBy, filter.colorBy);
};
