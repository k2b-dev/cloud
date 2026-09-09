import { normalizeTimeZone } from "@k2b/cloud/shared";
import type { ResponseScheduleDefinitionInput } from "./contracts";

type ScheduleWindow = { start: string; end: string };

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const START_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const END_TIME_PATTERN = /^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/;

const minuteOfDay = (value: string): number => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));

const validDate = (value: string): boolean => {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return date.toISOString().slice(0, 10) === value;
};

const validWindow = (window: ScheduleWindow): boolean =>
  START_TIME_PATTERN.test(window.start) && END_TIME_PATTERN.test(window.end) && minuteOfDay(window.start) < minuteOfDay(window.end);

const windowsOverlap = (windows: readonly ScheduleWindow[]): boolean => {
  const sorted = [...windows].sort((left, right) => minuteOfDay(left.start) - minuteOfDay(right.start));
  return sorted.some((window, index) => index > 0 && minuteOfDay(window.start) < minuteOfDay(sorted[index - 1]!.end));
};

export const validateResponseScheduleDefinition = (schedule: ResponseScheduleDefinitionInput): string[] => {
  if (schedule.mode === "always") return [];
  const errors: string[] = [];
  if (!normalizeTimeZone(schedule.timeZone, "")) errors.push("Select a valid IANA time zone");
  for (const range of schedule.activeRanges) {
    if (!validDate(range.from) || (range.to !== null && (!validDate(range.to) || range.to < range.from))) {
      errors.push("Active date ranges must use ordered YYYY-MM-DD dates");
      break;
    }
  }
  if (schedule.weeklyWindows.some((window) => !validWindow(window))) {
    errors.push("Weekly windows must be ordered HH:mm ranges within one local day");
  }
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    if (windowsOverlap(schedule.weeklyWindows.filter((window) => window.weekday === weekday))) {
      errors.push("Weekly windows cannot overlap on the same weekday");
      break;
    }
  }
  const exceptionDates = new Set<string>();
  for (const exception of schedule.exceptions) {
    if (!validDate(exception.date)) errors.push("Exception dates must use YYYY-MM-DD");
    if (exceptionDates.has(exception.date)) errors.push("Each exception date may appear only once");
    exceptionDates.add(exception.date);
    if (exception.closed && exception.windows.length > 0) errors.push("Closed exceptions cannot define active windows");
    if (exception.windows.some((window) => !validWindow(window))) {
      errors.push("Exception windows must be ordered HH:mm ranges within one local day");
    }
    if (windowsOverlap(exception.windows)) errors.push("Exception windows cannot overlap");
  }
  return [...new Set(errors)];
};
