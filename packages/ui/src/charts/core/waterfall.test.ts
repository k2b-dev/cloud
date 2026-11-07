import { expect, test } from "bun:test";
import { selectedChartSvg } from "../../content/chart-svg";
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
  expect(svg).toContain("&quot;key&quot;:&quot;after&quot;,&quot;value&quot;:-40");
  expect(svg).toContain("&quot;key&quot;:&quot;before&quot;,&quot;value&quot;:140");
});

test("all-negative balances, many categories and measured widths remain finite and bounded", () => {
  const many = {
    start: { label: "Opening balance", value: -100 },
    steps: Array.from({ length: 10 }, (_, i) => ({ label: `Cat${i}`, value: -10 })),
    end: { label: "Closing balance" },
  };
  const phone = waterfallLayout({ ...many, displayWidth: 296 }, { width: 900, height: 280 });
  const wide = waterfallLayout({ ...many, displayWidth: 900 }, { width: 900, height: 280 });
  expect(wide.left).toBeLessThan(phone.left);
  expect(wide.left).toBeLessThan(100);
  expect(wide.balance).toBe(-200);
  expect(wide.scale.domain[1]).toBe(0);
  for (const width of [296, 600, 650, 900]) {
    const svg = renderWaterfallSvg({ ...many, width, height: 280, displayWidth: width });
    expect(svg).not.toMatch(/NaN|Infinity/);
    const labels = [...svg.matchAll(/class="stdlib-chart-tick-label stdlib-chart-category-label[^"]*"/g)];
    expect(labels.length).toBeLessThanOrEqual(12);
    if (width <= 650) expect(svg).not.toContain('class="k2b-waterfall-value"');
  }
});

test("initial controlled selection uses the actual flow mark paint, skipping its category band", () => {
  const selected = selectedChartSvg(renderWaterfallSvg({ ...spec, ...size, inspect: true }), { role: "item", index: 2 });
  expect(selected).toContain("--k2b-chart-selection-color:color-mix(in srgb,var(--k2b-flow-out-mark, #8b5cf6)");
});

test("responsive waterfall emits desktop labels and amounts with actual-width guards", () => {
  const input = { ...spec, ...size, inspect: true };
  const svg = renderWaterfallSvg(input, true);
  expect(svg.match(/class="k2b-waterfall-value"/g)).toHaveLength(5);
  expect(svg.match(/class="stdlib-chart-tick-label stdlib-chart-category-label /g)).toHaveLength(5);
  expect(svg).toContain("@container (max-width:");
  expect(svg).toContain("data-waterfall-min-width=");
  expect(svg).not.toMatch(/NaN|Infinity/);
});
