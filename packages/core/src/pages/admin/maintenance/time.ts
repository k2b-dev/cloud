import { type DateContext, dates } from "@k2b/stdlib";

const QUARTER_HOUR_MS = 15 * 60_000;
const HOUR_MS = 60 * 60_000;

/**
 * The end a new maintenance suggests: one hour from now, rounded up to the next quarter hour. Every time zone in use
 * is offset by whole quarter hours, so the rounded instant is also a quarter hour on the viewer's clock.
 */
export const defaultEnd = (now = Date.now()): string =>
  new Date(Math.ceil((now + HOUR_MS) / QUARTER_HOUR_MS) * QUARTER_HOUR_MS).toISOString();

/** As for the API and `cld`: a planned end must lie in the future. */
export const isFutureEnd = (iso: string, now = Date.now()): boolean => {
  const at = Date.parse(iso);
  return Number.isFinite(at) && at > now;
};

/** Today as a date key in the viewer's time zone: the earliest day the end picker offers. */
export const todayKey = (timeZone: string, now = Date.now()): string => dates.instantToZonedInput(new Date(now), timeZone).split("T")[0]!;

/** `14:02` today, otherwise with the date, in the viewer's time zone. */
export const formatClock = (iso: string, context: DateContext, now = Date.now()): string =>
  dates.isSameDay(new Date(iso), new Date(now), context) ? dates.formatTime(iso, context) : dates.formatDateTime(iso, context);
