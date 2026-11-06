import { describe, expect, test } from "bun:test";
import { hbarLayout, renderHbarSvg } from "../charts/core/hbar";
import { renderBarChartSvg, seriesBarLayout } from "./chart-bar";

const series = [
  { label: "Shop", data: [10, 0, null] },
  { label: "Fair", data: [30, 0, 5] },
];
describe("category bars", () => {
  test("stack bases are cumulative; grouped bars each start at zero", () => {
    const stacked = seriesBarLayout({ x: ["A", "B", "C"], series, layout: "stacked" });
    expect(stacked.columns[0]?.current.map((v) => [v.base, v.value])).toEqual([
      [0, 10],
      [10, 30],
    ]);
    expect(seriesBarLayout({ x: ["A", "B", "C"], series }).columns[0]?.current.map((v) => v.base)).toEqual([0, 0]);
    expect(stacked.columns[2]?.current[0]?.value).toBeNull();
  });
  test("100 percent empty totals are gaps, partial gaps remain gaps", () => {
    const normalized = seriesBarLayout({ x: ["A", "B", "C"], series, layout: "stacked", normalize: true });
    expect(normalized.columns[0]?.current.map((v) => v.value)).toEqual([0.25, 0.75]);
    expect(normalized.columns[1]?.current.map((v) => v.value)).toEqual([null, null]);
    expect(normalized.columns[2]?.current.map((v) => v.value)).toEqual([null, 1]);
  });
  test("rejects negative stacks and unaligned comparison arrays", () => {
    expect(() => seriesBarLayout({ x: ["A"], series: [{ label: "Bad", data: [-1] }], layout: "stacked" })).toThrow("nonnegative");
    expect(() => seriesBarLayout({ x: ["A"], series: [{ label: "Bad", data: [] }] })).toThrow("same length");
  });
  test("comparison is left hatched, right current, totals and change retained", () => {
    const svg = renderBarChartSvg({
      x: ["A"],
      series: [{ label: "Now", data: [15] }],
      compare: { label: "Before", data: [10] },
      width: 480,
      height: 280,
      inspect: true,
    });
    expect(svg).toContain('class="k2b-chart-previous"');
    expect(svg).toContain("&quot;key&quot;:&quot;delta&quot;");
    expect(svg).toContain("+50%");
    expect(svg).toContain('data-bar-total="15"');
    expect(svg).toContain('data-bar-total="10"');
    expect(svg).toContain("k2b-chart-category-band");
    expect(svg).not.toMatch(/NaN|Infinity/);
  });
  test("horizontal groups retain original indices, sum segments and suppress cramped values", () => {
    const spec = {
      series: ["Q1", "Q2"],
      rows: [
        { group: "Store", label: "Desks", values: [1, 99] },
        { group: "Web", label: "Lamps", values: [40, 60] },
      ],
    };
    const layout = hbarLayout(spec);
    expect(layout.rows.map((r) => r.total)).toEqual([100, 100]);
    expect(layout.rows[0]?.segments[1]?.x).toBeGreaterThan(layout.left);
    const svg = renderHbarSvg({ ...spec, width: 480, height: 280, inspect: true });
    expect(svg).toContain("Store");
    expect(svg).toContain("Web");
    expect(svg).not.toContain(">1</text>");
    expect(() => hbarLayout({ ...spec, rows: [{ label: "bad", values: [-1, 2] }] })).toThrow("nonnegative");
  });
});
