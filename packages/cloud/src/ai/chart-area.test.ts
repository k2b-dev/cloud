import { expect, test } from "bun:test";
import { cloudAiChartTable } from "./chart-block";
import { CloudAiChartInputSchema } from "./default-tool-contracts";
import { parseCloudAiChartToolView } from "./view-block";

const spec = {
  kind: "area",
  title: "Sales mix",
  layout: "stacked",
  normalize: true,
  x: ["Jan", "Feb"],
  series: [
    { label: "Recurring", data: [30, 40] },
    { label: "One-off", data: [70, 60] },
  ],
};
test("Chat accepts the chart's stacked layout and keeps amount plus share", () => {
  const validated = CloudAiChartInputSchema.parse(spec);
  expect(validated.x).toEqual(spec.x);
  expect(validated.normalize).toBe(true);
  const input = parseCloudAiChartToolView(validated);
  expect(input?.view).toBe("chart");
  if (input?.view !== "chart" || input.kind !== "area") throw new Error("Expected area");
  expect(cloudAiChartTable(input, "de").rows.map((r) => r.values.percent)).toEqual([30, 40, 70, 60]);
  expect(parseCloudAiChartToolView({ ...spec, series: [{ label: "Bad", data: [1, -1] }] })).toBeUndefined();
});

test("the actual model-facing tool validates area semantics and nested groups", () => {
  expect(CloudAiChartInputSchema.safeParse({ ...spec, normalize: false }).success).toBe(true);
  expect(CloudAiChartInputSchema.safeParse({ ...spec, series: [{ label: "Gap", data: [1, null] }] }).success).toBe(true);
  for (const series of [[{ label: "Bad", data: [1, -1] }], [{ label: "Bad", data: [1] }]])
    expect(CloudAiChartInputSchema.safeParse({ ...spec, series }).success).toBe(false);
  expect(CloudAiChartInputSchema.safeParse({ charts: [spec, { ...spec, normalize: false }], layout: "grid" }).success).toBe(true);
});
