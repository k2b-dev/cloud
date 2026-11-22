import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";

import { formatList } from "./i18n";
import { publicHolidays } from "./holidays";

export type { GermanState, Holiday, HolidayKey, HolidayRegion } from "./holidays";
export { publicHolidays };

dayjs.extend(utc);
dayjs.extend(timezone);

// =============================================================================
// Types
// =============================================================================

export type DateContext = {
  /** IANA timezone, e.g. "Europe/Berlin" or "America/New_York". */
  timeZone?: string;
  /** BCP 47 locale tag, e.g. "en", "de", "fr". */
  locale?: string;
  /** First day of week. Defaults to ISO Monday. */
  weekStartsOn?: 0 | 1;
  /** Alias for weekStartsOn. Prefer this in app-facing code. */
  firstDayOfWeek?: 0 | 1;
};

export type RelativeDateContext = DateContext & {
  /** Base timestamp for relative formatting. Defaults to now. */
  base?: string | Date;
};

export type DstDisambiguation = "compatible" | "earlier" | "later" | "reject";

export type ZonedDateTimeToInstantOptions = {
  /**
   * How to handle ambiguous or nonexistent wall-clock times around DST
   * transitions. Defaults to "reject" for user input safety.
   */
  disambiguation?: DstDisambiguation;
};

export type ZonedAddOptions = ZonedDateTimeToInstantOptions & {
  timeZone: string;
  years?: number;
  months?: number;
  weeks?: number;
  days?: number;
  hours?: number;
  minutes?: number;
};

export type CalendarItemLike = {
  startsAt: string | null;
  endsAt: string | null;
  deadline: string | null;
};

export type CalendarUrlParams = {
  view?: "month" | "week";
  date?: Date;
  item?: string;
};

export type RecurrenceFrequency = "daily" | "weekly" | "monthly" | "yearly";

export type RecurrenceRule = {
  freq: RecurrenceFrequency;
  /** Repeat every n-th day/week/month/year. Defaults to 1. */
  interval?: number;
  /** Weekdays for weekly rules (0 = Sunday .. 6 = Saturday, like `Date#getDay`). */
  byWeekday?: number[];
  /** Last date the rule applies. */
  until?: string | Date;
  /** Total number of occurrences. */
  count?: number;
};

export type RecurrenceParts = {
  /** Localized interval + frequency unit, e.g. `"day"`, `"2 weeks"`, `"2 Wochen"`. */
  every: string;
  /** Localized weekday list for weekly rules, e.g. `"Tue and Wed"`, `"Di und Mi"`. */
  weekdays?: string;
  /** Localized until date, formatted like {@link formatDate}. */
  until?: string;
  /** Occurrence count, passed through from the rule. */
  count?: number;
};

// =============================================================================
// Internals (helpers)
// =============================================================================

const asDate = (input: string | Date): Date => (typeof input === "string" ? new Date(input) : input);

const pad2 = (value: number): string => String(value).padStart(2, "0");

const WALL_CLOCK_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

const contextLocale = (context: DateContext | undefined, fallback = "en"): string => context?.locale ?? fallback;

const contextTimeZone = (context: DateContext | undefined, fallback?: string): string | undefined => context?.timeZone ?? fallback;

const firstDayOfWeek = (context: DateContext | undefined): 0 | 1 => context?.firstDayOfWeek ?? context?.weekStartsOn ?? 1;

type TimeUnit = "second" | "minute" | "hour" | "day" | "week" | "month" | "year";

// Keep ICU objects across rows, without retaining every caller-supplied locale/zone forever.
// Budget: at most 64 ICU objects of each kind, regardless of caller-supplied variants.
const FORMATTER_CACHE_SIZE = 64;
const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const relativeFormatters = new Map<string, Intl.RelativeTimeFormat>();

const cachedFormatter = <T>(cache: Map<string, T>, key: string, create: () => T): T => {
  const cached = cache.get(key);
  if (cached) return cached;
  const formatter = create();
  if (cache.size >= FORMATTER_CACHE_SIZE) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, formatter);
  return formatter;
};

const dateFormatter = (locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat => {
  // Runtime-local calendar helpers must follow a changed host timezone, too.
  if (!options.timeZone) return new Intl.DateTimeFormat(locale, options);
  return cachedFormatter(dateFormatters, JSON.stringify([locale, options]), () => new Intl.DateTimeFormat(locale, options));
};

const relativeTime = (value: number, unit: TimeUnit, context?: DateContext): string => {
  const locale = contextLocale(context);
  return cachedFormatter(relativeFormatters, locale, () => new Intl.RelativeTimeFormat(locale, { numeric: "auto" })).format(value, unit);
};

const unitFormatter = (unit: TimeUnit, context?: DateContext): Intl.NumberFormat =>
  new Intl.NumberFormat(contextLocale(context), { style: "unit", unit, unitDisplay: "long" });

const formatUnit = (value: number, unit: TimeUnit, context?: DateContext): string =>
  unitFormatter(unit, context).format(value);

/** The localized unit name alone (e.g. "day" / "Tag"), without the number. */
const unitName = (unit: TimeUnit, context?: DateContext): string =>
  unitFormatter(unit, context)
    .formatToParts(1)
    .filter((part) => part.type === "unit")
    .map((part) => part.value)
    .join("");

const zoned = (input: string | Date, context?: DateContext, fallbackTimeZone?: string): dayjs.Dayjs => {
  const zone = contextTimeZone(context, fallbackTimeZone);
  const value = asDate(input);
  return zone ? dayjs(value).tz(zone) : dayjs(value);
};

const zonedNow = (context?: DateContext, fallbackTimeZone?: string): dayjs.Dayjs => {
  const zone = contextTimeZone(context, fallbackTimeZone);
  return zone ? dayjs().tz(zone) : dayjs();
};

const zonedLocalDate = (year: number, month: number, day: number, context?: DateContext): dayjs.Dayjs => {
  if (!context?.timeZone) return dayjs(new Date(year, month, day));

  // Preserve JavaScript Date overflow semantics (e.g. Jan 31 + 1 month = Mar 3)
  // before anchoring the resulting civil date in the requested timezone.
  const overflow = new Date(Date.UTC(year, month, day));
  const y = overflow.getUTCFullYear();
  const m = overflow.getUTCMonth() + 1;
  const d = overflow.getUTCDate();
  return dayjs.tz(`${y}-${pad2(m)}-${pad2(d)}`, context.timeZone);
};

const startOfZonedDay = (input: string | Date, context?: DateContext): Date => {
  if (!context?.timeZone) {
    const d = asDate(input);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
  return zoned(input, context).startOf("day").toDate();
};

const endOfZonedDay = (input: string | Date, context?: DateContext): Date => {
  if (!context?.timeZone) {
    const d = asDate(input);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  }
  return zoned(input, context).endOf("day").toDate();
};

const weekStart = (input: string | Date, context?: DateContext): dayjs.Dayjs => {
  const d = zoned(input, context);
  const firstDay = firstDayOfWeek(context);
  const diff = (d.day() - firstDay + 7) % 7;
  const start = d.subtract(diff, "day");
  return zonedLocalDate(start.year(), start.month(), start.date(), context);
};

const weekEnd = (input: string | Date, context?: DateContext): Date => {
  const start = weekStart(input, context);
  const end = zonedLocalDate(start.year(), start.month(), start.date() + 6, context).endOf("day");
  return end.toDate();
};

const monthName = (input: string | Date, context?: DateContext, width: "short" | "long" = "long", fallbackTimeZone?: string): string =>
  dateFormatter(contextLocale(context), {
    month: width,
    timeZone: contextTimeZone(context, fallbackTimeZone),
  }).format(asDate(input));

const weekdayName = (input: string | Date, context?: DateContext, width: "short" | "long" = "short", fallbackTimeZone?: string): string =>
  dateFormatter(contextLocale(context), {
    weekday: width,
    timeZone: contextTimeZone(context, fallbackTimeZone),
  }).format(asDate(input));

const sameZonedDay = (a: string | Date, b: string | Date, context?: DateContext, fallbackTimeZone?: string): boolean => {
  const da = zoned(a, context, fallbackTimeZone);
  const db = zoned(b, context, fallbackTimeZone);
  return da.year() === db.year() && da.month() === db.month() && da.date() === db.date();
};

type WallClockParts = {
  source: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  hasSeconds: boolean;
  hasMilliseconds: boolean;
};

const parseWallClock = (input: string): WallClockParts => {
  const match = WALL_CLOCK_RE.exec(input);
  if (!match) {
    throw new TypeError(`Expected datetime-local value in YYYY-MM-DDTHH:mm format, got "${input}"`);
  }
  const [, y, mo, d, h, mi, s, ms] = match;
  const parts: WallClockParts = {
    source: input,
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: Number(h),
    minute: Number(mi),
    second: s === undefined ? 0 : Number(s),
    millisecond: ms === undefined ? 0 : Number(ms.padEnd(3, "0")),
    hasSeconds: s !== undefined,
    hasMilliseconds: ms !== undefined,
  };
  if (
    parts.month < 1 ||
    parts.month > 12 ||
    parts.day < 1 ||
    parts.day > 31 ||
    parts.hour > 23 ||
    parts.minute > 59 ||
    parts.second > 59
  ) {
    throw new TypeError(`Invalid datetime-local value "${input}"`);
  }
  return parts;
};

type WallClockTuple = [
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
];

const DAY_MS = 86_400_000;
const zonedDateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

const getZonedDateTimeFormatter = (timeZone: string): Intl.DateTimeFormat => {
  const cached = zonedDateTimeFormatters.get(timeZone);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "iso8601",
    numberingSystem: "latn",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
  zonedDateTimeFormatters.set(timeZone, formatter);
  return formatter;
};

const wallClockTuple = (parts: WallClockParts): WallClockTuple => [
  parts.year,
  parts.month,
  parts.day,
  parts.hour,
  parts.minute,
  parts.second,
  parts.millisecond,
];

const zonedWallClockTuple = (instantMs: number, timeZone: string): WallClockTuple => {
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let millisecond = 0;

  for (const part of getZonedDateTimeFormatter(timeZone).formatToParts(new Date(instantMs))) {
    const value = Number(part.value);
    if (part.type === "year") year = value;
    else if (part.type === "month") month = value;
    else if (part.type === "day") day = value;
    else if (part.type === "hour") hour = value;
    else if (part.type === "minute") minute = value;
    else if (part.type === "second") second = value;
    else if (part.type === "fractionalSecond") millisecond = value;
  }

  return [year, month, day, hour, minute, second, millisecond];
};

const wallClockTupleToUtc = ([year, month, day, hour, minute, second, millisecond]: WallClockTuple): number =>
  Date.UTC(year, month - 1, day, hour, minute, second, millisecond);

const sameWallClock = (left: WallClockTuple, right: WallClockTuple): boolean =>
  left.every((value, index) => value === right[index]);

const wallClockToNaiveDayjs = (input: string): dayjs.Dayjs => {
  const parts = parseWallClock(input);
  return dayjs.utc(
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond),
  );
};

const applyZonedAdd = (input: string, options: ZonedAddOptions): string => {
  let result = wallClockToNaiveDayjs(input);
  if (options.years) result = result.add(options.years, "year");
  if (options.months) result = result.add(options.months, "month");
  if (options.weeks) result = result.add(options.weeks, "week");
  if (options.days) result = result.add(options.days, "day");
  if (options.hours) result = result.add(options.hours, "hour");
  if (options.minutes) result = result.add(options.minutes, "minute");
  return result.format("YYYY-MM-DDTHH:mm");
};

const candidateInstantsForWallClock = (parts: WallClockParts, timeZone: string): Date[] => {
  const expected = wallClockTuple(parts);
  const naiveUtc = wallClockTupleToUtc(expected);
  const offsets = new Set<number>();
  const candidates: Date[] = [];

  // Every IANA offset is within one day of UTC. Sampling both sides finds the
  // offsets around gaps and overlaps without scanning every possible offset.
  for (const probe of [naiveUtc - DAY_MS, naiveUtc + DAY_MS]) {
    offsets.add(wallClockTupleToUtc(zonedWallClockTuple(probe, timeZone)) - probe);
  }

  for (const offset of offsets) {
    const instantMs = naiveUtc - offset;
    if (sameWallClock(zonedWallClockTuple(instantMs, timeZone), expected)) {
      candidates.push(new Date(instantMs));
    }
  }

  return candidates.sort((a, b) => a.getTime() - b.getTime());
};

const defaultShiftedInstant = (input: string, timeZone: string): Date =>
  dayjs.tz(input, timeZone).toDate();

// =============================================================================
// Timezones
// =============================================================================

const validTimeZoneOrNull = (value: string | null | undefined): string | null => {
  const timeZone = typeof value === "string" ? value.trim() : "";
  try {
    if (!timeZone) return null;
    getZonedDateTimeFormatter(timeZone);
    return timeZone;
  } catch {
    return null;
  }
};

export const isValidTimeZone = (value: string | null | undefined): boolean => validTimeZoneOrNull(value) !== null;

export const normalizeTimeZone = (value: string | null | undefined, fallback: string | null | undefined = "UTC"): string =>
  validTimeZoneOrNull(value) ?? validTimeZoneOrNull(fallback) ?? "UTC";

/**
 * Convert a timezone-local wall-clock datetime to a UTC ISO instant.
 *
 * The input matches native `datetime-local` values (`YYYY-MM-DDTHH:mm`, with
 * optional seconds/milliseconds). By default the function rejects nonexistent
 * and ambiguous DST times so user input cannot silently shift.
 */
export const zonedDateTimeToInstant = (
  input: string,
  timeZone: string,
  options: ZonedDateTimeToInstantOptions = {},
): string => {
  const zone = normalizeTimeZone(timeZone);
  const disambiguation = options.disambiguation ?? "reject";
  const parts = parseWallClock(input);
  const candidates = candidateInstantsForWallClock(parts, zone);

  if (candidates.length === 1) return candidates[0]!.toISOString();

  if (candidates.length > 1) {
    if (disambiguation === "reject") {
      throw new RangeError(`Ambiguous datetime-local value "${input}" in timezone "${zone}"`);
    }
    const selected = disambiguation === "later" ? candidates[candidates.length - 1]! : candidates[0]!;
    return selected.toISOString();
  }

  if (disambiguation === "reject" || disambiguation === "earlier") {
    throw new RangeError(`Nonexistent datetime-local value "${input}" in timezone "${zone}"`);
  }

  return defaultShiftedInstant(input, zone).toISOString();
};

/**
 * Convert a UTC instant to a `datetime-local` input value in an IANA timezone.
 */
export const instantToZonedInput = (input: string | Date, timeZone: string): string => {
  const date = asDate(input);
  const zone = normalizeTimeZone(timeZone);
  if (Number.isNaN(date.getTime())) {
    const invalid = dayjs(date).tz(zone);
    return `${invalid.year()}-${pad2(invalid.month() + 1)}-${pad2(invalid.date())}T${pad2(invalid.hour())}:${pad2(invalid.minute())}`;
  }

  const [year, month, day, hour, minute] = zonedWallClockTuple(date.getTime(), zone);
  return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}`;
};

// =============================================================================
// Formatting
// =============================================================================

/**
 * Format a date in locale order, e.g. `"Mar 5, 2025"` or `"5. März 2025"`.
 * Use `style: "numeric"` for a two-digit day/month and numeric year.
 *
 * Defaults to UTC for backward compatibility. Pass `timeZone` to format the
 * same instant in an explicit IANA timezone.
 */
export const formatDate = (input: string | Date, context?: DateContext & { style?: "numeric" }): string =>
  dateFormatter(contextLocale(context), {
    day: context?.style === "numeric" ? "2-digit" : "numeric",
    month: context?.style === "numeric" ? "2-digit" : "short",
    year: "numeric", timeZone: contextTimeZone(context, "UTC"),
  }).format(asDate(input));

/**
 * Format a date and time as `"Mar 5, 2025, 13:53"`.
 *
 * Defaults to UTC for backward compatibility. Pass `timeZone` to format the
 * same instant in an explicit IANA timezone.
 */
export const formatDateTime = (input: string | Date, context?: DateContext): string => {
  const date = asDate(input);
  // Formatting an instant needs no localized-string parse or Dayjs timezone conversion.
  // Keep the existing ASCII, 24-hour HH:mm clock, independently of the date locale.
  const clock = dateFormatter("en-GB", {
    timeZone: contextTimeZone(context, "UTC"),
    numberingSystem: "latn", hourCycle: "h23", hour: "2-digit", minute: "2-digit",
  }).format(date);
  return `${formatDate(date, context)}, ${clock}`;
};

/**
 * Format a date/time as a human-friendly relative string.
 *
 * Time arithmetic uses absolute milliseconds. Wording comes from
 * `Intl.RelativeTimeFormat` in the context locale (default `"en"`). Day labels
 * and fallback absolute dates are rendered in the requested timezone,
 * defaulting to UTC.
 */
export const formatDateTimeRelative = (input: string | Date, context?: RelativeDateContext): string => {
  const d = asDate(input);
  const base = context?.base ? asDate(context.base) : new Date();
  const diffMs = base.getTime() - d.getTime();

  if (diffMs < 0) return formatDate(d, context);
  if (diffMs < 5_000) return relativeTime(0, "second", context);
  if (diffMs < 60_000) return relativeTime(-Math.max(1, Math.floor(diffMs / 1_000)), "second", context);
  if (diffMs < 60 * 60 * 1000) return relativeTime(-Math.max(1, Math.floor(diffMs / (60 * 1000))), "minute", context);
  if (diffMs < 24 * 60 * 60 * 1000) return relativeTime(-Math.max(1, Math.floor(diffMs / (60 * 60 * 1000))), "hour", context);
  if (diffMs < 48 * 60 * 60 * 1000) return relativeTime(-1, "day", context);
  if (diffMs < 7 * 24 * 60 * 60 * 1000) return weekdayName(d, context, "short", "UTC");
  return formatDate(d, context);
};

/**
 * Format a date relative to now with day-level granularity.
 *
 * Day boundaries are evaluated in the requested timezone, defaulting to UTC
 * for backward compatibility.
 */
export const formatDateRelative = (input: string | Date, context?: RelativeDateContext): string => {
  const d = asDate(input);
  const base = context?.base ? asDate(context.base) : new Date();
  if (d.getTime() > base.getTime()) return formatDate(d, context);

  const todayStart = zoned(base, context, "UTC").startOf("day");
  const dateDay = zoned(d, context, "UTC").startOf("day");
  const diffDays = todayStart.diff(dateDay, "day");

  if (diffDays === 0) {
    const time = zoned(d, context, "UTC");
    return `${pad2(time.hour())}:${pad2(time.minute())}`;
  }
  if (diffDays === 1) return relativeTime(-1, "day", context);
  if (diffDays < 7) return weekdayName(d, context, "short", "UTC");
  return formatDate(d, context);
};

/**
 * Format a timestamp relative to a base time using `Intl.RelativeTimeFormat`.
 *
 * Timezone does not affect elapsed time, but `locale` controls the wording
 * (default `"en"`). Pass `base` in the context for deterministic output.
 */
export const formatTimeSpan = (input: string | Date, context?: RelativeDateContext): string => {
  const target = asDate(input);
  const origin = context?.base ? asDate(context.base) : new Date();
  const diffMs = target.getTime() - origin.getTime();
  const absMs = Math.abs(diffMs);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;

  if (absMs < hour) return relativeTime(Math.round(diffMs / minute), "minute", context);
  if (absMs < day) return relativeTime(Math.round(diffMs / hour), "hour", context);
  if (absMs < week) return relativeTime(Math.round(diffMs / day), "day", context);
  return relativeTime(Math.round(diffMs / week), "week", context);
};

/**
 * Format an absolute duration between two timestamps as a human-readable
 * string, e.g. `"2 hours, 30 minutes"` / `"2 Stunden, 30 Minuten"`.
 *
 * At most two units are shown. Durations under one minute render as
 * `"< 1 minute"` in the context locale.
 */
export const formatDuration = (from: string | Date, to: string | Date, context?: DateContext): string => {
  const start = asDate(from);
  const end = asDate(to);
  const diffMs = Math.abs(end.getTime() - start.getTime());
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diffMs < minute) return `< ${formatUnit(1, "minute", context)}`;

  const days = Math.floor(diffMs / day);
  const hours = Math.floor((diffMs % day) / hour);
  const minutes = Math.floor((diffMs % hour) / minute);

  const parts =
    days > 0
      ? [formatUnit(days, "day", context), hours > 0 ? formatUnit(hours, "hour", context) : null]
      : hours > 0
        ? [formatUnit(hours, "hour", context), minutes > 0 ? formatUnit(minutes, "minute", context) : null]
        : [formatUnit(minutes, "minute", context)];
  return parts.filter(Boolean).join(", ");
};

export const formatMonthYear = (date: Date, context?: DateContext): string => {
  const z = zoned(date, context);
  return `${monthName(date, context, "long")} ${z.year()}`;
};

export const formatDayNumber = (date: Date, context?: DateContext): string => String(zoned(date, context).date());

export const formatWeekdayShort = (date: Date, context?: DateContext): string =>
  weekdayName(date, context, "short").slice(0, 2);

export const formatWeekdayLong = (date: Date, context?: DateContext): string => weekdayName(date, context, "long");

export const formatFullDate = (date: Date, context?: DateContext): string => {
  const z = zoned(date, context);
  return `${z.date()}. ${monthName(date, context, "long")} ${z.year()}`;
};

/**
 * Format a recurrence rule into localized building blocks.
 *
 * All parts come from `Intl` (unit names, weekday names, list separators,
 * dates), so any locale works without shipped translations. Connective words
 * like "every" or "until" are sentence structure and belong to the consumer's
 * message catalog; {@link formatRecurrence} provides an English default.
 *
 * @example
 * dates.formatRecurrenceParts(
 *   { freq: "weekly", byWeekday: [2, 3], until: new Date("2024-12-23") },
 *   { locale: "de" },
 * )
 * // { every: "Woche", weekdays: "Di und Mi", until: "23. Dez. 2024" }
 */
export const formatRecurrenceParts = (rule: RecurrenceRule, context?: DateContext): RecurrenceParts => {
  const interval = Math.max(1, Math.trunc(rule.interval ?? 1));
  const unit = ({ daily: "day", weekly: "week", monthly: "month", yearly: "year" } as const)[rule.freq];
  const locale = contextLocale(context);

  const weekdayLabels = rule.byWeekday?.map((weekday) =>
    weekdayName(zonedLocalDate(2024, 0, 7 + weekday, context).toDate(), context, "short"),
  );

  return {
    every: interval === 1 ? unitName(unit, context) : formatUnit(interval, unit, context),
    ...(weekdayLabels?.length ? { weekdays: formatList(weekdayLabels, locale) } : {}),
    ...(rule.until ? { until: formatDate(rule.until, context) } : {}),
    ...(rule.count !== undefined ? { count: rule.count } : {}),
  };
};

/**
 * Format a recurrence rule as an English sentence, e.g.
 * `"Every Tue and Wed until Dec 23, 2024"` or `"Every 2 weeks, 6 times"`.
 *
 * Only the sentence skeleton is English; weekday names, unit names, and dates
 * follow the context locale. For fully localized sentences, build them from
 * {@link formatRecurrenceParts} with your own message catalog.
 */
export const formatRecurrence = (rule: RecurrenceRule, context?: DateContext): string => {
  const parts = formatRecurrenceParts(rule, context);
  const interval = Math.max(1, Math.trunc(rule.interval ?? 1));

  let result =
    parts.weekdays && interval === 1
      ? `Every ${parts.weekdays}`
      : `Every ${parts.every}${parts.weekdays ? ` on ${parts.weekdays}` : ""}`;
  if (parts.until) result += ` until ${parts.until}`;
  if (parts.count !== undefined) result += `, ${parts.count} times`;
  return result;
};

export const formatDateShort = (date: Date, context?: DateContext): string => {
  const z = zoned(date, context);
  return `${z.date()}.${z.month() + 1}.`;
};

export const formatDateKey = (input: string | Date, context?: DateContext): string => {
  const z = zoned(input, context);
  return `${z.year()}-${pad2(z.month() + 1)}-${pad2(z.date())}`;
};

export const formatTime = (input: string | Date, context?: DateContext): string => {
  const d = zoned(input, context);
  return `${pad2(d.hour())}:${pad2(d.minute())}`;
};

// =============================================================================
// Comparison
// =============================================================================

export const isToday = (date: Date, context?: DateContext): boolean => sameZonedDay(date, new Date(), context);

export const isSameMonth = (date: Date, refDate: Date, context?: DateContext): boolean => {
  const a = zoned(date, context);
  const b = zoned(refDate, context);
  return a.year() === b.year() && a.month() === b.month();
};

export const isSameDay = (a: Date, b: Date, context?: DateContext): boolean => sameZonedDay(a, b, context);

// =============================================================================
// Arithmetic & Navigation
// =============================================================================

export const startOfDay = (input: string | Date, context?: DateContext): Date => startOfZonedDay(input, context);

export const endOfDay = (input: string | Date, context?: DateContext): Date => endOfZonedDay(input, context);

export const addMonths = (date: Date, n: number, context?: DateContext): Date => {
  if (!context?.timeZone) return new Date(date.getFullYear(), date.getMonth() + n, date.getDate());
  const z = zoned(date, context);
  return zonedLocalDate(z.year(), z.month() + n, z.date(), context).toDate();
};

export const addWeeks = (date: Date, n: number, context?: DateContext): Date => addDays(date, n * 7, context);

export const addDays = (date: Date, n: number, context?: DateContext): Date => {
  if (!context?.timeZone) return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
  const z = zoned(date, context);
  return zonedLocalDate(z.year(), z.month(), z.date() + n, context).toDate();
};

export const startOfMonth = (date: Date, context?: DateContext): Date => {
  if (!context?.timeZone) return new Date(date.getFullYear(), date.getMonth(), 1);
  const z = zoned(date, context);
  return zonedLocalDate(z.year(), z.month(), 1, context).toDate();
};

export const startOfWeek = (date: Date, context?: DateContext): Date => weekStart(date, context).toDate();

export const today = (context?: DateContext): Date => startOfDay(new Date(), context);

export const addZoned = (input: string, options: ZonedAddOptions): string => applyZonedAdd(input, options);

export const addZonedInstant = (input: string | Date, options: ZonedAddOptions): string => {
  const timeZone = normalizeTimeZone(options.timeZone);
  const wallClock = instantToZonedInput(input, timeZone);
  const next = addZoned(wallClock, options);
  return zonedDateTimeToInstant(next, timeZone, { disambiguation: options.disambiguation });
};

// =============================================================================
// Calendar Views
// =============================================================================

export const getMonthGrid = (year: number, month: number, context?: DateContext): Date[][] => {
  const first = zonedLocalDate(year, month, 1, context);
  const start = weekStart(first.toDate(), context);

  const weeks: Date[][] = [];
  let current = start;

  for (let w = 0; w < 6; w++) {
    const week = Array.from({ length: 7 }, (_, d) =>
      zonedLocalDate(current.year(), current.month(), current.date() + d, context).toDate(),
    );
    weeks.push(week);
    current = zonedLocalDate(current.year(), current.month(), current.date() + 7, context);

    if (current.month() !== month && w >= 3) break;
  }

  return weeks;
};

export const getWeekDays = (date: Date, context?: DateContext): Date[] => {
  const start = weekStart(date, context);
  return Array.from({ length: 7 }, (_, i) =>
    zonedLocalDate(start.year(), start.month(), start.date() + i, context).toDate(),
  );
};

export const getDateRange = (view: "month" | "week", date: Date, context?: DateContext): { from: Date; to: Date } => {
  if (view === "month") {
    const z = zoned(date, context);
    const first = zonedLocalDate(z.year(), z.month(), 1, context);
    const last = zonedLocalDate(z.year(), z.month() + 1, 0, context);
    return { from: weekStart(first.toDate(), context).toDate(), to: weekEnd(last.toDate(), context) };
  }

  return { from: weekStart(date, context).toDate(), to: weekEnd(date, context) };
};

// =============================================================================
// Calendar Item Filtering
// =============================================================================

export const itemOnDate = (item: CalendarItemLike, date: Date, context?: DateContext): boolean => {
  const dayStart = startOfZonedDay(date, context);
  const dayEnd = endOfZonedDay(date, context);

  if (item.startsAt && item.endsAt) {
    const start = asDate(item.startsAt);
    const end = asDate(item.endsAt);
    return start.getTime() < dayEnd.getTime() && end.getTime() > dayStart.getTime();
  }

  if (item.deadline) return sameZonedDay(item.deadline, date, context);

  return false;
};

export const getDayItems = <T extends CalendarItemLike>(items: T[], date: Date, context?: DateContext): T[] =>
  items.filter((item) => itemOnDate(item, date, context));

// =============================================================================
// Constants & Generators
// =============================================================================

export const weekdays = (context?: DateContext): string[] =>
  Array.from({ length: 7 }, (_, i) => {
    const d = zonedLocalDate(2024, 0, i + 1, context).toDate();
    return weekdayName(d, context, "short");
  });

export const months = (context?: DateContext): string[] => {
  return Array.from({ length: 12 }, (_, i) => {
    const d = zonedLocalDate(2024, i, 1, context).toDate();
    return monthName(d, context, "long");
  });
};

export const getYearOptions = (context?: DateContext): number[] => {
  const current = zonedNow(context).year();
  return Array.from({ length: 11 }, (_, i) => current - 5 + i);
};

// =============================================================================
// URL Helpers
// =============================================================================

export const buildCalendarUrl = (baseUrl: string, params: CalendarUrlParams, context?: DateContext): string => {
  const [path, query] = baseUrl.split("?");
  const searchParams = new URLSearchParams(query ?? "");

  searchParams.set("view", "calendar");

  if (params.view) searchParams.set("cv", params.view);
  else searchParams.delete("cv");

  if (params.date) searchParams.set("cd", formatDateKey(params.date, context));
  else searchParams.delete("cd");

  if (params.item) searchParams.set("item", params.item);
  else searchParams.delete("item");

  return `${path}?${searchParams.toString()}`;
};

export const parseCalendarDate = (param: string | undefined, context?: DateContext): Date => {
  if (!param) return today(context);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(param);
  if (match) {
    const [, y, m, d] = match;
    const date = zonedLocalDate(Number(y), Number(m) - 1, Number(d), context);
    if (date.isValid()) return date.toDate();
  }

  const lenient = asDate(param);
  if (!isNaN(lenient.getTime())) return startOfZonedDay(lenient, context);
  return today(context);
};

// =============================================================================
// Namespace Export
// =============================================================================

export const dates = {
  // Timezones
  isValidTimeZone,
  normalizeTimeZone,
  zonedDateTimeToInstant,
  instantToZonedInput,
  // Formatting
  formatDate,
  formatDateTime,
  formatDateTimeRelative,
  formatDateRelative,
  formatTimeSpan,
  formatDuration,
  formatMonthYear,
  formatDayNumber,
  formatWeekdayShort,
  formatWeekdayLong,
  formatFullDate,
  formatDateShort,
  formatDateKey,
  formatTime,
  formatRecurrence,
  formatRecurrenceParts,
  // Comparison
  isToday,
  isSameMonth,
  isSameDay,
  // Arithmetic
  startOfDay,
  endOfDay,
  addMonths,
  addWeeks,
  addDays,
  startOfMonth,
  startOfWeek,
  today,
  addZoned,
  addZonedInstant,
  // Calendar views
  getMonthGrid,
  getWeekDays,
  getDateRange,
  itemOnDate,
  getDayItems,
  // Holidays
  publicHolidays,
  // Constants & generators
  weekdays,
  months,
  getYearOptions,
  // URL helpers
  buildCalendarUrl,
  parseCalendarDate,
} as const;
