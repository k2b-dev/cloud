import { expect, test } from "bun:test";
import { parseRows069, positiveRows069Json, signedRows069Json } from "../../../ui/test/chart-rows-069-fixture";
import { chartDrawingIssue, cloudAiChartTable } from "./chart-block";
import { CloudAiChartInputSchema, cloudAiAppChartSchema, parseCloudAiChartInput } from "./default-tool-contracts";
import { parseCloudAiChartToolView } from "./view-block";

test("frozen 0.69 signed rows pass model, cloud.chart and Chat parsing without losing values", () => {
  const signedRows069 = parseRows069(signedRows069Json);
  for (const schema of [CloudAiChartInputSchema, cloudAiAppChartSchema()]) {
    const input = parseCloudAiChartInput(schema.parse(signedRows069));
    expect(input).toEqual(signedRows069);
    expect(chartDrawingIssue(input!)).toBeUndefined();
    expect(cloudAiChartTable(input!, "en").rows.map((row) => row.values.value)).toEqual([-12, 30, -4, 0]);
  }
  expect(parseCloudAiChartToolView(signedRows069)).toMatchObject({ ...signedRows069, view: "chart" });
});

test("both model and app schemas reject ranked-only options for signed rows", () => {
  for (const schema of [CloudAiChartInputSchema, cloudAiAppChartSchema()])
    for (const option of [{ share: true }, { share: false }, { limit: 1 }, { tone: "out" }])
      expect(() => schema.parse({ ...parseRows069(signedRows069Json), ...option })).toThrow(
        "Share, limit and tone need nonnegative values.",
      );
});

test("frozen positive 0.69 rows retain ordering and drawing options at model and Chat boundaries", () => {
  for (const json of Object.values(positiveRows069Json)) {
    const spec = parseRows069(json);
    for (const schema of [CloudAiChartInputSchema, cloudAiAppChartSchema()]) {
      const input = parseCloudAiChartInput(schema.parse(spec));
      expect(input).toEqual(spec);
      expect(chartDrawingIssue(input!)).toBeUndefined();
      expect(cloudAiChartTable(input!, "en").rows.map((row) => row.values.value)).toEqual([20, 50, 30]);
    }
    expect(parseCloudAiChartToolView(spec)).toMatchObject({ ...spec, view: "chart" });
  }
});
