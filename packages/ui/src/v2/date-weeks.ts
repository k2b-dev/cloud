/**
 * The rolling six weeks of a `DatePicker` with `view="weeks"`: a window of 42 days that starts on the first day of a
 * week and moves by whole weeks. Pure: date keys in, date keys out. The week start and the day arithmetic are core's
 * (`behavior/dates`), the same core's calendar uses.
 */
import { addDays, startOfWeek } from "./behavior/dates";

/** The days a window shows: six weeks. */
export const windowDays = 42;

/** The last day a window that starts on `start` shows. */
export const windowEnd = (start: string): string => addDays(start, windowDays - 1);

/**
 * The window that shows `target`, moved as little as possible from the one that starts on `start`: a day before it
 * makes its week the first, a day after it makes its week the last.
 */
export const windowShowing = (start: string, target: string, weekStartsOn: number): string => {
  if (target < start) return startOfWeek(target, weekStartsOn);
  if (target > windowEnd(start)) return addDays(startOfWeek(target, weekStartsOn), -(windowDays - 7));
  return start;
};

/** The 42 days of the window that starts on `start`, as six weeks of seven. */
export const windowWeeks = (start: string): string[][] =>
  Array.from({ length: windowDays / 7 }, (_, week) => Array.from({ length: 7 }, (__, day) => addDays(start, week * 7 + day)));
