import { expect, test } from "bun:test";
import { signedRows069 } from "../../../ui/test/chart-rows-069-fixture";
import { chartDrawingIssue, cloudAiChartTable } from "./chart-block";
import { CloudAiChartInputSchema, cloudAiAppChartSchema, parseCloudAiChartInput } from "./default-tool-contracts";
import { parseCloudAiChartToolView } from "./view-block";

test("frozen 0.69 signed rows pass model, cloud.chart and Chat parsing without losing values", () => {
  for (const schema of [CloudAiChartInputSchema, cloudAiAppChartSchema()]) {
    const input = parseCloudAiChartInput(schema.parse(signedRows069));
    expect(input).toEqual(signedRows069);
    expect(chartDrawingIssue(input!)).toBeUndefined();
    expect(cloudAiChartTable(input!, "en").rows.map((row) => row.values.value)).toEqual([-12, 30, -4, 0]);
  }
  expect(parseCloudAiChartToolView(signedRows069)).toMatchObject({ ...signedRows069, view: "chart" });
});
