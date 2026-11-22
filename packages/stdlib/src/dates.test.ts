import { describe, it, expect, beforeAll, afterAll, jest } from "bun:test";
import {
  dates,
  formatDate,
  formatDateTime,
  formatDateTimeRelative,
  formatDateRelative,
  formatTimeSpan,
  formatDuration,
  formatRecurrence,
  formatRecurrenceParts,
} from "./dates";
import {
  dates as rootDates,
  isValidTimeZone as rootIsValidTimeZone,
  normalizeTimeZone as rootNormalizeTimeZone,
} from "./index";

const {
  isValidTimeZone,
  normalizeTimeZone,
  zonedDateTimeToInstant,
  instantToZonedInput,
  getMonthGrid,
  getWeekDays,
  getDateRange,
  itemOnDate,
  getDayItems,
  isToday,
  isSameMonth,
  isSameDay,
  formatMonthYear,
  formatDayNumber,
  formatWeekdayShort,
  formatFullDate,
  formatDateKey,
  formatTime,
  addMonths,
  addWeeks,
  addDays,
  startOfDay,
  endOfDay,
  startOfMonth,
  startOfWeek,
  addZoned,
  addZonedInstant,
  buildCalendarUrl,
  parseCalendarDate,
  today,
  weekdays,
  months,
} = dates;

/**
 * Construct a Date at LOCAL midnight from a YYYY-MM-DD string. Calendar
 * functions (getMonthGrid, isToday, etc.) operate on local-time days, so
 * tests must construct dates in local time too. Using `new Date("YYYY-MM-DD")`
 * parses as UTC and silently shifts the day in non-zero timezones.
 */
const localDate = (s: string): Date => {
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
};

// =============================================================================
// Timezone helpers
// =============================================================================

describe("timezone helpers", () => {
  it("validates IANA timezone names", () => {
    expect(isValidTimeZone("Europe/Berlin")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone(" UTC ")).toBe(true);
    expect(isValidTimeZone("Berlin")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
  });

  it("normalizes invalid timezone values to a fallback", () => {
    expect(normalizeTimeZone("Europe/Berlin", "UTC")).toBe("Europe/Berlin");
    expect(normalizeTimeZone(" Europe/Berlin ")).toBe("Europe/Berlin");
    expect(normalizeTimeZone("Berlin", "America/New_York")).toBe("America/New_York");
    expect(normalizeTimeZone(undefined, " Europe/Berlin ")).toBe("Europe/Berlin");
    expect(normalizeTimeZone("", "UTC")).toBe("UTC");
    expect(normalizeTimeZone("   ", "UTC")).toBe("UTC");
    expect(normalizeTimeZone(null, "Not/AZone")).toBe("UTC");
  });

  it("exports timezone normalization as named root exports and in the dates namespace", () => {
    expect(rootNormalizeTimeZone(" Europe/Berlin ")).toBe("Europe/Berlin");
    expect(rootIsValidTimeZone("UTC")).toBe(true);
    expect(rootDates.normalizeTimeZone("nope", "America/New_York")).toBe("America/New_York");
    expect(rootDates.isValidTimeZone("nope")).toBe(false);
  });

  it("converts timezone-local datetime-local values to UTC instants", () => {
    expect(zonedDateTimeToInstant("2026-06-01T09:00", "Europe/Berlin")).toBe("2026-06-01T07:00:00.000Z");
    expect(zonedDateTimeToInstant("2026-06-01T09:00:12.345", "Europe/Berlin")).toBe(
      "2026-06-01T07:00:12.345Z",
    );
  });

  it("rejects nonexistent DST wall-clock values by default", () => {
    expect(() => zonedDateTimeToInstant("2026-03-29T02:30", "Europe/Berlin")).toThrow(RangeError);
  });

  it("can shift nonexistent DST wall-clock values with compatible disambiguation", () => {
    expect(
      zonedDateTimeToInstant("2026-03-29T02:30", "Europe/Berlin", {
        disambiguation: "compatible",
      }),
    ).toBe("2026-03-29T01:30:00.000Z");
  });

  it("preserves all disambiguation modes for nonexistent DST wall-clock values", () => {
    expect(() =>
      zonedDateTimeToInstant("2026-03-29T02:30", "Europe/Berlin", { disambiguation: "earlier" }),
    ).toThrow(RangeError);
    expect(zonedDateTimeToInstant("2026-03-29T02:30", "Europe/Berlin", { disambiguation: "later" })).toBe(
      "2026-03-29T01:30:00.000Z",
    );
  });

  it("rejects ambiguous DST wall-clock values by default", () => {
    expect(() => zonedDateTimeToInstant("2026-10-25T02:30", "Europe/Berlin")).toThrow(RangeError);
  });

  it("can disambiguate repeated DST wall-clock values", () => {
    expect(zonedDateTimeToInstant("2026-10-25T02:30", "Europe/Berlin", { disambiguation: "earlier" })).toBe(
      "2026-10-25T00:30:00.000Z",
    );
    expect(zonedDateTimeToInstant("2026-10-25T02:30", "Europe/Berlin", { disambiguation: "later" })).toBe(
      "2026-10-25T01:30:00.000Z",
    );
    expect(zonedDateTimeToInstant("2026-10-25T02:30", "Europe/Berlin", { disambiguation: "compatible" })).toBe(
      "2026-10-25T00:30:00.000Z",
    );
  });

  it("handles half-hour DST transitions in Australia/Lord_Howe", () => {
    expect(
      zonedDateTimeToInstant("2026-04-05T01:45", "Australia/Lord_Howe", { disambiguation: "earlier" }),
    ).toBe("2026-04-04T14:45:00.000Z");
    expect(
      zonedDateTimeToInstant("2026-04-05T01:45", "Australia/Lord_Howe", { disambiguation: "later" }),
    ).toBe("2026-04-04T15:15:00.000Z");
    expect(() => zonedDateTimeToInstant("2026-10-04T02:15", "Australia/Lord_Howe")).toThrow(RangeError);
    expect(
      zonedDateTimeToInstant("2026-10-04T02:15", "Australia/Lord_Howe", { disambiguation: "compatible" }),
    ).toBe("2026-10-03T15:45:00.000Z");
  });

  it("handles quarter-hour IANA offsets", () => {
    expect(zonedDateTimeToInstant("2026-06-01T09:00", "Asia/Kathmandu")).toBe("2026-06-01T03:15:00.000Z");
    expect(zonedDateTimeToInstant("2026-06-01T09:00", "Pacific/Chatham")).toBe("2026-05-31T20:15:00.000Z");
  });

  it("handles historical sub-minute IANA offsets", () => {
    expect(zonedDateTimeToInstant("1969-12-31T23:15:30", "Africa/Monrovia")).toBe(
      "1970-01-01T00:00:00.000Z",
    );
  });

  it("handles IANA transitions that skip an entire local date", () => {
    expect(() => zonedDateTimeToInstant("2011-12-30T12:00", "Pacific/Apia")).toThrow(RangeError);
    expect(() =>
      zonedDateTimeToInstant("2011-12-30T12:00", "Pacific/Apia", { disambiguation: "earlier" }),
    ).toThrow(RangeError);
    expect(zonedDateTimeToInstant("2011-12-30T12:00", "Pacific/Apia", { disambiguation: "compatible" })).toBe(
      "2011-12-30T22:00:00.000Z",
    );
    expect(zonedDateTimeToInstant("2011-12-30T12:00", "Pacific/Apia", { disambiguation: "later" })).toBe(
      "2011-12-30T22:00:00.000Z",
    );
  });

  it("converts UTC instants to datetime-local values in a timezone", () => {
    expect(instantToZonedInput("2026-06-01T07:00:00.000Z", "Europe/Berlin")).toBe("2026-06-01T09:00");
  });
});

// =============================================================================
// Pure formatters (no mocking needed)
// =============================================================================

describe("formatDate", () => {
  it("formats UTC date in default English order", () => {
    expect(formatDate("2025-03-05T13:53:00Z")).toBe("Mar 5, 2025");
  });

  it("handles Date object input", () => {
    expect(formatDate(new Date("2025-01-01T00:00:00Z"))).toBe("Jan 1, 2025");
  });

  it("uses an unpadded numeric day", () => {
    expect(formatDate("2025-03-01T00:00:00Z")).toBe("Mar 1, 2025");
  });

  it("uses UTC month (not local)", () => {
    expect(formatDate("2025-12-31T23:59:59Z")).toBe("Dec 31, 2025");
  });
});

describe("formatDateTime", () => {
  it("appends UTC hours:minutes", () => {
    expect(formatDateTime("2025-03-05T13:53:00Z")).toBe("Mar 5, 2025, 13:53");
  });

  it("pads single-digit hours and minutes", () => {
    expect(formatDateTime("2025-01-01T03:05:00Z")).toBe("Jan 1, 2025, 03:05");
  });

  it("formats the same instant in an explicit IANA timezone", () => {
    expect(formatDateTime("2025-03-05T23:30:00Z", { timeZone: "Europe/Berlin" })).toBe("Mar 6, 2025, 00:30");
  });

  it.each([
    ["2026-03-29T00:59:00Z", "Europe/Berlin", "Mar 29, 2026, 01:59"],
    ["2026-03-29T01:00:00Z", "Europe/Berlin", "Mar 29, 2026, 03:00"],
    ["2026-10-25T00:30:00Z", "Europe/Berlin", "Oct 25, 2026, 02:30"],
    ["2026-10-25T01:30:00Z", "Europe/Berlin", "Oct 25, 2026, 02:30"],
    ["2026-01-01T18:15:00Z", "Asia/Kathmandu", "Jan 2, 2026, 00:00"],
    ["2026-01-01T00:00:00Z", "America/St_Johns", "Dec 31, 2025, 20:30"],
  ])("preserves wall-clock display at %s in %s", (instant, timeZone, expected) => {
    expect(formatDateTime(instant, { timeZone })).toBe(expected);
  });

  it("interprets offset-free input as a host-local instant, just like a Date input", () => {
    const input = "2026-01-01T10:00";
    const instant = new Date(input);
    const expectedClock = `${String(instant.getUTCHours()).padStart(2, "0")}:${String(instant.getUTCMinutes()).padStart(2, "0")}`;
    expect(formatDateTime(input, { timeZone: "UTC" })).toBe(`${formatDate(instant, { timeZone: "UTC" })}, ${expectedClock}`);
  });

  it("rebuilds an evicted display formatter with the same result", () => {
    const date = new Date("2026-01-01T23:00:00Z");
    const context = { locale: "en-x-eviction", timeZone: "Europe/Berlin" };
    const expected = formatDate(date, context);
    // More distinct keys than the complete cache budget; no test-only reset API.
    for (let key = 0; key < 65; key++) {
      formatDate(date, { ...context, locale: `en-x-evict-${key}` });
    }
    const native = Intl.DateTimeFormat;
    let constructed = 0;
    Intl.DateTimeFormat = new Proxy(native, {
      construct(target, args) { constructed++; return Reflect.construct(target, args); },
    });
    try {
      expect(formatDate(date, context)).toBe(expected);
      expect(formatDate(date, context)).toBe(expected);
      expect(constructed).toBe(1);
    } finally {
      Intl.DateTimeFormat = native;
    }
  });

  it("keeps locale-specific dates and an ASCII 24-hour clock without reparsing localized strings", () => {
    const native = Date.prototype.toLocaleString;
    Date.prototype.toLocaleString = () => { throw new Error("Localized strings must not be parsed for display"); };
    try {
      expect(formatDateTime("2026-01-01T23:00:00Z", { locale: "de", timeZone: "Europe/Berlin" })).toBe("2. Jan. 2026, 00:00");
      const date = "2026-01-01T23:00:00Z";
      const context = { locale: "ar-EG-u-ca-islamic", timeZone: "Europe/Berlin" };
      expect(formatDateTime(date, context)).toBe(`${formatDate(date, context)}, 00:00`);
    } finally {
      Date.prototype.toLocaleString = native;
    }
  });

  it("reuses display formatters across a page of rows while isolating locale and timezone", () => {
    const NativeDateTimeFormat = Intl.DateTimeFormat;
    const NativeRelativeTimeFormat = Intl.RelativeTimeFormat;
    let datesConstructed = 0;
    let relativeConstructed = 0;
    Intl.DateTimeFormat = new Proxy(NativeDateTimeFormat, {
      construct(target, args) { datesConstructed++; return Reflect.construct(target, args); },
    });
    const relativeDescriptor = Object.getOwnPropertyDescriptor(Intl, "RelativeTimeFormat");
    Object.defineProperty(Intl, "RelativeTimeFormat", { ...relativeDescriptor, value: new Proxy(NativeRelativeTimeFormat, {
      construct(target, args) { relativeConstructed++; return Reflect.construct(target, args); },
    }) });
    try {
      for (let row = 0; row < 100; row++) {
        const date = new Date(Date.UTC(2026, 0, 1, 12, row));
        const context = { locale: "en-x-mailrow", timeZone: "Pacific/Chatham" };
        const expectedDate = new NativeDateTimeFormat(context.locale, { day: "numeric", month: "short", year: "numeric", timeZone: context.timeZone }).format(date);
        expect(formatDateTime(date, context).split(", ").slice(0, -1).join(", ")).toBe(expectedDate);
        expect(formatDateTimeRelative(date, { ...context, base: new Date(+date + 60_000) })).toBe("1 minute ago");
      }
      expect(datesConstructed).toBe(2);
      expect(relativeConstructed).toBe(1);
      expect(formatDateTime("2026-01-01T23:00:00Z", { locale: "de", timeZone: "Europe/Berlin" })).toBe("2. Jan. 2026, 00:00");
      expect(formatDateTime("2026-01-01T23:00:00Z", { locale: "en-GB", timeZone: "UTC" })).toBe("1 Jan 2026, 23:00");
    } finally {
      Intl.DateTimeFormat = NativeDateTimeFormat;
      Object.defineProperty(Intl, "RelativeTimeFormat", { ...relativeDescriptor, value: NativeRelativeTimeFormat });
    }
  });
});

// =============================================================================
// Relative formatters (need fake time)
// =============================================================================

describe("formatDateTimeRelative", () => {
  const NOW = new Date("2025-03-05T12:00:00Z");

  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it("returns 'now' for < 5 seconds ago", () => {
    expect(formatDateTimeRelative("2025-03-05T11:59:57Z")).toBe("now");
  });

  it("returns seconds ago for 5-59 seconds", () => {
    expect(formatDateTimeRelative("2025-03-05T11:59:30Z")).toBe("30 seconds ago");
  });

  it("returns minutes ago for 1-59 minutes", () => {
    expect(formatDateTimeRelative("2025-03-05T11:30:00Z")).toBe("30 minutes ago");
  });

  it("returns hours ago for 1-23 hours", () => {
    expect(formatDateTimeRelative("2025-03-05T06:00:00Z")).toBe("6 hours ago");
  });

  it("returns 'yesterday' for 24-47 hours", () => {
    expect(formatDateTimeRelative("2025-03-04T12:00:00Z")).toBe("yesterday");
  });

  it("localizes wording via the context locale", () => {
    expect(formatDateTimeRelative("2025-03-04T12:00:00Z", { locale: "de" })).toBe("gestern");
    expect(formatDateTimeRelative("2025-03-05T11:30:00Z", { locale: "de" })).toBe("vor 30 Minuten");
  });

  it("returns weekday name for 2-6 days ago", () => {
    // 2025-03-02 is a Sunday
    const result = formatDateTimeRelative("2025-03-02T12:00:00Z");
    expect(result).toBe("Sun");
  });

  it("returns formatted date for > 7 days ago", () => {
    expect(formatDateTimeRelative("2025-02-20T12:00:00Z")).toBe("Feb 20, 2025");
  });

  it("pluralizes correctly: '6 seconds ago'", () => {
    expect(formatDateTimeRelative("2025-03-05T11:59:54Z")).toBe("6 seconds ago");
  });

  it("pluralizes singular: '1 hour ago'", () => {
    expect(formatDateTimeRelative("2025-03-05T11:00:00Z")).toBe("1 hour ago");
  });

  it("returns formatted date for future timestamps", () => {
    expect(formatDateTimeRelative("2025-04-05T12:00:00Z")).toBe("Apr 5, 2025");
  });
});

describe("formatDateRelative", () => {
  const NOW = new Date("2025-03-05T14:30:00Z");

  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it("returns UTC time string for today", () => {
    const result = formatDateRelative("2025-03-05T14:30:00Z");
    expect(result).toBe("14:30");
  });

  it("returns 'yesterday' for 1 day ago", () => {
    expect(formatDateRelative("2025-03-04T10:00:00Z")).toBe("yesterday");
    expect(formatDateRelative("2025-03-04T10:00:00Z", { locale: "de" })).toBe("gestern");
  });

  it("returns formatted date for 7+ days ago", () => {
    expect(formatDateRelative("2025-02-20T12:00:00Z")).toBe("Feb 20, 2025");
  });

  it("returns formatted date for future timestamps", () => {
    expect(formatDateRelative("2025-04-05T12:00:00Z")).toBe("Apr 5, 2025");
  });

  it("uses timezone day boundaries when provided", () => {
    expect(
      formatDateRelative("2025-03-05T23:30:00Z", {
        base: "2025-03-06T01:00:00Z",
        timeZone: "Europe/Berlin",
      }),
    ).toBe("00:30");
  });
});

// =============================================================================
// formatTimeSpan (use explicit base for determinism)
// =============================================================================

describe("formatTimeSpan", () => {
  const base = "2025-03-05T12:00:00Z";

  it("returns relative minutes for future", () => {
    const result = formatTimeSpan("2025-03-05T12:30:00Z", { base });
    expect(result).toMatch(/30\s*minute/i);
  });

  it("returns relative hours", () => {
    const result = formatTimeSpan("2025-03-05T15:00:00Z", { base });
    expect(result).toMatch(/3\s*hour/i);
  });

  it("returns relative days", () => {
    const result = formatTimeSpan("2025-03-08T12:00:00Z", { base });
    expect(result).toMatch(/3\s*day/i);
  });

  it("handles past times", () => {
    const result = formatTimeSpan("2025-03-05T11:30:00Z", { base });
    expect(result).toMatch(/30\s*minute/i);
    expect(result).toContain("ago");
  });

  it("localizes wording via the context locale", () => {
    expect(formatTimeSpan("2025-03-05T11:30:00Z", { base, locale: "de" })).toBe("vor 30 Minuten");
  });
});

// =============================================================================
// formatDuration (pure)
// =============================================================================

describe("formatDuration", () => {
  const base = new Date("2025-01-01T00:00:00Z");

  it("returns '< 1 minute' for < 60 seconds", () => {
    const end = new Date(base.getTime() + 30_000);
    expect(formatDuration(base, end)).toBe("< 1 minute");
    expect(formatDuration(base, end, { locale: "de" })).toBe("< 1 Minute");
  });

  it("returns singular minute", () => {
    const end = new Date(base.getTime() + 60_000);
    expect(formatDuration(base, end)).toBe("1 minute");
  });

  it("returns plural minutes", () => {
    const end = new Date(base.getTime() + 5 * 60_000);
    expect(formatDuration(base, end)).toBe("5 minutes");
  });

  it("returns hours and minutes", () => {
    const end = new Date(base.getTime() + 2 * 60 * 60_000 + 30 * 60_000);
    expect(formatDuration(base, end)).toBe("2 hours, 30 minutes");
  });

  it("returns days and hours", () => {
    const end = new Date(base.getTime() + 24 * 60 * 60_000 + 3 * 60 * 60_000);
    expect(formatDuration(base, end)).toBe("1 day, 3 hours");
  });

  it("localizes unit names via the context locale", () => {
    const end = new Date(base.getTime() + 2 * 60 * 60_000 + 30 * 60_000);
    expect(formatDuration(base, end, { locale: "de" })).toBe("2 Stunden, 30 Minuten");
  });

  it("omits zero sub-units", () => {
    const end = new Date(base.getTime() + 2 * 60 * 60_000);
    expect(formatDuration(base, end)).toBe("2 hours");
  });

  it("is direction-independent", () => {
    const end = new Date(base.getTime() + 60 * 60_000);
    expect(formatDuration(base, end)).toBe(formatDuration(end, base));
  });
});

// =============================================================================
// formatRecurrence / formatRecurrenceParts
// =============================================================================

describe("formatRecurrence", () => {
  it("formats weekly rules with weekdays and until date", () => {
    expect(formatRecurrence({ freq: "weekly", byWeekday: [2, 3], until: new Date("2024-12-23") })).toBe(
      "Every Tue and Wed until Dec 23, 2024",
    );
  });

  it("formats simple frequencies", () => {
    expect(formatRecurrence({ freq: "daily" })).toBe("Every day");
    expect(formatRecurrence({ freq: "monthly" })).toBe("Every month");
  });

  it("formats intervals and counts", () => {
    expect(formatRecurrence({ freq: "monthly", interval: 2, count: 6 })).toBe("Every 2 months, 6 times");
  });

  it("combines intervals with weekdays", () => {
    expect(formatRecurrence({ freq: "weekly", interval: 2, byWeekday: [1] })).toBe("Every 2 weeks on Mon");
  });

  it("localizes weekday and unit names via the context locale", () => {
    expect(formatRecurrence({ freq: "weekly", interval: 2, byWeekday: [1] }, { locale: "de" })).toBe(
      "Every 2 Wochen on Mo",
    );
  });
});

describe("formatRecurrenceParts", () => {
  it("returns localized building blocks", () => {
    const parts = formatRecurrenceParts(
      { freq: "weekly", byWeekday: [2, 3], until: new Date("2024-12-23") },
      { locale: "de" },
    );
    expect(parts.every).toBe("Woche");
    expect(parts.weekdays).toBe("Di und Mi");
    expect(parts.until).toBe("23. Dez. 2024");
    expect(parts.count).toBeUndefined();
  });

  it("formats intervals as localized unit values", () => {
    expect(formatRecurrenceParts({ freq: "weekly", interval: 2 }).every).toBe("2 weeks");
    expect(formatRecurrenceParts({ freq: "daily" }).every).toBe("day");
  });

  it("passes count through and omits absent parts", () => {
    const parts = formatRecurrenceParts({ freq: "yearly", count: 3 });
    expect(parts).toEqual({ every: "year", count: 3 });
  });
});

// =============================================================================
// getMonthGrid
// =============================================================================

describe("getMonthGrid", () => {
  it("returns weeks of 7 days each", () => {
    const grid = getMonthGrid(2025, 0); // January 2025
    for (const week of grid) {
      expect(week.length).toBe(7);
    }
  });

  it("starts on Monday (ISO week)", () => {
    const grid = getMonthGrid(2025, 0);
    // First day of first week should be Monday (1)
    expect(grid[0]![0]!.getDay()).toBe(1);
  });

  it("includes all days of the target month", () => {
    const grid = getMonthGrid(2025, 0); // January has 31 days
    const allDays = grid.flat();
    const januaryDays = allDays.filter((d) => d.getMonth() === 0 && d.getFullYear() === 2025);
    expect(januaryDays.length).toBe(31);
  });
});

// =============================================================================
// getWeekDays
// =============================================================================

describe("getWeekDays", () => {
  it("returns 7 days starting from Monday", () => {
    const days = getWeekDays(localDate("2025-03-05")); // Wednesday
    expect(days.length).toBe(7);
    expect(days[0]!.getDay()).toBe(1); // Monday
  });

  it("returns correct week for date falling on Sunday", () => {
    const days = getWeekDays(localDate("2025-03-09")); // Sunday
    expect(days[0]!.getDay()).toBe(1); // Still starts Monday
  });
});

// =============================================================================
// getDateRange
// =============================================================================

describe("getDateRange", () => {
  it("month view includes padding days", () => {
    const { from } = getDateRange("month", localDate("2025-03-15"));
    // March 1 2025 is Saturday, so week starts Monday Feb 24
    expect(from.getTime()).toBeLessThan(localDate("2025-03-01").getTime());
  });

  it("week view returns 7-day span", () => {
    const { from, to } = getDateRange("week", localDate("2025-03-05"));
    const diffDays = (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThanOrEqual(6);
    expect(diffDays).toBeLessThanOrEqual(7);
  });
});

// =============================================================================
// itemOnDate
// =============================================================================

describe("itemOnDate", () => {
  it("returns true for event spanning the date", () => {
    const item = { startsAt: "2025-03-04T10:00", endsAt: "2025-03-06T18:00", deadline: null };
    expect(itemOnDate(item, localDate("2025-03-05"))).toBe(true);
  });

  it("returns false for event not spanning the date", () => {
    const item = { startsAt: "2025-03-01T10:00", endsAt: "2025-03-02T18:00", deadline: null };
    expect(itemOnDate(item, localDate("2025-03-05"))).toBe(false);
  });

  it("returns true for deadline on the same day", () => {
    const item = { startsAt: null, endsAt: null, deadline: "2025-03-05T10:00" };
    expect(itemOnDate(item, localDate("2025-03-05"))).toBe(true);
  });

  it("returns false for deadline on different day", () => {
    const item = { startsAt: null, endsAt: null, deadline: "2025-03-06T10:00" };
    expect(itemOnDate(item, localDate("2025-03-05"))).toBe(false);
  });

  it("returns false when no startsAt/endsAt/deadline", () => {
    const item = { startsAt: null, endsAt: null, deadline: null };
    expect(itemOnDate(item, localDate("2025-03-05"))).toBe(false);
  });
});

// =============================================================================
// getDayItems
// =============================================================================

describe("getDayItems", () => {
  it("filters items to those on the given date", () => {
    const items = [
      { startsAt: "2025-03-05T10:00", endsAt: "2025-03-05T12:00", deadline: null },
      { startsAt: "2025-03-06T10:00", endsAt: "2025-03-06T12:00", deadline: null },
      { startsAt: null, endsAt: null, deadline: "2025-03-05T15:00" },
    ];
    expect(getDayItems(items, localDate("2025-03-05")).length).toBe(2);
  });

  it("returns empty array when no items match", () => {
    expect(getDayItems([], localDate("2025-03-05")).length).toBe(0);
  });
});

// =============================================================================
// Date checks
// =============================================================================

describe("isToday", () => {
  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2025-03-05T12:00:00"));
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it("returns true for today's date", () => {
    expect(isToday(localDate("2025-03-05"))).toBe(true);
  });

  it("returns false for yesterday", () => {
    expect(isToday(localDate("2025-03-04"))).toBe(false);
  });
});

describe("isSameMonth", () => {
  it("returns true for dates in same month", () => {
    expect(isSameMonth(localDate("2025-03-01"), localDate("2025-03-31"))).toBe(true);
  });

  it("returns false for dates in different months", () => {
    expect(isSameMonth(localDate("2025-03-01"), localDate("2025-04-01"))).toBe(false);
  });
});

describe("isSameDay", () => {
  it("returns true for same date different times", () => {
    expect(isSameDay(new Date("2025-03-05T10:00"), new Date("2025-03-05T22:00"))).toBe(true);
  });

  it("returns false for different dates", () => {
    expect(isSameDay(localDate("2025-03-05"), localDate("2025-03-06"))).toBe(false);
  });

  it("compares calendar days in the requested timezone", () => {
    const a = new Date("2025-03-05T23:30:00Z");
    const b = new Date("2025-03-06T01:00:00Z");
    expect(isSameDay(a, b, { timeZone: "Europe/Berlin" })).toBe(true);
    expect(isSameDay(a, b, { timeZone: "UTC" })).toBe(false);
  });
});

// =============================================================================
// Formatting (calendar-specific)
// =============================================================================

describe("formatting", () => {
  it("formatMonthYear returns English month name", () => {
    expect(formatMonthYear(localDate("2025-03-05"))).toBe("March 2025");
  });

  it("formatDayNumber returns day without padding", () => {
    expect(formatDayNumber(localDate("2025-03-05"))).toBe("5");
  });

  it("formatWeekdayShort returns 2-letter English abbreviation", () => {
    // 2025-03-05 is Wednesday -> "We" (first two chars of "Wed")
    expect(formatWeekdayShort(localDate("2025-03-05"))).toBe("We");
  });

  it("formatFullDate returns European-style format", () => {
    expect(formatFullDate(localDate("2025-03-05"))).toBe("5. March 2025");
  });

  it("formatDateKey returns YYYY-MM-DD", () => {
    expect(formatDateKey(localDate("2025-03-05"))).toBe("2025-03-05");
  });

  it("formatTime returns HH:mm", () => {
    expect(formatTime("2025-03-05T14:30:00")).toBe("14:30");
  });

  it("formatDateKey uses the requested timezone", () => {
    expect(formatDateKey(new Date("2025-03-05T02:30:00Z"), { timeZone: "America/New_York" })).toBe("2025-03-04");
    expect(formatDateKey(new Date("2025-03-05T02:30:00Z"), { timeZone: "Asia/Tokyo" })).toBe("2025-03-05");
  });

  it("formatTime uses the requested timezone", () => {
    expect(formatTime("2025-03-05T23:30:00Z", { timeZone: "Europe/Berlin" })).toBe("00:30");
  });
});

// =============================================================================
// Locale support
// =============================================================================

describe("locale support", () => {
  it("formatMonthYear supports locale", () => {
    expect(formatMonthYear(localDate("2025-03-05"), { locale: "de" })).toBe("März 2025");
  });

  it("formatWeekdayShort supports locale", () => {
    // Wednesday in German short is "Mi", sliced to 2 chars -> "Mi"
    expect(formatWeekdayShort(localDate("2025-03-05"), { locale: "de" })).toBe("Mi");
  });

  it("formatFullDate supports locale", () => {
    expect(formatFullDate(localDate("2025-03-05"), { locale: "de" })).toBe("5. März 2025");
  });
});

// =============================================================================
// weekdays() and months() generators
// =============================================================================

describe("weekdays", () => {
  it("returns 7 short weekday names in English by default", () => {
    const result = weekdays();
    expect(result.length).toBe(7);
    expect(result).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  });

  it("starts with Monday (ISO order)", () => {
    expect(weekdays()[0]).toBe("Mon");
  });

  it("supports locale parameter", () => {
    const result = weekdays({ locale: "de" });
    expect(result.length).toBe(7);
    expect(result[0]).toBe("Mo");
    expect(result[2]).toBe("Mi"); // Wednesday in German
  });
});

describe("months", () => {
  it("returns 12 long month names in English by default", () => {
    const result = months();
    expect(result.length).toBe(12);
    expect(result[0]).toBe("January");
    expect(result[2]).toBe("March");
    expect(result[11]).toBe("December");
  });

  it("supports locale parameter", () => {
    const result = months({ locale: "de" });
    expect(result.length).toBe(12);
    expect(result[0]).toBe("Januar");
    expect(result[2]).toBe("März");
    expect(result[11]).toBe("Dezember");
  });
});

// =============================================================================
// Navigation
// =============================================================================

describe("navigation", () => {
  it("addMonths adds months correctly", () => {
    const result = addMonths(localDate("2025-01-15"), 2);
    expect(result.getMonth()).toBe(2); // March
  });

  it("addWeeks adds weeks correctly", () => {
    const result = addWeeks(localDate("2025-03-01"), 1);
    expect(result.getDate()).toBe(8);
  });

  it("addDays adds days correctly", () => {
    const result = addDays(localDate("2025-03-05"), 3);
    expect(result.getDate()).toBe(8);
  });

  it("startOfMonth returns first day", () => {
    const result = startOfMonth(localDate("2025-03-15"));
    expect(result.getDate()).toBe(1);
  });

  it("startOfWeek returns Monday", () => {
    const result = startOfWeek(localDate("2025-03-05")); // Wednesday
    expect(result.getDay()).toBe(1); // Monday
  });

  it("addDays preserves zoned civil days across DST", () => {
    const berlin = { timeZone: "Europe/Berlin" };
    const start = parseCalendarDate("2026-03-29", berlin);
    const next = addDays(start, 1, berlin);
    expect(formatDateKey(next, berlin)).toBe("2026-03-30");
    expect(next.toISOString()).toBe("2026-03-29T22:00:00.000Z");
  });

  it("startOfDay and endOfDay return zoned day boundary instants", () => {
    const berlin = { timeZone: "Europe/Berlin" };
    expect(startOfDay("2026-03-29T12:00:00Z", berlin).toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(endOfDay("2026-03-29T12:00:00Z", berlin).toISOString()).toBe("2026-03-29T21:59:59.999Z");
  });

  it("startOfWeek returns the zoned Monday instant", () => {
    const berlin = { timeZone: "Europe/Berlin" };
    const result = startOfWeek(new Date("2026-03-29T12:00:00Z"), berlin);
    expect(formatDateKey(result, berlin)).toBe("2026-03-23");
    expect(result.toISOString()).toBe("2026-03-22T23:00:00.000Z");
  });

  it("supports firstDayOfWeek as an alias for weekStartsOn", () => {
    const days = getWeekDays(localDate("2025-03-05"), { firstDayOfWeek: 0 });
    expect(days[0]!.getDay()).toBe(0);
  });

  it("adds zoned wall-clock recurrence intervals across DST", () => {
    expect(addZoned("2026-03-23T09:00", { timeZone: "Europe/Berlin", weeks: 1 })).toBe("2026-03-30T09:00");
  });

  it("adds zoned instant recurrence intervals while preserving wall-clock time", () => {
    expect(addZonedInstant("2026-03-23T08:00:00.000Z", { timeZone: "Europe/Berlin", weeks: 1 })).toBe(
      "2026-03-30T07:00:00.000Z",
    );
  });

  it("applies disambiguation when zoned recurrence addition reaches a DST overlap", () => {
    const input = "2026-10-24T00:30:00.000Z";
    expect(() => addZonedInstant(input, { timeZone: "Europe/Berlin", days: 1 })).toThrow(RangeError);
    expect(
      addZonedInstant(input, { timeZone: "Europe/Berlin", days: 1, disambiguation: "compatible" }),
    ).toBe("2026-10-25T00:30:00.000Z");
    expect(addZonedInstant(input, { timeZone: "Europe/Berlin", days: 1, disambiguation: "earlier" })).toBe(
      "2026-10-25T00:30:00.000Z",
    );
    expect(addZonedInstant(input, { timeZone: "Europe/Berlin", days: 1, disambiguation: "later" })).toBe(
      "2026-10-25T01:30:00.000Z",
    );
  });

  it("applies disambiguation when zoned recurrence addition reaches a DST gap", () => {
    const input = "2026-03-28T01:30:00.000Z";
    expect(() => addZonedInstant(input, { timeZone: "Europe/Berlin", days: 1 })).toThrow(RangeError);
    expect(() =>
      addZonedInstant(input, { timeZone: "Europe/Berlin", days: 1, disambiguation: "earlier" }),
    ).toThrow(RangeError);
    expect(
      addZonedInstant(input, { timeZone: "Europe/Berlin", days: 1, disambiguation: "compatible" }),
    ).toBe("2026-03-29T01:30:00.000Z");
    expect(addZonedInstant(input, { timeZone: "Europe/Berlin", days: 1, disambiguation: "later" })).toBe(
      "2026-03-29T01:30:00.000Z",
    );
  });
});

// =============================================================================
// URL helpers
// =============================================================================

describe("URL helpers", () => {
  it("buildCalendarUrl sets view=calendar", () => {
    const url = buildCalendarUrl("/page", {});
    expect(url).toContain("view=calendar");
  });

  it("buildCalendarUrl includes cv and cd params", () => {
    const url = buildCalendarUrl("/page", {
      view: "week",
      date: localDate("2025-03-05"),
    });
    expect(url).toContain("cv=week");
    expect(url).toContain("cd=2025-03-05");
  });

  it("buildCalendarUrl preserves existing query params", () => {
    const url = buildCalendarUrl("/page?existing=1", { view: "month" });
    expect(url).toContain("existing=1");
    expect(url).toContain("cv=month");
  });

  it("parseCalendarDate parses valid date string", () => {
    const result = parseCalendarDate("2025-03-05");
    expect(result.getFullYear()).toBe(2025);
    expect(result.getMonth()).toBe(2); // March = 2
    expect(result.getDate()).toBe(5);
  });

  it("parseCalendarDate returns today for undefined", () => {
    const result = parseCalendarDate(undefined);
    const t = today();
    expect(isSameDay(result, t)).toBe(true);
  });

  it("parseCalendarDate produces local-midnight (TZ regression test)", () => {
    // The bug was: new Date("2025-03-05") parsed as UTC; in negative-offset
    // timezones .getDate() returned 4 (previous day), silently breaking
    // calendar URLs throughout the Americas.
    const d = parseCalendarDate("2025-03-05");
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
  });

  it("parseCalendarDate normalizes ISO datetimes to local midnight", () => {
    const d = parseCalendarDate("2025-03-05T15:30:00Z");
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });

  it("parseCalendarDate anchors date-only params at midnight in the requested timezone", () => {
    const d = parseCalendarDate("2026-03-29", { timeZone: "Europe/Berlin" });
    expect(d.toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(formatDateKey(d, { timeZone: "Europe/Berlin" })).toBe("2026-03-29");
  });

  it("buildCalendarUrl writes date keys in the requested timezone", () => {
    const url = buildCalendarUrl(
      "/page",
      { view: "week", date: new Date("2025-03-05T02:30:00Z") },
      { timeZone: "America/New_York" },
    );
    expect(url).toContain("cd=2025-03-04");
  });
});

// =============================================================================
// Timezone-aware calendar views
// =============================================================================

describe("timezone-aware calendar views", () => {
  it("getDateRange returns instants for zoned week boundaries across DST", () => {
    const berlin = { timeZone: "Europe/Berlin" };
    const range = getDateRange("week", parseCalendarDate("2026-03-29", berlin), berlin);
    expect(formatDateKey(range.from, berlin)).toBe("2026-03-23");
    expect(formatDateKey(range.to, berlin)).toBe("2026-03-29");
    expect(range.from.toISOString()).toBe("2026-03-22T23:00:00.000Z");
    expect(range.to.toISOString()).toBe("2026-03-29T21:59:59.999Z");
  });

  it("getMonthGrid emits dates readable as the requested zoned month", () => {
    const newYork = { timeZone: "America/New_York" };
    const grid = getMonthGrid(2025, 2, newYork);
    const marchDays = grid.flat().filter((day) => formatDateKey(day, newYork).startsWith("2025-03-"));
    expect(marchDays.length).toBe(31);
  });

  it("itemOnDate matches event ranges against the requested timezone day", () => {
    const berlin = { timeZone: "Europe/Berlin" };
    const item = {
      startsAt: "2025-03-05T23:30:00Z",
      endsAt: "2025-03-06T00:30:00Z",
      deadline: null,
    };
    expect(itemOnDate(item, parseCalendarDate("2025-03-06", berlin), berlin)).toBe(true);
    expect(itemOnDate(item, parseCalendarDate("2025-03-05", berlin), berlin)).toBe(false);
  });
});

for (const locale of ["de", "de-DE", "en", "en-GB"]) {
  describe(`locale date formatting: ${locale}`, () => {
    for (const day of ["02", "27"]) for (const timeZone of [undefined, "UTC", "Asia/Tokyo"]) {
      it(`${day}, ${timeZone ?? "default UTC"}: punctuation, order, clock and relative fallback`, () => {
        const input = `2026-05-${day}T13:05:00Z`;
        const context = { locale, timeZone };
        const expected = locale.startsWith("de") ? `${Number(day)}. Mai 2026` : locale === "en" ? `May ${Number(day)}, 2026` : `${Number(day)} May 2026`;
        expect(formatDate(input, context)).toBe(expected);
        expect(formatDate(new Date(input), context)).toBe(expected);
        expect(formatDateTime(input, context)).toBe(`${expected}, ${timeZone === "Asia/Tokyo" ? "22" : "13"}:05`);
        const numeric = locale.startsWith("de") ? `${day}.05.2026` : locale === "en" ? `05/${day}/2026` : `${day}/05/2026`;
        expect(formatDate(input, { ...context, style: "numeric" })).toBe(numeric);
        for (const base of ["2026-04-01T12:00:00Z", "2026-06-15T12:00:00Z"]) {
          expect(formatDateRelative(input, { ...context, base })).toBe(expected);
          expect(formatDateTimeRelative(input, { ...context, base })).toBe(expected);
        }
        expect(formatRecurrenceParts({ freq: "daily", until: input }, context).until).toBe(expected);
      });
    }
  });
}

it("date-only input retains UTC semantics and explicit westward date rollover", () => {
  expect(formatDate("2026-05-02", { locale: "de" })).toBe("2. Mai 2026");
  expect(formatDate("2026-05-02", { locale: "de", timeZone: "America/New_York" })).toBe("1. Mai 2026");
  expect(formatDateTime("2026-05-02", { locale: "de", timeZone: "America/New_York" })).toBe("1. Mai 2026, 20:00");
});
