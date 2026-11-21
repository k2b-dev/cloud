import { expect, test } from "bun:test";
import { renderChartSvg } from "./render";

const series = [
  { label: "Saldo", data: [1, 4, 2, 5].map((y, x) => ({ x, y })) },
  { label: "Plan", data: [2, 3, 3, 4].map((y, x) => ({ x, y })) },
];
const points = (svg: string) => [...svg.matchAll(/<circle class="k2b-line-point"[^>]*\/>/g)].map((match) => match[0]);

test("a line draws no points unless it asks for them", () => {
  expect(points(renderChartSvg({ kind: "line", series }, 480, 260))).toEqual([]);
  expect(points(renderChartSvg({ kind: "line", series, zero: true }, 480, 260))).toEqual([]);
});

test("points mark every value as a hollow ring in its series colour, above the line, on both line paths", () => {
  for (const extra of [{}, { zero: true }]) {
    const svg = renderChartSvg({ kind: "line", series, points: true, ...extra }, 480, 260);
    const marks = points(svg);
    expect(marks).toHaveLength(8);
    for (const mark of marks.slice(0, 4)) expect(mark).toContain('stroke="var(--stdlib-chart-c1, #3b82f6)"');
    for (const mark of marks.slice(4)) expect(mark).toContain('stroke="var(--stdlib-chart-c2, #10b981)"');
    for (const mark of marks) expect(mark).toContain('fill="var(--k2b-surface, #fff)"');
    // The ring lies over its line, so the line does not cross the hollow inside.
    expect(svg.indexOf(marks[0]!)).toBeGreaterThan(svg.indexOf('class="stdlib-chart-line stdlib-chart-series-0"'));
  }
});
