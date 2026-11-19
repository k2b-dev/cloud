import type { AiWakeup } from "@k2b/cloud/ai";
import { describeCodeSchedule } from "@k2b/cloud/code/schedule";
import { dates } from "@k2b/stdlib";

const day = (at: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
const de = (locale: string) => locale.startsWith("de");

/**
 * When an alarm rings, in words and never as cron: a repeating alarm by its rhythm ("Mo–Fr 08:00"), a one-off as
 * "Heute 16:00", "Morgen 10:00" or "Do., 19.11. 09:00". `lower` keeps the words in lower case for the middle of a line.
 */
export const aiWakeupWhen = (
  wakeup: Pick<AiWakeup, "at" | "cron" | "rhythm">,
  input: { locale: string; timeZone: string; now?: Date | string; lower?: boolean /** Today as the time alone. */; short?: boolean },
): string => {
  // Words keep their own case in a line; only the start of a row gets a capital ("Mo–Fr" stays, "montags" begins one).
  const first = (text: string) => (input.lower ? text : text.charAt(0).toUpperCase() + text.slice(1));
  // The rhythm in the reader's language: a fact keeps the words of the turn that wrote it, the cron does not.
  if (wakeup.cron) return first(aiWakeupRhythm(wakeup.cron, input.locale));
  if (!wakeup.at) return first(wakeup.rhythm);
  const at = new Date(wakeup.at);
  const now = new Date(input.now ?? Date.now());
  const time = dates.formatTime(at, { locale: input.locale, timeZone: input.timeZone });
  const days = Math.round((Date.parse(day(at, input.timeZone)) - Date.parse(day(now, input.timeZone))) / 86_400_000);
  if (days === 0 && input.short) return time;
  if (days === 0 || days === 1) return first(`${de(input.locale) ? (days ? "morgen" : "heute") : days ? "tomorrow" : "today"} ${time}`);
  const date = new Intl.DateTimeFormat(input.locale, {
    timeZone: input.timeZone,
    weekday: "short",
    day: de(input.locale) ? "2-digit" : "numeric",
    month: de(input.locale) ? "2-digit" : "short",
    ...(at.getUTCFullYear() === now.getUTCFullYear() ? {} : { year: "numeric" }),
  }).format(at);
  return `${date} ${time}`;
};

/** A day without year, as an alarm's end: "16.12." or "Dec 16". */
export const aiWakeupDay = (iso: string, input: { locale: string; timeZone: string }) =>
  new Intl.DateTimeFormat(input.locale, {
    timeZone: input.timeZone,
    day: de(input.locale) ? "2-digit" : "numeric",
    month: de(input.locale) ? "2-digit" : "short",
  }).format(new Date(iso));

/** A repeating alarm's rhythm in words in `locale`, never cron; one the words cannot name is "Custom schedule". */
export const aiWakeupRhythm = (cron: string, locale: string) => {
  const described = describeCodeSchedule(cron, locale);
  return described === cron ? (de(locale) ? "Eigener Rhythmus" : "Custom schedule") : described;
};
