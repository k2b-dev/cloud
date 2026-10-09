import { describe, expect, test } from "bun:test";
import { fitMonthWeek, layoutMonthWeek, monthLaneCapacity } from "./calendar-month-layout";

const week = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"];
const bar = (id: string, firstKey: string, lastKey: string) => ({ item: id, firstKey, lastKey, bar: true });
const single = (id: string, key: string) => ({ item: id, firstKey: key, lastKey: key, bar: false });

describe("month week layout", () => {
  test("draws a long entry as one bar in one lane, torn where the row cuts it, and stacks one-day entries per day", () => {
    const layout = layoutMonthWeek(week, [
      single("kickoff", "2026-10-05"),
      bar("setup", "2026-10-07", "2026-10-13"),
      single("badges", "2026-10-08"),
      bar("trip", "2026-09-30", "2026-10-06"),
      bar("holiday", "2026-10-07", "2026-10-07"),
    ]);
    expect(layout.bars).toEqual([
      // The trip began in the week before, so its bar starts torn in the first column and comes first.
      { item: "trip", startColumn: 0, endColumn: 1, lane: 0, continuesBefore: true, continuesAfter: false },
      // The setup runs into the next week: one bar to the row's end, torn there, before the shorter holiday.
      { item: "setup", startColumn: 2, endColumn: 6, lane: 0, continuesBefore: false, continuesAfter: true },
      { item: "holiday", startColumn: 2, endColumn: 2, lane: 1, continuesBefore: false, continuesAfter: false },
    ]);
    expect(layout.singles).toEqual([["kickoff"], [], [], ["badges"], [], [], []]);
  });

  test("leaves out entries outside the row and keeps the row's order for equal bars", () => {
    const layout = layoutMonthWeek(week, [
      bar("before", "2026-09-28", "2026-10-04"),
      bar("first", "2026-10-09", "2026-10-10"),
      bar("second", "2026-10-09", "2026-10-10"),
      single("after", "2026-10-12"),
    ]);
    expect(layout.bars.map(({ item, lane }) => [item, lane])).toEqual([
      ["first", 0],
      ["second", 1],
    ]);
    expect(layout.singles.flat()).toEqual([]);
  });
});

describe("month week overflow", () => {
  const layout = layoutMonthWeek(week, [
    bar("setup", "2026-10-05", "2026-10-08"),
    single("one", "2026-10-08"),
    single("two", "2026-10-08"),
    single("three", "2026-10-08"),
    single("four", "2026-10-06"),
  ]);

  test("draws everything when every day fits", () => {
    const fit = fitMonthWeek(layout, 4);
    expect(fit.bars.map((piece) => piece.item)).toEqual(["setup"]);
    expect(fit.cells.map(({ top, shown, hidden }) => [top, shown.length, hidden])).toEqual([
      [1, 0, 0],
      [1, 1, 0],
      [1, 0, 0],
      [1, 3, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ]);
  });

  test("gives only a crowded day's last row to +N and leaves its neighbors whole", () => {
    const fit = fitMonthWeek(layout, 3);
    // Thursday shows the bar and one entry, then "+2"; Tuesday still fits its entry below the bar.
    expect(fit.cells.map(({ shown, hidden }) => [shown, hidden])).toEqual([
      [[], 0],
      [["four"], 0],
      [[], 0],
      [["one"], 2],
      [[], 0],
      [[], 0],
      [[], 0],
    ]);
  });

  test("counts a bar that no longer fits on each of its days instead of cutting it", () => {
    const fit = fitMonthWeek(layout, 1);
    expect(fit.bars).toEqual([]);
    expect(fit.cells.map(({ shown, hidden }) => [shown.length, hidden])).toEqual([
      [0, 1],
      [0, 2],
      [0, 1],
      [0, 4],
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
  });

  test("fits whole rows with their gaps into the measured height", () => {
    expect(monthLaneCapacity(0, 20, 2)).toBe(0);
    expect(monthLaneCapacity(19, 20, 2)).toBe(0);
    expect(monthLaneCapacity(20, 20, 2)).toBe(1);
    expect(monthLaneCapacity(63, 20, 2)).toBe(2);
    expect(monthLaneCapacity(64, 20, 2)).toBe(3);
  });
});
