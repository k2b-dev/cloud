import { describe, expect, test } from "bun:test";
import {
  MONTH_ROW_BLOCK,
  MONTH_ROWS_IN_VIEW,
  monthFocusRow,
  monthOfWeek,
  monthRenderWindow,
  monthRevealTop,
  monthRowOf,
  monthTodayDirection,
  monthVisibleRows,
  monthWeekKeys,
} from "./calendar-month-scroll";

describe("continuous month scroll math", () => {
  test("covers exclusive ranges in whole calendar weeks across DST, with either week start", () => {
    expect(MONTH_ROWS_IN_VIEW).toBe(5);
    expect(MONTH_ROW_BLOCK).toBe(8);
    expect(monthWeekKeys("2026-10-23", "2026-11-03", 1)).toEqual(["2026-10-19", "2026-10-26", "2026-11-02"]);
    expect(monthWeekKeys("2026-10-23", "2026-11-03", 0)).toEqual(["2026-10-18", "2026-10-25", "2026-11-01"]);
    expect(monthWeekKeys("2026-10-19", "2026-10-26", 1)).toEqual(["2026-10-19"]);
    expect(monthWeekKeys("2026-10-19", "2026-10-19", 1)).toEqual([]);
  });
  test("the center row names the month by its middle day and clamps to loaded rows", () => {
    const weeks = monthWeekKeys("2026-09-28", "2026-12-21", 1);
    expect(monthFocusRow(0, 500, 100, weeks.length)).toBe(2);
    expect(monthOfWeek(weeks[monthFocusRow(249, 500, 100, weeks.length)]!)).toBe("2026-10-01");
    expect(monthOfWeek(weeks[monthFocusRow(250, 500, 100, weeks.length)]!)).toBe("2026-11-01");
    // The middle day decides a week split across April and May.
    expect(monthOfWeek("2026-04-27")).toBe("2026-04-01");
    expect(monthOfWeek("2025-04-28")).toBe("2025-05-01");
    expect(monthOfWeek("2026-11-01")).toBe("2026-11-01");
    expect(monthFocusRow(-1000, 500, 100, 16)).toBe(0);
    expect(monthFocusRow(10000, 500, 100, 16)).toBe(15);
  });
  test("finds the week of the first and rejects days outside the loaded weeks", () => {
    const weeks = monthWeekKeys("2026-08-31", "2026-12-21", 1);
    expect(monthRowOf(weeks, "2026-10-01")).toBe(4);
    expect(monthRowOf(weeks, "2026-11-01")).toBe(8);
    expect(monthRowOf(weeks, "2026-12-21")).toBeUndefined();
    expect(monthRowOf(weeks, "2026-08-30")).toBeUndefined();
    expect(monthRowOf([], "2026-11-01")).toBeUndefined();
  });
  test("excludes rows visible by exactly half and handles partial rows at both edges", () => {
    expect(monthVisibleRows(0, 500, 100, 16)).toEqual({ first: 0, end: 5 });
    expect(monthVisibleRows(49, 500, 100, 16)).toEqual({ first: 0, end: 5 });
    expect(monthVisibleRows(50, 500, 100, 16)).toEqual({ first: 1, end: 5 });
    expect(monthVisibleRows(51, 500, 100, 16)).toEqual({ first: 1, end: 6 });
    expect(monthVisibleRows(1500, 500, 100, 16)).toEqual({ first: 15, end: 16 });
  });
  test("virtual windows change only when the top or bottom crosses a block boundary", () => {
    expect(monthRenderWindow(0, 500, 100, 64)).toEqual({ first: 0, end: 16 });
    expect(monthRenderWindow(350, 500, 100, 64)).toEqual(monthRenderWindow(0, 500, 100, 64));
    expect(monthRenderWindow(351, 500, 100, 64)).toEqual({ first: 0, end: 24 });
    expect(monthRenderWindow(1549, 500, 100, 64)).toEqual({ first: 0, end: 32 });
    expect(monthRenderWindow(1550, 500, 100, 64)).toEqual({ first: 8, end: 32 });
    expect(monthRenderWindow(5800, 500, 100, 64)).toEqual({ first: 48, end: 64 });
  });
  test("reveals a row with the least movement", () => {
    expect(monthRevealTop(3, 200, 500, 100)).toBeUndefined();
    expect(monthRevealTop(1, 200, 500, 100)).toBe(100);
    expect(monthRevealTop(7, 200, 500, 100)).toBe(300);
    expect(monthRevealTop(2, 250, 500, 100)).toBe(200);
  });
  test("today points outside the view until more than half its row is visible", () => {
    expect(monthTodayDirection(0, 50, 500, 100)).toBe("up");
    expect(monthTodayDirection(0, 49, 500, 100)).toBe("");
    expect(monthTodayDirection(5, 50, 500, 100)).toBe("down");
    expect(monthTodayDirection(5, 51, 500, 100)).toBe("");
    expect(monthTodayDirection(-1, 0, 500, 100)).toBe("up");
    expect(monthTodayDirection(20, 0, 500, 100)).toBe("down");
  });
});
