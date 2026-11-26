/**
 * Reading a time of day from text, for what core's time input does not read itself: a pasted time. Pure: no DOM, no
 * ui-sdk. The value is always `HH:MM` on the 24-hour clock.
 */

/** The words a locale gives morning and afternoon ("am", "pm"), lower case. */
const dayPeriods = (locale: string): [string, string] => {
  const format = new Intl.DateTimeFormat(locale, { hour: "numeric", hourCycle: "h12", timeZone: "UTC" });
  const period = (hour: number) =>
    format
      .formatToParts(Date.UTC(2000, 0, 1, hour))
      .find((each) => each.type === "dayPeriod")
      ?.value.toLowerCase() ?? "";
  return [period(1), period(13)];
};

/** A word for the hour that some locales write after a time ("14 Uhr", "14:30 Uhr"); it changes nothing. */
const hourWords = /uhr/g;

/**
 * A time as `HH:MM`, or `undefined` when the text is none: "14:30", "1430", "9:30", "9.30", "9", "14:30:00" (the
 * seconds are left out), "14 Uhr", full-width digits, and with a day period "02:30 PM", "2:30pm" or "2:30 p" (in the
 * locale's words or am/pm). A day period is read on either clock: "2:30 PM" is 14:30 in a 24-hour locale too.
 */
export const readTime = (text: string, locale: string): string | undefined => {
  const typed = text.normalize("NFKC").trim().toLowerCase().replace(hourWords, " ").trim();
  if (!typed) return undefined;
  const words = typed.replace(/[\d\s:.,h]/g, "");
  let afternoon = false;
  let morning = false;
  if (words) {
    const [am, pm] = dayPeriods(locale);
    afternoon = (pm !== "" && pm.startsWith(words)) || "pm".startsWith(words);
    morning = !afternoon && ((am !== "" && am.startsWith(words)) || "am".startsWith(words));
    if (!afternoon && !morning) return undefined;
  }
  const groups = typed.match(/\d+/g) ?? [];
  const [first = "", second, seconds] = groups;
  if (!first || groups.length > 3 || first.length > 4) return undefined;
  if (second !== undefined && second.length > 2) return undefined;
  if (seconds !== undefined && (seconds.length > 2 || Number(seconds) > 59)) return undefined;
  const split = second === undefined && first.length > 2;
  let hour = Number(split ? first.slice(0, -2) : first);
  const minute = Number(split ? first.slice(-2) : (second ?? 0));
  if (afternoon || morning) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (afternoon ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return undefined;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
};

/** Whether a locale reads the clock in twice twelve hours: American English yes, German and British English no. */
export const hourCycleOf = (locale: string): 12 | 24 => {
  const cycle = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hourCycle;
  return cycle === "h11" || cycle === "h12" ? 12 : 24;
};

/** 14:30 as the locale writes it ("14:30", "2:30 PM"), the example a hint names. */
export const timeExample = (locale: string): string =>
  new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    hourCycle: hourCycleOf(locale) === 12 ? "h12" : "h23",
    timeZone: "UTC",
  }).format(Date.UTC(2000, 0, 1, 14, 30));
