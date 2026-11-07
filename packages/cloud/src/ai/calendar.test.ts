import { expect, test } from "bun:test";
import { CloudAiChartInputSchema } from "./default-tool-contracts";
import { parseCloudAiChartToolView } from "./view-block";

const spec = {
  kind: "heatmap",
  layout: "calendar",
  title: "Opens per day",
  scale: "sequential",
  data: [
    ["2026-11-02", 5],
    ["2026-11-03", 8],
  ],
};
test("calendar model schema and saved tool view preserve date tuples and layout", () => {
  expect(CloudAiChartInputSchema.safeParse(spec).success).toBe(true);
  expect(CloudAiChartInputSchema.safeParse({ ...spec, locale: "de_DE" }).success).toBe(false);
  expect(parseCloudAiChartToolView(spec)).toMatchObject({ ...spec, view: "chart" });
  expect(CloudAiChartInputSchema.safeParse({ ...spec, data: [["2026-11-32", 3]] }).success).toBe(false);
});

test("calendar model validation covers gaps, spans, group membership and kind-specific fields", () => {
  expect(
    CloudAiChartInputSchema.safeParse({
      ...spec,
      data: [
        ["2026-11-02", null],
        ["2026-11-03", 5],
      ],
    }).success,
  ).toBe(true);
  expect(
    CloudAiChartInputSchema.safeParse({
      ...spec,
      data: [
        ["2000-01-01", 1],
        ["2026-01-01", 1],
      ],
    }).success,
  ).toBe(false);
  expect(
    CloudAiChartInputSchema.safeParse({ kind: "bar", title: "Bars", layout: "calendar", data: [{ label: "A", value: 1 }] }).success,
  ).toBe(false);
  expect(CloudAiChartInputSchema.safeParse({ kind: "bar", title: "Bars", locale: "de-DE", data: [{ label: "A", value: 1 }] }).success).toBe(
    false,
  );
  expect(CloudAiChartInputSchema.safeParse({ title: "Two calendars", charts: [spec, { ...spec, title: "Second" }] }).success).toBe(true);
});
