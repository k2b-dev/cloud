import { expect, test } from "bun:test";
import {
  type CloudAiChartInput,
  cloudAiAppChartSchema,
  cloudAiChartRows,
  cloudAiChartTable,
  cloudAiChartTooltip,
} from "@k2b/cloud/ai/browser";
import { escapeXml } from "@k2b/stdlib";
import { isChartDatum } from "@k2b/ui/chart-inspection";
import { createCloud } from "./cloud";
import { CloudError } from "./errors";
import { boundMoney, chart, chartOptions, chartSvg, html } from "./lib";
import { parseCsv, toCsv } from "./sheet-lib";

test("cloud.html escapes values, joins arrays and keeps nested markup", () => {
  const items = ["<b>", "Müller & Söhne"];
  const markup = html`<ul>${items.map((item) => html`<li title="${item}">${item}</li>`)}</ul>${null}${false}`;
  expect(String(markup)).toBe('<ul><li title="&lt;b&gt;">&lt;b&gt;</li><li title="Müller &amp; Söhne">Müller &amp; Söhne</li></ul>');
  expect(markup.includes("<li")).toBe(true);
});

test("cloud.chart drops stdlib's fixed colors and sizes text in pixels", () => {
  const markup = String(chart({ kind: "bar", title: "Umsatz", data: [{ label: "Jan", value: 1200.5 }] }, "de-DE"));
  expect(markup).not.toContain("<style>");
  // The @k2b/ui Chart markup, which the base stylesheet colors in light and dark.
  expect(markup).toStartWith(
    '<div class="k2b-chart" data-chart-kind="bar" role="img" aria-label="Umsatz"><div class="k2b-chart__svg" data-stretch',
  );
  expect(markup).toContain(">1200</text>");
  expect(markup).toContain("--k2b-chart-width:480px");
  expect(markup).toMatch(/<text\b[^>]* style="transform-origin:-?[\d.]+px -?[\d.]+px[^"]*">/);
  expect(() => chart({ kind: "map" }, "de-DE")).toThrow(/unknown kind "map"/);
});

test("parseCsv reads Excel CSV: windows-1252, semicolons, German numbers, codes stay text", async () => {
  // "ü" is 0xFC and "€" is 0x80 in Windows-1252.
  const bytes = new Uint8Array([
    ...Buffer.from("Name;PLZ;Betrag\r\nM"),
    0xfc,
    ...Buffer.from("ller;01234;1.234,56\r\nSchulz;80331;-12,50 "),
    0x80,
    0x0d,
    0x0a,
  ]);
  const rows = await parseCsv(new Blob([bytes]), {}, "de-DE");
  expect(rows).toEqual([
    { Name: "Müller", PLZ: "01234", Betrag: 1234.56 },
    { Name: "Schulz", PLZ: "80331", Betrag: -12.5 },
  ]);
  expect((await parseCsv("a,b\n1.5,x", {}, "en-US"))[0]).toEqual({ a: 1.5, b: "x" });
  expect((await parseCsv("a;b\n1,5;2", { numbers: false }, "de-DE"))[0]).toEqual({ a: "1,5", b: "2" });
});

test("toCsv writes Excel-friendly CSV and escapes formulas", async () => {
  const csv = await toCsv([{ Name: "=SUM(A1)", Betrag: 12.5, Notiz: 'sagt "hallo"; tschüss' }], {}, "de-DE");
  expect(csv).toBe('﻿Name;Betrag;Notiz\r\n\'=SUM(A1);12,5;"sagt ""hallo""; tschüss"\r\n');
});

test("chart keeps every complete label and always supplies an escaped accessible name", () => {
  const labels = Array.from({ length: 12 }, (_, i) => `Category ${i} long`);
  const markup = String(
    chart({ kind: "bar", width: 300, title: "A & B", subtitle: '"report"', data: labels.map((label) => ({ label, value: 1 })) }, "en-US"),
  );
  expect(markup).not.toContain("…");
  // Every category keeps its complete label: the measured 300px frame draws one row per category.
  const axisText = [...markup.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map((match) => match[1]);
  expect(labels.filter((label) => axisText.includes(label))).toEqual(labels);
  expect(markup).toContain('role="img" aria-label="A &amp; B — &quot;report&quot;"');
  expect(String(chart({ kind: "sparkline", data: [1, 2] }, "en-US"))).toContain('role="img"');
});
test("money defaults to the viewer locale; CSV dates remain text", async () => {
  const money = boundMoney("de-DE");
  const value = money.parse("1.234,56 €", { currency: "EUR" });
  expect(value.amount).toBe(123456);
  expect(money.format(value)).toContain("1.234,56");
  expect(await parseCsv("date;amount\n2026-10-07;12,5", {}, "de-DE")).toEqual([{ date: "2026-10-07", amount: 12.5 }]);
});

test("CSV preserves unsafe integer columns, unique headings and missing cells", async () => {
  expect(await parseCsv("id,name\n9007199254740993,large\n42,small", {}, "en-US")).toEqual([
    { id: "9007199254740993", name: "large" },
    { id: "42", name: "small" },
  ]);
  expect(await parseCsv("a,a,a,,column4\nleft,middle,right,blank,collision", {}, "en-US")).toEqual([
    { a: "left", a_2: "middle", a_3: "right", column4: "blank", column4_2: "collision" },
  ]);
  expect(await parseCsv("a,b\nleft", {}, "en-US")).toEqual([{ a: "left", b: "" }]);
});

for (const locale of ["en-US", "de-DE"])
  for (const delimiter of [undefined, ","])
    test(`CSV numbers round-trip in ${locale} with ${delimiter ?? "default"} delimiter`, async () => {
      const rows = [{ mass: 1.234, count: 1234 }];
      expect(await parseCsv(await toCsv(rows, { delimiter }, locale), { delimiter }, locale)).toEqual(rows);
    });

test("unambiguous columns decide ambiguous numeric columns before locale", async () => {
  expect(await parseCsv("Betrag;Menge\n1.234;1,5", {}, "en-US")).toEqual([{ Betrag: 1234, Menge: 1.5 }]);
});

for (const source of ['a,b\n"unterminated,x', "a,b\n1,2,3"])
  test("malformed CSV rejects with an invalid code and physical line", async () => {
    await expect(parseCsv(source, {}, "en-US")).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("line 2") });
  });

test("CSV diagnostics count blank and quoted physical lines", async () => {
  await expect(parseCsv("a,b\n,,\n1,2,3", {}, "en-US")).rejects.toMatchObject({
    code: "invalid",
    message: expect.stringContaining("line 3"),
  });
  await expect(parseCsv('a,b\n"two\nlines",ok\n1,2,3', {}, "en-US")).rejects.toMatchObject({
    code: "invalid",
    message: expect.stringContaining("line 4"),
  });
});

test("chart function formats survive validation and measured redraws", () => {
  const markup = String(
    chart(
      {
        kind: "line",
        title: "Formats",
        series: [
          {
            data: [
              { x: 1, y: 1 },
              { x: 2, y: 2 },
            ],
          },
        ],
        xAxis: { format: (v: number) => `X${v}` },
        yAxis: { format: (v: number) => `Y${v}` },
      },
      "en",
    ),
  );
  expect(markup).toContain(">X1</text>");
  expect(markup).toContain(">Y1</text>");
  const id = /data-chart-id="([^"]+)"/.exec(markup)?.[1];
  const saved = chartOptions.get(id ?? "");
  if (!saved) throw new Error("Missing redraw options");
  const redrawn = chartSvg(saved, "en", 300, 280);
  expect(redrawn).toContain('viewBox="0 0 300 280"');
  expect(redrawn).toContain(">X1</text>");
  expect(redrawn).toContain(">Y1</text>");
  for (const kind of ["gauge", "stat"])
    expect(String(chart({ kind, value: 12, format: (v: number) => `Value ${v}` }, "en"))).toContain("Value 12");
  expect(String(chart({ kind: "barGauge", data: [{ label: "A", value: 12 }], format: (v: number) => `Value ${v}` }, "en"))).toContain(
    "Value 12",
  );
  expect(
    String(chart({ kind: "heatmap", data: [{ x: "A", y: "B", value: 12 }], showValues: true, format: (v: number) => `Value ${v}` }, "en")),
  ).toContain("Value 12");
});

test("chart Date points and ISO instants become viewer wall-clock times before mapping", () => {
  const cloud = createCloud(async () => undefined, { locale: "en", timeZone: "America/New_York", user: null });
  const markup = String(
    cloud.chart({
      kind: "line",
      title: "Time",
      series: [
        {
          data: [
            { x: new Date("2026-01-02T00:30:00Z"), y: 1 },
            { x: "2026-01-02T02:00:00+01:00", y: 2 },
          ],
        },
      ],
      references: [{ axis: "x", value: new Date("2026-01-02T03:00:00Z") }],
    }),
  );
  const id = /data-chart-id="([^"]+)"/.exec(markup)?.[1];
  expect(chartOptions.get(id ?? "")?.input).toMatchObject({
    series: [
      {
        data: [
          { x: "2026-01-01T19:30:00", y: 1 },
          { x: "2026-01-01T20:00:00", y: 2 },
        ],
      },
    ],
    references: [{ axis: "x", value: "2026-01-01T22:00:00" }],
  });
  expect(markup).toContain("stdlib-chart-reference");
});

test("chart new kinds draw at the shared size and renderer errors become CloudError", () => {
  for (const options of [
    { kind: "boxplot", data: [{ label: "A", values: [1, 2, 3] }] },
    { kind: "heatmap", data: [{ x: "A", y: "B", value: 1 }] },
    { kind: "barGauge", data: [{ label: "A", value: 1 }] },
    { kind: "stat", value: 1, sparkline: [1, 2] },
  ]) {
    const markup = String(chart(options, "en"));
    expect(markup).toContain(`data-chart-kind="${options.kind}"`);
    expect(markup).toContain('viewBox="0 0 480 280"');
    expect(markup).not.toContain("<style>");
  }
  expect(String(chart({ kind: "gauge", value: 1 }, "en"))).toContain('viewBox="0 0 480 280"');
  expect(String(chart({ kind: "sparkline", data: [1, 2] }, "en"))).toContain('viewBox="0 0 160 40"');
  expect(String(chart({ kind: "bar", data: Array.from({ length: 481 }, () => ({ label: "A", value: 1 })) }, "en"))).toContain(
    'data-chart-kind="bar"',
  );
  expect(
    String(
      chart(
        {
          kind: "scatter",
          series: [
            {
              data: [
                { x: 1, y: 1 },
                { x: "2026-01-01", y: 2 },
              ],
            },
          ],
        },
        "en",
      ),
    ),
  ).not.toMatch(/NaN|Infinity/);
  expect(() => chart({ kind: "bar", data: [{ label: "A", value: 2 }], yAxis: { domain: [0, 1] } }, "en")).toThrow(
    expect.objectContaining({ code: "invalid", message: "cloud.chart: Chart axis domain must contain all plotted values and bounds" }),
  );
});

const lineChart = (data: object[]) => ({ kind: "line", series: [{ data }] });
const barChart = (extra: object = {}) => ({ kind: "bar", data: [{ label: "A", value: 1 }], ...extra });

const appCharts: [string, { kind: string } & Record<string, unknown>][] = [
  ["empty bar", barChart({ data: [] })],
  ["empty line", lineChart([])],
  ["one-point line", lineChart([{ x: 1, y: 1 }])],
  [
    "nine series",
    {
      kind: "line",
      series: Array.from({ length: 9 }, () => ({
        data: [
          { x: 1, y: 1 },
          { x: 2, y: 2 },
        ],
      })),
    },
  ],
  ["1,000 points", lineChart(Array.from({ length: 1000 }, (_, x) => ({ x, y: x })))],
  ["empty title", barChart({ title: "" })],
  ["long title", barChart({ title: "T".repeat(161) })],
  ["empty subtitle", barChart({ subtitle: "" })],
  ["long subtitle", barChart({ subtitle: "S".repeat(301) })],
  ["empty label", barChart({ data: [{ label: "", value: 1 }] })],
  ["numeric label", barChart({ data: [{ label: 2024, value: 1 }] })],
  [
    "YYYY-MM x",
    lineChart([
      { x: "2026-01", y: 1 },
      { x: "2026-02", y: 2 },
    ]),
  ],
  [
    "milliseconds without offset",
    lineChart([
      { x: "2026-01-01T10:00:00.123", y: 1 },
      { x: "2026-01-02T10:00:00.123", y: 2 },
    ]),
  ],
  [
    "space-separated date-times",
    lineChart([
      { x: "2026-01-01 10:00:00", y: 1 },
      { x: "2026-01-02 10:00:00", y: 2 },
    ]),
  ],
  ["zero pie", { kind: "pie", data: [{ label: "A", value: 0 }] }],
  [
    "negative pie slice",
    {
      kind: "pie",
      data: [
        { label: "A", value: -1 },
        { label: "B", value: 1 },
      ],
    },
  ],
  ["negative donut", { kind: "donut", data: [{ label: "A", value: -1 }] }],
  [
    "log axis at or below zero",
    barChart({
      data: [
        { label: "A", value: 0 },
        { label: "B", value: -1 },
      ],
      yAxis: { scale: "log" },
    }),
  ],
  ["one-value sparkline", { kind: "sparkline", data: [1] }],
  ["empty sparkline", { kind: "sparkline", data: [] }],
  ["empty histogram", { kind: "histogram", data: [] }],
  ["empty gauge unit", { kind: "gauge", value: 1, unit: "" }],
  ["20 ticks", barChart({ yAxis: { ticks: 20 } })],
  ["1,000 bins", { kind: "histogram", data: [1, 2], bins: 1000 }],
  [
    "mixed x types",
    lineChart([
      { x: 1, y: 1 },
      { x: "2026-01-01", y: 2 },
    ]),
  ],
  [
    "missing bar values",
    barChart({
      data: [
        { label: "A", value: undefined },
        { label: "B", value: NaN },
      ],
    }),
  ],
  ["empty heatmap", { kind: "heatmap", data: [] }],
  ["empty boxplot", { kind: "boxplot", data: [{ label: "A", values: [] }] }],
  ["empty bar gauge", { kind: "barGauge", data: [] }],
];
for (const [name, input] of appCharts)
  test(`an app chart draws what cloud.chart() drew before: ${name}`, () => {
    const markup = String(chart(input, "en"));
    expect(markup).toContain(`data-chart-kind="${input.kind}"`);
    expect(markup).not.toMatch(/NaN|Infinity/);
    if (name === "numeric label") expect(markup).toContain(">2024<");
    if (name === "nine series") {
      expect(markup).toContain("stdlib-chart-series-7");
      expect(markup).not.toContain("stdlib-chart-series-8");
    }
  });

for (const missing of [null, undefined, NaN, Infinity, -Infinity])
  test(`app chart omits missing or non-finite observations: ${String(missing)}`, () => {
    for (const input of [
      ...["bar", "pie", "donut", "barGauge"].map((kind) => ({ kind, data: [{ label: "A", value: missing }] })),
      { kind: "heatmap", data: [{ x: "A", y: "B", value: missing }] },
      lineChart([
        { x: missing, y: 1 },
        { x: 1, y: missing },
      ]),
      { kind: "scatter", series: [{ data: [{ x: missing, y: missing }] }] },
      ...["histogram", "sparkline"].map((kind) => ({ kind, data: [missing] })),
      { kind: "boxplot", data: [{ label: "A", values: [missing] }] },
      { kind: "gauge", value: missing },
      { kind: "stat", value: missing, delta: missing, sparkline: [missing] },
      barChart({ data: [{ label: "A", value: missing }], references: [{ value: 1 }], yAxis: { scale: "log" } }),
    ]) {
      const markup = String(chart(input, "en"));
      expect(markup).toContain(`data-chart-kind="${input.kind}"`);
      expect(markup).not.toMatch(/NaN|Infinity/);
    }
  });

for (const timeZone of ["UTC", "America/New_York", "Asia/Tokyo"])
  test(`app wall-clock strings stay written in ${timeZone}`, () => {
    const markup = String(
      chart(
        lineChart([
          { x: "2026-01", y: 1 },
          { x: "2026-01-01T10:00:00.123", y: 2 },
          { x: "2026-01-01 10:00:00", y: 3 },
        ]),
        "en",
        timeZone,
      ),
    );
    const saved = chartOptions.get(/data-chart-id="([^"]+)"/.exec(markup)?.[1] ?? "");
    expect(saved?.input).toMatchObject({
      series: [
        {
          data: [
            { x: "2026-01-01", y: 1 },
            { x: "2026-01-01T10:00:00", y: 2 },
            { x: "2026-01-01T10:00:00", y: 3 },
          ],
        },
      ],
    });
  });

test("app dates that are all at midnight show as calendar days, as before", () => {
  const markup = String(
    chart(
      lineChart([
        { x: "2026-01-01 00:00:00", y: 1 },
        { x: new Date("2026-01-02T00:00:00Z"), y: 2 },
        { x: "2026-01-03T00:00:00", y: 3 },
      ]),
      "en",
      "UTC",
    ),
  );
  const saved = chartOptions.get(/data-chart-id="([^"]+)"/.exec(markup)?.[1] ?? "");
  expect(saved?.input).toMatchObject({ series: [{ data: [{ x: "2026-01-01" }, { x: "2026-01-02" }, { x: "2026-01-03" }] }] });
});

test("app chart rejects unsafe tick precision quickly and wrong structures with paths", () => {
  const started = performance.now();
  for (const input of [
    { kind: "histogram", data: [1e17, 1e17 + 16] },
    lineChart([
      { x: 1e17, y: 1 },
      { x: 1e17 + 16, y: 2 },
    ]),
  ])
    expect(() => chart(input, "en")).toThrow(
      expect.objectContaining({ code: "invalid", message: expect.stringContaining("differ too little") }),
    );
  expect(performance.now() - started).toBeLessThan(1000);
  for (const [input, path] of [
    [{ kind: "unknown" }, "kind"],
    [barChart({ data: [{ label: "A", value: "abc" }] }), "data[0].value"],
    [barChart({ data: [{ label: null, value: 1 }] }), "data[0].label"],
  ] as const)
    expect(() => chart(input, "en")).toThrow(expect.objectContaining({ code: "invalid", message: expect.stringContaining(path) }));
});

test.each([false, true])("function-formatted bar ticks fit initially and after measured redraw, showValues=%s", (showValues) => {
  const markup = String(
    chart(
      {
        kind: "bar",
        data: [
          { label: "North", value: 12000 },
          { label: "South", value: 8000 },
        ],
        yAxis: { format: (v: number) => v.toLocaleString("de-DE", { minimumFractionDigits: 2 }) + " €" },
        showValues,
      },
      "de",
    ),
  );
  const saved = chartOptions.get(/data-chart-id="([^"]+)"/.exec(markup)?.[1] ?? "");
  if (!saved) throw new Error("Missing redraw options");
  for (const svg of [markup, chartSvg(saved, "de", 300, 280)]) {
    const ticks = [...svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)].filter((match) => match[1]?.includes('text-anchor="end"'));
    expect(ticks.length).toBeGreaterThan(0);
    for (const tick of ticks) {
      const x = Number(/\bx="([^"]+)"/.exec(tick[1] ?? "")?.[1]);
      // 11px sans with tabular figures: digits and letters about 6.7px, separators and spaces about 3.7px.
      const width = [...(tick[2] ?? "")].reduce((sum, char) => sum + (/[\p{L}\p{N}€]/u.test(char) ? 6.7 : 3.7), 0);
      expect(x - width).toBeGreaterThanOrEqual(0);
    }
    expect(svg).toContain(">12.000,00 €</text>");
  }
});

test("an app stat shows its title like every other kind", () => {
  const markup = String(chart({ kind: "stat", title: "Revenue", subtitle: "EUR", value: 12, delta: 2, better: "up" }, "en"));
  expect(markup).toContain(">Revenue</text>");
  expect(markup).toContain('aria-label="Revenue — EUR"');
});

test("cloud.chart preserves shared tooltip data and rejects unknown tooltip keys", () => {
  const tooltip = { label: "Umsatz", format: { style: "currency" as const, currency: "EUR" } };
  const options = { kind: "bar", data: [{ label: "Jan", value: 1200 }], tooltip };
  const markup = String(chart(options, "de-DE"));
  const id = /data-chart-id="([^"]+)"/.exec(markup)?.[1];
  expect(chartOptions.get(id ?? "")?.input).toMatchObject({ tooltip });
  expect(() => chart({ ...options, tooltip: { ...tooltip, unknown: true } }, "de-DE")).toThrow(CloudError);
  expect(() => chart({ ...options, tooltip: { ...tooltip, unknown: true } }, "de-DE")).toThrow(/tooltip/);
});

const decodeChartAttribute = (value: string) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** Read the compact table without a DOM, preserving exactly the text a browser receives. */
const printedTable = (markup: string) => {
  expect([...markup.matchAll(/<table\b/g)]).toHaveLength(1);
  const [drawing, table] = markup.split('<table class="k2b-chart__table" hidden>');
  expect(drawing).toEndWith("</div></div>");
  expect(drawing).not.toContain("<table");
  expect(markup).toEndWith("</table>");
  expect(table).toBeDefined();
  const cells = (row: string) => [...row.matchAll(/<td(?: class="num")?>([\s\S]*?)<\/td>/g)].map((cell) => decodeChartAttribute(cell[1]!));
  return {
    caption: decodeChartAttribute(/<caption>([\s\S]*?)<\/caption>/.exec(table!)![1]!),
    headers: [...table!.matchAll(/<th scope="col"( class="num")?>([\s\S]*?)<\/th>/g)].map((cell) => ({
      label: decodeChartAttribute(cell[2]!),
      numeric: Boolean(cell[1]),
    })),
    rows: [.../<tbody>([\s\S]*?)<\/tbody>/.exec(table!)![1]!.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((row) => cells(row[1]!)),
    numericCells: [...table!.matchAll(/<td class="num">/g)].length,
  };
};

for (const input of [
  {
    kind: "bar",
    title: "Umsatz",
    data: [
      { label: `Jan <&"' <text x="1" y="2">`, value: 1200 },
      { label: "Feb", value: 900 },
    ],
  },
  {
    kind: "line",
    title: "Umsatz",
    series: [
      {
        label: "Shop",
        data: [
          { x: 1, y: 1200 },
          { x: 2, y: 900 },
        ],
      },
    ],
  },
  {
    kind: "line",
    title: "Umsatz",
    subtitle: "By shop",
    series: [
      {
        label: "Shop A",
        data: [
          { x: 1, y: 1200 },
          { x: 2, y: 900 },
        ],
      },
      {
        label: "Shop B",
        data: [
          { x: 1, y: 800 },
          { x: 2, y: 700 },
        ],
      },
    ],
  },
  { kind: "scatter", title: "Umsatz", series: [{ data: [{ x: 1, y: 1200 }] }] },
  { kind: "pie", title: "Umsatz", data: [{ label: "Jan", value: 1200 }] },
  { kind: "donut", title: "Umsatz", data: [{ label: "Jan", value: 1200 }] },
  { kind: "heatmap", title: "Umsatz", data: [{ x: "Jan", y: "Shop", value: 1200 }] },
  { kind: "stat", title: "Umsatz", value: 1200, delta: 100, sparkline: [1000, 1200] },
  { kind: "histogram", title: "Umsatz", data: [900, 1200], bins: [800, 1000, 1300] },
  { kind: "boxplot", title: "Umsatz", data: [{ label: "Jan", values: [1, 1, 1, 1, 20] }] },
  { kind: "gauge", title: "Umsatz", value: 1200, max: 2000 },
  { kind: "barGauge", title: "Umsatz", data: [{ label: "Jan", value: 1200 }], max: 2000 },
  { kind: "sparkline", title: "Umsatz", data: [900, 1200] },
] satisfies CloudAiChartInput[])
  test(`app ${input.kind} print table, marks and redraws use exactly the chat formatter`, () => {
    const options = { ...input, tooltip: { label: "Umsatz", format: { style: "currency" as const, currency: "EUR" } } };
    const markup = String(chart(options, "de-DE"));
    const expected = cloudAiChartTable(cloudAiAppChartSchema().parse(options), "de-DE");
    expect(printedTable(markup)).toEqual({
      caption: [input.title, "subtitle" in input ? input.subtitle : undefined].filter(Boolean).join(" — "),
      headers: expected.columns.map(({ label, numeric }) => ({ label, numeric })),
      rows: expected.rows.map((row) => expected.columns.map((col) => row.cells[col.id] ?? "")),
      numericCells: expected.rows.length * expected.columns.filter((col) => col.numeric).length,
    });
    const saved = chartOptions.get(/data-chart-id="([^"]+)"/.exec(markup)?.[1] ?? "");
    if (saved) expect(chartSvg(saved, "de-DE", 300, 280)).not.toContain("<table");
    for (const svg of [markup, ...(saved ? [chartSvg(saved, "de-DE", 300, 280)] : [])]) {
      const rows = cloudAiChartRows(options, "de-DE");
      const marks = [...svg.matchAll(/data-chart-datum="([^"]*)" data-chart-tooltip='([^']*)'><title>([\s\S]*?)<\/title>/g)];
      expect(marks.length).toBeGreaterThan(0);
      expect(marks.length).toBe([...svg.matchAll(/data-chart-datum=/g)].length);
      for (const mark of marks) {
        const datum: unknown = JSON.parse(decodeChartAttribute(mark[1]!));
        if (!isChartDatum(datum)) throw new Error("Invalid mark");
        const row = rows.add(datum);
        const tooltip = cloudAiChartTooltip(rows.columns(), row);
        expect(JSON.parse(decodeChartAttribute(mark[2]!))).toEqual(JSON.parse(JSON.stringify(tooltip)));
        expect(mark[3]).toBe(escapeXml([tooltip.title, ...tooltip.rows.map((r) => `${r.label}: ${r.value}`)].filter(Boolean).join(" · ")));
      }
    }
  });

test("app tooltips keep German currency spacing and function formats through redraws", () => {
  for (const extra of [
    { tooltip: { label: "Umsatz", format: { style: "currency", currency: "EUR" } } },
    { yAxis: { format: (v: number) => `${v} kWh` } },
    { format: (v: number) => `${v} units`, yAxis: { format: (v: number) => `${v} kWh` } },
  ]) {
    const markup = String(chart({ kind: "bar", title: "Umsatz", data: [{ label: "Jan", value: 1200 }], ...extra }, "de-DE"));
    const saved = chartOptions.get(/data-chart-id="([^"]+)"/.exec(markup)?.[1] ?? "");
    if (!saved) throw new Error("Missing redraw options");
    for (const svg of [markup, chartSvg(saved, "de-DE", 300, 280)]) {
      const rows = cloudAiChartRows(saved.input, "de-DE", { formats: { x: saved.xFormat, y: saved.yFormat, value: saved.format } });
      const mark = /data-chart-datum="([^"]*)" data-chart-tooltip='([^']*)'/.exec(svg)!;
      const datum: unknown = JSON.parse(decodeChartAttribute(mark[1]!));
      if (!isChartDatum(datum)) throw new Error("Invalid mark");
      const row = rows.add(datum);
      expect(JSON.parse(decodeChartAttribute(mark[2]!))).toEqual(cloudAiChartTooltip(rows.columns(), row));
      expect(svg).toContain(
        "tooltip" in extra
          ? "<title>Jan · Umsatz: 1.200\u00a0€</title>"
          : `<title>Jan · Wert: 1200 ${"format" in extra ? "units" : "kWh"}</title>`,
      );
    }
  }
});

test("chart print tables preserve German currency, custom formats and escaped text", () => {
  const currency = String(
    chart(
      {
        kind: "bar",
        title: "Umsatz",
        data: [{ label: "Jan", value: 1200 }],
        tooltip: { label: "Umsatz", format: { style: "currency", currency: "EUR" } },
      },
      "de-DE",
    ),
  );
  expect(printedTable(currency).headers.map((col) => col.label)).toEqual(["Kategorie", "Umsatz"]);
  expect(printedTable(currency).rows).toEqual([["Jan", "1.200\u00a0€"]]);

  const custom = String(
    chart(
      {
        kind: "bar",
        data: [
          { label: "Jan", value: 12 },
          { label: "Feb", value: 8 },
        ],
        format: (v: number) => `${v} pcs`,
      },
      "en",
    ),
  );
  expect(printedTable(custom).caption).toBe("bar chart");
  expect(printedTable(custom).rows).toEqual([
    ["Jan", "12 pcs"],
    ["Feb", "8 pcs"],
  ]);
  const tooltips = [...custom.matchAll(/data-chart-tooltip='([^']*)'/g)].map((match) => JSON.parse(decodeChartAttribute(match[1]!)));
  expect(tooltips).toEqual(printedTable(custom).rows.map(([title, value]) => ({ title, rows: [{ label: "Value", value }] })));

  const hostile = String(
    chart(
      {
        kind: "bar",
        title: 'A & "B"',
        data: [{ label: "<img src=x onerror=alert(1)>", value: 1 }],
        tooltip: { label: '<Value & "units">' },
      },
      "en",
    ),
  );
  expect(hostile).not.toContain("<img");
  const table = hostile.slice(hostile.indexOf("<table"));
  expect(table).toContain("<caption>A &amp; &quot;B&quot;</caption>");
  expect(table).toContain("<td>&lt;img src=x onerror=alert(1)&gt;</td>");
  expect(table).toContain("&lt;Value &amp; &quot;units&quot;&gt;</th>");
});

test("an uninspectable empty stat omits its print table", () => {
  expect(String(chart({ kind: "stat", value: null }, "en"))).not.toContain("<table");
});

test("a gauge label with replacement patterns stays literal in its mark data", () => {
  const markup = String(chart({ kind: "gauge", title: "Margin", value: 42, label: "Profit $& costs $$" }, "en"));
  const encoded = /data-chart-datum="([^"]*)" data-chart-tooltip/.exec(markup)?.[1];
  expect(JSON.parse(decodeChartAttribute(encoded ?? "")).label).toBe("Profit $& costs $$");
});

test("a titled bar chart with many rows reserves the height of its title and every row", () => {
  const data = Array.from({ length: 20 }, (_, index) => ({ label: `Northwestern coastal region ${index + 1}`, value: index + 1 }));
  const markup = String(chart({ kind: "bar", title: "Regions", subtitle: "Fictional", data }, "en"));
  const height = Number(/viewBox="0 0 480 ([\d.]+)"/.exec(markup)?.[1]);
  expect(markup).toContain(`--k2b-chart-height:${height}px`);
  const baselines = [...markup.matchAll(/stdlib-chart-category-label"[^>]*y="([\d.]+)"/g)].map((match) => Number(match[1]));
  expect(baselines).toHaveLength(20);
  expect(Math.max(...baselines)).toBeLessThan(height);
});
