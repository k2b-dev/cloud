import { type DateContext, dates } from "@k2b/stdlib";
import type { MailV2Text } from "./mail-v2-messages";

/** One time "Später" and "Erinnere mich" offer: its words, the real day as a quiet hint when it helps, the instant. */
export type MailV2LaterTime = { label: string; meta?: string; at: string };

/** The person's time zone for the offered times and the calendar: the configured one, else the browser's. */
export const mailV2TimeZone = (config: DateContext) =>
  dates.normalizeTimeZone(config.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);

/** Moves a date key ("2026-11-27") by whole days; the calendar, not the clock, so a DST change cannot shift it. */
const shiftDay = (key: string, days: number) => {
  const [year, month, day] = key.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};
/** The weekday of a date key: 0 is Sunday, 1 Monday. */
const weekdayOf = (key: string) => new Date(`${key}T00:00:00Z`).getUTCDay();

/**
 * The times "Später" and "Erinnere mich" offer before "Datum und Uhrzeit …", in the person's time zone and words:
 * "Heute, 17:00" while that is still ahead, "Morgen, 8:00", and the start of the next week at 8:00. On Friday and
 * Saturday the next week is only days away and is named by its day ("Montag, 8:00"); on Sunday it is tomorrow and is
 * left out. A wall time a DST change skips moves forward as the clock does.
 */
export const mailV2LaterTimes = (config: DateContext, text: MailV2Text, now = Date.now()): MailV2LaterTime[] => {
  const timeZone = mailV2TimeZone(config);
  const format = (at: string, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(config.locale, { ...options, timeZone }).format(new Date(at));
  const at = (day: string, time: string) => dates.zonedDateTimeToInstant(`${day}T${time}`, timeZone, { disambiguation: "compatible" });
  const clock = (instant: string) => format(instant, { hour: "numeric", minute: "2-digit" });
  const today = dates.instantToZonedInput(new Date(now), timeZone).slice(0, 10);
  const tomorrow = shiftDay(today, 1);
  const weekday = weekdayOf(today);
  const monday = shiftDay(today, (8 - weekday) % 7 || 7);

  const times: MailV2LaterTime[] = [];
  const evening = at(today, "17:00");
  if (Date.parse(evening) > now) times.push({ label: text.laterToday({ time: clock(evening) }), at: evening });
  const morning = at(tomorrow, "08:00");
  times.push({
    label: text.laterTomorrow({ time: clock(morning) }),
    meta: format(morning, { weekday: "short", day: "numeric", month: "short" }),
    at: morning,
  });
  if (monday !== tomorrow) {
    const week = at(monday, "08:00");
    times.push(
      weekday === 5 || weekday === 6
        ? {
            label: text.laterOnDay({ day: format(week, { weekday: "long" }), time: clock(week) }),
            meta: format(week, { day: "numeric", month: "short" }),
            at: week,
          }
        : {
            label: text.laterNextWeek,
            meta: format(week, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }),
            at: week,
          },
    );
  }
  return times;
};
