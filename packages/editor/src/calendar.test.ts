import { expect, test } from "bun:test";
import { chartKinds, chartRenderOptions, chartTable } from "./charts";

const spec = {
  kind: "heatmap",
  layout: "calendar",
  title: "Opens per day",
  scale: "sequential",
  data: [
    ["2026-11-02", 1234.5],
    ["2026-11-03", 0],
  ],
};
test("calendar schema is additive, validates dates and preserves table locale", () => {
  const schema = chartKinds();
  const input = schema.parse(spec);
  expect(chartTable(input, "de").rows.map((r) => r.cells.value)).toEqual(["1.234,5", "0"]);
  expect(chartTable(input, "de").rows[0]!.cells.label).toContain("Montag");
  expect(chartRenderOptions(input, "de", { width: 900 })).toMatchObject({ displayWidth: 900 });
  expect(schema.safeParse({ ...spec, data: [["2026-02-30", 1]] }).success).toBe(false);
  expect(
    schema.safeParse({
      ...spec,
      data: [
        ["2026-11-02", 1],
        ["2026-11-02", 2],
      ],
    }).success,
  ).toBe(false);
  expect(schema.safeParse({ kind: "heatmap", title: "Queues", data: [{ x: "Mon", y: "Queue", value: 2 }] }).success).toBe(true);
});
