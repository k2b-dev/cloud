import { expect, test } from "bun:test";
import { chartDrawingIssue } from "./chart-block";
import { CloudAiChartInputSchema, cloudAiAppChartSchema, parseCloudAiChartInput } from "./default-tool-contracts";

test("Chat and cloud.chart preserve funnels and ranked rows", () => {
  const examples = [
    {
      kind: "funnel",
      title: "Conversion",
      data: [
        { label: "A", value: 0 },
        { label: "B", value: 10 },
        { label: "Missing", value: null },
      ],
    },
    {
      kind: "bar",
      title: "Costs",
      layout: "rows",
      share: true,
      limit: 1,
      tone: "out",
      data: [
        { label: "A", value: 10 },
        { label: "B", value: 30 },
      ],
    },
  ];
  for (const spec of examples)
    for (const schema of [CloudAiChartInputSchema, cloudAiAppChartSchema()])
      expect(parseCloudAiChartInput(schema.parse(spec))).toMatchObject(spec);
  expect(CloudAiChartInputSchema.safeParse({ kind: "funnel", title: "Bad", data: [{ label: "A", value: -1 }] }).success).toBe(false);
});

test("funnel drawing rejects rows without room for both value lines", () => {
  const input = cloudAiAppChartSchema().parse({
    kind: "funnel",
    title: "Too many steps",
    data: Array.from({ length: 20 }, (_, i) => ({ label: `Step ${i}`, value: 20 - i })),
  });
  expect(chartDrawingIssue(input)).toContain("two value lines");
});
