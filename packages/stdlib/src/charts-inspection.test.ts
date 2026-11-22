import { describe, expect, test } from "bun:test";
import { charts, type ChartDatum, autoBin, computeBoxStats } from "./charts";

const decode = (svg: string): ChartDatum[] => [...svg.matchAll(/data-chart-datum="([^"]+)"/g)].map((match) => JSON.parse(match[1]!.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")));
const samples = {
  line: { series: [{ data: [{ x: 1, y: 2 }, { x: 10, y: 3 }, { x: 100, y: 4 }] }], xAxis: { scale: "log" } },
  scatter: { series: [{ data: [{ x: 1, y: 2, size: 3, errY: 1 }] }] },
  bar: { data: [{ label: "A", value: 3 }] },
  pie: { data: [{ label: "A", value: 3 }, { label: "B", value: 1 }] },
  donut: { data: [{ label: "A", value: 3 }] },
  histogram: { data: [0, 1, 2, 3, 4], bins: [0, 2, 4] },
  boxplot: { groups: [{ label: "A", values: [1, 2, 3, 4, 5, 100] }] },
  gauge: { value: 110, min: 0, max: 100 },
  barGauge: { data: [{ label: "A", value: 25 }] },
  stat: { label: "A", value: 123, delta: 12, sparkline: [1, 2, 3] },
  heatmap: { data: [{ x: "A", y: "B", value: 3 }] },
  map: { series: [{ data: [{ latitude: 0, longitude: 0, label: "Office" }] }] },
  stateTimeline: { rows: [{ label: "A", intervals: [{ from: 0, to: 10, state: "ok" }] }] },
  sparkline: { data: [1, 3, 2] },
} satisfies { [K in keyof typeof charts]: Parameters<(typeof charts)[K]>[0] };

describe("renderer-owned chart inspection", () => {
  for (const kind of Object.keys(samples) as (keyof typeof samples)[]) {
    test(`${kind} emits inert metadata only when requested`, () => {
      // Dispatch each exact per-kind input through the existing namespace API.
      const render = charts[kind] as (opts: unknown) => string;
      expect(decode(render(samples[kind]))).toEqual([]);
      const svg = render({ ...samples[kind], inspect: true });
      const data = decode(svg);
      expect(data.length).toBeGreaterThan(0);
      expect(data.every((datum) => datum.anchor.every(Number.isFinite))).toBe(true);
      expect(svg).not.toContain('tabindex=');
      expect(svg).not.toContain('<script');
    });
  }
  test("logarithmic line anchors follow the rendered scale", () => {
    const data = decode(charts.line({ ...samples.line, inspect: true }));
    expect(data[1]!.anchor[0] - data[0]!.anchor[0]).toBeCloseTo(data[2]!.anchor[0] - data[1]!.anchor[0]);
  });
  test("bin values and inclusive final edge agree with the histogram calculation", () => {
    const { edges, counts } = autoBin(samples.histogram.data, samples.histogram.bins);
    const data = decode(charts.histogram({ ...samples.histogram, inspect: true }));
    expect(data.map((datum) => datum.values.find((field) => field.key === "count")!.value)).toEqual(counts);
    expect(data[1]!.values.find((field) => field.key === "to")!.value).toBe(edges[2]!);
    expect(data.map((datum) => datum.values.find((field) => field.key === "upperInclusive")!.value)).toEqual(["false", "true"]);
  });
  test("box summaries and outliers come from the same distribution", () => {
    const data = decode(charts.boxplot({ ...samples.boxplot, inspect: true }));
    const stats = computeBoxStats(samples.boxplot.groups[0]!.values)!;
    expect(data[0]!.values.find((field) => field.key === "q2")!.value).toBe(stats.q2);
    expect(data.find((datum) => datum.role === "outlier")?.index).toBe(5);
  });
  test("filtered source indices, repeated objects and escaped labels remain exact", () => {
    const item = { label: '<script>"&', value: 3 };
    const svg = charts.bar({ data: [{ label: "bad", value: NaN }, item, item], inspect: true });
    const data = decode(svg);
    expect(data.map((datum) => datum.index)).toEqual([1, 2]);
    expect(data[0]!.label).toBe(item.label);
    expect(svg).not.toContain('<script>');
  });
  test("pie shares use only the rendered positive values and gauges retain unclamped values", () => {
    const datum = decode(charts.pie({ data: [...samples.pie.data, { label: "bad", value: -100 }], inspect: true }))[0]!;
    expect(datum.values.find((field) => field.key === "percent")!.value).toBe(75);
    expect(decode(charts.gauge({ ...samples.gauge, inspect: true }))[0]!.values[0]!.value).toBe(110);
  });
});
