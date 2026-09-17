import { expect, test } from "bun:test";
import { formatCustomAppValue } from "../frontend/custom-app/value-format";
import { metricCellsFromPreview } from "./custom-app-insights";

test("metric display overrides carry exact aggregate values and configured units to the renderer", () => {
  const preview = {
    ok: true as const,
    mode: "rows" as const,
    limit: 1,
    columns: [{ key: "balance", label: "Balance", type: "aggregate", sqlType: "numeric", aggregate: "sum" }],
    rows: [{ values: { balance: "9007199254740993.25" } }],
  };
  expect(metricCellsFromPreview(preview, [])[0]!.valueFormat).toBeUndefined();
  const cell = metricCellsFromPreview(preview, [], { style: "number", decimalPlaces: 2, unit: "EUR" })[0]!;
  expect(cell.value).toBe("9007199254740993.25");
  expect(formatCustomAppValue(cell.value, cell.valueFormat, { locale: "de" })).toBe("9.007.199.254.740.993,25 EUR");
});
