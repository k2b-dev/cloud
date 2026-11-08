import { expect, test } from "bun:test";
import { chartKindSchema } from "@k2b/editor/charts";
import { chartCatalog } from "./chart-catalog.generated";
import { CloudAiChartInputSchema, cloudAiAppChartSchema } from "./default-tool-contracts";
import { createCloudAiChartTool } from "./default-tools";

const description = createCloudAiChartTool().def.description;
const issues = (result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  result.success ? [] : (result.error?.issues ?? []).map((issue) => `${issue.path.join(".")}: ${issue.message}`);

test("the chart tool describes every kind of the portable chart schema", () => {
  const described = new Set(chartCatalog.map((entry) => entry.example.kind));
  expect(chartKindSchema().options.filter((kind) => !described.has(kind))).toEqual([]);
  for (const entry of chartCatalog) {
    expect(entry.useFor.length, entry.name).toBeGreaterThan(0);
    expect(entry.avoidFor.length, entry.name).toBeGreaterThan(0);
  }
});

test("every example in the chart tool's description is a valid chart for the tool and for cloud.chart()", () => {
  const app = cloudAiAppChartSchema();
  for (const entry of chartCatalog) {
    expect({ name: entry.name, tool: issues(CloudAiChartInputSchema.safeParse(entry.example)) }).toEqual({ name: entry.name, tool: [] });
    expect({ name: entry.name, app: issues(app.safeParse(entry.example)) }).toEqual({ name: entry.name, app: [] });
    // The model reads the example exactly as the test parsed it.
    expect(description).toContain(JSON.stringify(entry.example));
  }
});
