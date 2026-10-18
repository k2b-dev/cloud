import { type DateContext, dates } from "@k2b/stdlib";

export const isDateOnlyDeadline = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value);

export const deadlineDayKey = (deadline: string, dateConfig?: DateContext): string =>
  isDateOnlyDeadline(deadline) ? deadline : dates.formatDateKey(deadline, { weekStartsOn: 1, ...dateConfig });

/** Calendar dates are formatted on a neutral clock built from their parts, never interpreted as instants. */
export const formatDeadline = (deadline: string, dateConfig?: DateContext): string => {
  const context: DateContext = { weekStartsOn: 1, ...dateConfig };
  const allDay = isDateOnlyDeadline(deadline);
  const key = deadlineDayKey(deadline, context);
  const [year = 1970, month = 1, day = 1] = key.split("-").map(Number);
  const currentYear = dates.formatDateKey(dates.today(context), context).slice(0, 4);
  const date = allDay ? new Date(Date.UTC(year, month - 1, day, 12)) : new Date(deadline);
  const label = new Intl.DateTimeFormat(context.locale ?? "en", {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(key.slice(0, 4) !== currentYear ? { year: "numeric" as const } : {}),
    timeZone: allDay ? "UTC" : context.timeZone,
  }).format(date);
  return allDay ? label : `${label}, ${dates.formatTime(date, context)}`;
};
