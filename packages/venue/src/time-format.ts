/**
 * Venue times read the same for everyone who looks at one Venue: always in the
 * Venue's time zone, in the reader's locale, and on a 24-hour clock like the
 * calendar grid and the HH:MM fields.
 */
const venueFormat = (timeZone: string, locale: string | undefined, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(locale, { ...options, timeZone, hourCycle: "h23" });

const HOUR_MINUTE = { hour: "2-digit", minute: "2-digit" } as const;
const DAY = { weekday: "short", day: "numeric", month: "short" } as const;

/** `14:00` */
export const formatVenueTime = (iso: string, timeZone: string, locale?: string): string =>
  venueFormat(timeZone, locale, HOUR_MINUTE).format(new Date(iso));

/** `Mon, Sep 28` / `Mo., 28. Sept.`: a day in the Venue's time zone, never with a zero-padded day. */
export const formatVenueDay = (iso: string, timeZone: string, locale?: string): string =>
  venueFormat(timeZone, locale, DAY).format(new Date(iso));

/** `14:00–18:00` for two venue clock times, such as opening hours; the one dash every Venue range uses. */
export const formatClockRange = (start: string, end: string): string => `${start}–${end}`;

/** `14:00–18:00`: the Venue's wall-clock times of a stretch between two instants. */
export const formatVenueTimeRange = (startsAt: string, endsAt: string, timeZone: string, locale?: string): string =>
  formatClockRange(formatVenueTime(startsAt, timeZone, locale), formatVenueTime(endsAt, timeZone, locale));

/** `Mon, Sep 28, 14:00` / `Mo., 28. Sept., 14:00` */
export const formatVenueDateTime = (iso: string, timeZone: string, locale?: string): string =>
  venueFormat(timeZone, locale, { ...DAY, ...HOUR_MINUTE }).format(new Date(iso));

/** `Mon, Sep 28 · 14:00–18:00`: the day a shift starts and its time range. */
export const formatVenueSpan = (startsAt: string, endsAt: string, timeZone: string, locale?: string): string =>
  `${formatVenueDay(startsAt, timeZone, locale)} · ${formatVenueTimeRange(startsAt, endsAt, timeZone, locale)}`;

/** A date key such as `2026-09-28` as a calendar day. Date keys name a day, so no time zone shifts them. */
export const formatDateKey = (
  dateKey: string,
  locale?: string,
  options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" },
): string => venueFormat("UTC", locale, options).format(new Date(`${dateKey}T12:00:00Z`));

/**
 * The time zone's name for the given times, in the reader's language: `Central European Summer Time` for
 * summer dates, `Central European Standard Time` for winter ones, and both when the times span a clock
 * change. Without times, the name that applies now. A zone without a localized name reads as its offset.
 */
export const timeZoneName = (timeZone: string, locale: string | undefined, times: readonly string[]): string => {
  const format = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "long" });
  const names = new Set(
    (times.length > 0 ? times : [new Date().toISOString()]).map(
      (time) => format.formatToParts(new Date(time)).find((part) => part.type === "timeZoneName")?.value ?? timeZone,
    ),
  );
  return new Intl.ListFormat(locale, { type: "conjunction" }).format([...names]);
};

/** `Wed 08:00` / `Mi. 08:00`: a start within the coming week. */
export const formatVenueWeekdayTime = (iso: string, timeZone: string, locale?: string): string =>
  venueFormat(timeZone, locale, { weekday: "short", ...HOUR_MINUTE }).format(new Date(iso));
