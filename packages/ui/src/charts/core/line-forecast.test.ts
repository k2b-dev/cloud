import { expect, test } from "bun:test";
import { lineForecastLayout } from "./line-options";
import { renderChartSvg } from "./render";
import { line } from "./svg";

const spec = {
  width: 480,
  height: 280,
  smooth: false,
  series: [
    {
      label: "Cash",
      data: [
        { x: 1, y: 10 },
        { x: 2, y: 8 },
        { x: 3, y: -4 },
        { x: 4, y: 12 },
      ],
    },
  ],
  forecast: {
    from: 2,
    band: [
      [4, 12],
      [-8, 0],
      [6, 18],
    ] as [number, number][],
  },
  marker: { at: 2, label: "Today" },
  threshold: { value: 5, label: "Reserve" },
  zero: true,
};
test("forecast layout binds ordered bounds to the first series suffix", () => {
  expect(lineForecastLayout(spec).map((p) => [p.x, p.lo, p.hi])).toEqual([
    [2, 4, 12],
    [3, -8, 0],
    [4, 6, 18],
  ]);
  expect(() => lineForecastLayout({ ...spec, forecast: { from: 2, band: [[4, 12]] } })).toThrow();
  expect(() =>
    lineForecastLayout({
      ...spec,
      forecast: {
        from: 2,
        band: [
          [12, 4],
          [-8, 0],
          [6, 18],
        ],
      },
    }),
  ).toThrow();
  expect(() => lineForecastLayout({ ...spec, forecast: { from: 2.5 } })).toThrow();
  const overlong: [number, number] = [1, 2];
  overlong.push(3);
  expect(() => lineForecastLayout({ ...spec, forecast: { from: 4, band: [overlong] } })).toThrow();
});
test("forecast, zero zone, warning threshold and today use portable presentation attributes", () => {
  const svg = line({ ...spec, inspect: true });
  expect(svg).toContain('class="k2b-line-forecast"');
  expect(svg).toContain('class="k2b-line-forecast-band"');
  expect(svg).toContain('class="k2b-line-negative-zone"');
  expect(svg).toContain('class="k2b-line-threshold"');
  expect(svg).toContain('class="k2b-line-marker"');
  expect(svg).toContain('stroke-dasharray="5 4"');
  expect(svg).toContain('stroke="var(--k2b-warning-500, #f59e0b)"');
  expect(svg).toContain('fill="none"');
  expect(svg).toContain("&quot;key&quot;:&quot;forecastLow&quot;");
  expect(svg).not.toMatch(/NaN|Infinity/);
});
test("null-class gaps split both the line and the forecast band", () => {
  const data = [
    { x: 1, y: 1 },
    { x: 2, y: 2 },
    { x: 3, y: Number.NaN },
    { x: 4, y: 4 },
    { x: 5, y: 5 },
  ];
  const svg = line({
    width: 480,
    height: 280,
    series: [{ data }],
    forecast: {
      from: 1,
      band: [
        [0, 2],
        [1, 3],
        [2, 4],
        [3, 5],
        [4, 6],
      ],
    },
    smooth: false,
  });
  expect(svg.match(/class="k2b-line-forecast-band"/g)).toHaveLength(2);
  expect(svg.match(/class="stdlib-chart-line stdlib-chart-series-0"/g)).toHaveLength(2);
  expect(svg).not.toMatch(/NaN|Infinity/);
});
test("both step directions and existing middle steps remain distinct", () => {
  const before = line({ ...spec, forecast: undefined, step: "before" });
  const after = line({ ...spec, forecast: undefined, step: "after" });
  expect(before).not.toBe(after);
  expect(line({ ...spec, step: "middle" })).not.toMatch(/NaN|Infinity/);
});
test("old line options still produce a drawing; bounds belong only to the first series", () => {
  const svg = line({ ...spec, series: [...spec.series, { label: "Other", data: spec.series[0]!.data }], inspect: true });
  expect(svg.match(/&quot;key&quot;:&quot;forecastLow&quot;/g)).toHaveLength(3);
  expect(line({ series: spec.series, smooth: true, area: true, errorBand: true, autoVariant: true, legend: true })).toContain(
    "stdlib-chart-line",
  );
});

test("forecast respects maxGap and gives isolated observations a visible portable mark", () => {
  const svg = line({ ...spec, maxGap: 0.5, inspect: true });
  expect(svg).not.toContain('class="stdlib-chart-line');
  expect(svg).toContain('fill="var(--stdlib-chart-c1, #3b82f6)"');
  expect(() => line({ ...spec, maxGap: 0 })).toThrow();
  expect(() => line({ ...spec, maxGap: 1, area: true })).toThrow();
});
test("line legends carry cursor fields, missing final values and bounded names", () => {
  const svg = line({
    series: Array.from({ length: 40 }, (_, i) => ({
      label: `Very long source ${i}`,
      data: [
        { x: 1, y: 1.5 },
        { x: 2, y: i === 0 ? NaN : 2.5 },
      ],
    })),
    legend: true,
    legendValues: true,
    locale: "de",
    width: 480,
    height: 280,
  });
  expect(svg.match(/class="stdlib-chart-legend-item"/g)).toHaveLength(3);
  expect(svg).toContain("+37");
  expect(svg).toContain('data-field="y" data-default="—"');
  expect(svg).toContain('data-field="y" data-default="2,5"');
});

test("a single forecast observation keeps a visible confidence band", () => {
  const svg = line({ series: [{ data: [{ x: 1, y: 3 }] }], forecast: { from: 1, band: [[2, 4]] }, width: 480, height: 280 });
  expect(svg).toContain('<rect class="k2b-line-forecast-band"');
  expect(svg).not.toMatch(/NaN|Infinity/);
});

test("the pure line legend localizes unnamed series", () => {
  const svg = line({
    series: [
      {
        data: [
          { x: 1, y: 2 },
          { x: 2, y: 3 },
        ],
      },
    ],
    legend: true,
    legendValues: true,
    locale: "de",
  });
  expect(svg).toContain("Datenreihe 1");
});

test("an explicit line locale takes precedence over the inherited render locale", () => {
  const svg = renderChartSvg(
    { kind: "line", series: [{ data: [{ x: 1, y: 2.5 }] }], threshold: { value: 2.5, label: "Reserve" }, locale: "de" },
    480,
    280,
    undefined,
    undefined,
    "en",
  );
  expect(svg).toContain("Reserve 2,5");
});

test("log axes reject annotations and forecast bounds outside their positive domain", () => {
  const series = [
    {
      data: [
        { x: 1, y: 2 },
        { x: 2, y: 3 },
      ],
    },
  ];
  expect(() => line({ series, yAxis: { scale: "log" }, threshold: { value: 0, label: "Reserve" } })).toThrow(RangeError);
  expect(() => line({ series, xAxis: { scale: "log" }, marker: { at: 0, label: "Today" } })).toThrow(RangeError);
  expect(() => line({ series, yAxis: { scale: "log" }, forecast: { from: 2, band: [[0, 4]] } })).toThrow(RangeError);
  expect(line({ series, xAxis: { scale: "log" }, yAxis: { scale: "log" }, forecast: { from: 2, band: [[1, 4]] } })).not.toMatch(
    /NaN|Infinity/,
  );
});

test("markers must fit an explicit X domain, including its edges", () => {
  for (const at of [0, 5])
    expect(() => line({ ...spec, marker: { at, label: "Today" }, xAxis: { domain: [1, 4] } })).toThrow(/explicit X domain/);
  for (const at of [1, 4])
    expect(line({ ...spec, marker: { at, label: "Today" }, xAxis: { domain: [1, 4] } })).toContain("k2b-line-marker");
});
