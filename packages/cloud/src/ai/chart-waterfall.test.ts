import { expect, test } from "bun:test";
import { cloudAiChartTable } from "./chart-block";
import { parseCloudAiChartToolView } from "./view-block";

const spec = {
  kind: "waterfall",
  title: "Cash movements",
  start: { label: "Opening", value: 100 },
  steps: [
    { label: "Sale", value: 70 },
    { label: "Payment", value: -30 },
  ],
  end: { label: "Closing" },
};
test("the Chat parse path accepts a waterfall and preserves its running balances", () => {
  const input = parseCloudAiChartToolView(spec);
  expect(input?.view).toBe("chart");
  if (input?.view !== "chart" || input.kind !== "waterfall") throw new Error("Expected waterfall");
  expect(cloudAiChartTable(input, "en").rows.map((r) => r.values.to)).toEqual([100, 170, 140, 140]);
  expect(parseCloudAiChartToolView({ ...spec, steps: [{ label: "Unknown", value: null }] })).toBeUndefined();
});
