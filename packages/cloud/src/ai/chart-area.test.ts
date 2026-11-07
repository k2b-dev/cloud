import { expect, test } from "bun:test";
import { cloudAiChartTable } from "./chart-block";
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
  const input = parseCloudAiChartToolView(spec);
  expect(input?.view).toBe("chart");
  if (input?.view !== "chart" || input.kind !== "area") throw new Error("Expected area");
  expect(cloudAiChartTable(input, "de").rows.map((r) => r.values.percent)).toEqual([30, 40, 70, 60]);
  expect(parseCloudAiChartToolView({ ...spec, series: [{ label: "Bad", data: [1, -1] }] })).toBeUndefined();
});
