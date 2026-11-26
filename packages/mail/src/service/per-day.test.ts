import { expect, test } from "bun:test";
import { countingTimeZone, fillDays, PER_DAY_WINDOW } from "./per-day";

// The hero trends of Mail administration: thirty calendar days ending today in the request's time zone, every day
// once, days without rows at zero, whatever summer time does to the length of a day.

test("fills every day of the window from the oldest to today, with zero for days without rows", () => {
  const days = fillDays(
    [
      { day: "2031-03-29", count: 2 },
      { day: "2031-03-01", count: 5 },
    ],
    new Date("2031-03-29T12:00:00Z"),
    "Europe/Berlin",
  );
  expect(days).toHaveLength(PER_DAY_WINDOW);
  expect(days[0]).toEqual({ day: "2031-02-28", count: 0 });
  expect(days[1]).toEqual({ day: "2031-03-01", count: 5 });
  expect(days.at(-1)).toEqual({ day: "2031-03-29", count: 2 });
  expect(new Set(days.map((entry) => entry.day)).size).toBe(PER_DAY_WINDOW);
});

test("today is the request's day, also just after midnight there and across the change to summer time", () => {
  // 00:30 in Berlin on 31 March (the day after summer time began) is still 30 March in UTC
  const berlin = fillDays([], new Date("2031-03-30T22:30:00Z"), "Europe/Berlin");
  expect(berlin.at(-1)?.day).toBe("2031-03-31");
  expect(berlin.map((entry) => entry.day)).toContain("2031-03-30");
  expect(new Set(berlin.map((entry) => entry.day)).size).toBe(PER_DAY_WINDOW);
  expect(fillDays([], new Date("2031-03-30T22:30:00Z"), "UTC").at(-1)?.day).toBe("2031-03-30");
});

test("an unknown or missing time zone counts in UTC instead of failing the page", () => {
  expect(countingTimeZone("Europe/Berlin")).toBe("Europe/Berlin");
  expect(countingTimeZone("Not/AZone")).toBe("UTC");
  expect(countingTimeZone(undefined)).toBe("UTC");
});
