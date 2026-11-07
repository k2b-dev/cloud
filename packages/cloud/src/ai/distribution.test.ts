import { expect, test } from "bun:test";
import { CloudAiChartInputSchema } from "./default-tool-contracts";
import { parseCloudAiChartToolView } from "./view-block";

test("treemap and Pareto model and saved-view paths retain the complete description", () => {
  for (const spec of [
    { kind: "treemap", title: "Shares", groups: ["A"], data: [{ label: "Chair", group: "A", value: 4 }] },
    { kind: "pareto", title: "Rank", labels: ["Now", "Before"], data: [{ label: "Chair", value: 4, prev: 3 }] },
  ]) {
    expect(CloudAiChartInputSchema.safeParse(spec).success).toBe(true);
    expect(parseCloudAiChartToolView(spec)).toMatchObject({ ...spec, view: "chart" });
  }
});

test("distribution JSON rejects invalid locales and overflowing totals", () => {
  expect(
    CloudAiChartInputSchema.safeParse({
      kind: "treemap",
      title: "Area",
      groups: ["A"],
      locale: "de_DE",
      data: [{ label: "A", group: "A", value: 1 }],
    }).success,
  ).toBe(false);
  expect(
    CloudAiChartInputSchema.safeParse({
      kind: "pareto",
      title: "Rank",
      labels: ["Now", "Before"],
      data: [
        { label: "A", value: 1e308, prev: 0 },
        { label: "B", value: 1e308, prev: 0 },
      ],
    }).success,
  ).toBe(false);
});
