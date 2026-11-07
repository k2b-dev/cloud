import { expect, test } from "bun:test";
import { chartDrawingIssue } from "./chart-block";
import { CloudAiChartInputSchema, cloudAiAppChartSchema, parseCloudAiChartInput } from "./default-tool-contracts";
import { parseCloudAiChartToolView } from "./view-block";

test("Chat and cloud.chart preserve dot matrix options and budget every dot", () => {
  const spec = {
    kind: "bar",
    title: "Campaign",
    marks: "dots",
    layout: "nested",
    total: 100,
    dots: 20,
    x: ["A"],
    series: [
      { label: "Opened", data: [80] },
      { label: "Clicked", data: [30] },
    ],
  };
  for (const schema of [CloudAiChartInputSchema, cloudAiAppChartSchema()])
    expect(parseCloudAiChartInput(schema.parse(spec))).toMatchObject(spec);
  expect(CloudAiChartInputSchema.safeParse({ ...spec, dots: 4000 }).success).toBe(false);
  expect(parseCloudAiChartToolView(spec)).toMatchObject({ ...spec, view: "chart" });
  const dense = parseCloudAiChartInput(cloudAiAppChartSchema().parse({ ...spec, dots: 1000 }));
  expect(chartDrawingIssue(dense!)).toContain("one pixel");
  expect(
    CloudAiChartInputSchema.safeParse({
      ...spec,
      series: [
        { label: "Opened", data: [20] },
        { label: "Clicked", data: [30] },
      ],
    }).success,
  ).toBe(false);
});
