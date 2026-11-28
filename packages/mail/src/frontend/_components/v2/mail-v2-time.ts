import { type DateContext, dates } from "@k2b/stdlib";

/**
 * When a list row's latest mail came, as the v2 mockup writes it: the time today ("09:42"), "gestern", the weekday
 * within the last week, else the date. Days follow the reader's time zone.
 */
export const mailV2RowTime = (value: string, config: DateContext, now = Date.now()): string =>
  dates.formatDateRelative(value, { ...config, base: new Date(now) });

/** When a message came, with its time: "heute, 09:42", "gestern, 16:02", else its day and time. */
export const mailV2MessageTime = (value: string, config: DateContext, now = Date.now()): string => {
  const time = new Intl.DateTimeFormat(config.locale, { hour: "2-digit", minute: "2-digit", timeZone: config.timeZone }).format(
    new Date(value),
  );
  const day = mailV2RowTime(value, config, now);
  // Today the row shows only its 24-hour time; a message names the day too.
  return /^\d{2}:\d{2}$/.test(day)
    ? `${new Intl.RelativeTimeFormat(config.locale, { numeric: "auto" }).format(0, "day")}, ${time}`
    : `${day}, ${time}`;
};

/** The day of a moment in the reader's time zone, as `YYYY-MM-DD`. */
const dayOf = (value: Date, timeZone: string | undefined) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(value);

/**
 * When something is due, such as a send that waits for its time, ahead or just past: its day in words while it is
 * near ("heute, 14:30", "morgen, 09:00", "gestern, 18:10"), else its weekday and date, with the year only when it
 * is another year. Days follow the reader's time zone.
 */
export const mailV2DueTime = (value: string, config: DateContext, now = Date.now()): string => {
  const date = new Date(value);
  const time = new Intl.DateTimeFormat(config.locale, { hour: "2-digit", minute: "2-digit", timeZone: config.timeZone }).format(date);
  const due = dayOf(date, config.timeZone);
  const today = dayOf(new Date(now), config.timeZone);
  const days = Math.round((Date.parse(due) - Date.parse(today)) / 86_400_000);
  if (Math.abs(days) <= 1) return `${new Intl.RelativeTimeFormat(config.locale, { numeric: "auto" }).format(days, "day")}, ${time}`;
  const day = new Intl.DateTimeFormat(config.locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(due.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }),
    timeZone: config.timeZone,
  }).format(date);
  return `${day}, ${time}`;
};
