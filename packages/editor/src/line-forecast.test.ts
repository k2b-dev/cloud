import { expect, test } from "bun:test";
import { liquidityForecastSpec } from "../../../docs-site/src/ui/demo-sections/charts/liquidity-forecast";
import { chartKinds, chartRenderOptions, chartSchema, chartTable, drawChart } from "./charts";
import { renderNotebookChartFigure } from "./markdown/lib/chart-blocks";

const spec = {
  kind: "line",
  title: "Studio cash outlook",
  series: [
    {
      label: "Cash",
      data: [
        { x: 1, y: 10 },
        { x: 2, y: null },
        { x: 3, y: -4 },
        { x: 4, y: 8 },
      ],
    },
  ],
  forecast: {
    from: 3,
    band: [
      [-8, 0],
      [2, 14],
    ],
  },
  zero: true,
  threshold: { value: 5, label: "Reserve" },
  marker: { at: 3, label: "Today" },
  step: "after",
};
test("portable line options preserve old JSON, null gaps and forecast semantics", () => {
  for (const schema of [chartKinds(), chartKinds({ maxSeries: 8, maxValues: 480, maxMarks: 3840 })]) {
    const parsed = schema.parse(spec);
    expect(parsed.kind).toBe("line");
    if (parsed.kind !== "line") throw new Error("Expected line");
    expect(Number.isNaN(parsed.series[0]!.data[1]!.y)).toBe(true);
    expect(parsed.forecast?.band).toEqual([
      [-8, 0],
      [2, 14],
    ]);
    expect(
      schema.safeParse({
        kind: "line",
        title: "Saved line",
        series: [
          {
            data: [
              { x: 1, y: 2 },
              { x: 2, y: 3 },
            ],
          },
        ],
      }).success,
    ).toBe(true);
    expect(schema.safeParse({ ...spec, step: "middle" }).success).toBe(true);
    expect(schema.safeParse({ ...spec, forecast: { from: 2.5 } }).success).toBe(false);
    expect(schema.safeParse({ ...spec, forecast: { from: 3, band: [[-8, 0]] } }).success).toBe(false);
    expect(
      schema.safeParse({
        ...spec,
        forecast: {
          from: 3,
          band: [
            [0, -8],
            [2, 14],
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...spec,
        forecast: {
          from: 3,
          band: [
            [-8, Infinity],
            [2, 14],
          ],
        },
      }).success,
    ).toBe(false);
  }
});
test("ISO coordinates are converted only at the render boundary; domains include the band and threshold", () => {
  const input = chartSchema().parse({
    ...spec,
    series: [
      {
        label: "Cash",
        data: [
          { x: "2026-10-01", y: 10 },
          { x: "2026-10-02", y: 8 },
        ],
      },
    ],
    forecast: { from: "2026-10-02", band: [[-20, 50]] },
    marker: { at: "2026-10-02", label: "Today" },
  });
  const render = chartRenderOptions(input, "de");
  if (render.kind !== "line") throw new Error("Expected line");
  expect(render.forecast?.from).toBe(Date.UTC(2026, 9, 2));
  expect(render.marker?.at).toBe(Date.UTC(2026, 9, 2));
  expect(render.yAxis?.domain?.[0]).toBeLessThanOrEqual(-20);
  expect(render.yAxis?.domain?.[1]).toBeGreaterThanOrEqual(50);
  expect(chartTable(input, "de").rows.map((r) => r.values.y)).toEqual([10, 8]);
});

test("the Liquidity dashboard balance is a real dated forecast through the shared JSON path", () => {
  const input = chartKinds().parse(liquidityForecastSpec);
  const options = chartRenderOptions(input, "en", { width: 942 });
  expect(options.kind).toBe("line");
  if (options.kind !== "line") throw new Error("Expected line");
  expect(options.series[0]!.data).toHaveLength(96);
  expect(options.forecast?.from).toBe(Date.UTC(2026, 10, 6));
  expect(options.forecast?.band).toHaveLength(60);
  expect(options.marker?.at).toBe(options.forecast?.from);
  const table = chartTable(input, "en");
  expect(table.rows).toHaveLength(96);
  expect(drawChart(options)).toContain("k2b-line-forecast-band");
  expect(drawChart(options)).toContain("k2b-line-threshold");
  expect(drawChart(options)).toContain("k2b-line-marker");
});

test("opted-in snapshot legends keep an all-missing final column as gaps", () => {
  const input = chartKinds().parse({
    kind: "line",
    title: "Missing final observations",
    legend: true,
    legendValues: true,
    series: [
      {
        label: "A",
        data: [
          { x: 1, y: 4 },
          { x: 2, y: null },
        ],
      },
      {
        label: "B",
        data: [
          { x: 1, y: 7 },
          { x: 2, y: null },
        ],
      },
    ],
  });
  const html = renderNotebookChartFigure(input, "en")!;
  expect(html).toContain('data-line-last-x="2"');
  expect([...html.matchAll(/data-default="([^"]*)"/g)].map((match) => match[1])).toEqual(["—", "—"]);
});
