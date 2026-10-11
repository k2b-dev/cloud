import { describe, expect, test } from "bun:test";
import { CLOUD_AI_GROUP_MAX_CHARTS, CLOUD_AI_VIEW_MAX_MARKS, type CloudAiChartInput } from "./default-tool-contracts";
import {
  CLOUD_AI_DETAILS_MAX_CHARS,
  CLOUD_AI_DETAILS_VIEWPORT_ITEMS,
  CLOUD_AI_STATS_MAX_ITEMS,
  CLOUD_AI_TABLE_MAX_ROWS,
  type CloudAiTableView,
  type CloudAiViewSummary,
  CloudAiViewSummarySchema,
  checkCloudAiView,
  cloudAiDetailsRows,
  cloudAiStatsTiles,
  cloudAiTableTsv,
  cloudAiViewSummary,
  cloudAiViewTable,
  isAiViewFile,
  isAiViewPath,
  parseCloudAiView,
  sortCloudAiViewRows,
} from "./view-block";

const table: CloudAiTableView = {
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
  test("table formatters are constructed per column, not per cell", () => {
    const view: CloudAiTableView = {
      view: "table",
      title: "Many cells",
      columns: [
        ...Array.from({ length: 10 }, (_, index): CloudAiTableView["columns"][number] => ({
          id: `n${index}`,
          type: "number",
          ...(index < 5 ? { format: { style: "currency", currency: "EUR" } } : {}),
        })),
        { id: "day", type: "date" },
        { id: "time", type: "datetime" },
      ],
      rows: Array.from({ length: 3840 }, (_, index) => ({
        ...Object.fromEntries(Array.from({ length: 10 }, (_, column) => [`n${column}`, index + column / 10])),
        day: "2026-01-02",
        time: index % 2 ? "2026-01-02T12:30:45" : "2026-01-02T12:30",
      })),
    };
    const NumberFormat = globalThis.Intl.NumberFormat;
    const DateTimeFormat = globalThis.Intl.DateTimeFormat;
    let numbers = 0,
      dates = 0;
    try {
      globalThis.Intl.NumberFormat = new Proxy(NumberFormat, {
        construct(target, args) {
          numbers++;
          return Reflect.construct(target, args);
        },
      });
      globalThis.Intl.DateTimeFormat = new Proxy(DateTimeFormat, {
        construct(target, args) {
          dates++;
          return Reflect.construct(target, args);
        },
      });
      const formatted = cloudAiViewTable(view, "en-US");
      expect(formatted.rows).toHaveLength(3840);
      expect(formatted.rows[0]?.cells).toMatchObject({
        n0: "€0.00",
        n5: "0.5",
        day: "Jan 2, 2026",
        time: "Jan 2, 2026, 12:30 PM",
      });
      expect(formatted.rows[1]?.cells.time).toBe("Jan 2, 2026, 12:30:45 PM");
      expect(numbers).toBe(10);
      expect(dates).toBe(3);
    } finally {
      globalThis.Intl.NumberFormat = NumberFormat;
      globalThis.Intl.DateTimeFormat = DateTimeFormat;
    }
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

  test("every reader starts from the view's own order; empty and inherited cells sort last", () => {
    const view = parseCloudAiView({
      view: "table",
      title: "Scores",
      columns: [
        { id: "name", type: "text" },
        { id: "score", type: "number" },
        { id: "constructor", type: "text" },
      ],
      rows: [{ name: "low", score: 2 }, { name: "none" }, { name: "high", score: 10, constructor: "A" }],
      sort: { column: "score", direction: "desc" },
    });
    if (!view || view.view !== "table") throw new Error("Missing table");
    const rows = cloudAiViewTable(view, "en").rows;
    expect(rows.map((row) => row.cells.name)).toEqual(["high", "low", "none"]);
    // A missing "constructor" cell must not sort as Object.prototype.constructor.
    for (const direction of ["asc", "desc"] as const)
      expect(sortCloudAiViewRows(rows, { key: "constructor", direction }, "en").map((row) => row.cells.name)[0]).toBe("high");
  });
});

describe("chart groups", () => {
  const line = (x: number | string = 1): CloudAiChartInput => ({
    kind: "line",
    title: "Trend",
    series: [
      {
        data: [
          { x, y: 1 },
          { x: typeof x === "number" ? x + 1 : "2026-01-02", y: 2 },
        ],
      },
    ],
  });
  test("parses and checks groups, summaries reserve all charts without their data", () => {
    const group = { view: "group", title: "Overview", subtitle: "Source", charts: [line(), line()], linkX: true, layout: "grid" };
    const parsed = parseCloudAiView(group);
    if (!parsed) throw new Error("Missing group");
    expect(checkCloudAiView(group)).toEqual({ view: parsed });
    expect(cloudAiViewSummary(parsed)).toEqual({
      view: "group",
      title: "Overview",
      subtitle: "Source",
      linkX: true,
      layout: "grid",
      charts: [
        { kind: "line", title: "Trend" },
        { kind: "line", title: "Trend" },
      ],
    });
    const defaults = parseCloudAiView({ view: "group", title: "Overview", charts: [line(), line()] });
    if (!defaults) throw new Error("Missing group");
    expect(cloudAiViewSummary(defaults)).toMatchObject({ linkX: false, layout: "stack" });
    expect(parseCloudAiView({ ...group, charts: [line()] })).toBeUndefined();
    expect(issues({ ...group, charts: Array.from({ length: CLOUD_AI_GROUP_MAX_CHARTS + 1 }, () => line()) })).toContain(
      `${CLOUD_AI_GROUP_MAX_CHARTS} charts`,
    );
  });
  test("renderer revalidation checks data and mark budget without drawing", () => {
    const bar = { kind: "bar", title: "B", data: [{ label: "A", value: 9 }], yAxis: { domain: [0, 1] } };
    const group = { view: "group", title: "G", charts: [line(), bar] };
    expect(parseCloudAiView(group)).toBeDefined();
    expect(issues(group)).toStartWith("charts[1]: The chart cannot be drawn:");
    const boxes = (count: number) => ({
      kind: "boxplot",
      title: "B",
      data: [{ label: "A", values: Array.from({ length: count }, () => 1) }],
    });
    const budget = { view: "group", title: "G", charts: [boxes(2000), boxes(1840)] };
    expect(parseCloudAiView(budget)).toBeDefined();
    expect(parseCloudAiView({ ...budget, charts: [boxes(2000), boxes(1841)] })).toBeUndefined();
    expect(issues({ ...budget, charts: [boxes(2000), boxes(1841)] })).toContain(
      `3841 marks; the limit is ${CLOUD_AI_VIEW_MAX_MARKS}. Aggregate or split into several views.`,
    );
    expect(issues({ ...group, charts: [line(), { ...bar, data: [] }] })).toContain("charts[1].data:");
  });
  test("linkX only links line charts with the same kind of x", () => {
    for (const charts of [
      [line(), line("2026-01-01")],
      [line(), { kind: "gauge", title: "G", value: 1 }],
    ]) {
      expect(issues({ view: "group", title: "G", charts, linkX: true })).toContain("linkX links line charts with the same kind of x.");
      expect(parseCloudAiView({ view: "group", title: "G", charts })).toBeDefined();
    }
    expect(parseCloudAiView({ view: "group", title: "G", charts: [line("2026-01-01"), line("2026-01-01")], linkX: true })).toBeDefined();
  });
  test("Phase S view files retain their original canonical shape", () => {
    for (const chart of [
      line(),
      { kind: "bar", title: "B", data: [{ label: "A", value: 1 }] },
      { kind: "gauge", title: "G", value: 50, unit: "%" },
    ] satisfies CloudAiChartInput[]) {
      const file = { view: "chart" as const, ...chart };
      expect(parseCloudAiView(JSON.parse(JSON.stringify(file)))).toEqual(file);
    }
    expect(parseCloudAiView(JSON.parse(JSON.stringify(table)))).toEqual(table);
  });
});

test("parse-only chart views enforce label-fit checks before drawing", () => {
  for (const input of [
    { kind: "barGauge", data: [{ label: "A".repeat(30), value: 1 }] },
    { kind: "heatmap", data: ["North region", "South region", "East region", "West region"].map((x) => ({ x, y: "B", value: 1 })) },
    { kind: "heatmap", data: Array.from({ length: 24 }, (_, y) => ({ x: "Mon", y: `${y}:00`, value: 1 })) },
  ])
    expect(parseCloudAiView({ view: "chart", title: "Labels", ...input })).toBeUndefined();
});

const ref = { type: "spaces.item", id: "task-1", title: "Check invoice" };

describe("stats views", () => {
  const item = { label: "Count", value: 12 };
  const stats = { view: "stats", title: "Overview", items: [item] };
  test("trims text and summarizes tile heights without values", () => {
    const view = parseCloudAiView({
      ...stats,
      title: " Overview ",
      subtitle: " Source ",
      items: [
        { label: " Count ", value: 12, sub: " Month ", delta: 0, better: "up", sparkline: [1, 2] },
        { label: "State", value: " OK " },
      ],
    });
    if (!view || view.view !== "stats") throw new Error("Missing stats");
    expect(view.items[1]?.value).toBe("OK");
    const summary: CloudAiViewSummary = {
      view: "stats",
      title: "Overview",
      subtitle: "Source",
      items: [
        { label: "Count", sparkline: true, sub: true, delta: true },
        { label: "State", sparkline: false, sub: false, delta: false },
      ],
    };
    expect(cloudAiViewSummary(view)).toEqual(summary);
    expect(CloudAiViewSummarySchema.parse(summary)).toEqual(summary);
    expect(checkCloudAiView(view)).toEqual({ view });
    expect(
      parseCloudAiView({
        ...stats,
        items: Array.from({ length: CLOUD_AI_STATS_MAX_ITEMS }, () => ({ ...item, sparkline: Array(480).fill(1) })),
      }),
    ).toBeDefined();
  });
  test.each([
    [{ items: [] }, "items"],
    [{ items: Array(7).fill(item) }, "6"],
    [{ items: [{ ...item, value: "OK", format: {} }] }, "items[0].format"],
    [{ items: [{ ...item, value: "OK", delta: 1 }] }, "items[0].delta"],
    [{ items: [{ ...item, better: "up" }] }, "items[0].better"],
    [{ items: [{ ...item, sparkline: [1] }] }, "items[0].sparkline"],
    [{ items: [{ ...item, sparkline: Array(481).fill(1) }] }, "480"],
    [{ items: [{ ...item, value: Infinity }] }, "items[0].value"],
    [{ items: [{ ...item, value: NaN }] }, "items[0].value"],
    [{ items: [{ ...item, delta: -Infinity }] }, "items[0].delta"],
    [{ items: [{ ...item, sparkline: [1, NaN] }] }, "items[0].sparkline[1]"],
    [{ items: [{ ...item, value: " " }] }, "items[0].value"],
    [{ items: [{ ...item, value: "x".repeat(81) }] }, "80"],
    [{ items: [{ ...item, sub: " " }] }, "items[0].sub"],
    [{ title: " " }, "title"],
    [{ subtitle: "x".repeat(301) }, "subtitle"],
  ])("rejects stats rules: %j", (change, path) => {
    expect(issues({ ...stats, ...change })).toContain(path);
    expect(parseCloudAiView({ ...stats, ...change })).toBeUndefined();
  });
  test("formats signed deltas and determines improvement without model colors", () => {
    const view = parseCloudAiView({
      ...stats,
      items: [
        {
          label: "Revenue",
          value: 12.5,
          format: { style: "currency", currency: "EUR", decimals: 2 },
          delta: 2.5,
          better: "up",
          sub: "Month",
          sparkline: [10, 12.5],
        },
        { ...item, delta: -2, better: "down" },
        { ...item, delta: 2, better: "down" },
        { ...item, delta: -2, better: "up" },
        { ...item, delta: 2 },
        { ...item, delta: 0, better: "up" },
      ],
    });
    if (!view || view.view !== "stats") throw new Error("Missing stats");
    const tiles = cloudAiStatsTiles(view, "en-US");
    expect(tiles[0]).toEqual({
      label: "Revenue",
      value: "€12.50",
      sub: "Month",
      sparkline: [10, 12.5],
      delta: { text: "+€2.50", direction: "up", tone: "better" },
    });
    expect(tiles.slice(1).map((tile) => tile.delta)).toEqual([
      { text: "-2", direction: "down", tone: "better" },
      { text: "+2", direction: "up", tone: "worse" },
      { text: "-2", direction: "down", tone: "worse" },
      { text: "+2", direction: "up", tone: "neutral" },
      { text: "0", direction: "flat", tone: "neutral" },
    ]);
    expect(
      cloudAiStatsTiles(
        {
          ...view,
          items: [
            { label: "State", value: "OK" },
            { ...item, delta: -0 },
          ],
        },
        "de-DE",
      ),
    ).toEqual([
      { label: "State", value: "OK" },
      { label: "Count", value: "12", delta: { text: "0", direction: "flat", tone: "neutral" } },
    ]);
    expect(cloudAiStatsTiles(view, "de-DE")[0]?.delta?.text).toBe("+2,50 €");
  });
});

describe("details views and reference cells", () => {
  const details = { view: "details", title: "Record", subtitle: "Checked", items: [{ label: "Name", type: "text", value: "A" }] };
  test("allows duplicate labels and null for every type; summaries reserve field count and sizes", () => {
    const view = parseCloudAiView({
      ...details,
      items: ["text", "number", "date", "datetime", "ref"].map((type) => ({ label: " Field ", type, value: null })),
    });
    if (!view || view.view !== "details") throw new Error("Missing details");
    expect(checkCloudAiView(view)).toEqual({ view });
    const summary: CloudAiViewSummary = {
      view: "details",
      title: "Record",
      subtitle: "Checked",
      items: 5,
      fields: Array(5).fill({ label: "Field", ref: false, chars: 0 }),
    };
    expect(cloudAiViewSummary(view)).toEqual(summary);
    expect(CloudAiViewSummarySchema.parse(summary)).toEqual(summary);
    expect(cloudAiDetailsRows(view, "en-US")).toEqual(Array(5).fill({ label: "Field", text: "" }));
    expect(parseCloudAiView({ ...details, items: Array(100).fill(details.items[0]) })).toBeDefined();
    expect(issues({ ...details, items: [] })).toContain("items");
    expect(issues({ ...details, items: Array(101).fill(details.items[0]) })).toContain("100");
    expect(issues({ ...details, items: [{ label: "Name", value: "A" }] })).toContain("items[0].type");
  });
  test.each([
    ["text", ref],
    ["number", "12"],
    ["number", ref],
    ["number", Infinity],
    ["date", "2026-02-30"],
    ["date", "2026-01-02T12:30"],
    ["date", 1],
    ["date", ref],
    ["datetime", "2026-01-02"],
    ["datetime", "2026-01-02T25:00"],
    ["datetime", "2026-01-02T12:30Z"],
    ["datetime", ref],
    ["ref", "task-1"],
    ["ref", 1],
    ["ref", { ...ref, href: "/spaces/task-1" }],
    ["ref", { ...ref, type: "item" }],
    ["ref", { ...ref, id: "" }],
    ["ref", { ...ref, id: "x".repeat(513) }],
    ["ref", { ...ref, title: "" }],
    ["ref", { ...ref, title: "x".repeat(501) }],
  ])("rejects details type/value mismatch %s %j", (type, value) => {
    expect(issues({ ...details, items: [{ label: "Field", type, value }] })).toContain("items[0].value");
  });
  test("a number in a text field or text column stays as written", () => {
    const view = parseCloudAiView({ ...details, items: [{ label: "Customer no.", type: "text", value: 12345 }] });
    if (view?.view !== "details") throw new Error("Expected details");
    expect(cloudAiDetailsRows(view, "en-US")).toEqual([{ label: "Customer no.", text: "12345" }]);
    expect(
      checkCloudAiView({ view: "table", title: "Ids", columns: [{ id: "id", type: "text" }], rows: [{ id: 12345 }, { id: "A-7" }] }),
    ).toHaveProperty("view");
  });
  test("formats only numeric fields; dates share the table formatters", () => {
    for (const type of ["text", "date", "datetime", "ref"])
      expect(issues({ ...details, items: [{ label: "Field", type, value: null, format: {} }] })).toContain("Only number fields");
    const view = parseCloudAiView({
      ...details,
      items: [
        { label: "Amount", type: "number", value: 1234.5, format: { style: "currency", currency: "EUR", decimals: 2 } },
        { label: "Rate", type: "number", value: 0.31, format: { style: "percent", decimals: 0 } },
        { label: "Day", type: "date", value: "2026-01-02" },
        { label: "Time", type: "datetime", value: "2026-01-02T12:30" },
        { label: "Seconds", type: "datetime", value: "2026-01-02T12:30:45" },
        { label: "Task", type: "ref", value: ref },
        { label: "Id", type: "ref", value: { type: ref.type, id: ref.id } },
        { label: "Empty", type: "text", value: null },
        { label: "Text", type: "text", value: "Exact" },
      ],
    });
    if (!view || view.view !== "details") throw new Error("Missing details");
    expect(cloudAiDetailsRows(view, "en-US")).toEqual([
      { label: "Amount", text: "€1,234.50" },
      { label: "Rate", text: "31%" },
      { label: "Day", text: "Jan 2, 2026" },
      { label: "Time", text: "Jan 2, 2026, 12:30 PM" },
      { label: "Seconds", text: "Jan 2, 2026, 12:30:45 PM" },
      { label: "Task", text: ref.title, ref },
      { label: "Id", text: ref.id, ref: { type: ref.type, id: ref.id } },
      { label: "Empty", text: "" },
      { label: "Text", text: "Exact" },
    ]);
    expect(cloudAiDetailsRows(view, "de-DE")[0]?.text).toBe("1.234,50 €");
  });
  test("table refs sort and copy by visible title; original row keys still resolve references", () => {
    const input = {
      view: "table",
      title: "Tasks",
      columns: [{ id: "task", type: "ref" }],
      rows: [
        { task: { ...ref, title: "Zebra" } },
        { task: null },
        { task: { ...ref, id: "task-2", title: "Alpha" } },
        { task: { type: ref.type, id: "task-3" } },
      ],
      footer: { task: ref },
      sort: { column: "task", direction: "asc" },
    };
    const view = parseCloudAiView(input);
    if (!view || view.view !== "table") throw new Error("Missing table");
    const formatted = cloudAiViewTable(view, "en-US");
    expect(formatted.rows.map((row) => row.key)).toEqual(["2", "3", "0", "1"]);
    expect(formatted.rows.map((row) => row.cells.task)).toEqual(["Alpha", "task-3", "Zebra", ""]);
    expect(formatted.rows.map((row) => row.values.task)).toEqual(["Alpha", "task-3", "Zebra", undefined]);
    expect(formatted.footer?.cells.task).toBe(ref.title);
    expect(formatted.footer?.values.task).toBe(ref.title);
    expect(cloudAiTableTsv(formatted)).toBe("task\nAlpha\ntask-3\nZebra\n\nCheck invoice");
    expect(issues({ ...input, columns: [{ id: "task", type: "text" }] })).toContain("rows[0].task: Expected text, a number or null.");
    expect(issues({ ...input, rows: [{ task: { ...ref, href: "/task" } }] })).toContain("rows[0].task");
    expect(issues({ ...input, columns: [{ id: "task", type: "ref", format: {} }] })).toContain("Only number columns");
  });
  test("unknown kinds give the allowed kinds without falling through to table validation", () => {
    for (const view of ["unknown", undefined, null]) {
      expect(issues({ view, title: "Unknown" })).toBe("view: Expected one of chart, group, table, stats, details.");
      expect(parseCloudAiView({ view })).toBeUndefined();
    }
    const field = { label: "N", ref: false, chars: 1 };
    for (const summary of [
      { view: "stats", title: "T", items: [] },
      { view: "stats", title: "T", items: Array(7).fill({ label: "N", sparkline: false, sub: false, delta: false }) },
      { view: "details", title: "T", items: 0, fields: [field] },
      { view: "details", title: "T", items: 101, fields: [field] },
      { view: "details", title: "T", items: 1 },
      { view: "details", title: "T", items: 13, fields: Array(13).fill(field) },
      { view: "details", title: "T", items: 1, fields: [{ ...field, chars: CLOUD_AI_DETAILS_MAX_CHARS + 1 }] },
    ])
      expect(CloudAiViewSummarySchema.safeParse(summary).success).toBe(false);
  });

  test("a details summary sizes the first twelve fields by label, reference and text length", () => {
    const view = parseCloudAiView({
      view: "details",
      title: "Record",
      items: [
        { label: "Order", type: "ref", value: { type: "spaces.item", id: "item-1", title: "Chairs" } },
        { label: "Unnamed", type: "ref", value: { type: "spaces.item", id: "item-2" } },
        { label: "Net", type: "number", value: 1840.5, format: { style: "currency", currency: "EUR" } },
        { label: "Note", type: "text", value: "x".repeat(CLOUD_AI_DETAILS_MAX_CHARS + 10) },
        ...Array.from({ length: 10 }, (_, index) => ({ label: `Field ${index}`, type: "text", value: "A" })),
      ],
    });
    if (!view || view.view !== "details") throw new Error("Missing details");
    const summary = cloudAiViewSummary(view);
    if (summary.view !== "details") throw new Error("Missing details summary");
    expect(summary.items).toBe(14);
    expect(summary.fields).toHaveLength(CLOUD_AI_DETAILS_VIEWPORT_ITEMS);
    expect(summary.fields.slice(0, 4)).toEqual([
      { label: "Order", ref: true, chars: "Chairs".length },
      { label: "Unnamed", ref: true, chars: "item-2".length },
      { label: "Net", ref: false, chars: "€1,840.50".length },
      { label: "Note", ref: false, chars: CLOUD_AI_DETAILS_MAX_CHARS },
    ]);
    expect(CloudAiViewSummarySchema.parse(summary)).toEqual(summary);
  });
});
