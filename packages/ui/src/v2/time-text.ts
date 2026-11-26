/**
 * A time of day as people type and read it in the @k2b/ui locale, never in the browser's: "14:30" in German, "2:30 PM"
 * in American English. The value under it is always `HH:MM` on the 24-hour clock.
 */

const formatter = (locale: string) => {
  const twelve = new Intl.DateTimeFormat(locale, { hour: "numeric", timeZone: "UTC" }).resolvedOptions().hourCycle;
  const h12 = twelve === "h12" || twelve === "h11";
  return {
    h12,
    format: new Intl.DateTimeFormat(locale, {
      hour: h12 ? "numeric" : "2-digit",
      minute: "2-digit",
      hourCycle: h12 ? "h12" : "h23",
      timeZone: "UTC",
    }),
  };
};

const at = (hhmm: string) => Date.UTC(2000, 0, 1, Number(hhmm.slice(0, 2)), Number(hhmm.slice(3, 5)));

/** Whether the locale reads the clock in twice twelve hours with a day period ("2:30 PM"). */
export const usesDayPeriods = (locale: string): boolean => formatter(locale).h12;

/** `HH:MM` as the locale writes a time of day. */
export const formatTime = (hhmm: string, locale: string): string => formatter(locale).format.format(at(hhmm));

/** The words the locale gives morning and afternoon ("AM", "PM"), lower case. */
const dayPeriods = (locale: string): [string, string] => {
  const { format } = formatter(locale);
  const period = (hhmm: string) =>
    format
      .formatToParts(at(hhmm))
      .find((part) => part.type === "dayPeriod")
      ?.value.toLowerCase() ?? "";
  return [period("01:00"), period("13:00")];
};

/**
 * A typed time as `HH:MM`, or `undefined` when it is none. Digits alone are hours ("9", "14") or hours and minutes
 * ("930", "1430"); any mark may stand between hour and minute ("9:30", "9.30", "9 30"). In a 12-hour locale, a day
 * period after it ("2:30 pm", "2:30p") counts; without one the hours are read on the 24-hour clock.
 */
export const parseTime = (text: string, locale: string): string | undefined => {
  const typed = text.trim().toLowerCase();
  if (!typed) return undefined;
  const [am, pm] = dayPeriods(locale);
  const words = typed.replace(/[\d\s:.,h-]/g, "");
  // a 24-hour locale has no day period to read
  if (words !== "" && !usesDayPeriods(locale)) return undefined;
  const afternoon = words !== "" && ((pm !== "" && pm.startsWith(words)) || "pm".startsWith(words));
  const morning = words !== "" && !afternoon && ((am !== "" && am.startsWith(words)) || "am".startsWith(words));
  if (words !== "" && !afternoon && !morning) return undefined;
  const groups = typed.match(/\d+/g) ?? [];
  let hour: number;
  let minute: number;
  if (groups.length === 1) {
    const digits = groups[0]!;
    if (digits.length > 4) return undefined;
    hour = Number(digits.length <= 2 ? digits : digits.slice(0, digits.length - 2));
    minute = digits.length <= 2 ? 0 : Number(digits.slice(-2));
  } else if (groups.length === 2 && groups[1]!.length <= 2) {
    hour = Number(groups[0]);
    minute = Number(groups[1]);
  } else return undefined;
  if (afternoon || morning) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (afternoon ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return undefined;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
};

/** One step of the hour or the minute, round the clock as a dial turns: the other part stays. */
export const stepTime = (hhmm: string, part: "hour" | "minute", delta: number): string => {
  const hour = Number(hhmm.slice(0, 2));
  const minute = Number(hhmm.slice(3, 5));
  const next = part === "hour" ? [(hour + delta + 24) % 24, minute] : [hour, (minute + delta + 60) % 60];
  return next.map((value) => String(value).padStart(2, "0")).join(":");
};

/** Whether the caret at `position` of a written time stands in its hour (up to the first mark after the digits). */
export const caretInHour = (text: string, position: number): boolean => {
  const end = text.search(/\d\D/);
  return end < 0 || position <= end + 1;
};
