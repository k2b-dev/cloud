import { expect, test } from "bun:test";
import { buildChartRenderData } from "../frontend/custom-app/chart-data";
import { formatCustomAppValue } from "../frontend/custom-app/value-format";
import { chartDataFromPreview, metricCellsFromPreview } from "./custom-app-insights";

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

test("date-typed chart categories use the request locale without reinterpreting text or timestamps", () => {
  const date = "2026-07-01T00:00:00.000Z";
  for (const sqlType of ["date", "text", "datetime", "numeric"]) {
    const key = sqlType === "numeric" ? 7 : date;
    const chart = chartDataFromPreview(
      {
        ok: true,
        mode: "groups",
        limit: 12,
        columns: [
          { key: "month", label: "Month", type: sqlType === "date" ? "date" : sqlType, sqlType },
          { key: "total", label: "Total", type: "aggregate", sqlType: "numeric", aggregate: "sum" },
        ],
        rows: [{ values: { month: key, total: "42.50" } }, { values: { month: null, total: "5" } }],
      },
      [],
    );
    if (chart.kind !== "chart") throw new Error(chart.reason);
    expect(chart.viewQuery.groupBy[0]?.granularity).toBe(sqlType === "date" ? "day" : undefined);
    for (const locale of ["de-DE", "en-GB"]) {
      const expected =
        sqlType === "date"
          ? new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(date))
          : String(key);
      for (const chartType of ["bar", "donut", "line"] as const) {
        const rendered = buildChartRenderData({
          widget: { chartType },
          ...chart.viewQuery,
          buckets: chart.buckets,
          fieldsById: new Map(),
          categoryFormat: { locale },
        });
        const label = rendered.kind === "line" ? rendered.xAxisFormat(0) : rendered.data[0]?.label;
        const empty = rendered.kind === "line" ? rendered.xAxisFormat(1) : rendered.data[1]?.label;
        expect(label).toBe(expected);
        expect(empty).toBe("—");
      }
    }
  }
});
