import { describe, expect, test } from "bun:test";
import { charts } from "@k2b/stdlib";
import { z } from "zod";
import {
  chartDateTime,
  checkCloudAiChartLabels,
  cloudAiChartMarkKey,
  cloudAiChartRenderOptions,
  cloudAiChartRows,
  cloudAiChartTable,
} from "./chart-block";
import {
  CLOUD_AI_CHART_MAX_SERIES,
  CLOUD_AI_CHART_MAX_VALUES,
  type CloudAiChartInput,
  CloudAiChartInputSchema,
  parseCloudAiChartInput,
} from "./default-tool-contracts";

const parse = (input: unknown): CloudAiChartInput => {
  const chart = parseCloudAiChartInput(input);
  if (!chart) throw new Error(`Not a chart: ${JSON.stringify(input)}`);
  return chart;
};
const issues = (input: unknown) => {
  const result = CloudAiChartInputSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

describe("chart tool input", () => {
  test("accepts every cloud.chart() kind as plain data", () => {
    const kinds = [
      { kind: "bar", title: "Orders by region", data: [{ label: "North", value: 12 }], showValues: true },
      {
        kind: "line",
        title: "Visits",
        series: [
          {
            label: "Web",
            data: [
              { x: "2026-10-01", y: 3 },
              { x: "2026-10-02", y: 5 },
            ],
          },
        ],
        area: true,
      },
      { kind: "scatter", title: "Size and price", series: [{ data: [{ x: 1, y: 2 }] }] },
      { kind: "pie", title: "Share", data: [{ label: "A", value: 1 }] },
      { kind: "donut", title: "Share", data: [{ label: "A", value: 1 }], showLabels: true },
      { kind: "histogram", title: "Response times", data: [120, 80, 95], bins: 4 },
      { kind: "gauge", title: "Disk", value: 72, max: 100, unit: "%" },
      { kind: "sparkline", title: "Trend", data: [1, 3, 2], area: true },
    ];
    for (const input of kinds) expect(issues(input)).toEqual([]);
  });

  test("strips options that only code or another kind can pass and keeps the rest", () => {
    const chart = { kind: "bar", title: " Revenue ", data: [{ label: "Q1", value: 4 }], width: 900, smooth: true, yAxis: { label: "EUR" } };
    expect(parse(chart)).toEqual({ kind: "bar", title: "Revenue", data: [{ label: "Q1", value: 4 }], yAxis: { label: "EUR" } });
    expect(issues(chart)).toEqual([]);
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
        kind: "scatter",
        title: "Mixed",
        series: [{ data: [{ x: 1, y: 1 }] }, { data: [{ x: "2026-10-01", y: 2 }] }],
      }),
    ).toEqual(["Use either numbers or dates for x in all series, not both."]);
    expect(issues({ kind: "scatter", title: "Date", series: [{ data: [{ x: "2026-13-01", y: 1 }] }] })).toEqual(["Not a valid date."]);
    expect(issues({ kind: "scatter", title: "Zone", series: [{ data: [{ x: "2026-10-01T10:00Z", y: 1 }] }] })).not.toEqual([]);
    expect(issues({ kind: "bar", title: "Domain", data: [{ label: "A", value: 5 }], yAxis: { domain: [0, 2] } })[0]).toStartWith(
      "The chart cannot be drawn: ",
    );
    expect(issues({ kind: "bar", title: "Kind", series: [{ data: [{ x: 1, y: 1 }] }] })).not.toEqual([]);
  });

  test("rejects values the chart would leave out, so the table never hides one", () => {
    const log = "A log axis shows only values above zero; use a linear axis or leave out the values at or below zero.";
    const points = [
      { x: 1, y: -3 },
      { x: 2, y: 10 },
    ];
    expect(issues({ kind: "line", title: "Log", series: [{ data: points }], yAxis: { scale: "log" } })).toEqual([log]);
    expect(issues({ kind: "scatter", title: "Log x", series: [{ data: [{ x: 0, y: 1 }] }], xAxis: { scale: "log" } })).toEqual([log]);
    expect(issues({ kind: "bar", title: "Log", data: [{ label: "A", value: 0 }], yAxis: { scale: "log" } })).toEqual([log]);
    expect(issues({ kind: "line", title: "Linear", series: [{ data: points }] })).toEqual([]);
    // One point draws no line; a scatter chart shows it.
    expect(issues({ kind: "line", title: "Point", series: [{ data: [{ x: 1, y: 5 }] }] })).toEqual([
      "A line needs at least two points per series; show single values as a bar or scatter chart.",
    ]);
    expect(issues({ kind: "scatter", title: "Point", series: [{ data: [{ x: 1, y: 5 }] }] })).toEqual([]);
  });

  test("accepts only calendar dates and times that exist, the same on every engine", () => {
    const at = (x: string) => issues({ kind: "scatter", title: "Dates", series: [{ data: [{ x, y: 1 }] }] });
    for (const x of ["2026-02-29", "2026-02-30", "2026-04-31", "2026-01-01T24:00", "2026-01-01T10:60", "2026-01-01T10:00:60"])
      expect(at(x)).toEqual(["Not a valid date."]);
    for (const x of ["2028-02-29", "2026-12-31T23:59:59", "0001-01-01"]) expect(at(x)).toEqual([]);
    expect(chartDateTime("2026-03-02")).toBe(Date.UTC(2026, 2, 2));
    expect(chartDateTime("2026-03-02T10:15:30")).toBe(Date.UTC(2026, 2, 2, 10, 15, 30));
    expect(chartDateTime("2026-02-30")).toBeUndefined();
  });

  test("rejects a pie whose legend would leave too little room for it", () => {
    const slices = (count: number, label: (index: number) => string) =>
      Array.from({ length: count }, (_, index) => ({ label: label(index), value: index + 1 }));
    expect(issues({ kind: "pie", title: "Long", data: slices(12, (index) => `Category ${index} with a long name`) })).toEqual([
      "The legend leaves too little room for the pie: combine small slices into one, shorten the labels, or use a bar chart.",
    ]);
    expect(issues({ kind: "donut", title: "Short", data: slices(30, (index) => `C${index}`) })).toEqual([]);
  });

  test("bounds series by the palette and values by the drawing width", () => {
    const series = (count: number, values: number) =>
      Array.from({ length: count }, () => ({ data: Array.from({ length: values }, (_, x) => ({ x, y: x })) }));
    expect(issues({ kind: "line", title: "Max", series: series(CLOUD_AI_CHART_MAX_SERIES, CLOUD_AI_CHART_MAX_VALUES) })).toEqual([]);
    expect(issues({ kind: "line", title: "Series", series: series(CLOUD_AI_CHART_MAX_SERIES + 1, 2) })).not.toEqual([]);
    expect(issues({ kind: "line", title: "Values", series: series(1, CLOUD_AI_CHART_MAX_VALUES + 1) })).not.toEqual([]);
  });

  test("fails on its bounds before anything is computed or drawn", () => {
    const started = performance.now();
    // Drawn, 50 million ticks would block the server for minutes.
    expect(issues({ kind: "bar", title: "Ticks", data: [{ label: "A", value: 5 }], yAxis: { ticks: 50_000_000 } })).toEqual([
      "Too big: expected number to be <=12",
    ]);
    const bars = Array.from({ length: 20_000 }, (_, value) => ({ label: "A", value }));
    expect(issues({ kind: "bar", title: "Bars", data: bars })).toHaveLength(1);
    // The renderer would step through 1e17 to 1e17 + 16 forever: a float cannot add its step there.
    const close = [
      { x: 1, y: 1e17 },
      { x: 2, y: 1e17 + 16 },
    ];
    expect(issues({ kind: "line", title: "Close", series: [{ data: close }] })).toEqual([
      "The values differ too little for their size to label an axis; subtract a common offset first.",
    ]);
    expect(issues({ kind: "histogram", title: "Close", data: [1e17, 1e17 + 16] })).not.toEqual([]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("describes itself to every model provider as one object", () => {
    const schema = z.toJSONSchema(CloudAiChartInputSchema, { target: "draft-07" }) as Record<string, unknown>;
    // Anthropic, OpenAI and Gemini accept only an object at the root of a tool schema, without oneOf or anyOf there.
    expect(schema.type).toBe("object");
    for (const key of ["oneOf", "anyOf", "allOf"]) expect(schema).not.toHaveProperty(key);
    const text = JSON.stringify(schema);
    // Gemini reads only one schema per array; a draft-07 tuple would give it a list.
    expect(text).not.toContain('"items":[');
    for (const kind of ["bar", "line", "scatter", "pie", "donut", "histogram", "gauge", "sparkline"]) expect(text).toContain(`"${kind}"`);
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
        kind: "scatter",
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
    const times = cloudAiChartTable(parse({ kind: "scatter", title: "Load", series: [{ data: [{ x: "2026-01-01T23:30", y: 1 }] }] }), "de");
    expect(times.rows[0]!.cells.x).toBe("01.01.2026, 23:30");
    // Points a second apart stay apart in the table.
    const seconds = cloudAiChartTable(
      parse({
        kind: "line",
        title: "Requests",
        series: [
          {
            data: [
              { x: "2026-01-01T10:00:01", y: 1 },
              { x: "2026-01-01T10:00:02", y: 2 },
            ],
          },
        ],
      }),
      "en",
    );
    expect(seconds.rows.map((row) => row.cells.x)).toEqual(["Jan 1, 2026, 10:00:01 AM", "Jan 1, 2026, 10:00:02 AM"]);
  });

  test("shows and copies every value as given, also small ones", () => {
    const table = cloudAiChartTable(
      parse({
        kind: "bar",
        title: "Rates",
        data: [
          { label: "A", value: 0.00000001 },
          { label: "B", value: 1.123456789 },
          { label: "C", value: 0.1 + 0.2 },
        ],
      }),
      "en",
    );
    expect(table.rows.map((row) => row.cells.value)).toEqual(["0.00000001", "1.123456789", "0.3"]);
  });

  test("fills the same table from the marks of a drawing", () => {
    const input = parse({
      kind: "pie",
      title: "Share",
      data: [
        { label: "A", value: 1 },
        { label: "B", value: 3 },
      ],
    });
    const rows = cloudAiChartRows(input, "de");
    const { kind, ...options } = cloudAiChartRenderOptions(input, "de");
    const svg = (charts[kind] as (value: object) => string)({ ...options, width: 480, height: 280, inspect: true });
    for (const match of svg.matchAll(/data-chart-datum="([^"]*)"/g)) rows.add(JSON.parse(match[1]!.replaceAll("&quot;", '"')));
    expect(rows.table()).toEqual(cloudAiChartTable(input, "de"));
    expect(rows.table().rows.map((row) => row.key)).toEqual([cloudAiChartMarkKey({ index: 0 }), cloudAiChartMarkKey({ index: 1 })]);
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
    const two = (locale: string) =>
      cloudAiChartRenderOptions(
        parse({
          kind: "line",
          title: "Two",
          series: [
            {
              data: [
                { x: 1, y: 1 },
                { x: 2, y: 2 },
              ],
            },
            {
              data: [
                { x: 1, y: 2 },
                { x: 2, y: 3 },
              ],
            },
          ],
        }),
        locale,
      );
    const lines = two("en");
    expect(lines.kind === "line" && lines.legend).toBe(true);
    // The legend names unnamed series in the reader's language, like the table.
    const german = two("de");
    expect(german.kind === "line" ? german.series.map((series) => series.label) : []).toEqual(["Datenreihe 1", "Datenreihe 2"]);
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

describe("chart axes", () => {
  const ticks = (input: unknown, anchor: "end" | "middle") => {
    const { kind, ...options } = cloudAiChartRenderOptions(parse(input), "en");
    const svg = (charts[kind] as (value: object) => string)({ ...options, width: 480, height: 280 });
    return [...svg.matchAll(new RegExp(`stdlib-chart-tick-label"[^>]*text-anchor="${anchor}">([^<]*)<`, "g"))].map((match) => match[1]);
  };

  test("label fractional values exactly and large ones briefly", () => {
    const shares = [0.12, 0.25, 0.18].map((value, index) => ({ label: `S${index}`, value }));
    expect(ticks({ kind: "bar", title: "Shares", data: shares }, "end")).toEqual(["0", "0.05", "0.1", "0.15", "0.2", "0.25"]);
    const rates = [
      { x: 1, y: 0.031 },
      { x: 2, y: 0.0425 },
    ];
    const rateTicks = ticks({ kind: "line", title: "Rates", series: [{ data: rates }] }, "end");
    expect(rateTicks).toContain("0.04");
    expect(new Set(rateTicks).size).toBe(rateTicks.length);
    expect(ticks({ kind: "bar", title: "Revenue", data: [{ label: "A", value: 1_250_000 }] }, "end")).toContain("1.2M");
  });

  test("label numbers on an x axis in full, such as years", () => {
    const years = [
      { x: 2020, y: 1 },
      { x: 2026, y: 3 },
    ];
    expect(ticks({ kind: "line", title: "Years", series: [{ data: years }] }, "middle")).toEqual([
      "2020",
      "2021",
      "2022",
      "2023",
      "2024",
      "2025",
      "2026",
    ]);
  });
});
