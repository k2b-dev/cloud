import { expect, test } from "bun:test";
import { paretoLayout, renderParetoSvg } from "./pareto";
import { chartRenderHeight } from "./render-size";
import { renderTreemapSvg, treemapLayout } from "./treemap";

const treemap = {
  legend: false,
  groups: ["A", "B"],
  data: [
    { label: "Chairs", group: "A", value: 6 },
    { label: "Tables", group: "B", value: 3 },
    { label: "Other", group: "A", value: 1 },
    { label: "Zero", group: "B", value: 0 },
  ],
};
test("squarified treemap preserves area proportions, bounds, zeros and input indices", () => {
  const s = treemapLayout(treemap, { width: 600, height: 300 });
  expect(s.cells.reduce((v, c) => v + c.width * c.height, 0)).toBeCloseTo(180000);
  for (const c of s.cells) {
    expect((c.width * c.height) / 180000).toBeCloseTo(c.value / 10);
    expect(c.x + c.width).toBeLessThanOrEqual(600.00001);
    expect(c.y + c.height).toBeLessThanOrEqual(300.00001);
  }
  for (let i = 0; i < s.cells.length; i++)
    for (let j = i + 1; j < s.cells.length; j++) {
      const a = s.cells[i]!,
        b = s.cells[j]!;
      expect(
        Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
          Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)),
      ).toBeCloseTo(0);
    }
  expect(() => treemapLayout({ ...treemap, data: [{ label: "Bad", group: "A", value: -1 }] })).toThrow();
  expect(renderTreemapSvg({ ...treemap, inspect: true })).not.toMatch(/NaN|Infinity/);
});
const pareto = {
  labels: ["Now", "Before"] as [string, string],
  data: [
    { label: "Small", value: 10, prev: 0 },
    { label: "Rest", value: 100, prev: 80 },
    { label: "Main", value: 90, prev: 100 },
  ],
};
test("Pareto sorts current values descending with Rest last and computes true cumulative shares", () => {
  const s = paretoLayout(pareto);
  expect(s.rows.map((r) => r.label)).toEqual(["Main", "Small", "Rest"]);
  expect(s.rows.map((r) => r.cumulative)).toEqual([0.45, 0.5, 1]);
  expect(s.rows.map((r) => r.index)).toEqual([2, 0, 1]);
  const svg = renderParetoSvg({ ...pareto, inspect: true });
  expect(svg).toContain("80 %");
  expect(svg).toContain("polyline");
  expect(svg).toContain("&quot;formatted&quot;:&quot;–&quot;");
  expect(svg).toContain("var(--stdlib-chart-c1,#3b82f6)");
  expect(svg).not.toMatch(/NaN|Infinity/);
  expect(() => paretoLayout({ ...pareto, data: [{ label: "Bad", value: 1, prev: -2 }] })).toThrow();
});

test("zero totals and extreme ratios remain finite without fabricated area", () => {
  for (const values of [
    [0, 0],
    [1, 1e-17],
    [1e308, 1e-308],
  ]) {
    const spec = { groups: ["A"], data: values.map((value, i) => ({ label: String(i), group: "A", value })) };
    expect(renderTreemapSvg({ ...spec, inspect: true })).not.toMatch(/NaN|Infinity/);
    expect(treemapLayout(spec).cells).toHaveLength(2);
  }
  expect(renderParetoSvg({ labels: ["Now", "Before"], data: [{ label: "Zero", value: 0, prev: 0 }], inspect: true })).not.toMatch(
    /NaN|Infinity/,
  );
});

// Chat reserves its frame before the lazy drawing module arrives.
test("Pareto lazy frame height equals the drawing for every header combination", () => {
  for (const header of [{}, { title: "Revenue" }, { subtitle: "This month" }, { title: "Revenue", subtitle: "This month" }]) {
    const spec = { ...pareto, ...header, data: Array.from({ length: 12 }, (_, i) => ({ label: `Region ${i}`, value: i, prev: i })) };
    expect(chartRenderHeight({ ...spec, kind: "pareto" })).toBe(paretoLayout(spec).height);
  }
});

// WebKit uses taller glyph boxes than Chromium; a 15px baseline step let the two lines touch.
test("treemap name and value reserve independent readable lines", () => {
  const svg = renderTreemapSvg({ groups: ["A"], data: [{ label: "Chairs", group: "A", value: 1234 }] });
  expect(svg).toContain("var(--k2b-chart-inverse-y,1) - 1) * 18px");
  expect(svg).toContain("var(--k2b-chart-inverse-y,1) - 1) * 38px");
  expect(renderTreemapSvg({ groups: ["A"], height: 60, data: [{ label: "Chairs", group: "A", value: 1234 }] })).not.toContain(
    "data-treemap-value",
  );
});
