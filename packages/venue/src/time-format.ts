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

/** `Mon, Sep 28, 14:00` / `Mo., 28. Sept., 14:00` */
export const formatVenueDateTime = (iso: string, timeZone: string, locale?: string): string =>
  venueFormat(timeZone, locale, { ...DAY, ...HOUR_MINUTE }).format(new Date(iso));

/** `Mon, Sep 28 · 14:00–18:00`: the day a shift starts and its time range. */
export const formatVenueSpan = (startsAt: string, endsAt: string, timeZone: string, locale?: string): string =>
  `${venueFormat(timeZone, locale, DAY).format(new Date(startsAt))} · ${formatVenueTime(startsAt, timeZone, locale)}–${formatVenueTime(endsAt, timeZone, locale)}`;

/** A date key such as `2026-09-28` as a calendar day. Date keys name a day, so no time zone shifts them. */
export const formatDateKey = (
  dateKey: string,
  locale?: string,
  options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" },
): string => venueFormat("UTC", locale, options).format(new Date(`${dateKey}T12:00:00Z`));

/** The time zone's name in the reader's language, such as `Central European Time`; the IANA ID when there is none. */
export const timeZoneName = (timeZone: string, locale?: string, at = new Date()): string =>
  new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "longGeneric" }).formatToParts(at).find((part) => part.type === "timeZoneName")
    ?.value ?? timeZone;
