import { expect, test } from "bun:test";
import { CloudAiChartInputSchema, cloudAiAppChartSchema } from "@k2b/cloud/ai/browser";
import chartKinds from "./skills/assistant-code-mode/references/chart-kinds.md" with { type: "text" };

const examples = [...chartKinds.matchAll(/```json\n(.+)\n```/g)].map((match) => JSON.parse(match[1]!) as { kind: string });
const issues = (result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  result.success ? [] : (result.error?.issues ?? []).map((issue) => `${issue.path.join(".")}: ${issue.message}`);

test("Code's chart kind reference has one example per kind, each valid for cloud.chart() and the chart tool", () => {
  const headings = [...chartKinds.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  expect(examples.length).toBe(headings.length);
  expect(new Set(examples.map((example) => example.kind)).size).toBeGreaterThanOrEqual(20);
  const app = cloudAiAppChartSchema();
  for (const [index, example] of examples.entries()) {
    expect({ kind: headings[index], app: issues(app.safeParse(example)) }).toEqual({ kind: headings[index], app: [] });
    expect({ kind: headings[index], tool: issues(CloudAiChartInputSchema.safeParse(example)) }).toEqual({
      kind: headings[index],
      tool: [],
    });
  }
});
