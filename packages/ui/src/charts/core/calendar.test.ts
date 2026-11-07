import { expect, test } from "bun:test";
import { calendarDay, calendarLayout, renderCalendarSvg, renderHeatmapSvg } from "./calendar";
import { heatmap } from "./svg";

const spec = {
  layout: "calendar" as const,
  locale: "en-GB",
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

test("calendar core headers reserve space without changing observation geometry", () => {
  const s = calendarLayout({ ...spec, title: "Opens", subtitle: "Fictional" });
  expect(s.cells[0]!.y).toBe(s.top);
  expect(s.top).toBeGreaterThan(22);
  const svg = renderCalendarSvg({ ...spec, title: "Opens", subtitle: "Fictional" });
  expect(svg).toContain("stdlib-chart-title");
  expect(svg).toContain("Fictional");
});

test("calendar gaps, square cells, locale weeks, months and complete scale legend", () => {
  const s = calendarLayout({
    ...spec,
    data: [
      ["2026-01-01", null],
      ["2026-02-01", -5],
      ["2026-03-01", 0],
    ],
    scale: "sequential",
  });
  expect(s.cells).toHaveLength(2);
  expect(s.cellWidth).toBe(s.cell);
  expect(s.cells[1]!.intensity).toBeGreaterThan(s.cells[0]!.intensity);
  expect(calendarLayout({ ...spec, locale: "en-US" }).weekStart).toBe(0);
  expect(calendarLayout({ ...spec, locale: "de-DE" }).weekStart).toBe(1);
  const svg = renderCalendarSvg({
    ...spec,
    data: [
      ["2026-01-01", 1],
      ["2026-05-01", 2],
    ],
  });
  for (const month of ["Jan 2026", "Feb", "Mar", "Apr", "May"]) expect(svg).toContain(month);
  expect(svg).toContain("more out");
  expect(svg).toContain("more in");
  expect(renderCalendarSvg({ ...spec, scale: "sequential" })).toContain("less");
  expect(() =>
    calendarLayout({
      ...spec,
      data: [
        ["2020-01-01", 1],
        ["2026-01-01", 2],
      ],
    }),
  ).toThrow("three years");
});
