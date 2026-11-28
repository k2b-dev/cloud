import { expect, test } from "bun:test";
import { heatGrid, heatMonths, heatScale, heatWeeks } from "./heat-days";

// The days of a Heat: 53 weeks that end with the week of today, days after it left out, a scale all days share.
// The dates are fixed: Friday 27 November 2026, weeks from Monday (de) or Sunday (en-US).
const today = "2026-11-27";

test("53 weeks end with the week of today; the days after today are left out", () => {
  const { rows, span } = heatGrid([], today, 1);
  expect(rows).toHaveLength(7);
  // Monday to Friday reach this week, Saturday and Sunday stop at the week before
  expect(rows.map((row) => row.length)).toEqual([53, 53, 53, 53, 53, 52, 52]);
  expect(span).toBe(369);
  expect(rows[0]![0]).toBe("2025-11-24");
  expect(rows[4]![52]).toBe(today);
  expect(rows[6]![51]).toBe("2026-11-22");
  // with Sunday first, today is the sixth row and the week begins a day earlier
  const sunday = heatGrid([], today, 0).rows;
  expect(sunday[0]![52]).toBe("2026-11-22");
  expect(sunday[5]![52]).toBe(today);
  expect(sunday[6]).toHaveLength(heatWeeks - 1);
});

test("counts outside the 53 weeks, below 1 or not finite are ignored; two counts for one day add up", () => {
  const grid = heatGrid(
    [
      { date: "2025-11-23", count: 9 },
      { date: "2026-11-28", count: 9 },
      { date: today, count: 2 },
      { date: today, count: 3 },
      { date: "2026-11-26", count: -4 },
      { date: "2026-11-25", count: Number.NaN },
      { date: "2026-11-24", count: Number.POSITIVE_INFINITY },
    ],
    today,
    1,
  );
  expect([...grid.days]).toEqual([[today, { count: 5, tone: 4 }]]);
  expect(grid.total).toBe(5);
});

test("the scale splits the distinct counts into quarters: the busiest day is the strongest, one busy day flattens nothing", () => {
  const tone = heatScale([1, 2, 3, 4, 5, 6, 7, 1000, 0, 0]);
  expect([0, 1, 2, 3, 4, 5, 6, 7, 1000].map(tone)).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4]);
  // nothing counted: every day is quiet
  expect(heatScale([0, 0])(5)).toBe(0);
});

test("one day with a count, or every day with the same count, stands at the strongest tone", () => {
  expect(heatGrid([{ date: today, count: 1 }], today, 1).days.get(today)!.tone).toBe(4);
  const equal = heatGrid(
    Array.from({ length: 30 }, (_, index) => ({ date: `2026-11-${String(index + 1).padStart(2, "0")}`, count: 3 })),
    today,
    1,
  );
  expect(new Set([...equal.days.values()].map((day) => day.tone))).toEqual(new Set([4]));
  // two distinct counts: the lower one half, the higher one strong
  const two = heatScale([2, 2, 9]);
  expect([two(2), two(9)]).toEqual([2, 4]);
});

test("a month's name stands over the week of its first day; a month with fewer than three weeks in view has none", () => {
  const months = heatMonths(heatGrid([], today, 1).rows);
  // the view starts on 24 November 2025, so December is the first named month; 1 November 2026, a Sunday, ends the
  // week of 26 October
  expect(months[0]).toEqual({ week: 1, weeks: 4, date: "2025-12-01" });
  expect(months.at(-1)).toEqual({ week: 48, weeks: 5, date: "2026-11-01" });
  expect(months).toHaveLength(12);
});

test("the current month keeps its name from its first day: it stands at the end of the month before", () => {
  // 3 December 2026: December has one week in view, so it takes November's place and stands at its end
  const months = heatMonths(heatGrid([], "2026-12-03", 1).rows);
  expect(months.at(-1)).toEqual({ week: 47, weeks: 6, date: "2026-12-01", end: true });
  expect(months.some((month) => month.date === "2026-11-01")).toBe(false);
});
