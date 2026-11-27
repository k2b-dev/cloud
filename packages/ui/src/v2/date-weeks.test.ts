import { describe, expect, test } from "bun:test";
import { firstDayOfWeek, startOfWeek } from "./behavior/dates";
import { windowEnd, windowShowing, windowWeeks } from "./date-weeks";

describe("the rolling six weeks of a date picker", () => {
  test("a week starts where core starts it: the locale, its region, and a tag's -u-fw- first", () => {
    expect([firstDayOfWeek("de"), firstDayOfWeek("en-US"), firstDayOfWeek("en-GB"), firstDayOfWeek("de-u-fw-sun")]).toEqual([1, 0, 1, 0]);
    // Wednesday 25 November 2026
    expect(startOfWeek("2026-11-25", 1)).toBe("2026-11-23");
    expect(startOfWeek("2026-11-25", 0)).toBe("2026-11-22");
  });
  test("a window shows six weeks of seven, over the end of a month and a year", () => {
    expect(windowEnd("2026-11-23")).toBe("2027-01-03");
    const weeks = windowWeeks("2026-11-23");
    expect(weeks.length).toBe(6);
    expect(weeks.every((week) => week.length === 7)).toBe(true);
    expect([weeks[1]?.[0], weeks[1]?.[1], weeks[5]?.[6]]).toEqual(["2026-11-30", "2026-12-01", "2027-01-03"]);
  });
  test("a week over a change of the clocks is seven days like any other", () => {
    // Berlin and New York change on 25 October and 1 November 2026: date keys never see it
    expect(windowWeeks("2026-10-19")[1]).toEqual([
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
    ]);
  });
  test("a window moves as little as needed to show a day, by whole weeks", () => {
    expect(windowShowing("2026-11-23", "2026-12-25", 1)).toBe("2026-11-23");
    expect(windowShowing("2026-11-23", "2027-01-04", 1)).toBe("2026-11-30");
    expect(windowShowing("2026-11-23", "2027-01-25", 1)).toBe("2026-12-21");
    expect(windowShowing("2026-11-30", "2026-11-25", 1)).toBe("2026-11-23");
  });
});
