import { expect, test } from "bun:test";
import { renderWaterfallSvg, waterfallLayout } from "./waterfall";

const size = { width: 480, height: 280 };
const spec = {
  start: { label: "Opening", value: 100 },
  steps: [
    { label: "In", value: 40 },
    { label: "Out", value: -180 },
    { label: "No change", value: 0 },
  ],
  end: { label: "Closing" },
};
test("changes float on the running balance and totals rest on zero, including a crossing", () => {
  const g = waterfallLayout(spec, size);
  expect(g.bars.map(({ from, to }) => [from, to])).toEqual([
    [0, 100],
    [100, 140],
    [140, -40],
    [-40, -40],
    [0, -40],
  ]);
  expect(g.balance).toBe(-40);
  expect(g.scale.domain[0]).toBeLessThanOrEqual(-40);
  expect(g.scale.domain[1]).toBeGreaterThanOrEqual(140);
  expect(g.project(0)).toBeGreaterThan(g.project(100));
});
test("zero and a start-only waterfall remain inspectable", () => {
  const svg = renderWaterfallSvg({ ...spec, start: { label: "Zero", value: 0 }, steps: [], ...size, inspect: true });
  expect(svg.match(/data-chart-datum=/g)).toHaveLength(2);
  expect(svg).not.toMatch(/NaN|Infinity/);
});
test("rejects missing changes, nonfinite balances and overflowing ranges", () => {
  for (const value of [NaN, Infinity, -Infinity])
    expect(() => waterfallLayout({ ...spec, steps: [{ label: "Bad", value }] }, size)).toThrow();
  expect(() =>
    waterfallLayout({ ...spec, start: { label: "Big", value: 1e308 }, steps: [{ label: "Bigger", value: 1e308 }] }, size),
  ).toThrow();
});
test("every mark includes portable paint, escaped names, raw before and after balances", () => {
  const svg = renderWaterfallSvg({ ...spec, end: { label: "</text><script>" }, ...size, inspect: true, locale: "de" });
  expect(svg).toContain('fill="var(--k2b-flow-in-mark');
  expect(svg).toContain('fill="var(--k2b-flow-out-mark');
  expect(svg.match(/k2b-waterfall-connector/g)).toHaveLength(4);
  expect(svg).toContain("&lt;script&gt;");
  expect(svg).toContain("&quot;key&quot;:&quot;to&quot;,&quot;value&quot;:-40");
});
