import { type DateContext, dates } from "@k2b/stdlib";
import { formatDeadline } from "@/presentation/deadline";
import { isTaskOverdue } from "@/task-overdue";

type Scheduled = { startsAt: string | null; endsAt: string | null; deadline: string | null; deadlineAllDay: boolean };

/** The overview carries no all-day flag; an all-day event runs from one local midnight to a later one. */
const isAllDay = (start: Date, end: Date | null, dateConfig: DateContext) =>
  end !== null &&
  end > start &&
  start.getTime() === dates.startOfDay(start, dateConfig).getTime() &&
  end.getTime() === dates.startOfDay(end, dateConfig).getTime();

/** When a task is due or an event takes place, as the list and the task show it; null without a date. */
export const workSchedule = (
  item: Scheduled,
  dateConfig: DateContext,
  allDay: string,
): { text: string; datetime: string; icon: string; overdue: boolean } | null => {
  if (item.startsAt) {
    const start = new Date(item.startsAt);
    const end = item.endsAt ? new Date(item.endsAt) : null;
    const time = dates.formatTime(start, dateConfig);
    const range = isAllDay(start, end, dateConfig)
      ? allDay
      : end && dates.isSameDay(start, end, dateConfig)
        ? `${time}–${dates.formatTime(end, dateConfig)}`
        : time;
    const text = dates.isToday(start, dateConfig) ? range : `${dates.formatDate(start, dateConfig)}, ${range}`;
    return { text, datetime: item.startsAt, icon: "ti ti-clock", overdue: false };
  }
  if (!item.deadline) return null;
  return {
    text: formatDeadline(item.deadline, dateConfig),
    datetime: item.deadline,
    icon: "ti ti-calendar-due",
    // Only open items are scheduled here.
    overdue: isTaskOverdue({ ...item, completedAt: null }, dateConfig),
  };
};
