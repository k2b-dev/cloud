import { expect, test } from "bun:test";
import { CloudAiChartInputSchema, cloudAiAppChartSchema } from "./default-tool-contracts";
import { parseCloudAiChartToolView, parseCloudAiView } from "./view-block";

const spec = {
  kind: "balanceFlow",
  title: "Settlements",
  currency: "EUR",
  locale: "de-DE",
  periods: [
    { label: "October", opening: 10, inflows: [{ label: "Orders", value: 20 }], outflows: [{ label: "Fees", value: 5 }], closing: 25 },
    { label: "November", opening: 25, inflows: [], outflows: [{ label: "Payout", value: 15 }], closing: 10 },
  ],
};
test("model, saved view and app JSON enforce both balance equations and continuity", () => {
  for (const schema of [CloudAiChartInputSchema, cloudAiAppChartSchema()]) {
    expect(schema.safeParse(spec).success).toBe(true);
    expect(schema.safeParse({ ...spec, locale: "de_DE" }).success).toBe(false);
    expect(schema.safeParse({ ...spec, periods: [{ ...spec.periods[0], closing: 24 }] }).success).toBe(false);
    expect(schema.safeParse({ ...spec, periods: [spec.periods[0], { ...spec.periods[1], opening: 24, closing: 9 }] }).success).toBe(false);
  }
  expect(parseCloudAiChartToolView(spec)).toMatchObject({ kind: "balanceFlow" });
  expect(parseCloudAiView({ ...spec, view: "chart" })?.view).toBe("chart");
  expect(parseCloudAiView({ ...spec, view: "chart", periods: [{ ...spec.periods[0], closing: 0 }] })).toBeUndefined();
});
test("model chart groups accept balance flows without losing periods", () => {
  const input = CloudAiChartInputSchema.safeParse({ title: "Settlements", charts: [spec, { ...spec, title: "Other settlement" }] });
  expect(input.success).toBe(true);
  expect(parseCloudAiChartToolView({ title: "Settlements", charts: [spec, { ...spec, title: "Other settlement" }] })?.view).toBe("group");
});
