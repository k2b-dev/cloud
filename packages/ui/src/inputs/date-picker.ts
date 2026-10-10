import { type DateContext, dates } from "@k2b/stdlib";

export type DateRangeValue = {
  start: string | null;
  end: string | null;
};

export const pickerContext = (context?: DateContext): DateContext => ({
  weekStartsOn: 1,
  ...context,
});

export const hasInstantOffset = (value: string): boolean => /[T\s].*([zZ]|[+-]\d{2}:?\d{2})$/.test(value);

export const dateKey = (date: Date | string, context?: DateContext): string => dates.formatDateKey(date, pickerContext(context));

/**
 * Short month names for the month panel. `dates.months()` only returns the long
 * form ("September"), which overflows the three-column month grid, so the short
 * form is derived here while staying locale aware.
 */
export const monthNames = (context?: DateContext): string[] => {
  const merged = pickerContext(context);
  const formatter = new Intl.DateTimeFormat(merged.locale, { month: "short", timeZone: "UTC" });
  return Array.from({ length: 12 }, (_, index) => formatter.format(Date.UTC(2024, index, 15)));
};

/**
 * Picks the roving-tabindex day for a rendered month grid. The preferred day is
 * used when the grid actually contains it, otherwise the first day of the
 * visible month keeps exactly one cell reachable by Tab.
 */
export const resolveFocusDay = (monthDayKeys: readonly string[], preferred: string | null | undefined): string | undefined =>
  preferred && monthDayKeys.includes(preferred) ? preferred : monthDayKeys[0];

export const yearMonth = (date: Date, context?: DateContext): { year: number; month: number } => {
  const [year = "1970", month = "1"] = dateKey(date, context).split("-");
  return { year: Number(year), month: Number(month) - 1 };
};

export const monthDate = (year: number, month: number, context?: DateContext): Date => {
  const value = `${year}-${String(month + 1).padStart(2, "0")}-01T12:00`;
  if (context?.timeZone) {
    return new Date(dates.zonedDateTimeToInstant(value, context.timeZone, { disambiguation: "compatible" }));
  }
  return new Date(year, month, 1, 12);
};

/**
 * Milliseconds from `now` until the next calendar day starts in the picker's
 * time zone, so a panel left open past midnight moves its today mark on time.
 */
export const msUntilNextDay = (now: Date, context?: DateContext): number => {
  const merged = pickerContext(context);
  return dates.startOfDay(dates.addDays(now, 1, merged), merged).getTime() - now.getTime();
};

export const parseDateValue = (value: string | null | undefined, context?: DateContext): Date => {
  if (!value) return dates.today(pickerContext(context));
  return dates.parseCalendarDate(value.slice(0, 10), pickerContext(context));
};

export const displayDate = (value: string | null | undefined, context?: DateContext): string =>
  value ? dates.formatDate(`${value.slice(0, 10)}T12:00`, pickerContext(context)) : "";

const localDateTimeInput = (value: string): string => {
  if (!hasInstantOffset(value)) return value.slice(0, 16);
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
};

export const dateTimeInput = (value: string | null | undefined, context?: DateContext): string => {
  if (!value) return "";
  if (context?.timeZone && hasInstantOffset(value)) return dates.instantToZonedInput(value, context.timeZone);
  return localDateTimeInput(value);
};

export const splitDateTime = (value: string | null | undefined, context?: DateContext): { date: string; time: string } => {
  const input = dateTimeInput(value, context);
  const [date = "", time = ""] = input.split("T");
  return { date, time: time.slice(0, 5) };
};

export const isCompleteTime = (value: string): boolean => {
  if (!/^\d{2}:\d{2}$/.test(value)) return false;
  const [hours, minutes] = value.split(":").map(Number);
  return hours! >= 0 && hours! <= 23 && minutes! >= 0 && minutes! <= 59;
};

export const toDateTimeValue = (date: string, time: string, context?: DateContext): string | null => {
  if (!date) return null;
  const resolvedTime = time || "00:00";
  if (!isCompleteTime(resolvedTime)) return null;
  const local = `${date}T${resolvedTime}`;
  if (context?.timeZone) {
    return dates.zonedDateTimeToInstant(local, context.timeZone, { disambiguation: "compatible" });
  }
  return local;
};

export const formatDateTimeValue = (value: string | null | undefined, context?: DateContext): string =>
  value ? dates.formatDateTime(value, pickerContext(context)) : "";

export const normalizeTimeInput = (value: string): string => {
  const [hours = "", minutes = ""] = value.split(":");
  const hour = Math.max(0, Math.min(23, Number(hours || 0)));
  const minute = Math.max(0, Math.min(59, Number(minutes || 0)));
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
};

export const filterTimeInput = (value: string): string => {
  const digits = value.replace(/\D/g, "").slice(0, 4);
  return digits.length <= 2 ? digits : `${digits.slice(0, 2)}:${digits.slice(2)}`;
};

export const orderedRange = (start: string, end: string): DateRangeValue =>
  end.localeCompare(start) < 0 ? { start: end, end: start } : { start, end };

export const previewRange = (range: DateRangeValue, preview: string | null): DateRangeValue => {
  if (!range.start || range.end || !preview) return range;
  return orderedRange(range.start, preview);
};

export const inRange = (day: string, range: DateRangeValue): boolean =>
  Boolean(range.start && range.end && day >= range.start && day <= range.end);

export const isRangeEdge = (day: string, range: DateRangeValue): boolean => day === range.start || day === range.end;

export const formatDateOnlyRangeDuration = (range: DateRangeValue, context?: DateContext): string => {
  if (!range.start || !range.end) return "";
  const start = Date.parse(`${dateKey(range.start, context)}T00:00:00.000Z`);
  const end = Date.parse(`${dateKey(range.end, context)}T00:00:00.000Z`);
  const days = Math.floor(Math.abs(end - start) / 86_400_000) + 1;
  return `${days} ${days === 1 ? "day" : "days"}`;
};
