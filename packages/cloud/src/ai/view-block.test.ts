import { describe, expect, test } from "bun:test";
import {
  CLOUD_AI_TABLE_MAX_ROWS,
  type CloudAiTableView,
  checkCloudAiView,
  cloudAiTableTsv,
  cloudAiViewSummary,
  cloudAiViewTable,
  isAiViewFile,
  isAiViewPath,
  parseCloudAiView,
} from "./view-block";

const table = {
  view: "table",
  title: "Prices",
  columns: [
    { id: "price", type: "number" },
    { id: "name", type: "text" },
  ],
  rows: [{ price: 12.5, name: "A" }, { name: "B" }],
};
const issues = (value: unknown) => {
  const checked = checkCloudAiView(value);
  if (!("issues" in checked)) throw new Error("Expected rejection");
  return checked.issues.join("; ");
};

describe("declarative views", () => {
  test("accepts the chart tool contract and summaries contain no values", () => {
    const chart = parseCloudAiView({ view: "chart", kind: "bar", title: "Sales", data: [{ label: "A", value: 4 }] });
    expect(chart).toBeDefined();
    if (!chart) throw new Error("Missing chart");
    expect(checkCloudAiView(chart)).toEqual({ view: chart });
    expect(cloudAiViewSummary(chart)).toEqual({ view: "chart", kind: "bar", title: "Sales" });
    const parsed = parseCloudAiView(table);
    if (!parsed) throw new Error("Missing table");
    expect(cloudAiViewSummary(parsed)).toEqual({ view: "table", title: "Prices", rows: 2, columns: 2, footer: false });
  });
  test("reads without drawing but rejects an impossible drawing on write", () => {
    const view = { view: "chart", kind: "bar", title: "Outside", data: [{ label: "A", value: 9 }], yAxis: { domain: [0, 1] } };
    expect(parseCloudAiView(view)).toBeDefined();
    expect(issues(view)).toContain("chart:");
  });
  test.each([
    [{ columns: [] }, "columns"],
    [{ columns: Array.from({ length: 101 }, (_, i) => ({ id: String(i), type: "text" })) }, "100"],
    [{ rows: Array.from({ length: CLOUD_AI_TABLE_MAX_ROWS + 1 }, () => ({})) }, "3840"],
    [
      {
        columns: [
          { id: "price", type: "number" },
          { id: "price", type: "text" },
        ],
      },
      "columns[1].id",
    ],
    [{ columns: [{ id: "", type: "text" }] }, "columns[0].id"],
    [{ columns: [{ id: "a".repeat(81), type: "text" }] }, "80"],
    [{ columns: [{ id: "price", type: "text", label: "" }] }, "label"],
    [{ rows: [{ unknown: 1 }] }, "rows[0].unknown"],
    [{ rows: [{ price: "12" }] }, "rows[0].price: Expected a number or null."],
    [{ footer: { price: "12" } }, "footer.price"],
    [{ rows: [{ price: Infinity }] }, "rows[0].price"],
    [{ rows: [{ name: true }] }, "rows[0].name"],
    [{ sort: { column: "missing", direction: "asc" } }, "sort.column"],
    [{ title: "" }, "title"],
    [{ subtitle: "x".repeat(301) }, "300"],
  ])("rejects table rules with paths: %j", (change, path) => {
    expect(issues({ ...table, ...change })).toContain(path);
  });
  test.each([
    ["date", "2026-02-30"],
    ["date", "2026-01-01T00:00"],
    ["datetime", "2026-01-01"],
    ["datetime", "2026-01-01T25:00"],
    ["datetime", "2026-01-01T12:00Z"],
  ])("rejects invalid %s cell %s", (type, cell) => {
    expect(issues({ ...table, columns: [{ id: "day", type }], rows: [{ day: cell }] })).toContain("rows[0].day");
  });
  test.each([
    [{ style: "currency" }, "currency"],
    [{ currency: "EUR" }, "currency"],
    [{ style: "percent", currency: "EUR" }, "currency"],
    [{ style: "currency", currency: "eur" }, "currency"],
    [{ decimals: 11 }, "10"],
    [{ decimals: 1.5 }, "decimals"],
    [{ unit: " " }, "unit"],
    [{ unit: "x".repeat(13) }, "12"],
    [{ compact: "yes" }, "compact"],
  ])("rejects invalid number format %j", (format, path) => {
    expect(issues({ ...table, columns: [{ id: "price", type: "number", format }] })).toContain(path);
  });
  test("formats belong only to number columns", () => {
    expect(issues({ ...table, columns: [{ id: "name", type: "text", format: {} }] })).toContain("Only number columns");
  });
  test("checks exact view namespace, suffix and origin", () => {
    expect(isAiViewPath("/views")).toBe(true);
    expect(isAiViewPath("/views/a")).toBe(true);
    expect(isAiViewPath("/views-other/a")).toBe(false);
    expect(isAiViewFile({ path: "/views/a.view.json", origin: "assistant" })).toBe(true);
    for (const file of [
      { path: "/views/a.json", origin: "assistant" },
      { path: "/a.view.json", origin: "assistant" },
      { path: "/views/a.view.json", origin: "user" },
    ])
      expect(isAiViewFile(file)).toBe(false);
  });
  test("formats EN and DE numbers, fractions, currency, dates, nulls and footer", () => {
    const view = parseCloudAiView({
      view: "table",
      title: "Formats",
      columns: [
        { id: "money", label: "Amount", type: "number", format: { style: "currency", currency: "EUR", decimals: 2 } },
        { id: "rate", type: "number", format: { style: "percent", decimals: 0 } },
        { id: "count", type: "number", format: { compact: true, decimals: 1, unit: "kg" } },
        { id: "raw", type: "number" },
        { id: "day", type: "date" },
        { id: "time", type: "datetime" },
        { id: "missing", type: "text" },
      ],
      rows: [{ money: 1234.5, rate: 0.31, count: 1200, raw: 1234.56789, day: "2026-01-02", time: "2026-01-02T12:30:45", missing: null }],
      footer: { money: 1234.5 },
      sort: { column: "money", direction: "desc" },
    });
    if (!view || view.view !== "table") throw new Error("Missing table");
    const en = cloudAiViewTable(view, "en-US"),
      de = cloudAiViewTable(view, "de-DE");
    expect(en.rows[0]?.cells.money).toBe("€1,234.50");
    expect(de.rows[0]?.cells.money).toBe("1.234,50 €");
    expect(en.rows[0]?.cells.rate).toBe("31%");
    expect(de.rows[0]?.cells.rate).toBe("31 %");
    expect(en.rows[0]?.cells.count).toBe("1.2K kg");
    expect(en.rows[0]?.cells.raw).toBe("1,234.56789");
    expect(en.rows[0]?.cells.day).toBe("Jan 2, 2026");
    expect(de.rows[0]?.cells.time).toContain("12:30:45");
    expect(en.rows[0]?.cells.missing).toBe("");
    expect(en.rows[0]?.values).not.toHaveProperty("missing");
    expect(en.rows[0]?.key).toBe("0");
    expect(en.footer?.cells.money).toBe("€1,234.50");
    expect(en.columns[0]).toEqual({ id: "money", label: "Amount", numeric: true });
  });
  test("TSV quotes cells, includes footer and guards spreadsheet formulas in text", () => {
    const view = parseCloudAiView({
      view: "table",
      title: "Export",
      columns: [
        { id: "text", type: "text" },
        { id: "n", type: "number" },
      ],
      rows: [
        { text: '=HYPERLINK("x")', n: -1 },
        { text: "line\nnext\tcell", n: null },
        { text: "@sum" },
        { text: "+1" },
        { text: "-1" },
        { text: "\tstart" },
        { text: "\rstart" },
      ],
      footer: { text: "Total", n: 2 },
    });
    if (!view || view.view !== "table") throw new Error("Missing table");
    const tsv = cloudAiTableTsv(cloudAiViewTable(view, "en-US"));
    expect(tsv).toStartWith('text\tn\n"\'=HYPERLINK(""x"")"\t-1');
    expect(tsv).toContain('"line\nnext\tcell"\t');
    expect(tsv).toContain("'@sum\t");
    expect(tsv).toContain("'+1\t");
    expect(tsv).toContain("'-1\t");
    expect(tsv).toContain('"\'\tstart"');
    expect(tsv).toContain('"\'\rstart"');
    expect(tsv).toEndWith("Total\t2");
  });
  test("missing prototype-named cells are blank and absent from sort values", () => {
    const view = parseCloudAiView({
      view: "table",
      title: "Missing cells",
      columns: ["toString", "constructor", "__proto__"].map((id) => ({ id, type: "text" })),
      rows: [{}],
      footer: {},
    });
    if (!view || view.view !== "table") throw new Error("Missing table");
    const formatted = cloudAiViewTable(view, "en");
    expect(formatted.rows[0]?.cells).toEqual({ toString: "", constructor: "", ["__proto__"]: "" });
    expect(formatted.rows[0]?.values).toEqual({});
    expect(formatted.footer?.cells).toEqual(formatted.rows[0]?.cells);
  });
  test("own prototype-named cells survive validation and unknown keys are rejected", () => {
    const input: CloudAiTableView = {
      view: "table",
      title: "Own cells",
      columns: ["toString", "constructor", "__proto__"].map((id) => ({ id, type: "text" })),
      rows: [
        Object.fromEntries([
          ["toString", "one"],
          ["constructor", "two"],
          ["__proto__", "three"],
        ]),
      ],
    };
    const view = parseCloudAiView(input);
    expect(view).toEqual(input);
    if (!view || view.view !== "table") throw new Error("Missing table");
    expect(cloudAiViewTable(view, "en").rows[0]?.cells).toEqual({ toString: "one", constructor: "two", ["__proto__"]: "three" });
    expect(issues({ ...input, columns: [{ id: "name", type: "text" }] })).toContain("rows[0].__proto__: Unknown column id.");
  });
});
