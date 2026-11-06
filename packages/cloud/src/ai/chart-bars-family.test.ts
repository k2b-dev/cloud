import { expect, test } from "bun:test";
import { chartDrawingIssue, cloudAiChartTable } from "./chart-block";
import { CloudAiChartInputSchema, cloudAiAppChartSchema, cloudAiChartSchema, parseCloudAiChartInput } from "./default-tool-contracts";

const bar = {
  kind: "bar",
  title: "Orders",
  x: ["Q1", "Q2"],
  series: [
    { label: "Store", data: [35, 42] },
    { label: "Web", data: [24, 31] },
  ],
  layout: "stacked",
};
test("Chat and cloud.chart preserve aligned series and layout through the flat tool entry", () => {
  for (const schema of [CloudAiChartInputSchema, cloudAiAppChartSchema()]) {
    const input = parseCloudAiChartInput(schema.parse(bar));
    expect(input).toMatchObject(bar);
    expect(cloudAiChartTable(input!, "en").rows[0]?.values["series:1"]).toBe(24);
  }
  expect(CloudAiChartInputSchema.safeParse({ ...bar, series: [{ label: "bad", data: [-1, 2] }] }).success).toBe(false);
});
test("Chat accepts horizontal group headings, segment series and gaps", () => {
  const horizontal = {
    kind: "hbar",
    title: "Orders",
    series: ["Q1", "Q2"],
    rows: [{ group: "Store", label: "Furniture", values: [35, null] }],
  };
  expect(parseCloudAiChartInput(CloudAiChartInputSchema.parse(horizontal))).toMatchObject(horizontal);
});

test("drawing rejects bars that are narrower than half a phone pixel", () => {
  const x = Array.from({ length: 480 }, (_, i) => `Category ${i}`);
  const input = cloudAiChartSchema().parse({ kind: "bar", title: "Dense", x, series: [{ label: "A", data: x.map(() => 1) }] });
  expect(chartDrawingIssue(input)).toContain("half a pixel");
});
