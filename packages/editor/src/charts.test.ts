import { describe, expect, test } from "bun:test";
import { type ChartDatum, charts } from "@k2b/stdlib";
import { isChartDatum } from "@k2b/ui/chart-inspection";
import { barChartLayout, renderBarChartSvg } from "@k2b/ui/charts";
import {
  type ChartInput,
  chartKinds,
  chartMarkKey,
  chartRenderOptions,
  chartRows,
  chartTable,
  chartTooltip,
  checkChartLabels,
} from "./charts";

// Preserve the renderer fixtures' bounded data shape; AI policy assertions remain in Cloud.
const schema = chartKinds({ maxSeries: 8, maxValues: 480, maxMarks: 3840 });
const parse = (input: unknown): ChartInput => schema.parse(input);
const chartDatums = (svg: string): ChartDatum[] =>
  [...svg.matchAll(/data-chart-datum="([^"]*)"/g)].map((match) => {
    const datum: unknown = JSON.parse(match[1]!.replaceAll("&quot;", '"'));
    if (!isChartDatum(datum)) throw new Error("Invalid chart datum");
    return datum;
  });

describe("chart table", () => {
  test("has the same labels in every locale", () => {
    expect(checkChartLabels()).toEqual([]);
  });

  test("lists bars with exact values in the reader's language", () => {
    const table = chartTable(
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
    const days = chartTable(
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
    const times = chartTable(parse({ kind: "scatter", title: "Load", series: [{ data: [{ x: "2026-01-01T23:30", y: 1 }] }] }), "de");
    expect(times.rows[0]!.cells.x).toBe("01.01.2026, 23:30");
    // Points a second apart stay apart in the table.
    const seconds = chartTable(
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
    const table = chartTable(
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
    const rows = chartRows(input, "de");
    const { kind, ...options } = chartRenderOptions(input, "de");
    const svg = (charts[kind] as (value: object) => string)({ ...options, width: 480, height: 280, inspect: true });
    for (const match of svg.matchAll(/data-chart-datum="([^"]*)"/g)) rows.add(JSON.parse(match[1]!.replaceAll("&quot;", '"')));
    expect(rows.table()).toEqual(chartTable(input, "de"));
    expect(rows.table().rows.map((row) => row.key)).toEqual([chartMarkKey({ index: 0 }), chartMarkKey({ index: 1 })]);
  });

  test("lists what the chart draws: shares, bins and a gauge with its unit", () => {
    const pie = chartTable(
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
    const histogram = chartTable(parse({ kind: "histogram", title: "Times", data: [1, 2, 2, 3], bins: 2 }), "en");
    expect(histogram.columns.map((column) => column.id)).toEqual(["from", "to", "count"]);
    expect(histogram.rows.reduce((sum, row) => sum + Number(row.values.count), 0)).toBe(4);
    const gauge = chartTable(parse({ kind: "gauge", title: "Disk", value: 72, unit: "%" }), "en");
    expect(gauge.rows[0]!.cells).toEqual({ value: "72 %", min: "0 %", max: "100 %" });
  });
});

describe("chart render options", () => {
  test("make room for long tick labels and show a legend for several series", () => {
    const values = (y: number) => ({
      kind: "line",
      title: "Y",
      series: [
        {
          data: [
            { x: 1, y: 0 },
            { x: 2, y },
          ],
        },
      ],
    });
    const small = chartRenderOptions(parse(values(5)), "en");
    const large = chartRenderOptions(parse(values(1_250_000)), "de");
    const left = (options: typeof small) => ("padding" in options && typeof options.padding === "object" ? (options.padding.left ?? 0) : 0);
    expect(left(large)).toBeGreaterThan(left(small));
    const two = (locale: string) =>
      chartRenderOptions(
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
    const pie = chartRenderOptions(parse({ kind: "pie", title: "Share", data: [{ label: "A", value: 1 }] }), "en");
    expect(pie.kind === "pie" && pie.legend).toBe(true);
  });

  test("label every long category in a bar row and print its value, like the table", () => {
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
    const options = chartRenderOptions(input, "en");
    if (options.kind !== "bar") throw new Error("Expected bar");
    const layout = barChartLayout(options);
    expect(layout.layout).toBe("rows");
    const svg = renderBarChartSvg({ ...options, width: 480, height: layout.height });
    const labels = [...svg.matchAll(/stdlib-chart-category-label"[^>]*>([^<]*)</g)].map((match) => match[1]);
    expect(labels).toEqual(months.map((label) => `${label} 2026`));
    expect([...svg.matchAll(/stdlib-chart-bar-value"[^>]*>([^<]*)</g)].map((match) => match[1])).toEqual(
      months.map((_, value) => `${value}`),
    );
    expect(chartTable(input, "en").rows.map((row) => row.cells.label)).toEqual(months.map((label) => `${label} 2026`));
  });
});

describe("chart axes", () => {
  const ticks = (input: unknown, anchor: "end" | "middle") => {
    const { kind, ...options } = chartRenderOptions(parse(input), "en");
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

test("function formats replace their own axes before measuring the padding", () => {
  const histogram = parse({ kind: "histogram", title: "H", data: [1, 2, 3] });
  const plain = chartRenderOptions(histogram, "en", { width: 480 });
  const y = (value: number) => `Long y label ${value}`;
  const x = (value: number) => `Long x label ${value}`;
  const yOnly = chartRenderOptions(histogram, "en", { width: 480, formats: { y } });
  const both = chartRenderOptions(histogram, "en", { width: 480, formats: { x, y } });
  if (plain.kind !== "histogram" || yOnly.kind !== "histogram" || both.kind !== "histogram") throw new Error("Expected histogram");
  expect(yOnly.xAxis?.format?.(1)).toBe(plain.xAxis?.format?.(1));
  expect(yOnly.yAxis?.format).toBe(y);
  expect(both.xAxis?.format).toBe(x);
  expect(both.yAxis?.format).toBe(y);
  if (typeof plain.padding !== "object" || typeof both.padding !== "object") throw new Error("Expected padding");
  expect(both.padding.left!).toBeGreaterThan(plain.padding.left!);
  expect(both.padding.right!).toBeGreaterThan(16);
  const stat = chartRenderOptions(parse({ kind: "stat", title: "S", value: 1, delta: 2 }), "en", { formats: { value: y } });
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
      const table = chartTable(parse({ ...input, tooltip }), "de");
      const values = table.columns.filter((column) => column.id === "value" || column.id === "y");
      expect(values.length).toBeGreaterThan(0);
      for (const column of values) {
        expect(column.label).toBe("Umsatz");
        expect(table.rows.find((row) => row.values[column.id] === 1200)?.cells[column.id]).toBe("1.200\u00a0€");
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
      const table = chartTable(parse({ ...input, tooltip }), "de");
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
    const box = chartTable(parse({ kind: "boxplot", title: "B", data: [{ label: "A", values: [1, 1, 1, 1, 20] }], tooltip }), "de");
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
    const histogram = chartTable(parse({ kind: "histogram", title: "H", data: [1, 2, 3], bins: [1, 2, 4], tooltip }), "de");
    expect(histogram.rows[0]?.cells).toEqual({ from: "1,0 kg", to: "2,0 kg", count: "1" });
    const pie = chartTable(parse({ kind: "pie", title: "P", data: [{ label: "A", value: 1 }], tooltip }), "de");
    expect(pie.rows[0]?.cells).toEqual({ label: "A", value: "1,0 kg", percent: "100\u00a0%" });
    const heat = chartTable(parse({ kind: "heatmap", title: "H", data: [{ x: "A", y: "B", value: 1.5 }], tooltip }), "de");
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
      const before = chartRenderOptions(parse(input), "de");
      const after = chartRenderOptions(withTooltip, "de");
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
    expect(chartTooltip(columns, row)).toEqual({
      title: "Jan",
      rows: [{ label: "Umsatz", value: "1.200,00\u00a0€" }],
    });
    expect(chartTooltip(columns.slice(1), row)).toEqual({
      title: undefined,
      rows: [{ label: "Umsatz", value: "1.200,00\u00a0€" }],
    });
    expect(chartTooltip(columns, { ...row, cells: { ...row.cells, missing: "" } })).toEqual({
      title: "Jan",
      rows: [
        { label: "Umsatz", value: "1.200,00\u00a0€" },
        { label: "Other", value: "" },
      ],
    });
    expect(chartTooltip([], row)).toEqual({ title: undefined, rows: [] });
  });

  test("stat sparkline tooltips omit the stat value and delta columns", () => {
    const input = parse({ kind: "stat", title: "S", value: 5, delta: 1, sparkline: [1, 2, 3] });
    const options = chartRenderOptions(input, "de");
    if (options.kind !== "stat") throw new Error("Expected stat");
    const rows = chartRows(input, "de");
    const marks = chartDatums(charts.stat({ ...options, width: 480, height: 280, inspect: true }));
    const added = marks.map((datum) => ({ datum, row: rows.add(datum) }));
    const point = added.find(({ datum }) => datum.role === "point" && datum.index === 0);
    if (!point) throw new Error("Missing sparkline point");
    expect(chartTooltip(rows.columns(), point.row)).toEqual({
      title: undefined,
      rows: [
        { label: "#", value: "1" },
        { label: "Wert", value: "1" },
      ],
    });
    expect(rows.table()).toEqual(chartTable(input, "de"));
  });

  test("boxplot outlier tooltips omit summary columns", () => {
    const input = parse({ kind: "boxplot", title: "B", data: [{ label: "A", values: [1, 1, 1, 1, 20] }] });
    const options = chartRenderOptions(input, "de");
    if (options.kind !== "boxplot") throw new Error("Expected boxplot");
    const rows = chartRows(input, "de");
    const marks = chartDatums(charts.boxplot({ ...options, width: 480, height: 280, inspect: true }));
    const added = marks.map((datum) => ({ datum, row: rows.add(datum) }));
    const outlier = added.find(({ datum }) => datum.role === "outlier");
    if (!outlier) throw new Error("Missing outlier");
    expect(chartTooltip(rows.columns(), outlier.row)).toEqual({ title: "A", rows: [{ label: "Wert", value: "20" }] });
    expect(rows.table()).toEqual(chartTable(input, "de"));
  });
});

describe("function formats in chart rows", () => {
  const datum: ChartDatum = {
    index: 0,
    role: "point",
    anchor: [0, 0],
    values: [
      { key: "x", value: 1 },
      { key: "y", value: 1200 },
    ],
  };
  const input = parse({
    kind: "line",
    title: "Energy",
    series: [
      {
        data: [
          { x: 1, y: 1200 },
          { x: 2, y: 900 },
        ],
      },
    ],
  });
  const x = (v: number) => `day ${v}`;
  const y = (v: number) => `${v} kWh`;
  const value = (v: number) => `${v} units`;

  test("uses x and y functions for table and tooltip cells, with value taking precedence", () => {
    const rows = chartRows(input, "de", { formats: { x, y } });
    const row = rows.add(datum);
    expect(row.cells).toEqual({ x: "day 1", y: "1200 kWh" });
    expect(chartTooltip(rows.columns(), row)).toEqual({
      title: undefined,
      rows: [
        { label: "X", value: "day 1" },
        { label: "Y", value: "1200 kWh" },
      ],
    });
    expect(chartRows(input, "de", { formats: { y, value } }).add(datum).cells.y).toBe("1200 units");
    const bar = parse({ kind: "bar", title: "Energy", data: [{ label: "Jan", value: 1200 }] });
    expect(
      chartRows(bar, "de", { formats: { y } }).add({ ...datum, role: "item", values: [{ key: "value", value: 1200 }] }).cells.value,
    ).toBe("1200 kWh");
  });

  test("explicit tooltip format wins over functions without changing x cells", () => {
    const rows = chartRows({ ...input, tooltip: { format: { style: "currency", currency: "EUR" } } }, "de", {
      formats: { x, y, value },
    });
    expect(rows.add(datum).cells).toEqual({ x: "day 1", y: "1.200\u00a0€" });
  });

  test("histogram bounds use x functions and counts follow the count axis", () => {
    const input = parse({
      kind: "histogram",
      title: "Bins",
      data: [1, 2, 3],
      bins: [1, 2, 4],
      tooltip: { format: { unit: "kg", decimals: 1 } },
    });
    const datum: ChartDatum = {
      index: 0,
      role: "bin",
      anchor: [0, 0],
      values: [
        { key: "from", value: 1 },
        { key: "to", value: 2 },
        { key: "count", value: 1 },
      ],
    };
    expect(chartRows(input, "de", { formats: { x, y, value } }).add(datum).cells).toEqual({
      from: "day 1",
      to: "day 2",
      count: "1 kWh",
    });
    expect(chartRows(input, "de").add(datum).cells).toEqual({ from: "1,0 kg", to: "2,0 kg", count: "1" });
  });

  test("histogram y functions format counts without formatting bounds", () => {
    const input = parse({ kind: "histogram", title: "Bins", data: [1, 1, 3], bins: [1, 2, 4] });
    const options = chartRenderOptions(input, "de");
    if (options.kind !== "histogram") throw new Error("Expected histogram");
    const datum = chartDatums(charts.histogram({ ...options, width: 480, height: 280, inspect: true })).find(
      (datum) => datum.role === "bin" && datum.index === 0,
    );
    if (!datum) throw new Error("Missing histogram bin");
    const y = (v: number) => `${v} Stk.`;
    expect(chartRows(input, "de", { formats: { y } }).add(datum).cells).toEqual({ from: "1", to: "2", count: "2 Stk." });
    expect(chartRows(input, "de", { formats: { x, y } }).add(datum).cells).toEqual({
      from: "day 1",
      to: "day 2",
      count: "2 Stk.",
    });
    expect(chartRows(input, "de", { formats: { y, value } }).add(datum).cells).toEqual({
      from: "1 units",
      to: "2 units",
      count: "2 Stk.",
    });
  });

  test("omitting function formats preserves declarative output", () => {
    expect(chartRows(input, "de", {}).add(datum)).toEqual(chartRows(input, "de").add(datum));
    const spark = parse({ kind: "sparkline", title: "Trend", data: [1, 2] });
    expect(chartRows(spark, "de").add(datum).cells.x).toBe("2");
    // A sparkline's x is its position, never a formatted axis value.
    expect(chartRows(spark, "de", { formats: { x } }).add(datum).cells.x).toBe("2");
  });
});
