import { expect, test } from "bun:test";
import { formatClock, parseEndTime } from "./time";

// 14:10 in Berlin (CET, UTC+1).
const NOW = Date.parse("2026-11-16T13:10:00.000Z");

test("a clock time means today in the viewer's zone, in several spellings", () => {
  for (const value of ["14:30", "1430", "14.30", " 14:30 "])
    expect(parseEndTime(value, "Europe/Berlin", NOW)).toEqual({ ok: true, iso: "2026-11-16T13:30:00.000Z" });
  expect(parseEndTime("15", "Europe/Berlin", NOW)).toEqual({ ok: true, iso: "2026-11-16T14:00:00.000Z" });
  expect(parseEndTime("14:30", "UTC", NOW)).toEqual({ ok: true, iso: "2026-11-16T14:30:00.000Z" });
});

test("a passed time is rejected, never moved to tomorrow, and nonsense is a format error", () => {
  expect(parseEndTime("09:00", "Europe/Berlin", NOW)).toEqual({ ok: false, reason: "past" });
  expect(parseEndTime("14:10", "Europe/Berlin", NOW)).toEqual({ ok: false, reason: "past" });
  for (const value of ["", "24:00", "12:60", "abc", "1:2", "2026-11-16T15:00"])
    expect(parseEndTime(value, "Europe/Berlin", NOW)).toEqual({ ok: false, reason: "format" });
});

test("times today show the clock alone, other days add the date", () => {
  const context = { timeZone: "Europe/Berlin", locale: "de" };
  expect(formatClock("2026-11-16T13:02:00.000Z", context, NOW)).toBe("14:02");
  expect(formatClock("2026-11-15T21:00:00.000Z", context, NOW)).toContain("22:00");
  expect(formatClock("2026-11-15T21:00:00.000Z", context, NOW)).not.toBe("22:00");
});
