import { expect, test } from "bun:test";
import { calendarDay, calendarLayout, renderCalendarSvg, renderHeatmapSvg } from "./calendar";
import { heatmap } from "./svg";

const spec = {
  layout: "calendar" as const,
  scale: "diverging" as const,
  data: [
    ["2026-11-02", 100],
    ["2026-11-09", -25],
    ["2026-11-10", 0],
  ] as [string, number][],
};
test("calendar weeks/day geometry, all-data scale and area-free color intensity", () => {
  const s = calendarLayout(spec);
  expect(s.cells.map((c) => [c.week, c.weekday])).toEqual([
    [0, 0],
    [1, 0],
    [1, 1],
  ]);
  expect(s.absMax).toBe(100);
  expect(s.cells[1]!.intensity).toBe(0.25);
  expect(s.cells[0]!.x).toBeLessThan(s.cells[1]!.x);
  expect(s.cells[1]!.y).toBeLessThan(s.cells[2]!.y);
  expect(calendarDay("2024-02-29")).toBe(Date.UTC(2024, 1, 29));
  for (const day of ["2026-02-29", "2026-11-31", "2026-1-01"]) expect(() => calendarDay(day)).toThrow();
  expect(() => calendarLayout({ ...spec, data: [...spec.data, spec.data[0]!] })).toThrow();
});
test("calendar sorted metadata retains input indices, missing days stay absent, grid JSON unchanged", () => {
  const reverse = calendarLayout({ ...spec, data: [...spec.data].reverse() });
  expect(reverse.cells.map((c) => c.index)).toEqual([2, 1, 0]);
  const svg = renderCalendarSvg({ ...spec, inspect: true, locale: "de" });
  expect([...svg.matchAll(/data-chart-datum=/g)]).toHaveLength(3);
  expect(svg).toContain("&quot;grid&quot;:[1,1]");
  expect(svg).toContain("var(--k2b-flow-out-mark,#8b5cf6)");
  expect(svg).not.toMatch(/NaN|Infinity/);
  const old = { data: [{ x: "Mon", y: "Queue", value: 4 }] };
  expect(renderHeatmapSvg(old)).toBe(heatmap(old));
});
