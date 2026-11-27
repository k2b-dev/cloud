import { expect, test } from "bun:test";
import { heatBounds, heatMonths, heatRows, heatTone, heatWeeks } from "./heat-days";

// The days of a Heat: 53 weeks that end with the week of the given day, days after it left out, a scale all days share.
// The dates are fixed: Friday 27 November 2026, weeks from Monday (de) or Sunday (en-US).
const today = "2026-11-27";

test("53 weeks end with the week of today; the days after today are left out", () => {
  const rows = heatRows([], today, 1);
  expect(rows).toHaveLength(7);
  // Monday to Friday reach this week, Saturday and Sunday stop at the week before
  expect(rows.map((row) => row.length)).toEqual([53, 53, 53, 53, 53, 52, 52]);
  expect(rows[0]![0]!.date).toBe("2025-11-24");
  expect(rows[4]![52]!.date).toBe(today);
  expect(rows[6]![51]!.date).toBe("2026-11-22");
  // with Sunday first, today is the sixth row and the week begins a day earlier
  const sunday = heatRows([], today, 0);
  expect(sunday[0]![52]!.date).toBe("2026-11-22");
  expect(sunday[5]![52]!.date).toBe(today);
  expect(sunday[6]).toHaveLength(heatWeeks - 1);
});

test("counts outside the 53 weeks are ignored, two counts for one day add up, a negative count is nothing", () => {
  const rows = heatRows(
    [
      { date: "2025-11-23", count: 9 },
      { date: "2026-11-28", count: 9 },
      { date: today, count: 2 },
      { date: today, count: 3 },
      { date: "2026-11-26", count: -4 },
    ],
    today,
    1,
  );
  const cells = rows.flat();
  expect(cells).toHaveLength(369);
  expect(cells.find((cell) => cell.date === today)).toEqual({ date: today, count: 5, tone: 1 });
  expect(cells.find((cell) => cell.date === "2026-11-26")!.count).toBe(0);
  expect(cells.reduce((sum, cell) => sum + cell.count, 0)).toBe(5);
});

test("the scale splits the days with a count into quarters: one busy day does not flatten the rest", () => {
  const bounds = heatBounds([1, 2, 3, 4, 5, 6, 7, 1000, 0, 0]);
  expect(bounds).toEqual([2, 4, 6]);
  expect([0, 1, 2, 3, 4, 5, 6, 7, 1000].map((count) => heatTone(count, bounds))).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4]);
  // nothing counted: every day is quiet; one value only: every day with a count is the softest tone
  expect(heatBounds([0, 0])).toEqual([]);
  expect(heatTone(5, [])).toBe(0);
  expect(heatBounds([3, 3, 3]).map((bound) => heatTone(3, [bound]))).toEqual([1, 1, 1]);
});

test("a month's name stands over the week of its first day; a month with fewer than three weeks in view has none", () => {
  const months = heatMonths(heatRows([], today, 1));
  // the view starts on 24 November 2025, so December is the first named month; 1 November 2026, a Sunday, ends the
  // week of 26 October
  expect(months[0]).toEqual({ week: 1, weeks: 4, date: "2025-12-01" });
  expect(months.at(-1)).toEqual({ week: 48, weeks: 5, date: "2026-11-01" });
  expect(months).toHaveLength(12);
  expect(months.every((month) => month.weeks >= 3)).toBe(true);
});
