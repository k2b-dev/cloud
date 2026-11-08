import { expect, test } from "bun:test";
import { z } from "zod";
import { chartDrawingIssue } from "./chart-block";
import { CloudAiChartInputSchema, cloudAiAppChartSchema, parseCloudAiChartInput } from "./default-tool-contracts";
import { createCloudAiChartTool } from "./default-tools";
import { parseCloudAiChartToolView } from "./view-block";

test("the model-facing chart catalog includes a valid nested dots example", () => {
  const tool = createCloudAiChartTool().def;
  const schema = z.toJSONSchema(tool.inputSchema, { target: "draft-07" });
  const description = String(schema.description ?? "");
  const entry = description.split("\n").find((line) => line.startsWith('- bar (layout "nested").'));
  const example = entry?.slice(entry.indexOf("{"));
  expect(example).toBeDefined();
  const input = CloudAiChartInputSchema.parse(JSON.parse(example!));
  expect(parseCloudAiChartInput(input)).toMatchObject({ kind: "bar", marks: "dots", layout: "nested" });
  expect(tool.description).toContain('- bar (layout "nested"):');
  expect(JSON.stringify(schema)).toContain("subset");
  expect(JSON.stringify(schema)).toContain("never summed rates");
});

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
