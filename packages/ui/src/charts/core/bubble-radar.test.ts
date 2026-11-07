import { expect, test } from "bun:test";
import { resolveChartMessages } from "../../content/chart-message-catalog";
import { type BubbleOptions, bubbleLayout, renderBubbleSvg } from "./bubble";
import { type RadarOptions, radarLayout, renderRadarSvg } from "./radar";

const bubble: BubbleOptions = {
  groups: ["A"],
  xLabel: "Visits",
  yLabel: "Opens",
  averages: true,
  data: [
    { label: "One", group: "A", x: 2, y: 4, size: 4 },
    { label: "Two", group: "A", x: 8, y: 6, size: 16 },
  ],
};
const radar: RadarOptions = {
  axes: ["Quality", "Speed", "Cost"],
  max: 5,
  unit: "points",
  series: [
    { label: "A", data: [1, 3, 5] },
    { label: "B", data: [2, 4, 3] },
  ],
};
test("bubble area follows size and means are unweighted, including zero and absent sizes", () => {
  const s = bubbleLayout(bubble);
  expect(s.points[1]!.radius / s.points[0]!.radius).toBe(2);
  expect(s.meanX).toBe(5);
  expect(s.meanY).toBe(5);
  const zero = bubbleLayout({
    ...bubble,
    data: [
      { ...bubble.data[0]!, size: 0 },
      { ...bubble.data[1]!, size: undefined },
    ],
  });
  expect(zero.points[0]!.radius).toBe(0);
  expect(zero.points[1]!.radius).toBeGreaterThan(0);
  expect(renderBubbleSvg(bubble)).toContain("Unweighted average");
  expect(renderBubbleSvg({ ...bubble, locale: "de" })).toContain("Ungewichteter Durchschnitt");
});
test("names fit and never intersect another bubble or an accepted name", () => {
  const s = bubbleLayout({
    ...bubble,
    displayWidth: 390,
    data: [
      ...bubble.data,
      { ...bubble.data[0]!, label: "Same place" },
      { ...bubble.data[0]!, label: "A name that cannot fit in any available space" },
    ],
  });
  const names = s.points.filter((p) => p.labelBox);
  expect(names.length).toBeLessThan(s.points.length);
  for (const p of names) {
    const b = p.labelBox!;
    expect(b.x + b.width).toBeLessThanOrEqual(s.right);
    expect(b.y).toBeGreaterThanOrEqual(s.top);
    for (const q of s.points.filter((q) => q !== p))
      expect(
        b.x >= q.cx + q.radius || b.x + b.width <= q.cx - q.radius || b.y >= q.cy + q.radius || b.y + b.height <= q.cy - q.radius,
      ).toBe(true);
  }
});
test("bubble validation rejects missing groups, negative size and overflowing domains; markup escapes and has fallback paint", () => {
  for (const data of [
    [{ ...bubble.data[0]!, group: "missing" }],
    [{ ...bubble.data[0]!, size: -1 }],
    [{ ...bubble.data[0]!, x: Infinity }],
    [
      { ...bubble.data[0]!, x: -1e308 },
      { ...bubble.data[0]!, x: 1e308 },
    ],
  ])
    expect(() => bubbleLayout({ ...bubble, data })).toThrow();
  const svg = renderBubbleSvg({ ...bubble, inspect: true, data: [{ ...bubble.data[0]!, label: "<One>" }] });
  expect(svg).toContain("&lt;One&gt;");
  expect(svg).toContain("var(--stdlib-chart-c1,#3b82f6)");
  expect(svg).not.toMatch(/NaN|Infinity/);
  expect(renderBubbleSvg({ ...bubble, data: [{ ...bubble.data[0]!, x: 1e308, y: 1e308 }] })).not.toMatch(/NaN|Infinity/);
});
test("radar uses a common maximum and unit, one inspection datum per axis with every series", () => {
  const s = radarLayout(radar);
  expect(s.axes).toHaveLength(3);
  expect(Math.hypot(s.axes[0]!.points[0]![0] - s.cx, s.axes[0]!.points[0]![1] - s.cy)).toBeCloseTo(s.radius / 5);
  const svg = renderRadarSvg({ ...radar, inspect: true });
  expect([...svg.matchAll(/data-chart-datum=/g)]).toHaveLength(3);
  expect(svg).toContain("1 / 5 points");
  expect(svg).toContain("--k2b-chart-inspection-color:var(--stdlib-chart-c2,#10b981)");
  expect(svg).toContain("2 / 5 points");
  expect(svg).not.toMatch(/NaN|Infinity/);
  expect(renderRadarSvg({ ...radar, max: 1e308 })).not.toMatch(/NaN|Infinity/);
});
test("radar bounds axes, series and all observations at the core boundary", () => {
  for (const patch of [
    { axes: ["A", "B"] },
    { axes: Array(9).fill("A") },
    { max: 0 },
    { max: Infinity },
    { series: Array(5).fill(radar.series[0]) },
    { series: [{ label: "A", data: [1, 2] }] },
    { series: [{ label: "A", data: [1, 2, 6] }] },
    { series: [{ label: "A", data: [1, 2, -1] }] },
  ])
    expect(() => radarLayout({ ...radar, ...patch })).toThrow();
});

test("phone radar leaves room for ordinary complete axis names", () => {
  const s = radarLayout({ ...radar, axes: ["Quality", "Speed", "Cost", "Access"], series: [{ label: "A", data: [1, 2, 3, 4] }] });
  expect(s.axes.map((a) => a.text)).toEqual(["Quality", "Speed", "Cost", "Access"]);
});

test("shared group tooltip text agrees with editor rows in both locales", () => {
  expect(resolveChartMessages("de-DE").chartFields({ key: "group" })).toBe("Bereich");
  expect(resolveChartMessages("en-US").chartFields({ key: "group" })).toBe("Group");
});
