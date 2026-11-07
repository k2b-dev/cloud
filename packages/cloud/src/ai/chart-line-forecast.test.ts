import { expect, test } from "bun:test";
import { chartRenderOptions, drawChart } from "@k2b/editor/charts";
import { liquidityForecastSpec } from "../../../../docs-site/src/ui/demo-sections/charts/liquidity-forecast";
import { CloudAiChartInputSchema } from "./default-tool-contracts";
import { parseCloudAiChartToolView } from "./view-block";

test("Chat accepts additive forecast options and preserves missing observations", () => {
  const input = {
    kind: "line",
    title: "Cash forecast",
    series: [
      {
        label: "Cash",
        data: [
          { x: 1, y: 10 },
          { x: 2, y: null },
          { x: 3, y: -4 },
        ],
      },
    ],
    forecast: {
      from: 2,
      band: [
        [-1, 15],
        [-8, 0],
      ],
    },
    marker: { at: 2, label: "Today" },
    threshold: { value: 5, label: "Reserve" },
    zero: true,
    step: "before",
  };
  const validated = CloudAiChartInputSchema.parse(input);
  const parsed = parseCloudAiChartToolView(validated);
  expect(parsed?.view).toBe("chart");
  if (parsed?.view !== "chart" || parsed.kind !== "line") throw new Error("Expected line");
  expect(parsed.forecast?.band).toEqual([
    [-1, 15],
    [-8, 0],
  ]);
  expect(Number.isNaN(parsed.series[0]!.data[1]!.y)).toBe(true);
  expect(
    parseCloudAiChartToolView({
      ...input,
      forecast: {
        from: 2,
        band: [
          [15, -1],
          [-8, 0],
        ],
      },
    }),
  ).toBeUndefined();
});

test("the real Chat tool accepts the Liquidity dashboard forecast", () => {
  const validated = CloudAiChartInputSchema.parse(liquidityForecastSpec);
  const view = parseCloudAiChartToolView(validated);
  expect(view?.view).toBe("chart");
  if (view?.view !== "chart" || view.kind !== "line") throw new Error("Expected line");
  expect(view.forecast?.band).toHaveLength(60);
});

test("the real Chat tool rejects a marker outside an explicit X domain", () => {
  const input = {
    kind: "line",
    title: "Cash",
    series: [
      {
        data: [
          { x: 1, y: 2 },
          { x: 4, y: 5 },
        ],
      },
    ],
    xAxis: { domain: [1, 4] },
    marker: { at: 5, label: "Today" },
  };
  expect(CloudAiChartInputSchema.safeParse(input).success).toBe(false);
});

test("Chat accepts null gaps only for line details, keeping saved lines and scatter strict", () => {
  const input = {
    title: "Observations",
    series: [
      {
        data: [
          { x: 1, y: 10 },
          { x: 2, y: null },
          { x: 3, y: 12 },
        ],
      },
    ],
  };
  for (const options of [{}, { zero: false }, { legendValues: false }, { step: "after" }, { area: true }, { smooth: true }]) {
    const rejected = CloudAiChartInputSchema.safeParse({ ...input, kind: "line", ...options });
    expect(rejected.success).toBe(false);
    if (!rejected.success) expect(rejected.error.issues.some((issue) => issue.path.join(".") === "series.0.data.1.y")).toBe(true);
  }
  for (const options of [{}, { legendValues: true }, { forecast: { from: 3 } }])
    expect(CloudAiChartInputSchema.safeParse({ ...input, kind: "scatter", ...options }).success).toBe(false);
  for (const options of [
    { forecast: { from: 3 } },
    { zero: true },
    { threshold: { value: 5, label: "Reserve" } },
    { marker: { at: 2, label: "Today" } },
    { legendValues: true },
  ]) {
    const validated = CloudAiChartInputSchema.parse({ ...input, kind: "line", ...options });
    const chart = parseCloudAiChartToolView(validated);
    if (chart?.view !== "chart" || chart.kind !== "line") throw new Error("Expected line");
    expect(Number.isNaN(chart.series[0]!.data[1]!.y)).toBe(true);
    const svg = drawChart(chartRenderOptions(chart, "en"));
    // The observations on either side of the gap remain isolated marks, never one connecting path.
    expect(svg).not.toMatch(/<path[^>]*d="M[^"L]*L/);
    expect(svg.match(/<circle/g)).toHaveLength(2);
  }
  for (const kind of ["line", "scatter"])
    expect(
      CloudAiChartInputSchema.safeParse({
        ...input,
        kind,
        series: [
          {
            data: [
              { x: 1, y: 10 },
              { x: 2, y: 12 },
            ],
          },
        ],
      }).success,
    ).toBe(true);
});
