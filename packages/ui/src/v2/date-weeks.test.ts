import { describe, expect, test } from "bun:test";
import { firstDayOfWeek, weekStartOf, windowEnd, windowShowing } from "./date-weeks";

describe("the rolling six weeks of a date picker", () => {
  test("a week starts where the locale starts it", () => {
    expect([firstDayOfWeek("de"), firstDayOfWeek("en-US"), firstDayOfWeek("en-GB")]).toEqual([1, 0, 1]);
    // Wednesday 25 November 2026
    expect(weekStartOf("2026-11-25", 1)).toBe("2026-11-23");
    expect(weekStartOf("2026-11-25", 0)).toBe("2026-11-22");
    expect(weekStartOf("2026-11-23", 1)).toBe("2026-11-23");
    expect(weekStartOf("2026-12-01", 1)).toBe("2026-11-30");
  });
  test("a window shows six weeks, over the end of a month and a year", () => {
    expect(windowEnd("2026-11-23")).toBe("2027-01-03");
  });
  test("a window moves as little as needed to show a day, by whole weeks", () => {
    expect(windowShowing("2026-11-23", "2026-12-25", 1)).toBe("2026-11-23");
    expect(windowShowing("2026-11-23", "2027-01-04", 1)).toBe("2026-11-30");
    expect(windowShowing("2026-11-23", "2027-01-25", 1)).toBe("2026-12-21");
    expect(windowShowing("2026-11-30", "2026-11-25", 1)).toBe("2026-11-23");
  });
});
