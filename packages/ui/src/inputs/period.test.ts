import { describe, expect, test } from "bun:test";
import {
  formatPeriodDays,
  formatPeriodRange,
  isPeriodDay,
  type PeriodPreset,
  parsePeriodValue,
  periodContext,
  periodDayCount,
  periodInstants,
  periodPresets,
  resolvePeriod,
} from "./period";

const presets: PeriodPreset[] = [
  periodPresets.today,
  periodPresets.thisWeek,
  periodPresets.lastWeek,
  periodPresets.thisMonth,
  periodPresets.lastMonth,
  periodPresets.thisQuarter,
  periodPresets.lastQuarter,
  periodPresets.thisYear,
  periodPresets.lastYear,
  periodPresets.all({ since: "2019-03-14" }),
];
// Saturday, 7 November 2026, 12:00 in Berlin.
const now = new Date("2026-11-07T11:00:00Z");
const resolve = (preset: string, clock: Parameters<typeof resolvePeriod>[2] = { now, timeZone: "Europe/Berlin" }) =>
  resolvePeriod({ preset }, presets, clock);

describe("period presets", () => {
  test("cover their whole calendar period, not only up to today", () => {
    expect(resolve("today")).toEqual({ start: "2026-11-07", end: "2026-11-07" });
    expect(resolve("this-month")).toEqual({ start: "2026-11-01", end: "2026-11-30" });
    expect(resolve("last-month")).toEqual({ start: "2026-10-01", end: "2026-10-31" });
    expect(resolve("this-quarter")).toEqual({ start: "2026-10-01", end: "2026-12-31" });
    expect(resolve("last-quarter")).toEqual({ start: "2026-07-01", end: "2026-09-30" });
    expect(resolve("this-year")).toEqual({ start: "2026-01-01", end: "2026-12-31" });
    expect(resolve("last-year")).toEqual({ start: "2025-01-01", end: "2025-12-31" });
  });

  test("weeks follow the week start of the date config, Monday by default", () => {
    expect(resolve("this-week")).toEqual({ start: "2026-11-02", end: "2026-11-08" });
    expect(resolve("last-week")).toEqual({ start: "2026-10-26", end: "2026-11-01" });
    expect(resolve("this-week", { now, timeZone: "Europe/Berlin", weekStartsOn: 0 })).toEqual({ start: "2026-11-01", end: "2026-11-07" });
    expect(resolve("this-week", { now, timeZone: "Europe/Berlin", firstDayOfWeek: 0 })).toEqual({ start: "2026-11-01", end: "2026-11-07" });
    // A Sunday is the last day of a Monday week and the first of a Sunday week.
    const sunday = new Date("2026-11-08T11:00:00Z");
    expect(resolve("this-week", { now: sunday, timeZone: "UTC" })).toEqual({ start: "2026-11-02", end: "2026-11-08" });
    expect(resolve("this-week", { now: sunday, timeZone: "UTC", weekStartsOn: 0 })).toEqual({ start: "2026-11-08", end: "2026-11-14" });
  });

  test("read today in the period's time zone, not the runtime's", () => {
    // 23:30 UTC on 31 October is already 1 November in Berlin and still 31 October in New York.
    const late = new Date("2026-10-31T23:30:00Z");
    expect(resolve("this-month", { now: late, timeZone: "Europe/Berlin" })).toEqual({ start: "2026-11-01", end: "2026-11-30" });
    expect(resolve("this-month", { now: late, timeZone: "America/New_York" })).toEqual({ start: "2026-10-01", end: "2026-10-31" });
    expect(periodContext({ now: late, timeZone: "Pacific/Kiritimati" }).today).toBe("2026-11-01");
  });

  test("cross year, leap day and month-end edges", () => {
    const january = new Date("2027-01-15T12:00:00Z");
    expect(resolve("last-month", { now: january, timeZone: "UTC" })).toEqual({ start: "2026-12-01", end: "2026-12-31" });
    expect(resolve("last-quarter", { now: january, timeZone: "UTC" })).toEqual({ start: "2026-10-01", end: "2026-12-31" });
    expect(resolve("this-week", { now: january, timeZone: "UTC" })).toEqual({ start: "2027-01-11", end: "2027-01-17" });
    const leap = new Date("2028-03-31T12:00:00Z");
    expect(resolve("last-month", { now: leap, timeZone: "UTC" })).toEqual({ start: "2028-02-01", end: "2028-02-29" });
    const newYear = new Date("2027-01-01T12:00:00Z");
    expect(resolve("last-week", { now: newYear, timeZone: "UTC" })).toEqual({ start: "2026-12-21", end: "2026-12-27" });
  });

  test("all time is open at the start unless the app knows its first day", () => {
    expect(resolve("all")).toEqual({ start: "2019-03-14", end: "2026-11-07" });
    expect(resolvePeriod({ preset: "all" }, [periodPresets.all()], { now, timeZone: "UTC" })).toEqual({ start: null, end: "2026-11-07" });
  });

  test("an unknown preset key resolves to nothing instead of a silent replacement", () => {
    expect(resolvePeriod({ preset: "season-2025" }, presets, { now })).toBeUndefined();
    expect(resolvePeriod({ start: "2026-11-01", end: "2026-11-07" }, presets, { now })).toEqual({ start: "2026-11-01", end: "2026-11-07" });
  });

  test("app presets resolve with the same context", () => {
    const fiscalYear: PeriodPreset = {
      key: "fiscal-year",
      label: "Geschäftsjahr",
      resolve: ({ today }) => {
        const year = Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) < 4 ? 1 : 0);
        return { start: `${year}-04-01`, end: `${year + 1}-03-31` };
      },
    };
    expect(resolvePeriod({ preset: "fiscal-year" }, [fiscalYear], { now, timeZone: "Europe/Berlin" })).toEqual({
      start: "2026-04-01",
      end: "2027-03-31",
    });
  });
});

describe("period values and instants", () => {
  test("accepts only known presets and real ordered days", () => {
    expect(parsePeriodValue({ preset: "this-month" }, presets)).toEqual({ preset: "this-month" });
    expect(parsePeriodValue({ preset: "gone" }, presets)).toBeUndefined();
    expect(parsePeriodValue({ start: "2026-11-01", end: "2026-11-07" }, presets)).toEqual({ start: "2026-11-01", end: "2026-11-07" });
    expect(parsePeriodValue({ start: "2026-11-07", end: "2026-11-01" }, presets)).toBeUndefined();
    expect(parsePeriodValue({ start: "2026-02-30", end: "2026-03-01" }, presets)).toBeUndefined();
    expect(parsePeriodValue("this-month", presets)).toBeUndefined();
    expect(isPeriodDay("2028-02-29")).toBe(true);
    expect(isPeriodDay("2027-02-29")).toBe(false);
  });

  test("query bounds start at local midnight and end exclusively at the next one, across DST", () => {
    // Berlin leaves summer time on 25 October 2026: that day has 25 hours.
    expect(periodInstants({ start: "2026-10-25", end: "2026-10-25" }, "Europe/Berlin")).toEqual({
      from: "2026-10-24T22:00:00.000Z",
      to: "2026-10-25T23:00:00.000Z",
    });
    expect(periodInstants({ start: "2026-11-01", end: "2026-11-30" }, "America/New_York")).toEqual({
      from: "2026-11-01T04:00:00.000Z",
      to: "2026-12-01T05:00:00.000Z",
    });
    // Santiago skips midnight when summer time starts (6 September 2026): the day begins at 01:00.
    expect(periodInstants({ start: "2026-09-06", end: "2026-09-06" }, "America/Santiago").from).toBe("2026-09-06T04:00:00.000Z");
    expect(periodInstants({ start: null, end: "2026-11-07" }, "UTC")).toEqual({ from: null, to: "2026-11-08T00:00:00.000Z" });
  });

  test("counts calendar days, not 24-hour blocks", () => {
    expect(periodDayCount({ start: "2026-10-24", end: "2026-10-26" })).toBe(3);
    expect(periodDayCount({ start: "2026-11-07", end: "2026-11-07" })).toBe(1);
    expect(periodDayCount({ start: "2025-12-29", end: "2026-01-04" })).toBe(7);
  });
});

describe("period labels", () => {
  const since = (date: string) => `seit ${date}`;
  test("presets show their days, with the year only outside today's year", () => {
    const today = "2026-11-07";
    expect(formatPeriodDays({ start: "2026-11-07", end: "2026-11-07" }, today, "de", since)).toBe("Sa., 7. Nov.");
    expect(formatPeriodDays({ start: "2026-11-02", end: "2026-11-08" }, today, "de", since)).toBe("2.–8. Nov.");
    expect(formatPeriodDays({ start: "2026-10-01", end: "2026-12-31" }, today, "de", since)).toBe("1. Okt. – 31. Dez.");
    expect(formatPeriodDays({ start: "2025-01-01", end: "2025-12-31" }, today, "de", since)).toBe("2025");
    expect(formatPeriodDays({ start: "2019-03-14", end: "2026-11-07" }, today, "de", since)).toBe("seit 14.03.2019");
    expect(formatPeriodDays({ start: null, end: "2026-11-07" }, today, "de", since)).toBe("");
    expect(formatPeriodDays({ start: "2025-11-01", end: "2025-11-30" }, today, "en", since)).toBe("Nov 1 – 30, 2025");
  });

  test("explicit days are numbers with the year in the locale's order", () => {
    expect(formatPeriodRange({ start: "2026-11-01", end: "2026-11-07" }, "de")).toBe("01.–07.11.2026");
    expect(formatPeriodRange({ start: "2025-12-29", end: "2026-01-04" }, "de")).toBe("29.12.2025 – 04.01.2026");
    expect(formatPeriodRange({ start: "2026-11-07", end: "2026-11-07" }, "en-US")).toBe("11/07/2026");
  });
});
