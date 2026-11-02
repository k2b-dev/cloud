/**
 * Typed date input: a small, predictable grammar instead of a natural-language parser. Every input resolves to one
 * calendar day (a date key such as `2026-11-11`), so the field can show the absolute date before it is committed.
 *
 * - Dates in the locale's order of day, month and year: `11.11.2026`, `11.11.26`, `11.11.`, `11.11`, `11/11/2026`.
 * - Digits only: 1–2 digits are a day of the current month; 4, 6 or 8 digits are day, month and year without separators.
 * - ISO dates (`2026-11-11`) and month names (`11. November 2026`, `Nov 11, 2026`).
 * - Day words and weekdays in German and English: `heute`, `morgen`, `mi`, `wed`, `Mittwoch`. A weekday is its next
 *   occurrence after today; today's weekday is the same day next week.
 * - One offset at the end: `[anchor] ± N [unit]`, such as `+14`, `-3`, `heute +2w`, `gestern + 34`, `mi +7`, `11.11. -3`.
 *   The anchor is any of the forms above; without one it is today, never the saved value.
 */

export type DatePart = "day" | "month" | "year";
export type DateUnit = "day" | "week" | "month" | "year";

/** What a word or offset meant, so the field can say it next to the resolved date. */
export type DateInputAnchor =
  | { kind: "today" }
  | { kind: "date"; date: string }
  | { kind: "day"; offset: number }
  | { kind: "weekday"; weekday: number };

export type DateInputNote =
  | { kind: "day"; offset: number }
  | { kind: "weekday"; weekday: number; nextWeek: boolean }
  | { kind: "offset"; anchor: DateInputAnchor; amount: number; unit: DateUnit };

export type DateInputError =
  | { code: "not-a-date" }
  | { code: "incomplete" }
  | { code: "ambiguous" }
  | { code: "year" }
  | { code: "unit" }
  | { code: "month"; month: number }
  | { code: "day"; year: number; month: number; days: number };

export type DateInputResult =
  | { kind: "empty" }
  | { kind: "date"; date: string; note?: DateInputNote }
  | { kind: "error"; error: DateInputError };

/** Weekday indexes count from Monday (0) to Sunday (6). */
const DAY_WORDS: Record<string, number> = {
  vorgestern: -2,
  gestern: -1,
  heute: 0,
  morgen: 1,
  übermorgen: 2,
  yesterday: -1,
  today: 0,
  tomorrow: 1,
};
const WEEKDAY_NAMES: readonly (readonly string[])[] = [
  ["montag", "monday"],
  ["dienstag", "tuesday"],
  ["mittwoch", "wednesday"],
  ["donnerstag", "thursday"],
  ["freitag", "friday"],
  ["samstag", "saturday"],
  ["sonntag", "sunday"],
];
/** Abbreviations are matched exactly and win over prefixes: `mo` is Monday, `mor` is morgen. */
const WEEKDAY_ABBREVIATIONS: readonly (readonly string[])[] = [
  ["mo", "mon"],
  ["di", "tue"],
  ["mi", "wed"],
  ["do", "thu"],
  ["fr", "fri"],
  ["sa", "sat"],
  ["so", "sun"],
];
const MONTH_PREFIXES: readonly (readonly string[])[] = [
  ["jan", "jän"],
  ["feb"],
  ["mär", "mar", "mae"],
  ["apr"],
  ["mai", "may"],
  ["jun"],
  ["jul"],
  ["aug"],
  ["sep"],
  ["okt", "oct"],
  ["nov"],
  ["dez", "dec"],
];
const UNITS: Record<string, DateUnit> = {
  "": "day",
  t: "day",
  tag: "day",
  tage: "day",
  tagen: "day",
  d: "day",
  day: "day",
  days: "day",
  w: "week",
  wo: "week",
  woche: "week",
  wochen: "week",
  week: "week",
  weeks: "week",
  m: "month",
  monat: "month",
  monate: "month",
  monaten: "month",
  month: "month",
  months: "month",
  j: "year",
  jahr: "year",
  jahre: "year",
  jahren: "year",
  y: "year",
  year: "year",
  years: "year",
};

/** Right-to-left locales put direction marks between the parts of a date. */
const DIRECTION_MARKS = /[\u200e\u200f\u061c]/g;

const pad = (value: number): string => String(value).padStart(2, "0");
const toKey = (year: number, month: number, day: number): string => `${year}-${pad(month)}-${pad(day)}`;
const keyParts = (key: string): [number, number, number] => {
  const [year = 1970, month = 1, day = 1] = key.split("-").map(Number);
  return [year, month, day];
};
const keyTime = (key: string): number => {
  const [year, month, day] = keyParts(key);
  return Date.UTC(year, month - 1, day, 12);
};
const timeKey = (time: number): string => {
  const date = new Date(time);
  return toKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
};
const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

export const addDaysToKey = (key: string, days: number): string => timeKey(keyTime(key) + days * 86_400_000);

/** Months and years keep the day where it exists and otherwise end on the last day of the month (31.01. + 1m = 28.02.). */
export const addMonthsToKey = (key: string, months: number): string => {
  const [year, month, day] = keyParts(key);
  const index = year * 12 + month - 1 + months;
  const nextYear = Math.floor(index / 12);
  const nextMonth = (index % 12) + 1;
  return toKey(nextYear, nextMonth, Math.min(day, daysInMonth(nextYear, nextMonth)));
};

/** Monday 0 … Sunday 6. */
export const weekdayOfKey = (key: string): number => (new Date(keyTime(key)).getUTCDay() + 6) % 7;

/** Whole days from `from` to `to`. */
export const daysBetweenKeys = (from: string, to: string): number => Math.round((keyTime(to) - keyTime(from)) / 86_400_000);

/**
 * The editable numeric form: the locale's order and separators, but always the Gregorian calendar with Latin digits,
 * so the text the field shows (`ar-EG`, `th-TH`, `fa-IR` included) is text it can read back.
 */
const numericFormat = (locale?: string): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
    calendar: "gregory",
    numberingSystem: "latn",
  });

/** The locale's order of day, month and year in a numeric date, read from Intl; day-month-year without data. */
export const dateOrder = (locale?: string): DatePart[] => {
  try {
    const parts = numericFormat(locale).formatToParts(
      Date.UTC(2026, 10, 22, 12),
    );
    const order = parts.map((part) => part.type).filter((type): type is DatePart => type === "day" || type === "month" || type === "year");
    return order.length === 3 ? order : ["day", "month", "year"];
  } catch {
    return ["day", "month", "year"];
  }
};

/** The numeric form the field shows after a commit, such as `11.11.2026` or `11/11/2026`. */
export const formatDateInput = (key: string, locale?: string): string =>
  numericFormat(locale).format(keyTime(key)).replace(DIRECTION_MARKS, "");

/** The placeholder pattern in the locale's order, with letters from the caller (`TT.MM.JJJJ`, `MM/DD/YYYY`). */
export const dateInputPattern = (locale: string | undefined, letters: Record<DatePart, string>): string => {
  try {
    return numericFormat(locale)
      .formatToParts(Date.UTC(2026, 10, 22, 12))
      .map((part) => (part.type === "day" || part.type === "month" || part.type === "year" ? letters[part.type] : part.value))
      .join("");
  } catch {
    return `${letters.day}.${letters.month}.${letters.year}`;
  }
};

const ok = (date: string, note?: DateInputNote): DateInputResult => ({ kind: "date", date, note });
const fail = (error: DateInputError): DateInputResult => ({ kind: "error", error });

const resolveYear = (text: string | undefined, today: string): number | null => {
  const [currentYear] = keyParts(today);
  if (!text) return currentYear;
  if (text.length === 4) return Number(text);
  if (text.length === 2) {
    // Two digits name the nearest year that is at most 20 years ahead: `26` is 2026, `85` is 1985.
    const year = Math.floor(currentYear / 100) * 100 + Number(text);
    return year > currentYear + 20 ? year - 100 : year;
  }
  return null;
};

const build = (day: number, month: number, yearText: string | undefined, today: string): DateInputResult => {
  const year = resolveYear(yearText, today);
  if (year === null) return fail({ code: "year" });
  if (month < 1 || month > 12) return fail({ code: "month", month });
  const days = daysInMonth(year, month);
  if (day < 1 || day > days) return fail({ code: "day", year, month, days });
  return ok(toKey(year, month, day));
};

/** Maps numeric groups to day, month and year in the locale's order; two groups leave out the year. */
const fromGroups = (groups: readonly string[], order: readonly DatePart[], today: string): DateInputResult => {
  const parts = groups.length === 3 ? order : order.filter((part) => part !== "year");
  const value = (part: DatePart) => groups[parts.indexOf(part)];
  return build(Number(value("day")), Number(value("month")), value("year"), today);
};

const monthFromName = (word: string): number | null => {
  const cleaned = word.replace(/\./g, "");
  if (cleaned.length < 3) return null;
  const index = MONTH_PREFIXES.findIndex((prefixes) => prefixes.some((prefix) => cleaned.startsWith(prefix)));
  return index < 0 ? null : index + 1;
};

const weekdayDate = (weekday: number, today: string): DateInputResult => {
  const delta = (weekday - weekdayOfKey(today) + 7) % 7 || 7;
  return ok(addDaysToKey(today, delta), { kind: "weekday", weekday, nextWeek: delta === 7 });
};

const parseWord = (word: string, today: string): DateInputResult => {
  const abbreviation = WEEKDAY_ABBREVIATIONS.findIndex((names) => names.includes(word));
  if (abbreviation >= 0) return weekdayDate(abbreviation, today);
  const candidates: { key: string; exact: boolean; resolve: () => DateInputResult }[] = [];
  for (const [name, offset] of Object.entries(DAY_WORDS)) {
    if (name === word || (word.length >= 3 && name.startsWith(word))) {
      candidates.push({
        key: `day:${offset}`,
        exact: name === word,
        resolve: () => ok(addDaysToKey(today, offset), { kind: "day", offset }),
      });
    }
  }
  WEEKDAY_NAMES.forEach((names, weekday) => {
    for (const name of names) {
      if (name === word || (word.length >= 3 && name.startsWith(word))) {
        candidates.push({ key: `weekday:${weekday}`, exact: name === word, resolve: () => weekdayDate(weekday, today) });
      }
    }
  });
  const exact = candidates.find((candidate) => candidate.exact);
  if (exact) return exact.resolve();
  const meanings = new Set(candidates.map((candidate) => candidate.key));
  if (meanings.size === 1) return candidates[0]!.resolve();
  if (meanings.size > 1) return fail({ code: "ambiguous" });
  return fail({ code: "not-a-date" });
};

const anchorOf = (result: Extract<DateInputResult, { kind: "date" }>): DateInputAnchor => {
  if (result.note?.kind === "day") return result.note.offset === 0 ? { kind: "today" } : { kind: "day", offset: result.note.offset };
  if (result.note?.kind === "weekday") return { kind: "weekday", weekday: result.note.weekday };
  return { kind: "date", date: result.date };
};

const applyOffset = (base: string, amount: number, unit: DateUnit): string => {
  if (unit === "day") return addDaysToKey(base, amount);
  if (unit === "week") return addDaysToKey(base, amount * 7);
  return addMonthsToKey(base, unit === "month" ? amount : amount * 12);
};

const OFFSET_TAIL = /([+-]) ?(\d{1,3}) ?([a-zäöü]*)\.?$/;

const parseBase = (text: string, today: string, order: readonly DatePart[]): DateInputResult => {
  if (/^[a-zäöüß]+$/.test(text)) return parseWord(text, today);
  // A pasted ISO date may carry a time, nothing else: "2026-11-11 nonsense" is not a date.
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[t ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:?\d{2})?)?$/);
  if (match) return build(Number(match[3]), Number(match[2]), match[1], today);
  match = text.match(/^(\d{1,2})\.? ?([a-zäöü]{3,}\.?) ?,? ?(\d{2}|\d{4})?$/);
  if (match) {
    const month = monthFromName(match[2]!);
    return month ? build(Number(match[1]), month, match[3], today) : fail({ code: "not-a-date" });
  }
  match = text.match(/^([a-zäöü]{3,}\.?) ?(\d{1,2})(?:st|nd|rd|th)?,? ?(\d{2}|\d{4})?$/);
  if (match) {
    const month = monthFromName(match[1]!);
    return month ? build(Number(match[2]), month, match[3], today) : fail({ code: "not-a-date" });
  }
  match = text.match(/^(\d{1,4})[.,/\- ]+(\d{1,2})(?:[.,/\- ]+(\d*))?\.?$/);
  if (match) {
    const groups = [match[1]!, match[2]!, ...(match[3] ? [match[3]] : [])];
    if (groups[0]!.length > 2 && order[0] !== "year") return fail({ code: "not-a-date" });
    return fromGroups(groups, order, today);
  }
  if (/^\d+$/.test(text)) {
    const [, currentMonth] = keyParts(today);
    if (text.length <= 2) return build(Number(text), currentMonth, undefined, today);
    if (text.length === 4) return fromGroups([text.slice(0, 2), text.slice(2)], order, today);
    if (text.length === 6) return fromGroups([text.slice(0, 2), text.slice(2, 4), text.slice(4)], order, today);
    if (text.length === 8) {
      const yearFirst = order[0] === "year";
      const groups = yearFirst ? [text.slice(0, 4), text.slice(4, 6), text.slice(6)] : [text.slice(0, 2), text.slice(2, 4), text.slice(4)];
      return fromGroups(groups, order, today);
    }
    return fail({ code: "incomplete" });
  }
  return fail({ code: "not-a-date" });
};

/**
 * Parses what a person typed into a date field. `today` is the current date key in the field's time zone; the result
 * never depends on the clock.
 */
export const parseDateInput = (raw: string, options: { today: string; locale?: string }): DateInputResult => {
  const text = raw.replace(DIRECTION_MARKS, "").trim().replace(/\s+/g, " ").toLowerCase();
  if (!text) return { kind: "empty" };
  const order = dateOrder(options.locale);
  const offset = text.match(OFFSET_TAIL);
  if (offset) {
    const head = text.slice(0, offset.index);
    const anchorText = head.trim();
    // `+` always starts an offset; `-` only at the start, after a space or after a word, so `11-11-2026` stays a date.
    if (offset[1] === "+" || head === "" || /\s$/.test(head) || /[a-zäöüß]$/.test(anchorText)) {
      const unit = UNITS[offset[3]!];
      if (!unit) return fail({ code: "unit" });
      const amount = Number(offset[2]) * (offset[1] === "-" ? -1 : 1);
      if (!anchorText) return ok(applyOffset(options.today, amount, unit), { kind: "offset", anchor: { kind: "today" }, amount, unit });
      const anchor = parseBase(anchorText, options.today, order);
      if (anchor.kind !== "date") return anchor.kind === "empty" ? fail({ code: "not-a-date" }) : anchor;
      return ok(applyOffset(anchor.date, amount, unit), { kind: "offset", anchor: anchorOf(anchor), amount, unit });
    }
  }
  if (/[+-]$/.test(text)) return fail({ code: "incomplete" });
  return parseBase(text, options.today, order);
};
