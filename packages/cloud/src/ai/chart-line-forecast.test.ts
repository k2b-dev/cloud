import { expect, test } from "bun:test";
import { CloudAiChartInputSchema } from "./default-tool-contracts";
import { parseCloudAiChartToolView } from "./view-block";

test("Chat accepts additive forecast options and preserves missing observations", () => {
  const input = {
    kind: "line",
    title: "Cash forecast",
    series: [
      {
        label: "Cash",
        data: [
          { x: 1, y: 10 },
          { x: 2, y: null },
          { x: 3, y: -4 },
        ],
      },
    ],
    forecast: {
      from: 2,
      band: [
        [-1, 15],
        [-8, 0],
      ],
    },
    marker: { at: 2, label: "Today" },
    threshold: { value: 5, label: "Reserve" },
    zero: true,
    step: "before",
  };
  const validated = CloudAiChartInputSchema.parse(input);
  const parsed = parseCloudAiChartToolView(validated);
  expect(parsed?.view).toBe("chart");
  if (parsed?.view !== "chart" || parsed.kind !== "line") throw new Error("Expected line");
  expect(parsed.forecast?.band).toEqual([
    [-1, 15],
    [-8, 0],
  ]);
  expect(Number.isNaN(parsed.series[0]!.data[1]!.y)).toBe(true);
  expect(
    parseCloudAiChartToolView({
      ...input,
      forecast: {
        from: 2,
        band: [
          [15, -1],
          [-8, 0],
        ],
      },
    }),
  ).toBeUndefined();
});
