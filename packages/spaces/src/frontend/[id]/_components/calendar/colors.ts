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

/** The tints behind avatar initials in `@k2b/ui`, in the order of its `data-tint` rules. */
const PERSON_COLORS = ["#3b82f6", "#8b5cf6", "#ec4899", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#06b6d4", "#6366f1", "#a855f7"];

/** A person's avatar tint: the same name hashes to the same color as the `@k2b/ui` avatar initials. */
export const calendarPersonColor = (displayName: string): string => {
  const name = displayName.trim();
  let hash = 0;
  for (let index = 0; index < name.length; index++) hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  return PERSON_COLORS[hash % PERSON_COLORS.length]!;
};

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
