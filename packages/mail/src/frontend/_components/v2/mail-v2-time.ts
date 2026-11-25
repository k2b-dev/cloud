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
