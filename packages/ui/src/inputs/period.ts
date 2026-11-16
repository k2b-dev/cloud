import { dates } from "@k2b/stdlib";

/**
 * A period as an app stores it: a preset key that stays relative ("this month" is next month's month too), or two
 * explicit days. Days are date keys such as `2026-11-01`; `end` is inclusive.
 */
export type PeriodValue = { preset: string } | { start: string; end: string };

/** Inclusive days of a period. `null` is an open edge, for example "All time" without a known first day. */
export type PeriodRange = { start: string | null; end: string | null };

/** What a preset resolves against: today in the period's time zone and the first day of the week. */
export type PeriodContext = { today: string; weekStartsOn: 0 | 1 };

export type PeriodPreset = {
  key: string;
  /** Shown in the list and the trigger. Built-in presets bring a translated label; app presets name their own. */
  label?: string;
  resolve: (context: PeriodContext) => PeriodRange;
};

/** The clock a period is resolved with. Server and browser pass the same values so the first render agrees. */
export type PeriodClock = {
  /** The instant "today" is read from; defaults to now. */
  now?: Date;
  /** IANA time zone the days belong to, for example a base's zone; defaults to the runtime zone. */
  timeZone?: string;
  /** First day of the week, as in the calendar's date config; Monday by default. */
  weekStartsOn?: 0 | 1;
  /** Alias of `weekStartsOn`, accepted from a shared date config. */
  firstDayOfWeek?: 0 | 1;
};

const keyDate = (key: string): Date => new Date(`${key}T00:00:00Z`);
const dateKeyOf = (date: Date): string => date.toISOString().slice(0, 10);
const day = (year: number, month: number, date: number): string => dateKeyOf(new Date(Date.UTC(year, month, date)));
const parts = (key: string) => ({ year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)) - 1, date: Number(key.slice(8, 10)) });

/** Adds whole days to a date key; calendar days, so a DST change never moves it. */
export const addPeriodDays = (key: string, count: number): string => {
  const date = keyDate(key);
  date.setUTCDate(date.getUTCDate() + count);
  return dateKeyOf(date);
};

/** Number of days in an inclusive range of date keys. */
export const periodDayCount = (range: { start: string; end: string }): number =>
  Math.round((keyDate(range.end).getTime() - keyDate(range.start).getTime()) / 86_400_000) + 1;

const month = (key: string, offset: number): PeriodRange => {
  const { year, month } = parts(key);
  return { start: day(year, month + offset, 1), end: day(year, month + offset + 1, 0) };
};
const quarter = (key: string, offset: number): PeriodRange => {
  const { year, month } = parts(key);
  const first = Math.floor(month / 3) * 3 + offset * 3;
  return { start: day(year, first, 1), end: day(year, first + 3, 0) };
};
const year = (key: string, offset: number): PeriodRange => {
  const value = parts(key).year + offset;
  return { start: `${value}-01-01`, end: `${value}-12-31` };
};
const week = (context: PeriodContext, offset: number): PeriodRange => {
  const weekday = keyDate(context.today).getUTCDay();
  const start = addPeriodDays(context.today, -((weekday - context.weekStartsOn + 7) % 7) + offset * 7);
  return { start, end: addPeriodDays(start, 6) };
};

/**
 * Built-in presets. Each covers its whole calendar period ("This month" is the 1st to the last day, not up to
 * today) in the period's time zone; weeks start on the context's first day of the week.
 */
export const periodPresets = {
  today: { key: "today", resolve: ({ today }) => ({ start: today, end: today }) },
  yesterday: { key: "yesterday", resolve: ({ today }) => ({ start: addPeriodDays(today, -1), end: addPeriodDays(today, -1) }) },
  thisWeek: { key: "this-week", resolve: (context) => week(context, 0) },
  lastWeek: { key: "last-week", resolve: (context) => week(context, -1) },
  thisMonth: { key: "this-month", resolve: ({ today }) => month(today, 0) },
  lastMonth: { key: "last-month", resolve: ({ today }) => month(today, -1) },
  thisQuarter: { key: "this-quarter", resolve: ({ today }) => quarter(today, 0) },
  lastQuarter: { key: "last-quarter", resolve: ({ today }) => quarter(today, -1) },
  thisYear: { key: "this-year", resolve: ({ today }) => year(today, 0) },
  lastYear: { key: "last-year", resolve: ({ today }) => year(today, -1) },
  /** Everything up to today; `since` is the first day with data when the app knows it, else the start stays open. */
  all: (options: { since?: string | null } = {}): PeriodPreset => ({
    key: "all",
    resolve: ({ today }) => ({ start: options.since ?? null, end: today }),
  }),
} satisfies Record<string, PeriodPreset | ((options?: { since?: string | null }) => PeriodPreset)>;

const dateKeyPattern = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar day key, not only the shape (`2026-02-30` is refused). */
export const isPeriodDay = (value: unknown): value is string => {
  if (typeof value !== "string" || !dateKeyPattern.test(value)) return false;
  const date = keyDate(value);
  return !Number.isNaN(date.getTime()) && dateKeyOf(date) === value;
};

/** Accepts a stored or URL value only when it is a known preset key or two real days in order. */
export const parsePeriodValue = (value: unknown, presets: readonly PeriodPreset[]): PeriodValue | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.preset === "string")
    return presets.some((preset) => preset.key === candidate.preset) ? { preset: candidate.preset } : undefined;
  if (isPeriodDay(candidate.start) && isPeriodDay(candidate.end) && candidate.start <= candidate.end)
    return { start: candidate.start, end: candidate.end };
  return undefined;
};

/** The context presets resolve against: today in the clock's time zone. */
export const periodContext = (clock: PeriodClock = {}): PeriodContext => ({
  today: dates.formatDateKey(clock.now ?? new Date(), { timeZone: clock.timeZone }),
  weekStartsOn: clock.weekStartsOn ?? clock.firstDayOfWeek ?? 1,
});

/**
 * Resolves a value to inclusive days. Returns `undefined` for a preset key the list does not contain, so a stored
 * period that no longer exists is never silently replaced.
 */
export const resolvePeriod = (value: PeriodValue, presets: readonly PeriodPreset[], clock: PeriodClock = {}): PeriodRange | undefined => {
  if (!("preset" in value)) return { start: value.start, end: value.end };
  return presets.find((preset) => preset.key === value.preset)?.resolve(periodContext(clock));
};

/**
 * The instants a query uses for a resolved period: `from` is the start of the first day and `to` the start of the
 * day after the last one (exclusive), both in the time zone. Days are never assumed to last 24 hours.
 */
export const periodInstants = (range: PeriodRange, timeZone: string): { from: string | null; to: string | null } => {
  const midnight = (key: string) => dates.zonedDateTimeToInstant(`${key}T00:00`, timeZone, { disambiguation: "compatible" });
  return { from: range.start ? midnight(range.start) : null, to: range.end ? midnight(addPeriodDays(range.end, 1)) : null };
};

/**
 * How a period steps to its neighbour: whole months for a period from the first day of a month to the last day of a
 * month (a month, a quarter, a year), else its own number of days (a day, a week, any other range).
 */
export type PeriodStep = { months: number } | { days: number };

/** What a period is, for its text and the way back to the current one. */
export type PeriodKind = "day" | "week" | "month" | "quarter" | "year" | "range";

const monthIndex = (key: string): number => parts(key).year * 12 + parts(key).month;
const daysBetween = (from: string, to: string): number => Math.round((keyDate(to).getTime() - keyDate(from).getTime()) / 86_400_000);

/** The step of a period; `undefined` for an open edge, which has no neighbour. */
export const periodStep = (range: PeriodRange): PeriodStep | undefined => {
  if (!range.start || !range.end) return undefined;
  if (range.start.endsWith("-01") && addPeriodDays(range.end, 1).endsWith("-01"))
    return { months: monthIndex(range.end) - monthIndex(range.start) + 1 };
  return { days: periodDayCount({ start: range.start, end: range.end }) };
};

/** The period `count` steps away: `-1` is the previous one, `1` the next. */
export const stepPeriod = (range: { start: string; end: string }, step: PeriodStep, count: number): { start: string; end: string } => {
  if ("months" in step) {
    const { year, month } = parts(range.start);
    const first = month + step.months * count;
    return { start: day(year, first, 1), end: day(year, first + step.months, 0) };
  }
  return { start: addPeriodDays(range.start, step.days * count), end: addPeriodDays(range.end, step.days * count) };
};

/** The period of the same kind and rhythm that contains today: this week for a week, this month for a month. */
export const currentPeriodOf = (range: { start: string; end: string }, step: PeriodStep, today: string): { start: string; end: string } =>
  stepPeriod(
    range,
    step,
    "months" in step
      ? Math.floor((monthIndex(today) - monthIndex(range.start)) / step.months)
      : Math.floor(daysBetween(range.start, today) / step.days),
  );

export const periodKind = (range: { start: string; end: string }, weekStartsOn: 0 | 1): PeriodKind => {
  const step = periodStep(range);
  if (!step) return "range";
  if ("months" in step) {
    const first = parts(range.start).month;
    if (step.months === 1) return "month";
    if (step.months === 3 && first % 3 === 0) return "quarter";
    if (step.months === 12 && first === 0) return "year";
    return "range";
  }
  if (step.days === 1) return "day";
  if (step.days === 7 && keyDate(range.start).getUTCDay() === weekStartsOn) return "week";
  return "range";
};

const utcFormat = (locale: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" });

/**
 * Short days of a preset, for the list and the trigger: "Sat, Nov 7", "Nov 1 – 30", "2025", "since 3/14/2019".
 * The year is added only when the period is not in today's year.
 */
export const formatPeriodDays = (range: PeriodRange, today: string, locale: string, since: (date: string) => string): string => {
  if (!range.start) return "";
  if (!range.end) return since(utcFormat(locale, { day: "2-digit", month: "2-digit", year: "numeric" }).format(keyDate(range.start)));
  const start = keyDate(range.start);
  const end = keyDate(range.end);
  const sameYear = range.start.slice(0, 4) === range.end.slice(0, 4);
  if (sameYear && range.start.endsWith("-01-01") && range.end.endsWith("-12-31")) return range.start.slice(0, 4);
  if (range.end === today && range.start.slice(0, 4) !== today.slice(0, 4))
    return since(utcFormat(locale, { day: "2-digit", month: "2-digit", year: "numeric" }).format(start));
  const withYear = !sameYear || range.start.slice(0, 4) !== today.slice(0, 4);
  if (range.start === range.end)
    return utcFormat(locale, { weekday: "short", day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) }).format(start);
  return utcFormat(locale, { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) }).formatRange(start, end);
};

/** Explicit days as numbers with the year: "01.–07.11.2026" in German, "11/1/2026 – 11/7/2026" in English. */
export const formatPeriodRange = (range: { start: string; end: string }, locale: string): string => {
  const format = utcFormat(locale, { day: "2-digit", month: "2-digit", year: "numeric" });
  return range.start === range.end ? format.format(keyDate(range.start)) : format.formatRange(keyDate(range.start), keyDate(range.end));
};

/**
 * Explicit days that are one calendar week, month or year read as that: "9.–15. Nov. 2026", "Oktober 2026", "2025".
 * `undefined` for any other range, which keeps its numeric days and count.
 */
export const formatPeriodUnit = (range: { start: string; end: string }, weekStartsOn: 0 | 1, locale: string): string | undefined => {
  const kind = periodKind(range, weekStartsOn);
  if (kind === "year") return range.start.slice(0, 4);
  if (kind === "month") return utcFormat(locale, { month: "long", year: "numeric" }).format(keyDate(range.start));
  if (kind === "week")
    return utcFormat(locale, { day: "numeric", month: "short", year: "numeric" }).formatRange(keyDate(range.start), keyDate(range.end));
  return undefined;
};

/** The widest explicit range within today's year, all of it (two-digit days, a three-digit count), so a trigger can reserve its width. */
export const widePeriodRangeSample = (today: string): { start: string; end: string } => {
  const year = today.slice(0, 4);
  return { start: `${year}-01-01`, end: `${year}-12-31` };
};
