/**
 * The rolling six weeks of a `DatePicker` with `view="weeks"`: a window of 42 days that starts on the first day of a
 * week and moves by whole weeks. Pure: date keys in, date keys out.
 */
import { addDaysToKey } from "../inputs/date-input";
import { dayOfWeekOfKey } from "../intl/weekend";

/** The days a window shows: six weeks. */
export const windowDays = 42;

/** The first day of the week in a locale, 0 for Sunday: Monday in German, Sunday in American English. */
export const firstDayOfWeek = (locale: string): number => {
  let tag: Intl.Locale;
  try {
    tag = new Intl.Locale(locale);
  } catch {
    return 1;
  }
  // `getWeekInfo()` in current engines, the `weekInfo` getter in older ones; neither is in every TypeScript lib yet
  const getter: unknown = Reflect.get(tag, "getWeekInfo");
  const info: unknown = typeof getter === "function" ? getter.call(tag) : Reflect.get(tag, "weekInfo");
  return typeof info === "object" && info !== null && "firstDay" in info && typeof info.firstDay === "number" ? info.firstDay % 7 : 1;
};

/** The first day of the week `key` lies in. */
export const weekStartOf = (key: string, firstDay: number): string => addDaysToKey(key, -((dayOfWeekOfKey(key) - firstDay + 7) % 7));

/** The last day a window that starts on `start` shows. */
export const windowEnd = (start: string): string => addDaysToKey(start, windowDays - 1);

/**
 * The window that shows `target`, moved as little as possible from the one that starts on `start`: a day before it
 * makes its week the first, a day after it makes its week the last.
 */
export const windowShowing = (start: string, target: string, firstDay: number): string => {
  if (target < start) return weekStartOf(target, firstDay);
  if (target > windowEnd(start)) return addDaysToKey(weekStartOf(target, firstDay), -(windowDays - 7));
  return start;
};
