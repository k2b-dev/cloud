import {
  addDaysToKey,
  type DateInputAnchor,
  type DateInputError,
  type DateInputNote,
  daysBetweenKeys,
  formatDateInput,
} from "./date-input";
import type { DateInputMessages } from "./date-input-messages";

/**
 * The line under a typed date field. It always says which day is meant: grey at rest (weekday and distance), blue
 * while typing (the absolute date that a commit would save), red after a commit that failed.
 */
export type DateStatusTone = "rest" | "draft" | "error";
export type DateStatus = { tone: DateStatusTone; text: string };

const noon = (key: string): number => Date.parse(`${key}T12:00:00.000Z`);
// A known Monday; weekday indexes count from Monday (0).
const MONDAY = "2026-11-02";

/** "Mi., 4. Nov. 2026" / "Wed, Nov 4, 2026": the absolute date of a draft. */
export const formatDateLong = (key: string, locale?: string): string =>
  new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(noon(key));

const weekdayName = (weekday: number, locale?: string): string =>
  new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(noon(addDaysToKey(MONDAY, weekday)));

const relativeDay = (days: number, locale?: string): string => new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(days, "day");

/** "Mittwoch, in 9 Tagen": the saved date at rest. */
export const restStatusText = (key: string, today: string, locale?: string): string =>
  `${new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(noon(key))}, ${relativeDay(daysBetweenKeys(today, key), locale)}`;

const anchorText = (anchor: DateInputAnchor, locale?: string): string => {
  if (anchor.kind === "today") return relativeDay(0, locale);
  if (anchor.kind === "day") return relativeDay(anchor.offset, locale);
  if (anchor.kind === "weekday") return weekdayName(anchor.weekday, locale);
  return formatDateInput(anchor.date, locale);
};

/** What a word or offset meant: "morgen", "nächster Mittwoch", "gestern + 34 Tage". */
export const noteText = (note: DateInputNote, locale: string | undefined, t: DateInputMessages): string => {
  if (note.kind === "day") return relativeDay(note.offset, locale);
  if (note.kind === "weekday") return note.nextWeek ? t.nextWeek : t.nextWeekday({ weekday: weekdayName(note.weekday, locale) });
  const amount = new Intl.NumberFormat(locale, { style: "unit", unit: note.unit, unitDisplay: "long" }).format(Math.abs(note.amount));
  return `${anchorText(note.anchor, locale)} ${note.amount < 0 ? "−" : "+"} ${amount}`;
};

/** The draft line: "→ Mi., 4. Nov. 2026 · nächster Mittwoch". */
export const draftStatusText = (key: string, note: DateInputNote | undefined, locale: string | undefined, t: DateInputMessages): string =>
  `→ ${formatDateLong(key, locale)}${note ? ` · ${noteText(note, locale, t)}` : ""}`;

/** The reason a text is not a date, short enough for one line. */
export const errorText = (error: DateInputError, locale: string | undefined, t: DateInputMessages, today: string): string => {
  if (error.code === "day") {
    const month = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(
      Date.UTC(error.year, error.month - 1, 15, 12),
    );
    return t.shortMonth({ month, days: error.days });
  }
  if (error.code === "month") return t.noSuchMonth({ month: error.month });
  if (error.code === "year") return t.incompleteYear({ year: today.slice(0, 4) });
  if (error.code === "unit") return t.unknownUnit;
  if (error.code === "ambiguous") return t.ambiguous;
  const example = new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", timeZone: "UTC" }).format(Date.UTC(2026, 10, 11, 12));
  return t.notADate({ example });
};

/** A date outside `min`/`max` (date keys) is refused with the nearest allowed day. */
export const limitErrorText = (
  key: string,
  limits: { min?: string; max?: string },
  locale: string | undefined,
  t: DateInputMessages,
): string | undefined => {
  if (limits.min && key < limits.min) return t.earliest({ date: formatDateInput(limits.min, locale) });
  if (limits.max && key > limits.max) return t.latest({ date: formatDateInput(limits.max, locale) });
  return undefined;
};

/** While typing nothing is red yet: an unfinished entry says so calmly, a definite mistake already names the reason. */
export const typingStatusText = (error: DateInputError, locale: string | undefined, t: DateInputMessages, today: string): string => {
  if (error.code === "incomplete") return "…";
  if (error.code === "not-a-date") return t.notYet;
  return errorText(error, locale, t, today);
};

/** "Mittwoch, 4. November 2026, nächster Mittwoch": what the live region reads after typing pauses. */
export const spokenDateText = (key: string, note: DateInputNote | undefined, locale: string | undefined, t: DateInputMessages): string => {
  const date = new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(
    noon(key),
  );
  return note ? `${date}, ${noteText(note, locale, t)}` : date;
};

/** "Mi., 11. Nov. 2026 – Sa., 14. Nov. 2026 · 4 Tage", or one end with what is missing. */
export const rangeStatusText = (
  range: { start: string | null; end: string | null },
  locale: string | undefined,
  t: DateInputMessages,
): string => {
  if (range.start && range.end) {
    const days = new Intl.NumberFormat(locale, { style: "unit", unit: "day", unitDisplay: "long" }).format(
      Math.abs(daysBetweenKeys(range.start, range.end)) + 1,
    );
    return `${formatDateLong(range.start, locale)} – ${formatDateLong(range.end, locale)} · ${days}`;
  }
  if (range.start) return `${formatDateLong(range.start, locale)} · ${t.endMissing}`;
  if (range.end) return `${formatDateLong(range.end, locale)} · ${t.startMissing}`;
  return "";
};
