import { personColor } from "@k2b/ui";
import type { CalendarItem, Priority, SpaceColumn } from "@/contracts";
import type { CalendarColorBy } from "./filter";

/** The calm gray of an item whose chosen dimension has no color. */
export const CALENDAR_NEUTRAL_COLOR = "#a1a1aa";

/** The priority colors of the Spaces filters and table. */
export const CALENDAR_PRIORITY_COLORS: Record<Priority, string> = {
  urgent: "#ef4444",
  high: "#f97316",
  medium: "#eab308",
  low: "#3b82f6",
};

/** A person's color, the same as their avatar initials and comments: `personColor` of `@k2b/ui`. */
export const calendarPersonColor = (displayName: string): string => personColor(displayName);

export type CalendarColorSource = Pick<CalendarItem, "tags" | "columnId" | "priority" | "assignees">;

export type CalendarItemColors = {
  /** The item's color: the tinted fill of an event or the marker of a task. */
  color: string;
  /** Colors of further tags or assignees, for small dots where there is room. */
  extra: string[];
};

/**
 * The one color rule of every Spaces calendar view. By tag (the default), an item takes its first tag's color, then
 * its status color, then neutral gray; the other modes take the status, priority, or first assignee's avatar color.
 */
export const calendarItemColors = (
  item: CalendarColorSource,
  colorBy: CalendarColorBy,
  columns: readonly Pick<SpaceColumn, "id" | "color">[],
): CalendarItemColors => {
  const statusColor = () => columns.find((column) => column.id === item.columnId)?.color || null;
  switch (colorBy) {
    case "tag": {
      const [first, ...rest] = item.tags ?? [];
      return { color: first?.color ?? statusColor() ?? CALENDAR_NEUTRAL_COLOR, extra: rest.map((tag) => tag.color) };
    }
    case "status":
      return { color: statusColor() ?? CALENDAR_NEUTRAL_COLOR, extra: [] };
    case "priority":
      return { color: item.priority ? CALENDAR_PRIORITY_COLORS[item.priority] : CALENDAR_NEUTRAL_COLOR, extra: [] };
    case "person": {
      const [first, ...rest] = item.assignees;
      return {
        color: first ? calendarPersonColor(first.displayName) : CALENDAR_NEUTRAL_COLOR,
        extra: rest.map((assignee) => calendarPersonColor(assignee.displayName)),
      };
    }
  }
};

/** A task with a due date and no start time: it shows as a marker, not as a band. */
export const isCalendarTask = (item: Pick<CalendarItem, "deadline" | "startsAt">): boolean => Boolean(item.deadline && !item.startsAt);

/** Urgent and high priority show a small red flag in every color mode. */
export const isCalendarFlagged = (item: Pick<CalendarItem, "priority">): boolean => item.priority === "urgent" || item.priority === "high";
