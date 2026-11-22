import { describe, expect, test } from "bun:test";
import { charts } from "./index";

describe("chart comparison domains and stable colors", () => {
  test("keeps an observation at the same coordinates across different snapshots", () => {
    const chart = (values: number[]) => charts.scatter({ inspect: true, series: [{ data: values.map((y) => ({ x: 5, y })) }], xAxis: { domain: [0, 10] }, yAxis: { domain: [0, 100] } });
    const first = chart([50, 60]);
    const second = chart([50, 95]);
    const marker = (svg: string) => svg.match(/<circle class="[^"]*" cx="([^"]*)" cy="([^"]*)"/g)?.[0];
    expect(marker(first)).toBeDefined();
    expect(marker(first)).toEqual(marker(second));
    expect(first).toContain('>100</text>');
  });
  test("rejects invalid and misleading domains including bar baselines", () => {
    for (const domain of [[10, 0], [0, 0], [0, Infinity], [1, 40]] satisfies [number, number][]) {
      expect(() => charts.bar({ data: [{ label: "A", value: 30 }], yAxis: { domain } })).toThrow(RangeError);
    }
    expect(() => charts.line({ series: [{ data: [{ x: 1, y: 1 }] }], xAxis: { scale: "log", domain: [0, 10] } })).toThrow(RangeError);
    expect(charts.line({ series: [{ data: [{ x: 3, y: 5 }, { x: 7, y: 6 }] }], xAxis: { scale: "log", domain: [2, 8] } })).toContain('>8</text>');
  });
  test("exact domains terminate at large and subnormal magnitudes", () => {
    for (const domain of [[1e16, 1e16 + 2], [0, Number.MIN_VALUE]] satisfies [number, number][]) {
      const svg = charts.scatter({ series: [{ data: [{ x: domain[0], y: 1 }, { x: domain[1], y: 2 }] }], xAxis: { domain } });
      expect(svg).not.toContain("NaN");
      expect(svg).not.toContain("Infinity");
    }
  });
  test("retains bar and slice palette slots after filtering", () => {
    const data = [{ label: "Exports", value: 28, colorIndex: 1 }];
    expect(charts.bar({ data, colorByBar: true, legend: true })).toContain('stdlib-chart-bar stdlib-chart-series-1');
    expect(charts.donut({ data, legend: true })).toContain('stdlib-chart-slice stdlib-chart-series-1');
    expect(charts.pie({ data: [{ ...data[0]!, colorIndex: 9 }] })).toContain('stdlib-chart-slice stdlib-chart-series-1');
    expect(() => charts.pie({ data: [{ ...data[0]!, colorIndex: -1 }] })).toThrow(RangeError);
  });
});
