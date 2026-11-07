import { expect, test } from "bun:test";
import { renderBarChartSvg, seriesBarLayout } from "./chart-bar";

const spec = {
  x: ["A"],
  series: [
    { label: "Opened", data: [780] },
    { label: "Clicked", data: [320] },
  ],
  layout: "nested" as const,
  marks: "dots" as const,
  total: 1000,
  dots: 100,
};
test("nested counts share zero, use two dot columns and leave the remainder grey", () => {
  const g = seriesBarLayout(spec),
    points = g.columns[0]!.matrix;
  expect(points).toHaveLength(100);
  expect(g.columns[0]!.current.map((v) => v.base)).toEqual([0, 0]);
  expect(new Set(points.map((p) => p.x)).size).toBe(2);
  expect(points.filter((p) => p.seriesIndex === 1)).toHaveLength(32);
  expect(points.filter((p) => p.seriesIndex === 0)).toHaveLength(46);
  expect(points.filter((p) => p.seriesIndex === null)).toHaveLength(22);
  expect(points.every((p) => p.y - p.radius >= g.top && p.y + p.radius <= g.bottom)).toBe(true);
  const svg = renderBarChartSvg({ ...spec, width: 480, height: 280, inspect: true });
  expect(svg).toContain('data-dot-series="remainder"');
  expect(svg).toContain('data-dot-series="1"');
  expect(svg).not.toMatch(/NaN|Infinity/);
});
test("nested validation rejects stacks disguised as subsets, over-capacity and odd dot counts", () => {
  expect(() =>
    seriesBarLayout({
      ...spec,
      series: [
        { label: "Opened", data: [50] },
        { label: "Clicked", data: [60] },
      ],
    }),
  ).toThrow("subset");
  expect(() => seriesBarLayout({ ...spec, total: 100 })).toThrow("at most total");
  expect(() => seriesBarLayout({ ...spec, dots: 3 })).toThrow("even");
  expect(() => seriesBarLayout({ ...spec, compare: { label: "Before", data: [10] } })).toThrow("comparison");
  expect(() => seriesBarLayout({ ...spec, marks: "bars" })).toThrow("dot marks");
});
test("missing categories are gaps, zero counts leave grey dots and capacity can be inferred", () => {
  expect(
    seriesBarLayout({
      ...spec,
      series: [
        { label: "A", data: [null] },
        { label: "B", data: [20] },
      ],
    }).columns[0]!.matrix,
  ).toEqual([]);
  expect(
    seriesBarLayout({
      ...spec,
      series: [
        { label: "A", data: [0] },
        { label: "B", data: [0] },
      ],
    }).columns[0]!.matrix.every((p) => p.seriesIndex === null),
  ).toBe(true);
  expect(seriesBarLayout({ ...spec, total: undefined, dots: undefined }).dot).toEqual({ total: 780, count: 100 });
});

test("share legends show the latest period, while count legends retain period totals", () => {
  const shares = {
    ...spec,
    x: ["Jan", "Feb", "Mar"],
    total: 1,
    series: [
      { label: "Opened", data: [0.5, 0.6, 0.7] },
      { label: "Clicked", data: [0.2, 0.3, 0.4] },
    ],
    legendValues: "latest" as const,
    valueFormat: (value: number) => new Intl.NumberFormat("en", { style: "percent" }).format(value),
  };
  expect(seriesBarLayout(shares).legendLayout.items.map((item) => item.total)).toEqual([0.7, 0.4]);
  const svg = renderBarChartSvg({ ...shares, width: 480, height: 280, inspect: true });
  expect(svg).toContain('data-bar-total="70%"');
  expect(svg).toContain('data-bar-total="40%"');
  expect(svg).not.toContain('data-bar-total="180%"');
  expect(seriesBarLayout({ ...shares, legendValues: "total" }).legendLayout.items[0]?.total).toBeCloseTo(1.8);
  expect(seriesBarLayout({ ...shares, series: [{ label: "Missing", data: [0.5, 0.6, null] }] }).legendLayout.items[0]?.total).toBeNull();
});
