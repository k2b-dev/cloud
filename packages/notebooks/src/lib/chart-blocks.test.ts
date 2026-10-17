import { describe, expect, spyOn, test } from "bun:test";
import { cloudAiChartSchema } from "@k2b/cloud/ai/browser";
import * as prettyTable from "../frontend/lib/pretty-table";
import { evaluatePrettyTable, renderPrettyTableHtml } from "../frontend/lib/pretty-table";
import {
  CHART_MAX_BLOCKS,
  chartBlockFrame,
  notebookChartFrameHtml,
  parseNotebookChartBlocks,
  renderNotebookChartFigure,
} from "./chart-blocks";

const chart = (body: string) => `:::chart\n${body}\n:::`;
const inline = "type: bar\ntitle: Sales\ncolumns: [Month, Revenue]\nrows:\n  - [Jan, 12]\n  - [Feb, 18]\nx: Month\ny: Revenue";
const table =
  "@umsatz\n| Datum | Umsatz | Kosten |\n| --- | --- | --- |\n| 2026-01-01 | 1200 | =Umsatz / 2 |\n| 2026-02-01 | 1400 | =Umsatz / 2 |\n| Total | =SUM(Umsatz) | =SUM(Kosten) |\n\n";
const named = "type: line\ntitle: Umsatz 2026\ndata: @umsatz\nx: Datum\ny: [Umsatz, Kosten]";
const input = (markdown: string) => {
  const parsed = parseNotebookChartBlocks(markdown);
  expect(parsed.diagnostics).toEqual([]);
  expect(parsed.blocks).toHaveLength(1);
  return parsed.blocks[0]!.input;
};

describe("notebook chart mapping", () => {
  test("evaluates a named formula table once for twenty charts", () => {
    const evaluate = spyOn(prettyTable, "evaluatePrettyTable");
    try {
      const markdown =
        "@t\n| a | b | share |\n| --- | --- | --- |\n" +
        Array.from({ length: 480 }, (_, i) => `| ${i} | ${i + 1} | =b/SUM(b) |`).join("\n") +
        "\n\n" +
        Array.from({ length: 20 }, () => chart("type: bar\ntitle: Shares\ndata: @t\nx: a\ny: share")).join("\n");
      const result = parseNotebookChartBlocks(markdown);
      expect(result.diagnostics).toEqual([]);
      expect(result.blocks).toHaveLength(20);
      expect(evaluate).toHaveBeenCalledTimes(1);
    } finally {
      evaluate.mockRestore();
    }
  });

  test("uses evaluated table cells and excludes totals from every series", () => {
    expect(input(table + chart(named))).toEqual({
      kind: "line",
      title: "Umsatz 2026",
      xAxis: { label: "Datum" },
      series: [
        {
          label: "Umsatz",
          data: [
            { x: "2026-01-01", y: 1200 },
            { x: "2026-02-01", y: 1400 },
          ],
        },
        {
          label: "Kosten",
          data: [
            { x: "2026-01-01", y: 600 },
            { x: "2026-02-01", y: 700 },
          ],
        },
      ],
    });
  });

  test("maps inline rows to bars and defaults the value tooltip", () => {
    expect(input(chart(inline))).toEqual({
      kind: "bar",
      title: "Sales",
      data: [
        { label: "Jan", value: 12 },
        { label: "Feb", value: 18 },
      ],
      tooltip: { label: "Revenue" },
    });
  });

  test("keeps raw numeric-looking table labels and evaluates formula labels", () => {
    const source = "@t\n| Label | Value |\n| --- | --- |\n| 007 | 1.50 |\n| 1.50 | 2 |\n| =2+3 | 4 |\n\n";
    for (const type of ["bar", "pie", "donut"]) {
      const columns = type === "bar" ? "x: Label\ny: Value" : "label: Label\nvalue: Value";
      expect(input(source + chart(`type: ${type}\ntitle: Labels\ndata: @t\n${columns}`))).toMatchObject({
        data: [
          { label: "007", value: 1.5 },
          { label: "1.50", value: 2 },
          { label: "5", value: 4 },
        ],
      });
    }
    for (const type of ["line", "scatter"]) {
      expect(input(source + chart(`type: ${type}\ntitle: Numbers\ndata: @t\nx: Label\ny: Value`))).toMatchObject({
        series: [
          {
            data: [
              { x: 7, y: 1.5 },
              { x: 1.5, y: 2 },
              { x: 5, y: 4 },
            ],
          },
        ],
      });
    }
  });

  test("maps a named list to pie with implicit columns", () => {
    expect(input("@sales\n- Jan: 12\n- Feb: 18\n\n" + chart("type: pie\ntitle: Sales\ndata: @sales"))).toEqual({
      kind: "pie",
      title: "Sales",
      data: [
        { label: "Jan", value: 12 },
        { label: "Feb", value: 18 },
      ],
    });
  });

  test("maps a named data key to stat and humanizes its label", () => {
    const result = input(
      "@sales\n:::data\nrevenue: 1200\nowner: Ada\n:::\n\n" +
        chart("type: stat\ntitle: Revenue\ndata: @sales\nvalue: revenue\ntooltip:\n  format: EUR\n  unit: net"),
    );
    expect(result).toMatchObject({
      kind: "stat",
      value: 1200,
      format: { style: "currency", currency: "EUR", unit: "net" },
      tooltip: { format: { style: "currency", currency: "EUR", unit: "net" } },
    });
    expect(result.tooltip?.label).toBeTruthy();
  });

  test("stat uses the last table value and the same column as its sparkline", () => {
    expect(input(table + chart("type: stat\ntitle: Costs\ndata: @umsatz\nvalue: Kosten"))).toMatchObject({
      kind: "stat",
      value: 700,
      sparkline: [600, 700],
      tooltip: { label: "Kosten" },
    });
    expect(input(chart("type: stat\ntitle: One number\nvalue: 42"))).toMatchObject({ kind: "stat", value: 42 });
  });

  test("the requested area example uses the chart contract and tooltip format", () => {
    expect(input(table + chart(named.replace("type: line", "type: area") + "\ntooltip:\n  label: Betrag\n  format: EUR"))).toMatchObject({
      kind: "line",
      area: true,
      tooltip: { label: "Betrag", format: { style: "currency", currency: "EUR" } },
    });
  });

  test("plain numbers use the formula engine's full-cell rule", () => {
    const markdown =
      "@numbers\n| X | Y |\n| --- | --- |\n| 1 | +1.2e2 |\n| 2 | .5 |\n\n" +
      chart("type: line\ntitle: Numbers\ndata: @numbers\nx: X\ny: Y");
    expect(input(markdown)).toMatchObject({
      series: [
        {
          data: [
            { x: 1, y: 120 },
            { x: 2, y: 0.5 },
          ],
        },
      ],
    });
    expect(parseNotebookChartBlocks(markdown.replace("+1.2e2", "120 EUR")).diagnostics[0]).toMatchObject({
      code: "not-a-number",
      params: { name: "Y", row: 1 },
    });
  });

  test("the shared evaluated table and rendered formula agree", () => {
    const data = { headers: ["Revenue", "Cost"], rows: [["1200", "=Revenue / 2"]] };
    expect(evaluatePrettyTable(data)[0]?.cells[1]?.result).toEqual({ kind: "ok", value: 600 });
    expect(renderPrettyTableHtml(data, { locale: "en" })).toContain('class="ti ti-math-function"></i>600');
  });
});

describe("chart diagnostics point to the authored setting", () => {
  test("missing columns reports only the missing key", () => {
    expect(parseNotebookChartBlocks(chart(inline.replace("columns: [Month, Revenue]\n", ""))).diagnostics).toEqual([
      { code: "missing-key", line: 1, path: "chart.columns" },
    ]);
  });

  test("nested contract issues point at the tooltip entry once", () => {
    for (const body of [inline, "type: stat\ntitle: Revenue\nvalue: 42"]) {
      for (const field of ["unit", "label"]) {
        const markdown = chart(body + `\ntooltip:\n  format: EUR\n  ${field}: ${"x".repeat(201)}`);
        expect(parseNotebookChartBlocks(markdown).diagnostics).toEqual([
          { code: "chart-unsupported", line: markdown.split("\n").length - 1, path: `chart.tooltip.${field}` },
        ]);
      }
    }
  });

  test("a named data source with errors reports invalid-source at data", () => {
    const markdown =
      "@sales\n:::data\nrevenue: 12\nrevenue: 18\n:::\n\n" + chart("type: stat\ntitle: Revenue\ndata: @sales\nvalue: revenue");
    expect(parseNotebookChartBlocks(markdown).diagnostics).toEqual([
      { code: "invalid-source", line: 10, path: "chart.data", params: { name: "sales" } },
    ]);
  });

  test("a stat's existing non-numeric data key reports not-a-number at value", () => {
    for (const value of ["Ada", '"007"', "true"]) {
      const markdown =
        `@sales\n:::data\nrevenue: 12\nowner: ${value}\n:::\n\n` + chart("type: stat\ntitle: Owner\ndata: @sales\nvalue: owner");
      expect(parseNotebookChartBlocks(markdown).diagnostics).toEqual([
        { code: "not-a-number", line: 11, path: "chart.value", params: { name: "owner", row: 2 } },
      ]);
    }
  });

  test("implicit chart rows exclude non-numeric data entries", () => {
    const source = '@sales\n:::data\nowner: Ada\nrevenue: 12\ncode: "007"\nactive: true\nprofit: 5\n:::\n\n';
    for (const type of ["bar", "pie", "donut"]) {
      const result = input(source + chart(`type: ${type}\ntitle: Sales\ndata: @sales`));
      expect(result).toMatchObject({ data: [{ value: 12 }, { value: 5 }] });
      if (result.kind === "bar" || result.kind === "pie" || result.kind === "donut") expect(result.data).toHaveLength(2);
    }
    expect(input(source + chart("type: stat\ntitle: Profit\ndata: @sales\nvalue: profit"))).toMatchObject({ value: 5 });
  });

  for (const [body, code, line, path] of [
    [inline + "\nwat: nope", "unknown-key", 10, "chart.wat"],
    [inline.replace("title: Sales\n", ""), "missing-key", 1, "chart.title"],
    ["type: bar\ntitle: Missing\ndata: @nope\nx: X\ny: Y", "unknown-block", 4, "chart.data"],
    [inline.replace("y: Revenue", "y: [Revenue, Month]"), "chart-one-series", 9, "chart.y"],
    [inline.replace("type: bar", "type: line"), "chart-x-type", 8, "chart.x"],
    [inline + "\ntitle: Repeated", "duplicate-key", 10, "chart.title"],
    [inline.replace("[Feb, 18]", "[Feb]"), "invalid-type", 7, "chart.rows.1"],
    [inline + "\ndata: @nope", "invalid-type", 10, "chart.data"],
  ] as const) {
    test(`${code} at ${path}:${line}`, () => {
      expect(parseNotebookChartBlocks(chart(body)).diagnostics).toContainEqual(expect.objectContaining({ code, line, path }));
      expect(parseNotebookChartBlocks(chart(body)).blocks).toEqual([]);
    });
  }
  test("unknown y column preserves its name and exact note line", () => {
    const markdown = table + chart(named.replace("Kosten]", "Kosen]"));
    expect(parseNotebookChartBlocks(markdown).diagnostics).toEqual([
      { code: "unknown-column", line: 13, path: "chart.y", params: { name: "Kosen" } },
    ]);
  });
  test("a formula failure in a used cell is a numeric diagnostic", () => {
    expect(parseNotebookChartBlocks(table.replace("=Umsatz / 2", "=1 / 0") + chart(named)).diagnostics[0]).toMatchObject({
      code: "not-a-number",
      line: 13,
      params: { name: "Kosten", row: 1 },
    });
  });
  test("inline rows stop at the 481st row and report its line", () => {
    const markdown = chart(
      "type: bar\ntitle: Too many\ncolumns: [X, Y]\nrows:\n" +
        Array.from({ length: 485 }, (_, i) => `  - [${i}, ${i}]`).join("\n") +
        "\nx: X\ny: Y",
    );
    expect(parseNotebookChartBlocks(markdown).diagnostics).toEqual([
      { code: "too-many-items", line: 486, path: "chart.rows.480", params: { limit: 480 } },
    ]);
  });
  test("a named table over budget reports the data line", () => {
    const markdown =
      "@many\n| X | Y |\n| --- | --- |\n" +
      Array.from({ length: 481 }, (_, i) => `| ${i} | ${i} |`).join("\n") +
      "\n\n" +
      chart("type: bar\ntitle: Too many\ndata: @many\nx: X\ny: Y");
    expect(parseNotebookChartBlocks(markdown).diagnostics).toEqual([
      { code: "too-many-items", line: 489, path: "chart.data", params: { limit: 480 } },
    ]);
  });
  test("unclosed charts remain source", () => {
    expect(parseNotebookChartBlocks(`:::chart\n${inline}`).diagnostics).toContainEqual({ code: "unclosed-block", line: 1, path: "chart" });
  });
  test("every block after the twentieth is over budget", () => {
    const markdown = Array.from({ length: CHART_MAX_BLOCKS + 2 }, () => chart("type: stat\ntitle: Value\nvalue: 12")).join("\n");
    const result = parseNotebookChartBlocks(markdown);
    expect(result.blocks).toHaveLength(20);
    expect(result.diagnostics).toEqual([101, 106].map((line) => ({ code: "too-many-items", line, path: "chart" })));
  });
  test("contract failures are owned diagnostics, never contract text", () => {
    expect(
      parseNotebookChartBlocks(chart("type: pie\ntitle: Negative\ncolumns: [X, Y]\nrows:\n  - [A, -1]\nlabel: X\nvalue: Y")).diagnostics[0],
    ).toMatchObject({ code: "chart-unsupported", line: 5 });
    expect(
      parseNotebookChartBlocks(chart("type: pie\ntitle: Empty\ncolumns: [X, Y]\nrows:\n  - [A, 0]\nlabel: X\nvalue: Y")).diagnostics[0]
        ?.code,
    ).toBe("chart-unsupported");
  });
});

test("frame placeholders reuse the figure header and escape authored text", () => {
  const frame = chartBlockFrame(["type: bar", "title: <b>Sales</b>", "subtitle: Draft"]);
  expect(frame).toEqual({ kind: "bar", title: "<b>Sales</b>", subtitle: "Draft" });
  expect(frame && notebookChartFrameHtml(frame, "")).toContain("&lt;b&gt;Sales&lt;/b&gt;");
  expect(chartBlockFrame(["type: nope", "title: Sales"])).toBeNull();
  expect(chartBlockFrame(["type: bar"])).toBeNull();
  const figure = renderNotebookChartFigure(input(chart(inline)), "en");
  expect(figure).toContain("<svg");
  expect(figure).toMatch(/<title>[^<]*Revenue[^<]*12/);
});

test("timestamp list labels keep their colons for the x column", () => {
  const result = input("@sales\n- 2026-01-01T10:30: 12\n- 2026-01-01T11:30:00: 18\n\n" + chart("type: line\ntitle: Sales\ndata: @sales"));
  expect(result).toMatchObject({
    kind: "line",
    series: [
      {
        data: [
          { x: "2026-01-01T10:30", y: 12 },
          { x: "2026-01-01T11:30:00", y: 18 },
        ],
      },
    ],
  });
});

test("frame uses the same quoted types and header limits as the parser", () => {
  expect(chartBlockFrame(['type: "bar"', 'title: " Sales "'])).toEqual({ kind: "bar", title: "Sales" });
  expect(chartBlockFrame(["type: bar", "title: " + "x".repeat(161)])).toBeNull();
  expect(chartBlockFrame(["type: bar", "title: Sales", 'subtitle: ""'])).toBeNull();
});

test("a bad column reports its first row once, not one diagnostic per row", () => {
  const diagnostics = parseNotebookChartBlocks(chart(inline.replace("type: bar", "type: line"))).diagnostics;
  expect(diagnostics.filter((entry) => entry.code === "chart-x-type")).toEqual([
    { code: "chart-x-type", line: 8, path: "chart.x", params: { name: "Month" } },
  ]);
  expect(input("@sales\n- 1: 12\n- 2: 18\n\n" + chart("type: line\ntitle: Sales\ndata: @sales"))).not.toHaveProperty("xAxis");
});

test("a name shared by two blocks is a diagnostic, never an arbitrary pick", () => {
  const markdown =
    "@sales\n:::data\nrevenue: 12\n:::\n\n@sales\n:::data\nrevenue: 999\n:::\n\n" +
    chart("type: stat\ntitle: Revenue\ndata: @sales\nvalue: revenue");
  expect(parseNotebookChartBlocks(markdown).diagnostics).toEqual([
    { code: "duplicate-block", line: 14, path: "chart.data", params: { name: "sales" } },
  ]);
});

test("one chart can be read alone, still within the note's block budget", () => {
  const markdown = Array.from({ length: CHART_MAX_BLOCKS + 1 }, () => chart("type: stat\ntitle: Value\nvalue: 12")).join("\n");
  expect(parseNotebookChartBlocks(markdown, { line: 6 }).blocks.map((block) => block.line)).toEqual([6]);
  expect(parseNotebookChartBlocks(markdown, { line: 101 })).toEqual({
    blocks: [],
    diagnostics: [{ code: "too-many-items", line: 101, path: "chart" }],
  });
});

test("drawn figures reserve controls and carry a validated, escaped chart payload", () => {
  const title = 'Sales "quoted" <total> & profit';
  const label = 'Jan "quoted" <label> & costs';
  const parsed = input(
    chart(`type: bar
title: ${JSON.stringify(title)}
columns: [Month, Revenue]
rows:
  - [${JSON.stringify(label)}, 12]
x: Month
y: Revenue`),
  );
  const html = renderNotebookChartFigure(parsed, "de")!;
  expect(html).toContain('<div class="notebook-book-chart__actions"></div>');
  const attribute = /<figure\b[^>]* data-chart="([^"]*)"/.exec(html)?.[1];
  expect(attribute).toBeDefined();
  expect(attribute).toContain("&quot;");
  expect(attribute).toContain("&lt;");
  expect(attribute).toContain("&amp;");
  // Decode one HTML entity layer, like an HTML attribute parser. Do not decode recursively.
  const entities: Record<string, string> = { quot: '"', amp: "&", lt: "<", gt: ">", "#39": "'", "#x27": "'" };
  const json = attribute!.replace(/&(quot|amp|lt|gt|#39|#x27);/g, (_, entity: string) => entities[entity]!);
  const payload = JSON.parse(json);
  expect(cloudAiChartSchema().parse(payload)).toEqual(parsed);
  expect(payload).toEqual(parsed);
  expect(payload.title).toBe(title);
  expect(payload.data[0].label).toBe(label);
});
