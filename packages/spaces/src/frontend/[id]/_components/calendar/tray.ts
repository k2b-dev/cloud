import { defaultFilter, type FilterState, writeFilterParams } from "../filter/types";
import type { CalendarFilter } from "./filter";

/**
 * Tasks each part of the tray below the day view shows: one row to take in at a glance. The list view shows the rest,
 * with the same query.
 */
export const TASK_TRAY_SIZE = 5;

export type TaskTraySection = "overdue" | "undated";

/**
 * The list queries of the tray under the calendar's filter: open tasks whose deadline lies before today, most recent
 * first, and open tasks without a deadline assigned to the reader, most urgent first. A part the filter rules out is
 * null, and so is the whole tray while the calendar shows only events.
 */
export const taskTrayFilters = (filter: CalendarFilter): Record<TaskTraySection, FilterState | null> | null => {
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
export const taskTrayFiltered = (filter: CalendarFilter): boolean =>
  filter.assignedTo !== "all" || filter.priorities.length > 0 || filter.columnIds.length > 0 || filter.tagIds.length > 0;

/** The list view of a Space with one query of the tray, where the reader finds every task it holds. */
export const taskTrayListHref = (spacePath: string, query: FilterState): string => {
  const params = new URLSearchParams({ view: "list" });
  writeFilterParams(params, query);
  return `${spacePath}?${params.toString()}`;
};
