import { expect, test } from "bun:test";
import { defaultEnd, formatClock, isFutureEnd, todayKey } from "./time";

// 14:10 in Berlin (CET, UTC+1).
const NOW = Date.parse("2026-11-16T13:10:00.000Z");

test("the suggested end is one hour ahead, rounded up to the next quarter hour", () => {
  expect(defaultEnd(NOW)).toBe("2026-11-16T14:15:00.000Z");
  expect(defaultEnd(Date.parse("2026-11-16T13:00:00.000Z"))).toBe("2026-11-16T14:00:00.000Z");
  expect(defaultEnd(Date.parse("2026-11-16T13:00:00.001Z"))).toBe("2026-11-16T14:15:00.000Z");
  // Late in the evening the suggestion crosses midnight.
  expect(defaultEnd(Date.parse("2026-11-16T22:50:00.000Z"))).toBe("2026-11-17T00:00:00.000Z");
});

test("only an end after now counts, also on a later day", () => {
  expect(isFutureEnd("2026-11-16T13:10:00.001Z", NOW)).toBe(true);
  expect(isFutureEnd("2026-11-17T00:30:00.000Z", NOW)).toBe(true);
  expect(isFutureEnd("2026-11-16T13:10:00.000Z", NOW)).toBe(false);
  expect(isFutureEnd("2026-11-16T08:00:00.000Z", NOW)).toBe(false);
  expect(isFutureEnd("not a date", NOW)).toBe(false);
});

test("today is the viewer's day, which can differ from UTC", () => {
  expect(todayKey("Europe/Berlin", NOW)).toBe("2026-11-16");
  expect(todayKey("Europe/Berlin", Date.parse("2026-11-16T23:30:00.000Z"))).toBe("2026-11-17");
  expect(todayKey("America/Los_Angeles", Date.parse("2026-11-16T05:00:00.000Z"))).toBe("2026-11-15");
});

test("times today show the clock alone, other days add the date", () => {
  const context = { timeZone: "Europe/Berlin", locale: "de" };
  expect(formatClock("2026-11-16T13:02:00.000Z", context, NOW)).toBe("14:02");
  expect(formatClock("2026-11-17T00:30:00.000Z", context, NOW)).toContain("01:30");
  expect(formatClock("2026-11-17T00:30:00.000Z", context, NOW)).not.toBe("01:30");
});
