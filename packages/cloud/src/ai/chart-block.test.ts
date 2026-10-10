import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { checkCloudAiChartLabels, cloudAiChartRenderOptions, cloudAiChartTable } from "./chart-block";
import { CLOUD_AI_CHART_MAX_SERIES, CLOUD_AI_CHART_MAX_VALUES, CloudAiChartInputSchema } from "./default-tool-contracts";

const parse = (input: unknown) => CloudAiChartInputSchema.parse(input);
const issues = (input: unknown) => {
  const result = CloudAiChartInputSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

describe("chart tool input", () => {
  test("accepts every cloud.chart() kind as plain data", () => {
    const kinds = [
      { kind: "bar", title: "Orders by region", data: [{ label: "North", value: 12 }], showValues: true },
      { kind: "line", title: "Visits", series: [{ label: "Web", data: [{ x: "2026-10-01", y: 3 }] }], area: true },
      { kind: "scatter", title: "Size and price", series: [{ data: [{ x: 1, y: 2 }] }] },
      { kind: "pie", title: "Share", data: [{ label: "A", value: 1 }] },
      { kind: "donut", title: "Share", data: [{ label: "A", value: 1 }], showLabels: true },
      { kind: "histogram", title: "Response times", data: [120, 80, 95], bins: 4 },
      { kind: "gauge", title: "Disk", value: 72, max: 100, unit: "%" },
      { kind: "sparkline", title: "Trend", data: [1, 3, 2], area: true },
    ];
    for (const input of kinds) expect(issues(input)).toEqual([]);
  });

  test("strips options that only code can pass and keeps the rest", () => {
    const chart = parse({ kind: "bar", title: " Revenue ", data: [{ label: "Q1", value: 4 }], width: 900, yAxis: { label: "EUR" } });
    expect(chart).toEqual({ kind: "bar", title: "Revenue", data: [{ label: "Q1", value: 4 }], yAxis: { label: "EUR" } });
  });

  test("rejects input that would not draw, with a reason the model can act on", () => {
    expect(issues({ kind: "radar", title: "X", data: [] })).not.toEqual([]);
    expect(issues({ kind: "bar", title: "", data: [{ label: "A", value: 1 }] })).not.toEqual([]);
    expect(issues({ kind: "bar", title: "Empty", data: [] })).not.toEqual([]);
    expect(issues({ kind: "bar", title: "Text", data: [{ label: "A", value: "12" }] })).not.toEqual([]);
    expect(issues({ kind: "pie", title: "Negative", data: [{ label: "A", value: -1 }] })).not.toEqual([]);
    expect(issues({ kind: "pie", title: "Nothing", data: [{ label: "A", value: 0 }] })).toEqual([
      "Pie and donut slices must add up to more than zero.",
    ]);
    expect(
      issues({
        kind: "line",
        title: "Mixed",
        series: [{ data: [{ x: 1, y: 1 }] }, { data: [{ x: "2026-10-01", y: 2 }] }],
      }),
    ).toEqual(["Use either numbers or dates for x in all series, not both."]);
    expect(issues({ kind: "line", title: "Date", series: [{ data: [{ x: "2026-13-01", y: 1 }] }] })).toEqual(["Not a valid date."]);
    expect(issues({ kind: "line", title: "Zone", series: [{ data: [{ x: "2026-10-01T10:00Z", y: 1 }] }] })).not.toEqual([]);
    expect(issues({ kind: "bar", title: "Domain", data: [{ label: "A", value: 5 }], yAxis: { domain: [0, 2] } })[0]).toStartWith(
      "The chart cannot be drawn: ",
    );
    expect(issues({ kind: "line", title: "Log", series: [{ data: [{ x: 1, y: -1 }] }], yAxis: { scale: "log" } })).toEqual([
      "None of the values can be drawn; a log axis needs values above zero.",
    ]);
  });

  test("bounds series by the palette and values by the drawing width", () => {
    const series = (count: number, values: number) =>
      Array.from({ length: count }, () => ({ data: Array.from({ length: values }, (_, x) => ({ x, y: x })) }));
    expect(issues({ kind: "line", title: "Max", series: series(CLOUD_AI_CHART_MAX_SERIES, CLOUD_AI_CHART_MAX_VALUES) })).toEqual([]);
    expect(issues({ kind: "line", title: "Series", series: series(CLOUD_AI_CHART_MAX_SERIES + 1, 1) })).not.toEqual([]);
    expect(issues({ kind: "line", title: "Values", series: series(1, CLOUD_AI_CHART_MAX_VALUES + 1) })).not.toEqual([]);
  });

  test("describes itself as JSON Schema for the model", () => {
    const schema = JSON.stringify(z.toJSONSchema(CloudAiChartInputSchema, { target: "draft-07" }));
    for (const kind of ["bar", "line", "scatter", "pie", "donut", "histogram", "gauge", "sparkline"]) expect(schema).toContain(`"${kind}"`);
  });
});

describe("chart table", () => {
  test("has the same labels in every locale", () => {
    expect(checkCloudAiChartLabels()).toEqual([]);
  });

  test("lists bars with exact values in the reader's language", () => {
    const table = cloudAiChartTable(
      parse({
        kind: "bar",
        title: "Revenue",
        data: [
          { label: "Jan", value: 1_250_000 },
          { label: "Feb", value: 980_000.5 },
        ],
        yAxis: { label: "EUR" },
      }),
      "de",
    );
    expect(table.columns).toEqual([
      { id: "label", label: "Kategorie", numeric: false },
      { id: "value", label: "EUR", numeric: true },
    ]);
    expect(table.rows).toEqual([
      { key: "0:0", cells: { label: "Jan", value: "1.250.000" }, values: { label: "Jan", value: 1_250_000 } },
      { key: "0:1", cells: { label: "Feb", value: "980.000,5" }, values: { label: "Feb", value: 980_000.5 } },
    ]);
  });

  test("keeps calendar days and local times as written, on every device", () => {
    const days = cloudAiChartTable(
      parse({
        kind: "line",
        title: "Visits",
        series: [
          { label: "Web", data: [{ x: "2026-01-01", y: 3 }] },
          { label: "App", data: [{ x: "2026-01-01", y: 1 }] },
        ],
      }),
      "en",
    );
    expect(days.columns.map((column) => column.label)).toEqual(["Series", "X", "Y"]);
    expect(days.rows.map((row) => row.cells)).toEqual([
      { series: "Web", x: "Jan 1, 2026", y: "3" },
      { series: "App", x: "Jan 1, 2026", y: "1" },
    ]);
    const times = cloudAiChartTable(parse({ kind: "line", title: "Load", series: [{ data: [{ x: "2026-01-01T23:30", y: 1 }] }] }), "de");
    expect(times.rows[0]!.cells.x).toBe("01.01.2026, 23:30");
  });

  test("lists what the chart draws: shares, bins and a gauge with its unit", () => {
    const pie = cloudAiChartTable(
      parse({
        kind: "pie",
        title: "Share",
        data: [
          { label: "A", value: 1 },
          { label: "B", value: 3 },
        ],
      }),
      "en",
    );
    expect(pie.rows.map((row) => row.cells)).toEqual([
      { label: "A", value: "1", percent: "25%" },
      { label: "B", value: "3", percent: "75%" },
    ]);
    const histogram = cloudAiChartTable(parse({ kind: "histogram", title: "Times", data: [1, 2, 2, 3], bins: 2 }), "en");
    expect(histogram.columns.map((column) => column.id)).toEqual(["from", "to", "count"]);
    expect(histogram.rows.reduce((sum, row) => sum + Number(row.values.count), 0)).toBe(4);
    const gauge = cloudAiChartTable(parse({ kind: "gauge", title: "Disk", value: 72, unit: "%" }), "en");
    expect(gauge.rows[0]!.cells).toEqual({ value: "72 %", min: "0 %", max: "100 %" });
  });
});

describe("chart render options", () => {
  test("make room for long tick labels and show a legend for several series", () => {
    const small = cloudAiChartRenderOptions(parse({ kind: "bar", title: "Small", data: [{ label: "A", value: 5 }] }), "en");
    const large = cloudAiChartRenderOptions(parse({ kind: "bar", title: "Large", data: [{ label: "A", value: 1_250_000 }] }), "de");
    const left = (options: typeof small) => ("padding" in options && typeof options.padding === "object" ? (options.padding.left ?? 0) : 0);
    expect(left(large)).toBeGreaterThan(left(small));
    const lines = cloudAiChartRenderOptions(
      parse({ kind: "line", title: "Two", series: [{ data: [{ x: 1, y: 1 }] }, { data: [{ x: 1, y: 2 }] }] }),
      "en",
    );
    expect(lines.kind === "line" && lines.legend).toBe(true);
    const pie = cloudAiChartRenderOptions(parse({ kind: "pie", title: "Share", data: [{ label: "A", value: 1 }] }), "en");
    expect(pie.kind === "pie" && pie.legend).toBe(true);
  });

  test("show every n-th long category label on the axis while the table keeps them all", () => {
    const months = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];
    const input = parse({ kind: "bar", title: "Months", data: months.map((label, value) => ({ label: `${label} 2026`, value })) });
    const options = cloudAiChartRenderOptions(input, "en");
    const shown = options.kind === "bar" ? options.data.map((item) => item.label).filter(Boolean) : [];
    expect(shown.length).toBeGreaterThan(1);
    expect(shown.length).toBeLessThan(months.length);
    expect(cloudAiChartTable(input, "en").rows.map((row) => row.cells.label)).toEqual(months.map((label) => `${label} 2026`));
  });
});
