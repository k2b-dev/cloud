import { describe, expect, test } from "bun:test";
import { addMonthsToKey, dateInputPattern, dateOrder, formatDateInput, parseDateInput } from "./date-input";

// Monday, 2 November 2026. The parser takes "today" as an argument, so no test depends on the clock.
const today = "2026-11-02";
const de = (text: string) => parseDateInput(text, { today, locale: "de-DE" });
const us = (text: string) => parseDateInput(text, { today, locale: "en-US" });
const date = (text: string, locale = "de-DE") => {
  const result = parseDateInput(text, { today, locale });
  return result.kind === "date" ? result.date : result.kind === "error" ? `error:${result.error.code}` : "empty";
};

describe("typed dates", () => {
  test("German dates with and without year", () => {
    for (const text of ["11.11.2026", "11.11.26", "11.11.", "11.11", "11 11 2026", "11,11,2026", "11-11-2026", "1.1.2027"]) {
      expect(date(text)).toBe(text === "1.1.2027" ? "2027-01-01" : "2026-11-11");
    }
  });

  test("digits without separators for a phone keypad", () => {
    expect(date("24")).toBe("2026-11-24");
    expect(date("1111")).toBe("2026-11-11");
    expect(date("111126")).toBe("2026-11-11");
    expect(date("11112026")).toBe("2026-11-11");
    expect(date("111")).toBe("error:incomplete");
  });

  test("two-digit years pick the nearest year at most 20 years ahead", () => {
    expect(date("11.11.46")).toBe("2046-11-11");
    expect(date("11.11.47")).toBe("1947-11-11");
    expect(date("11.11.85")).toBe("1985-11-11");
  });

  test("ISO and month names", () => {
    expect(date("2026-11-11")).toBe("2026-11-11");
    expect(date("2026-11-11T09:00")).toBe("2026-11-11");
    expect(date("11. November 2026")).toBe("2026-11-11");
    expect(date("11. Nov.")).toBe("2026-11-11");
    expect(date("3 März 2027")).toBe("2027-03-03");
    expect(date("Nov 11, 2026", "en-US")).toBe("2026-11-11");
  });

  test("the locale decides the order of day and month", () => {
    expect(dateOrder("de-DE")).toEqual(["day", "month", "year"]);
    expect(dateOrder("en-US")).toEqual(["month", "day", "year"]);
    expect(date("02/03/2027", "en-US")).toBe("2027-02-03");
    expect(date("02/03/2027", "en-GB")).toBe("2027-03-02");
    expect(date("0203", "en-US")).toBe("2026-02-03");
  });

  test("invalid days, months and years say why", () => {
    expect(de("31.02.2026")).toEqual({ kind: "error", error: { code: "day", year: 2026, month: 2, days: 28 } });
    expect(de("12.13.2026")).toEqual({ kind: "error", error: { code: "month", month: 13 } });
    expect(de("11.11.202")).toEqual({ kind: "error", error: { code: "year" } });
    expect(de("abc")).toEqual({ kind: "error", error: { code: "not-a-date" } });
    expect(de("")).toEqual({ kind: "empty" });
    expect(de("   ")).toEqual({ kind: "empty" });
  });
});

describe("words", () => {
  test("day words in German and English", () => {
    expect(de("heute")).toEqual({ kind: "date", date: "2026-11-02", note: { kind: "day", offset: 0 } });
    expect(date("morgen")).toBe("2026-11-03");
    expect(date("tomorrow")).toBe("2026-11-03");
    expect(date("übermorgen")).toBe("2026-11-04");
    expect(date("gestern")).toBe("2026-11-01");
    expect(date("yesterday", "en-US")).toBe("2026-11-01");
  });

  test("a weekday is its next occurrence; today's weekday is next week", () => {
    expect(de("mi")).toEqual({ kind: "date", date: "2026-11-04", note: { kind: "weekday", weekday: 2, nextWeek: false } });
    for (const text of ["mittwoch", "Mittwoch", "wed", "wednesday", "mit"]) expect(date(text)).toBe("2026-11-04");
    expect(de("mo")).toEqual({ kind: "date", date: "2026-11-09", note: { kind: "weekday", weekday: 0, nextWeek: true } });
    expect(date("montag")).toBe("2026-11-09");
    expect(date("sun")).toBe("2026-11-08");
    expect(date("fr")).toBe("2026-11-06");
  });

  test("abbreviations win, other prefixes need three letters and one meaning", () => {
    expect(date("mor")).toBe("2026-11-03");
    expect(date("to")).toBe("error:not-a-date");
    expect(date("tod")).toBe("2026-11-02");
    expect(date("tom")).toBe("2026-11-03");
    expect(date("m")).toBe("error:not-a-date");
  });
});

describe("offsets", () => {
  test("without an anchor they count from today", () => {
    expect(de("+14")).toEqual({
      kind: "date",
      date: "2026-11-16",
      note: { kind: "offset", anchor: { kind: "today" }, amount: 14, unit: "day" },
    });
    expect(date("heute +14")).toBe("2026-11-16");
    expect(date("heute+14")).toBe("2026-11-16");
    expect(date("-3")).toBe("2026-10-30");
    expect(date("+2w")).toBe("2026-11-16");
    expect(date("+2 wochen")).toBe("2026-11-16");
    expect(date("+2 weeks", "en-US")).toBe("2026-11-16");
    expect(date("+1m")).toBe("2026-12-02");
    expect(date("+1j")).toBe("2027-11-02");
    expect(date("+3t")).toBe("2026-11-05");
  });

  test("any date, day word or weekday can be the anchor", () => {
    expect(de("gestern + 34")).toEqual({
      kind: "date",
      date: "2026-12-05",
      note: { kind: "offset", anchor: { kind: "day", offset: -1 }, amount: 34, unit: "day" },
    });
    expect(date("gestern+34")).toBe("2026-12-05");
    expect(de("mi +7")).toEqual({
      kind: "date",
      date: "2026-11-11",
      note: { kind: "offset", anchor: { kind: "weekday", weekday: 2 }, amount: 7, unit: "day" },
    });
    expect(de("11.11. -3")).toEqual({
      kind: "date",
      date: "2026-11-08",
      note: { kind: "offset", anchor: { kind: "date", date: "2026-11-11" }, amount: -3, unit: "day" },
    });
    expect(date("11.11.+3")).toBe("2026-11-14");
    expect(date("morgen +2w")).toBe("2026-11-17");
    expect(date("11.11.2026 +1m")).toBe("2026-12-11");
  });

  test("a minus right after a date is part of the date, not an offset", () => {
    expect(date("11-11-2026")).toBe("2026-11-11");
    expect(date("2026-11-11")).toBe("2026-11-11");
    expect(date("11.11.-3")).toBe("error:year");
  });

  test("incomplete, unknown and chained offsets", () => {
    expect(date("+")).toBe("error:incomplete");
    expect(date("heute +")).toBe("error:incomplete");
    expect(date("+2x")).toBe("error:unit");
    expect(date("abc +3")).toBe("error:not-a-date");
    expect(date("31.02.2026 +1")).toBe("error:day");
    expect(date("gestern + 34 + 2")).toBe("error:not-a-date");
    expect(date("in 2 wochen")).toBe("error:not-a-date");
  });

  test("months end on the last day that exists", () => {
    expect(addMonthsToKey("2027-01-31", 1)).toBe("2027-02-28");
    expect(addMonthsToKey("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonthsToKey("2026-12-15", 1)).toBe("2027-01-15");
    expect(addMonthsToKey("2026-01-15", -1)).toBe("2025-12-15");
  });
});

describe("formatting", () => {
  test("numeric form and placeholder follow the locale", () => {
    expect(formatDateInput("2026-11-04", "de-DE")).toBe("04.11.2026");
    expect(formatDateInput("2026-11-04", "en-US")).toBe("11/04/2026");
    expect(dateInputPattern("de-DE", { day: "TT", month: "MM", year: "JJJJ" })).toBe("TT.MM.JJJJ");
    expect(dateInputPattern("en-US", { day: "DD", month: "MM", year: "YYYY" })).toBe("MM/DD/YYYY");
  });

  test("a commit of the formatted text gives the same date back", () => {
    for (const locale of ["de-DE", "en-US", "en-GB"]) {
      expect(date(formatDateInput("2027-02-03", locale), locale)).toBe("2027-02-03");
    }
    expect(us("tomorrow")).toEqual({ kind: "date", date: "2026-11-03", note: { kind: "day", offset: 1 } });
  });
});
