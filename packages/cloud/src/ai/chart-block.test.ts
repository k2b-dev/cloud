import { describe, expect, test } from "bun:test";
import { charts } from "@k2b/stdlib";
import { z } from "zod";
import {
  chartDateTime,
  checkCloudAiChartLabels,
  cloudAiChartLegend,
  cloudAiChartMarkKey,
  cloudAiChartMarks,
  cloudAiChartReferenceMark,
  cloudAiChartRenderOptions,
  cloudAiChartRows,
  cloudAiChartTable,
  cloudAiChartTooltip,
  cloudAiChartXValueFormat,
  cloudAiNumberFormatters,
} from "./chart-block";
import {
  CLOUD_AI_CHART_MAX_SERIES,
  CLOUD_AI_CHART_MAX_VALUES,
  CLOUD_AI_VIEW_MAX_MARKS,
  type CloudAiChartInput,
  CloudAiChartInputSchema,
  cloudAiAppChartSchema,
  cloudAiChartSchema,
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

describe("richer chart contracts", () => {
  test("number formats share value precision, units and distinct tick precision", () => {
    const fmt = cloudAiNumberFormatters({ style: "percent", decimals: 0, compact: false, unit: "share" }, "en");
    expect(fmt.value(0.214)).toBe("21% share");
    expect(fmt.tick(0.214)).toBe("21.4% share");
    const money = cloudAiNumberFormatters({ style: "currency", currency: "EUR", decimals: 2, compact: true }, "en");
    expect(money.value(1200)).toBe("€1.20K");
    expect(money.tick(1250)).toBe("€1.25K");
    expect(cloudAiNumberFormatters(undefined, "en").value(0.00000001)).toBe("0.00000001");
    expect(cloudAiNumberFormatters(undefined, "en").tick(1250000)).toBe("1.25M");
  });

  test("bar showValues prints values with the value precision, which the y ticks then share", () => {
    const input = parse({
      kind: "bar",
      title: "Rate",
      data: [{ label: "A", value: 0.214 }],
      showValues: true,
      yAxis: { format: { style: "percent", decimals: 0 } },
    });
    expect(cloudAiChartTable(input, "en").rows[0]?.cells.value).toBe("21%");
    const options = cloudAiChartRenderOptions(input, "en");
    if (options.kind !== "bar") throw new Error("Expected bar");
    const svg = charts.bar({ ...options, width: 480, height: 280 });
    expect(/class="stdlib-chart-bar-value"[^>]*>([^<]*)</.exec(svg)?.[1]).toBe("21%");
    expect(options.yAxis?.format?.(0.05)).toBe("5%");
  });

  test.each(["day", "minute", "second"] as const)("date format %s controls x ticks and values", (date) => {
    const input = parse({
      kind: "scatter",
      title: "Time",
      xAxis: { format: { date } },
      series: [{ data: [{ x: "2026-01-01T10:15:30", y: 1 }] }],
    });
    const options = cloudAiChartRenderOptions(input, "en");
    if (options.kind !== "scatter") throw new Error("Expected scatter");
    const x = chartDateTime("2026-01-01T10:15:30")!;
    const text = cloudAiChartXValueFormat(input, "en")(x);
    expect(cloudAiChartTable(input, "en").rows[0]?.cells.x).toBe(text);
    expect(text).toContain("Jan 1, 2026");
    if (date === "day") {
      expect(text).not.toContain("10:");
      expect(options.xAxis?.format?.(x)).not.toContain("10:");
    } else {
      expect(text).toContain(date === "second" ? "10:15:30" : "10:15");
      expect(options.xAxis?.format?.(x)).toContain(date === "second" ? "10:15:30" : "10:15");
    }
  });

  test("formats must match their axes and currency is only for currency style", () => {
    for (const [x, format] of [
      [1, { date: "day" }],
      ["2026-01-01", { style: "number" }],
    ])
      expect(issues({ kind: "scatter", title: "X", series: [{ data: [{ x, y: 1 }] }], xAxis: { format } })[0]).toContain(
        "format for the x axis",
      );
    expect(issues({ kind: "bar", title: "Y", data: [{ label: "A", value: 1 }], yAxis: { format: { date: "day" } } })[0]).toContain(
      "number format",
    );
    for (const format of [{ style: "currency" }, { currency: "EUR" }, { style: "percent", currency: "EUR" }])
      expect(parseCloudAiChartInput({ kind: "gauge", title: "G", value: 1, format })).toBeUndefined();
  });

  test("references extend domains, keep zero and include their labels in the padding", () => {
    const plain = parse({ kind: "bar", title: "B", data: [{ label: "A", value: 2 }] });
    const input = parse({ ...plain, references: [{ value: 100000000 }] });
    const options = cloudAiChartRenderOptions(input, "en");
    const before = cloudAiChartRenderOptions(plain, "en");
    if (options.kind !== "bar" || before.kind !== "bar") throw new Error("Expected bar");
    expect(options.yAxis?.domain?.[0]).toBeLessThanOrEqual(0);
    expect(options.yAxis?.domain?.[1]).toBeGreaterThanOrEqual(100000000);
    expect(typeof options.padding === "object" && options.padding.left).toBeGreaterThan(
      typeof before.padding === "object" ? before.padding.left! : 0,
    );
    expect(charts.bar({ ...options, inspect: true })).toContain("stdlib-chart-reference");
    for (const kind of ["line", "scatter"] as const) {
      const dateInput = parse({
        kind,
        title: "D",
        series: [
          {
            data: [
              { x: "2026-01-01", y: 1 },
              { x: "2026-01-02", y: 2 },
            ],
          },
        ],
        references: [{ axis: "x", value: "2026-02-01" }, { value: 10 }],
      });
      const mapped = cloudAiChartRenderOptions(dateInput, "en");
      if (mapped.kind !== "line" && mapped.kind !== "scatter") throw new Error("Expected series chart");
      expect(mapped.xAxis?.domain?.[1]).toBeGreaterThanOrEqual(chartDateTime("2026-02-01")!);
      expect(mapped.references?.[0]?.value).toBe(chartDateTime("2026-02-01"));
    }
    const histogram = cloudAiChartRenderOptions(
      parse({ kind: "histogram", title: "H", data: [1, 2, 3], references: [{ axis: "x", value: 10 }, { value: 20 }] }),
      "en",
    );
    if (histogram.kind !== "histogram") throw new Error("Expected histogram");
    expect(histogram.xAxis?.domain?.[1]).toBeGreaterThanOrEqual(10);
    expect(histogram.yAxis?.domain?.[0]).toBeLessThanOrEqual(0);
    expect(histogram.yAxis?.domain?.[1]).toBeGreaterThanOrEqual(20);
  });

  test("invalid references fail instead of disappearing", () => {
    const input = { kind: "bar", title: "B", data: [{ label: "A", value: 2 }] };
    expect(issues({ ...input, yAxis: { domain: [0, 3] }, references: [{ value: 10 }] })).toEqual([
      "Extend the y domain to include every reference.",
    ]);
    expect(issues({ ...input, yAxis: { scale: "log" }, references: [{ value: 0 }] })[0]).toContain("above zero");
    expect(issues({ ...input, references: [{ axis: "x", value: 1 }] })[0]).toContain("Use y references");
    expect(issues({ ...input, references: [{ value: "2026-01-01" }] })[0]).toContain("numbers for y references");
    expect(issues({ ...input, references: Array.from({ length: 9 }, () => ({ value: 1 })) })[0]).toContain("8 references");
    expect(
      issues({ kind: "scatter", title: "S", series: [{ data: [{ x: "2026-01-01", y: 1 }] }], references: [{ axis: "x", value: 1 }] })[0],
    ).toContain("dates for x references");
  });

  test("line style, comparison marks and outside legends use the same defaults", () => {
    const data = [
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ];
    const input = parse({
      kind: "line",
      title: "L",
      series: [{ data }, { data, role: "reference" }, { data, style: "dotted", role: "reference" }],
    });
    const mapped = cloudAiChartRenderOptions(input, "de", { legend: "outside" });
    if (mapped.kind !== "line") throw new Error("Expected line");
    expect(mapped.series.map((series) => series.lineStyle)).toEqual([undefined, "dashed", "dotted"]);
    expect(mapped.legend).toBe(false);
    expect(cloudAiChartLegend(input, "de")).toEqual([
      { label: "Datenreihe 1", color: 0, style: "solid" },
      { label: "Datenreihe 2", color: 1, style: "dashed", reference: true },
      { label: "Datenreihe 3", color: 2, style: "dotted", reference: true },
    ]);
    const datum = { index: 0, role: "point" as const, anchor: [0, 0] as [number, number], values: [] };
    // A line's comparison is dashed; only scatter points of a comparison series draw hollow.
    expect(cloudAiChartReferenceMark(input, { ...datum, seriesIndex: 1 })).toBe(false);
    const scatter = parse({
      ...input,
      kind: "scatter",
      series: input.kind === "line" ? input.series.map(({ style: _, ...series }) => series) : [],
    });
    expect(cloudAiChartReferenceMark(scatter, { ...datum, seriesIndex: 1 })).toBe(true);
    expect(cloudAiChartReferenceMark(scatter, datum)).toBe(false);
    expect(cloudAiChartLegend(parse({ ...input, legend: false }), "en")).toEqual([]);
    const bar = parse({ kind: "bar", title: "B", data: [{ label: "A", value: 1 }], colorByBar: true, legend: true });
    expect(cloudAiChartLegend(bar, "en")).toEqual([{ label: "A", color: 0 }]);
    const outside = cloudAiChartRenderOptions(bar, "en", { legend: "outside" });
    expect(outside.kind === "bar" && outside.legend).toBe(false);
    const pie = cloudAiChartRenderOptions(parse({ kind: "pie", title: "P", data: [{ label: "A", value: 1 }] }), "en", {
      legend: "outside",
    });
    expect(pie.kind === "pie" && pie.legend).toBe(true);
  });

  test("new kinds map options and every inspected datum to localized table rows", () => {
    const box = parse({
      kind: "boxplot",
      title: "B",
      data: [
        { label: "A", values: [1, 1, 1, 1, 20] },
        { label: "B", values: [2, 2, 2, 2, 30] },
      ],
      references: [{ value: 40 }],
    });
    const boxOptions = cloudAiChartRenderOptions(box, "en");
    expect(boxOptions.kind === "boxplot" && boxOptions.groups).toEqual(box.kind === "boxplot" ? box.data : []);
    const boxes = cloudAiChartTable(box, "de");
    expect(boxes.rows).toHaveLength(4);
    expect(new Set(boxes.rows.map((row) => row.key)).size).toBe(4);
    expect(boxes.rows[0]?.values).toMatchObject({ label: "A", count: 5, q1: 1, q2: 1, q3: 1, whiskerLow: 1, whiskerHigh: 1 });
    expect(boxes.columns.map((column) => column.label)).toContain("Median");
    expect(boxes.rows[1]?.values).toEqual({ label: "A", value: 20 });
    const heatmap = parse({
      kind: "heatmap",
      title: "H",
      data: [{ x: "A", y: "B", value: 0.21 }],
      format: { style: "percent" },
      min: 0,
      max: 1,
      showValues: true,
    });
    const heat = cloudAiChartRenderOptions(heatmap, "en");
    if (heat.kind !== "heatmap") throw new Error("Expected heatmap");
    expect(heat.format?.(0.21)).toBe("21%");
    expect(heat.showValues).toBe(true);
    expect(cloudAiChartTable(heatmap, "en").rows[0]?.cells).toEqual({ x: "A", y: "B", value: "21%" });
    const barGauge = parse({
      kind: "barGauge",
      title: "G",
      data: [{ label: "A", value: 3, min: 1, max: 5 }],
      thresholds: [{ value: 2 }, { value: 5 }],
      unit: "kg",
    });
    const bars = cloudAiChartRenderOptions(barGauge, "en");
    expect(bars.kind === "barGauge" && bars.thresholds).toEqual([{ value: 2 }, { value: 5 }]);
    expect(cloudAiChartTable(barGauge, "en").rows[0]?.cells).toEqual({ label: "A", value: "3 kg", min: "1 kg", max: "5 kg" });
    const stat = parse({
      kind: "stat",
      title: "S",
      value: 0.21,
      delta: 0.02,
      better: "down",
      sparkline: [0.1, 0.21],
      format: { style: "percent" },
    });
    const options = cloudAiChartRenderOptions(stat, "en");
    if (options.kind !== "stat") throw new Error("Expected stat");
    expect(options.trend).toBe("down");
    expect(options.label).toBe("");
    expect(options.deltaFormat?.(0.02)).toBe("2%");
    const stats = cloudAiChartTable(stat, "en");
    expect(stats.rows[0]?.cells).toEqual({ value: "21%", delta: "+2%" });
    expect(stats.rows).toHaveLength(3);
    expect(new Set(stats.rows.map((row) => row.key)).size).toBe(3);
    expect(stats.rows[1]?.cells).toEqual({ x: "1", y: "10%" });
    for (const [delta, better, trend] of [
      [-1, "down", "up"],
      [1, "up", "up"],
      [0, "up", "neutral"],
      [1, undefined, "neutral"],
    ] as const) {
      const mapped = cloudAiChartRenderOptions(parse({ kind: "stat", title: "S", value: 1, delta, better }), "en");
      expect(mapped.kind === "stat" && mapped.trend).toBe(trend);
    }
    for (const kind of ["pie", "donut"])
      expect(
        cloudAiChartTable(parse({ kind, title: "P", data: [{ label: "A", value: 0.21 }], format: { style: "percent" } }), "en").rows[0]
          ?.cells.value,
      ).toBe("21%");
  });

  test("thresholds, pairs, labels and marks stay within the shared drawing limits", () => {
    for (const thresholds of [[], [{ value: 2 }, { value: 1 }], [{ value: 101 }], Array.from({ length: 9 }, (_, value) => ({ value }))])
      expect(issues({ kind: "gauge", title: "G", value: 50, thresholds })).not.toEqual([]);
    expect(issues({ kind: "barGauge", title: "G", data: Array.from({ length: 9 }, () => ({ label: "A", value: 1 })) })).not.toEqual([]);
    expect(issues({ kind: "barGauge", title: "G", data: [{ label: "A".repeat(30), value: 1 }] })[0]).toBe(
      "Use bar gauge labels of at most 10 characters, or a bar chart for longer names.",
    );
    const cell = { x: "A", y: "B", value: 1 };
    expect(issues({ kind: "heatmap", title: "H", data: [cell, cell] })).toEqual(["Use each heatmap x/y pair once."]);
    const columns = ["North region", "South region", "East region", "West region"].map((x) => ({ x, y: "B", value: 1 }));
    expect(issues({ kind: "heatmap", title: "H", data: columns })).toEqual([
      "Use column labels of at most 8 characters for 4 columns, or swap x and y.",
    ]);
    expect(issues({ kind: "heatmap", title: "H", data: columns.map((cell) => ({ ...cell, x: cell.x.slice(0, 5) })) })).toEqual([]);
    const box = {
      kind: "boxplot",
      title: "B",
      data: [{ label: "A", values: Array.from({ length: CLOUD_AI_VIEW_MAX_MARKS + 1 }, () => 1) }],
    };
    expect(issues(box)[0]).toContain(`3841 marks; the limit is ${CLOUD_AI_VIEW_MAX_MARKS}`);
    for (const input of [
      { kind: "gauge", title: "G", value: 1 },
      { kind: "stat", title: "S", value: 1, sparkline: [1, 2] },
      { kind: "boxplot", title: "B", data: [{ label: "A", values: [1, 2, 3] }] },
    ])
      expect(cloudAiChartMarks(parse(input))).toBe(input.kind === "gauge" ? 1 : 3);
  });

  test("pixel-exact width uses full label room instead of narrow-column scaling", () => {
    const input = parse({
      kind: "bar",
      title: "B",
      data: Array.from({ length: 12 }, (_, value) => ({ label: `Month ${value}`, value: 1250000 })),
    });
    const narrow = cloudAiChartRenderOptions(input, "en"),
      wide = cloudAiChartRenderOptions(input, "en", { width: 480 });
    if (narrow.kind !== "bar" || wide.kind !== "bar" || typeof narrow.padding !== "object" || typeof wide.padding !== "object")
      throw new Error("Expected padding");
    expect(wide.padding.left!).toBeLessThan(narrow.padding.left!);
    expect(wide.data.filter((item) => item.label).length).toBeGreaterThan(narrow.data.filter((item) => item.label).length);
    const heat = cloudAiChartRenderOptions(parse({ kind: "heatmap", title: "H", data: [{ x: "A", y: "Long row label", value: 1 }] }), "en");
    if (heat.kind !== "heatmap") throw new Error("Expected heatmap");
    expect(typeof heat.padding === "object" && heat.padding.left).toBeGreaterThan(100);
  });
});

test("app and chat schemas share the output type but preserve separate limits", () => {
  const app = cloudAiAppChartSchema();
  const chat = cloudAiChartSchema();
  const series = Array.from({ length: 9 }, () => ({
    data: [
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ],
  }));
  for (const input of [
    { kind: "bar", title: "Empty", data: [] },
    { kind: "line", title: "Many", series },
    { kind: "bar", title: "Growing", data: Array.from({ length: 481 }, () => ({ label: "A", value: 1 })) },
    { kind: "line", title: "Single", series: [{ data: [{ x: 1, y: 1 }] }] },
  ]) {
    expect(app.safeParse(input).success).toBe(true);
    expect(chat.safeParse(input).success).toBe(false);
  }
  const parsed: CloudAiChartInput = app.parse({ kind: "bar", title: "  ", subtitle: "", data: [{ label: 2024, value: null }] });
  expect(parsed.title).toBe("  ");
  if (parsed.kind !== "bar") throw new Error("Expected bar");
  expect(parsed.data[0]?.label).toBe("2024");
  expect(Number.isNaN(parsed.data[0]?.value)).toBe(true);
});

test("app schemas remove list bounds while retaining finite structural configuration", () => {
  const schema = cloudAiAppChartSchema();
  const many = Array.from({ length: 1000 }, (_, value) => value);
  for (const input of [
    { kind: "gauge", value: 1, thresholds: [] },
    { kind: "gauge", value: 1, thresholds: many.map((value) => ({ value, label: value })), label: 2024, unit: "" },
    { kind: "barGauge", data: many.map((value) => ({ label: value, value })) },
    { kind: "heatmap", data: many.map((value) => ({ x: value, y: 1, value })) },
    { kind: "bar", data: [], references: many.map((value) => ({ value, label: value })) },
    { kind: "boxplot", data: [{ label: "A", values: many }] },
    { kind: "stat", value: 1, sparkline: many },
    { kind: "boxplot", data: [{ label: "A", values: Array.from({ length: CLOUD_AI_VIEW_MAX_MARKS + 1 }, () => 1) }] },
  ])
    expect(schema.safeParse({ title: "", ...input }).success).toBe(true);
  for (const input of [
    { kind: "bar", data: [], yAxis: { domain: [0] } },
    { kind: "bar", data: [], yAxis: { domain: [0, Infinity] } },
    { kind: "bar", data: [], yAxis: { ticks: 1 } },
    { kind: "bar", data: [], references: [{ value: NaN }] },
    { kind: "histogram", data: [], bins: [1] },
    { kind: "histogram", data: [], bins: 0 },
    { kind: "gauge", value: 1, min: Infinity },
    { kind: "gauge", value: 1, thresholds: [{ value: Infinity }] },
    { kind: "gauge", value: 1, label: Infinity },
  ])
    expect(schema.safeParse({ title: "", ...input }).success).toBe(false);
});

test("parse-only charts reject overlapping labels and suggest only fitting orientations", () => {
  const heatmap = (x: string[], y: string[]) => ({
    kind: "heatmap",
    title: "H",
    data: x.flatMap((x) => y.map((y) => ({ x, y, value: 1 }))),
  });
  const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const hours = Array.from({ length: 24 }, (_, hour) => `${hour}:00`);
  const columns = heatmap(hours, weekdays);
  const rows = heatmap(weekdays, hours);
  expect(parseCloudAiChartInput(columns)).toBeUndefined();
  expect(issues(columns)[0]).toContain("24 columns");
  expect(issues(columns)[0]).not.toContain("swap");
  expect(parseCloudAiChartInput(rows)).toBeUndefined();
  expect(issues(rows)[0]).toContain("at most 17 heatmap rows");
  expect(issues(rows)[0]).not.toContain("swap");
  const small = heatmap(["North region", "South region", "East region", "West region"], ["B"]);
  expect(parseCloudAiChartInput(small)).toBeUndefined();
  expect(issues(small)[0]).toContain("swap x and y");
  expect(parseCloudAiChartInput({ kind: "barGauge", title: "G", data: [{ label: "A".repeat(30), value: 1 }] })).toBeUndefined();
});

test("function formats replace their own axes before measuring the padding", () => {
  const histogram = parse({ kind: "histogram", title: "H", data: [1, 2, 3] });
  const plain = cloudAiChartRenderOptions(histogram, "en", { width: 480 });
  const y = (value: number) => `Long y label ${value}`;
  const x = (value: number) => `Long x label ${value}`;
  const yOnly = cloudAiChartRenderOptions(histogram, "en", { width: 480, formats: { y } });
  const both = cloudAiChartRenderOptions(histogram, "en", { width: 480, formats: { x, y } });
  if (plain.kind !== "histogram" || yOnly.kind !== "histogram" || both.kind !== "histogram") throw new Error("Expected histogram");
  expect(yOnly.xAxis?.format?.(1)).toBe(plain.xAxis?.format?.(1));
  expect(yOnly.yAxis?.format).toBe(y);
  expect(both.xAxis?.format).toBe(x);
  expect(both.yAxis?.format).toBe(y);
  if (typeof plain.padding !== "object" || typeof both.padding !== "object") throw new Error("Expected padding");
  expect(both.padding.left!).toBeGreaterThan(plain.padding.left!);
  expect(both.padding.right!).toBeGreaterThan(16);
  const stat = cloudAiChartRenderOptions(parse({ kind: "stat", title: "S", value: 1, delta: 2 }), "en", { formats: { value: y } });
  if (stat.kind !== "stat") throw new Error("Expected stat");
  expect(stat.format).toBe(y);
  expect(stat.deltaFormat).toBe(y);
});

describe("shared chart tooltip", () => {
  const tooltip = { label: "Umsatz", format: { style: "currency", currency: "EUR" } };
  test("names value and y columns before axis labels, including stat sparklines", () => {
    for (const input of [
      { kind: "bar", title: "B", data: [{ label: "Jan", value: 1200 }], yAxis: { label: "Axis", format: { decimals: 0 } } },
      { kind: "pie", title: "P", data: [{ label: "Jan", value: 1200 }] },
      { kind: "stat", title: "S", value: 1200, sparkline: [1200, 1500] },
      ...["line", "scatter"].map((kind) => ({
        kind,
        title: "L",
        series: [
          {
            data: [
              { x: 1, y: 1200 },
              { x: 2, y: 1500 },
            ],
          },
        ],
        yAxis: { label: "Axis" },
      })),
    ]) {
      const table = cloudAiChartTable(parse({ ...input, tooltip }), "de");
      const values = table.columns.filter((column) => column.id === "value" || column.id === "y");
      expect(values.length).toBeGreaterThan(0);
      for (const column of values) {
        expect(column.label).toBe("Umsatz");
        expect(table.rows.find((row) => row.values[column.id] === 1200)?.cells[column.id]).toBe("1.200,00\u00a0€");
      }
    }
  });

  test("appends the tooltip format unit and retains the kind's unit", () => {
    const tooltip = { format: { unit: "kWh", decimals: 1 } };
    for (const input of [
      { kind: "bar", title: "B", data: [{ label: "A", value: 1.5 }] },
      { kind: "gauge", title: "G", value: 1.5, unit: "used" },
      { kind: "barGauge", title: "G", data: [{ label: "A", value: 1.5, min: 1, max: 5 }], unit: "used" },
      { kind: "stat", title: "S", value: 1.5, delta: 1.5, sparkline: [1.5, 2], unit: "used" },
    ]) {
      const table = cloudAiChartTable(parse({ ...input, tooltip }), "de");
      expect(table.rows[0]?.cells.value).toBe(`1,5 kWh${"unit" in input ? " used" : ""}`);
      if (input.kind === "barGauge") expect(table.rows[0]?.cells).toMatchObject({ min: "1,0 kWh used", max: "5,0 kWh used" });
      if (input.kind === "stat") {
        expect(table.rows[0]?.cells.delta).toBe("+1,5 kWh");
        expect(table.rows[1]?.cells).toEqual({ x: "1", y: "1,5 kWh" });
      }
    }
  });

  test("formats box summaries and bin bounds, keeping counts, shares and category cells", () => {
    const tooltip = { label: "Measure", format: { decimals: 1, unit: "kg" } };
    const box = cloudAiChartTable(parse({ kind: "boxplot", title: "B", data: [{ label: "A", values: [1, 1, 1, 1, 20] }], tooltip }), "de");
    expect(box.rows[0]?.cells).toEqual({
      label: "A",
      count: "5",
      q1: "1,0 kg",
      q2: "1,0 kg",
      q3: "1,0 kg",
      whiskerLow: "1,0 kg",
      whiskerHigh: "1,0 kg",
    });
    expect(box.rows[1]?.cells).toEqual({ label: "A", value: "20,0 kg" });
    const histogram = cloudAiChartTable(parse({ kind: "histogram", title: "H", data: [1, 2, 3], bins: [1, 2, 4], tooltip }), "de");
    expect(histogram.rows[0]?.cells).toEqual({ from: "1,0 kg", to: "2,0 kg", count: "1" });
    const pie = cloudAiChartTable(parse({ kind: "pie", title: "P", data: [{ label: "A", value: 1 }], tooltip }), "de");
    expect(pie.rows[0]?.cells).toEqual({ label: "A", value: "1,0 kg", percent: "100\u00a0%" });
    const heat = cloudAiChartTable(parse({ kind: "heatmap", title: "H", data: [{ x: "A", y: "B", value: 1.5 }], tooltip }), "de");
    expect(heat.rows[0]?.cells).toEqual({ x: "A", y: "B", value: "1,5 kg" });
    expect(heat.columns.find((column) => column.id === "y")?.label).toBe("Y");
  });

  test("leaves render options, axis formats and drawn SVG unchanged", () => {
    for (const input of [
      { kind: "bar", title: "B", data: [{ label: "Jan", value: 1200 }], yAxis: { format: { decimals: 0 } }, showValues: true },
      {
        kind: "line",
        title: "L",
        series: [
          {
            data: [
              { x: 1, y: 1200 },
              { x: 2, y: 1500 },
            ],
          },
        ],
        yAxis: { label: "Axis" },
      },
    ]) {
      const withTooltip = parse({ ...input, tooltip });
      expect(withTooltip).toHaveProperty("tooltip", tooltip);
      const before = cloudAiChartRenderOptions(parse(input), "de");
      const after = cloudAiChartRenderOptions(withTooltip, "de");
      // Format callbacks are allocated per call; compare their output as well as every plain-data option.
      const comparable = (options: typeof before) =>
        JSON.parse(JSON.stringify(options, (_key, value) => (typeof value === "function" ? [0, 1.5, 1200].map(value) : value)));
      expect(comparable(after)).toEqual(comparable(before));
      if (before.kind === "bar" && after.kind === "bar") expect(charts.bar(after)).toEqual(charts.bar(before));
      else if (before.kind === "line" && after.kind === "line") expect(charts.line(after)).toEqual(charts.line(before));
      else throw new Error("Expected matching chart kinds");
    }
  });

  test("uses the first text column as title and the remaining columns as rows", () => {
    const columns = [
      { id: "label", label: "Category", numeric: false },
      { id: "value", label: "Umsatz", numeric: true },
      { id: "missing", label: "Other", numeric: true },
    ];
    const row = { key: "0:0", cells: { label: "Jan", value: "1.200,00\u00a0€" }, values: { label: "Jan", value: 1200 } };
    expect(cloudAiChartTooltip(columns, row)).toEqual({
      title: "Jan",
      rows: [
        { label: "Umsatz", value: "1.200,00\u00a0€" },
        { label: "Other", value: "" },
      ],
    });
    expect(cloudAiChartTooltip(columns.slice(1), row)).toEqual({
      title: undefined,
      rows: [
        { label: "Umsatz", value: "1.200,00\u00a0€" },
        { label: "Other", value: "" },
      ],
    });
    expect(cloudAiChartTooltip([], row)).toEqual({ title: undefined, rows: [] });
  });
});
