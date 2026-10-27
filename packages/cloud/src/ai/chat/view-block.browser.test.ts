import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { z } from "zod";
import { launchBrowser } from "../../../../ui/test/browser";
import type { CloudResourceRef } from "../../contracts/capabilities";
import { cloudAiNumberFormatters } from "../chart-block";
import type { AiTurnBlock } from "../protocol";
import { cloudAiViewSummary, parseCloudAiView } from "../view-block";

// Whether a presented view moves anything when its file arrives depends on real layout, fonts and themes, so this
// measures the blocks in a browser.
const ui = resolve(import.meta.dir, "../../../../ui");

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "view-block.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-view-block-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "View block harness build failed");
  return build.outputs[0]!.text();
};

const chart = {
  view: "chart",
  kind: "bar",
  title: "Offers by status",
  subtitle: "1,284 offers, January to September 2026",
  data: [
    { label: "Open", value: 512 },
    { label: "Accepted", value: 398 },
    { label: "Declined", value: 274 },
    { label: "Expired", value: 100 },
  ],
};
const table = {
  view: "table",
  title: "Offers per month",
  subtitle: "Median price in EUR",
  columns: [
    { id: "month", label: "Month", type: "date" },
    { id: "region", label: "Region", type: "text" },
    { id: "count", label: "Offers", type: "number" },
    { id: "median", label: "Median price", type: "number", format: { style: "currency", currency: "EUR" } },
  ],
  rows: Array.from({ length: 12 }, (_, index) => ({
    month: `2026-${String((index % 9) + 1).padStart(2, "0")}-01`,
    region: ["North", "South", "=SUM(A1)"][index % 3],
    count: 40 + ((index * 37) % 90),
    median: 4200 + ((index * 613) % 1800),
  })),
  footer: { region: "Total", count: 1284 },
};
// A short table fits its reserved rows without scrolling, even where long header labels would wrap on a phone.
const small = {
  view: "table",
  title: "Prices by region",
  columns: [
    { id: "region", label: "Sales region", type: "text" },
    { id: "median", label: "Median price per accepted offer", type: "number", format: { style: "currency", currency: "EUR" } },
    { id: "count", label: "Accepted offers", type: "number" },
  ],
  rows: [
    { region: "North", median: 4950, count: 128 },
    { region: "South", median: 5120, count: 97 },
    { region: "West", median: 4780, count: 173 },
  ],
  footer: { region: "Total", count: 398 },
};
const days = (base: number, step: number) =>
  Array.from({ length: 30 }, (_, index) => ({ x: `2026-09-${String(index + 1).padStart(2, "0")}`, y: base + ((index * step) % 17) }));
// Two measures with different units share the x cursor instead of a second y axis.
const linked = {
  view: "group",
  title: "Offers and acceptance",
  subtitle: "Daily, September 2026",
  linkX: true,
  charts: [
    {
      kind: "line",
      title: "Offers",
      series: [
        { label: "Frontend service", data: days(40, 7) },
        { label: "Gateway service", data: days(30, 5) },
        { label: "Catalog service", data: days(20, 3) },
        { label: "Same day last year", data: days(25, 4), role: "reference" },
      ],
      references: [{ value: 50, label: "Target" }],
    },
    {
      kind: "line",
      title: "Acceptance rate",
      series: [{ label: "Accepted", data: days(0.2, 0.01) }],
      yAxis: { format: { style: "percent" } },
    },
  ],
};
const kinds = {
  view: "group",
  title: "Prices and capacity",
  layout: "grid",
  charts: [
    {
      kind: "boxplot",
      title: "Price by region",
      data: ["North", "South", "West"].map((label, index) => ({
        label,
        values: [40, 42, 45, 47, 50, 90].map((value) => value + index * 5),
      })),
      yAxis: { format: { style: "currency", currency: "EUR", compact: true } },
    },
    {
      kind: "heatmap",
      title: "Offers by weekday",
      data: ["Mon", "Tue", "Wed", "Thu", "Fri"].flatMap((x, column) => ["AM", "PM"].map((y, row) => ({ x, y, value: column * 2 + row }))),
      showValues: true,
    },
    {
      kind: "barGauge",
      title: "Storage",
      data: [
        { label: "Files", value: 72 },
        { label: "Mail", value: 35 },
        { label: "Backups", value: 91 },
      ],
      unit: "%",
      thresholds: [{ value: 60 }, { value: 85 }, { value: 100 }],
    },
    {
      kind: "stat",
      title: "Acceptance",
      value: 0.31,
      format: { style: "percent" },
      delta: 0.04,
      better: "up",
      sparkline: [0.24, 0.26, 0.25, 0.29, 0.31],
    },
  ],
};
// Legends the contract allows: one entry per bar, and eight series with names up to 80 characters.
const crowded = {
  view: "chart",
  kind: "bar",
  title: "Offers by office",
  data: Array.from({ length: 40 }, (_, index) => ({ label: `Office ${index + 1}`, value: 10 + ((index * 7) % 23) })),
  colorByBar: true,
  legend: true,
};
const named = {
  view: "chart",
  kind: "line",
  title: "Offers by sales channel",
  series: Array.from({ length: 8 }, (_, index) => ({
    label: `Sales channel ${index + 1} with a long descriptive name for the regional partner network`.slice(0, 80),
    data: days(10 + index, index + 1),
  })),
};
// Key figures: a sparkline, a better and a worse change, and a text state, so tiles of one row differ in height.
const stats = {
  view: "stats",
  title: "Offers at a glance",
  subtitle: "January to September 2026",
  items: [
    { label: "Offers", value: 1284, sub: "Jan–Sep 2026", sparkline: [120, 132, 128, 141, 150, 146, 155, 160, 152] },
    { label: "Median price", value: 4950, format: { style: "currency", currency: "EUR" } },
    { label: "Acceptance", value: 0.31, format: { style: "percent" }, delta: 0.04, better: "up", sparkline: [0.24, 0.26, 0.29, 0.31] },
    { label: "Open volume", value: 612000, format: { style: "currency", currency: "EUR", compact: true }, delta: -48000, better: "up" },
    { label: "Import", value: "OK", sub: "37 rows without a price skipped" },
  ],
};
const statsSummary = {
  view: "stats",
  title: stats.title,
  subtitle: stats.subtitle,
  items: stats.items.map((item) => ({ label: item.label, sparkline: "sparkline" in item, sub: "sub" in item, delta: "delta" in item })),
};
const invoice = {
  view: "details",
  title: "Invoice RE-2026-0412",
  subtitle: "Checked against the order",
  items: [
    { label: "Supplier", type: "text", value: "Müller Bürobedarf GmbH" },
    { label: "Order", type: "ref", value: { type: "spaces.item", id: "item-42", title: "Office chairs for the second floor" } },
    { label: "Net", type: "number", value: 1840.5, format: { style: "currency", currency: "EUR" } },
    { label: "VAT", type: "number", value: 349.7, format: { style: "currency", currency: "EUR" } },
    { label: "Gross", type: "number", value: 2190.2, format: { style: "currency", currency: "EUR" } },
    { label: "Due", type: "date", value: "2026-10-30" },
    { label: "Routing ID", type: "text", value: null },
    { label: "Bank account", type: "text", value: "DE89 3704 0044 0532 0130 00 · COBADEFFXXX · Commerzbank Köln" },
  ],
};
const note = {
  view: "details",
  title: "Delivery LS-2026-118",
  items: [
    { label: "Recipient", type: "text", value: "Kolb Antik, Lager Süd" },
    { label: "Delivery address for freight forwarders arriving outside opening hours", type: "text", value: "Hof 2, Tor B" },
    {
      label: "Note",
      type: "text",
      value:
        "Two pallets, the second one with fragile glass: unload it by hand, keep it upright and store it in the dry area next to the loading ramp until the inventory check on Monday morning has counted every piece.",
    },
    {
      label: "Order",
      type: "ref",
      value: { type: "spaces.item", id: "item-77", title: "Display cabinets for the new showroom on the ground floor" },
    },
    { label: "Weight", type: "number", value: 412.5 },
  ],
};
const tasks = {
  view: "table",
  title: "Overdue tasks without an assignee",
  subtitle: "All spaces",
  columns: [
    { id: "task", label: "Task", type: "ref" },
    { id: "space", label: "Space", type: "text" },
    { id: "due", label: "Due", type: "date" },
    { id: "late", label: "Days late", type: "number" },
  ],
  rows: [
    { task: { type: "spaces.item", id: "item-7", title: "Renew the domain" }, space: "Operations", due: "2026-10-02", late: 9 },
    { task: { type: "spaces.item", id: "item-9", title: "Send the offer to Becker" }, space: "Sales", due: "2026-10-06", late: 5 },
    { task: { type: "spaces.item", id: "item-3" }, space: "Sales", due: "2026-10-09", late: 2 },
  ],
  sort: { column: "late", direction: "desc" },
};
// One dataset in a few views: monthly offers per region over two years, filtered by region and stepped by year.
const regions = ["North", "South", "West"];
const explorer = {
  view: "explorer",
  title: "Offers by month and region",
  subtitle: "Number of offers and median price, 2025 and 2026",
  columns: [
    { id: "year", label: "Year", type: "text" },
    { id: "month", label: "Month", type: "number" },
    { id: "region", label: "Region", type: "text" },
    { id: "count", label: "Offers", type: "number" },
    { id: "median", label: "Median price", type: "number", format: { style: "currency", currency: "EUR" } },
  ],
  rows: ["2025", "2026"].flatMap((year, y) =>
    regions.flatMap((region, r) =>
      Array.from({ length: 12 }, (_, index) => ({
        year,
        month: index + 1,
        region,
        count: 30 + r * 12 + y * 8 + ((index * (r + 5)) % 17),
        median: 4200 + r * 300 + y * 150 + ((index * 113) % 600),
      })),
    ),
  ),
  views: [
    { id: "count", label: "Offers", kind: "line", x: "month", y: "count", series: "region" },
    { id: "median", label: "Median price", kind: "scatter", x: "month", y: "median", series: "region" },
  ],
  controls: { filter: "region", step: "year", compare: true },
};
const explorerSummary = {
  view: "explorer",
  title: explorer.title,
  subtitle: explorer.subtitle,
  rows: explorer.rows.length,
  columns: explorer.columns.length,
  views: explorer.views.map(({ id, label, kind }) => ({ id, label, kind })),
  step: true,
  filter: true,
  compare: true,
};
// Comparison exceeds the inline row budget, while each individual step fits.
const largeExplorer = {
  ...explorer,
  rows: explorer.rows.flatMap((row) => [row, { ...row, region: `${row.region} annex` }]),
};
// Realistic data labels: a long step column label, a long filter label and step names of different lengths.
const longSteps = ["2024", "Fiscal year 2025 (preliminary figures)", "Fiscal year 2026 (preliminary figures)"];
const longExplorer = {
  ...explorer,
  columns: explorer.columns.map((column) =>
    column.id === "year"
      ? { ...column, label: "Fiscal reporting year of the original observation recorded in this dataset" }
      : column.id === "region"
        ? { ...column, label: "Sales region of the responsible office" }
        : column,
  ),
  rows: longSteps.flatMap((year, y) =>
    explorer.rows.filter((row) => row.year === "2025").map((row) => ({ ...row, year, count: row.count + y * 3 })),
  ),
};
// A column named like an Object member, with a missing cell that must sort as missing, not as the inherited member.
const memberExplorer = {
  view: "explorer",
  title: "Member names",
  columns: [
    { id: "name", label: "Name", type: "text" },
    { id: "constructor", label: "Constructor", type: "number" },
  ],
  rows: [
    { name: "One", constructor: 1 },
    { name: "Two", constructor: 2 },
    { name: "Missing", constructor: null },
  ],
  views: [{ id: "bar", label: "Bar", kind: "bar", x: "name", y: "constructor" }],
};
const referenceExplorer = {
  view: "explorer",
  title: "Product references",
  columns: [
    { id: "item", label: "Item", type: "ref" },
    { id: "name", type: "text" },
    { id: "stock", type: "number" },
  ],
  rows: [
    { item: { type: "spaces.item", id: "first", title: "First product" }, name: "A", stock: 1 },
    { item: { type: "spaces.item", id: "second", title: "Second product" }, name: "B", stock: 2 },
    { item: null, name: "C", stock: 3 },
  ],
  views: [{ id: "stock", label: "Stock", kind: "bar", x: "name", y: "stock" }],
};
const files: Record<string, unknown> = {
  "/views/product-references-12345678.view.json": referenceExplorer,
  "/views/offers-at-a-glance-0a1b2c3d.view.json": stats,
  "/views/invoice-re-2026-0412-4d5e6f7a.view.json": invoice,
  "/views/overdue-tasks-8b9c0d1e.view.json": tasks,
  "/views/footer-reference-5a6b7c8d.view.json": {
    view: "table",
    title: "Task references",
    columns: [
      { id: "task", label: "Task", type: "ref" },
      { id: "__proto__", label: "Missing reference", type: "ref" },
    ],
    rows: [{ task: tasks.rows[0]!.task }],
    footer: { task: { type: "spaces.item", id: "item-42", title: "All tasks" } },
  },
  // Edited after `present`: a tile lost the sparkline its summary reserved.
  "/views/flattened-2f3a4b5c.view.json": { ...stats, items: stats.items.map(({ sparkline: _sparkline, ...item }) => item) },
  // A record whose values wrap over several lines on a phone, and its file after the note grew.
  "/views/delivery-note-1c2d3e4f.view.json": note,
  "/views/delivery-note-grown-2d3e4f5a.view.json": {
    ...note,
    items: note.items.map((item) => (item.label === "Note" ? { ...item, value: `${item.value} Call ahead.` } : item)),
  },
  // Edited after `present`: the stats title and table subtitle changed.
  "/views/retitled-stats-6a7b8c9d.view.json": { ...stats, title: "Updated offers at a glance" },
  "/views/resubtitled-table-7b8c9d0e.view.json": { ...table, subtitle: "Updated median price in EUR" },
  "/views/explorer-more-0a1b2c3e.view.json": largeExplorer,
  "/views/explorer-long-labels-0a1b2c41.view.json": longExplorer,
  "/views/explorer-member-names-0a1b2c42.view.json": memberExplorer,
  "/views/explorer-views-edited-0a1b2c3f.view.json": { ...explorer, views: explorer.views.slice(1) },
  "/views/explorer-controls-edited-0a1b2c40.view.json": { ...explorer, controls: { step: "year" } },
  // Edited after `present`: the cursor is no longer linked, and a chart gained a subtitle its summary did not reserve.
  "/views/unlinked-4e5f6a7b.view.json": { ...linked, linkX: false },
  "/views/subtitled-8c9d0e1f.view.json": chart,
  "/views/offers-by-office-2d3e4f5a.view.json": crowded,
  "/views/offers-by-sales-channel-6b7c8d9e.view.json": named,
  "/views/offers-and-acceptance-7a8b9c0d.view.json": linked,
  "/views/prices-and-capacity-1b2c3d4e.view.json": kinds,
  "/views/offers-by-status-1a2b3c4d.view.json": chart,
  "/views/offers-per-month-5e6f7a8b.view.json": table,
  "/views/prices-by-region-3c4d5e6f.view.json": small,
  "/views/offers-by-month-and-region-0a1b2c3d.view.json": explorer,
};

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
/** Files a test holds back until it releases them, so it can measure the loading frame without racing the file. */
const held = new Map<string, PromiseWithResolvers<void>>();
const release = (path: string) => {
  held.get(path)?.resolve();
  held.delete(path);
};
const hold = (path: string) => {
  held.set(path, Promise.withResolvers<void>());
  return () => release(path);
};
// A test that fails while holding a file must not leave it held for the next one.
afterEach(() => {
  for (const path of [...held.keys()]) release(path);
});
beforeAll(async () => {
  const [harness, styles] = await Promise.all([
    buildHarness(),
    Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../../styles.css")], plugins: [tailwind] }),
  ]);
  if (!styles.success) throw new AggregateError(styles.logs, "Could not compile the global stylesheet.");
  const css = await styles.outputs[0]!.text();
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/harness.js") return new Response(harness, { headers: { "content-type": "text/javascript" } });
      // View files arrive late, so a block that sized itself by its content would move what follows it.
      if (url.pathname === "/files") {
        const path = url.searchParams.get("path") ?? "";
        const file = files[path];
        return Promise.all([Bun.sleep(400), held.get(path)?.promise]).then(() =>
          file ? Response.json(file, { headers: { "X-Cloud-Ai-File-Origin": "assistant" } }) : new Response(null, { status: 404 }),
        );
      }
      if (url.pathname !== "/") return new Response(null, { status: 404 });
      const lang = url.searchParams.get("lang") ?? "en";
      const theme = url.searchParams.get("theme") ?? "light";
      return new Response(
        `<!doctype html><html lang="${lang}" class="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1">` +
          `<style>${css}</style></head><body class="k2b-ui" style="margin: 0"><script src="/harness.js"></script></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;
declare global {
  interface Window {
    show: (blocks: ToolBlock[]) => void;
    opened: { title: string; ref: CloudResourceRef }[];
  }
}
const present = (path: string, view: unknown): ToolBlock => ({
  id: path,
  kind: "tool",
  callId: path,
  name: "present",
  args: { path },
  status: "completed",
  result: { path, size: 900, mediaType: "application/json", view },
});
const groupSummary = (group: typeof linked | typeof kinds) => ({
  view: "group",
  title: group.title,
  ...("subtitle" in group ? { subtitle: group.subtitle } : {}),
  linkX: "linkX" in group ? group.linkX : false,
  layout: "layout" in group ? group.layout : "stack",
  charts: group.charts.map((chart) => ({ kind: chart.kind, title: chart.title })),
});
const blocks = [
  present("/views/offers-and-acceptance-7a8b9c0d.view.json", groupSummary(linked)),
  present("/views/prices-and-capacity-1b2c3d4e.view.json", groupSummary(kinds)),
  present("/views/offers-by-status-1a2b3c4d.view.json", { view: "chart", kind: "bar", title: chart.title, subtitle: chart.subtitle }),
  present("/views/offers-per-month-5e6f7a8b.view.json", {
    view: "table",
    title: table.title,
    subtitle: table.subtitle,
    rows: table.rows.length,
    columns: table.columns.length,
    footer: true,
  }),
  present("/views/prices-by-region-3c4d5e6f.view.json", {
    view: "table",
    title: small.title,
    rows: small.rows.length,
    columns: small.columns.length,
    footer: true,
  }),
  present("/views/deleted-9c0d1e2f.view.json", { view: "table", title: "Deleted view", rows: 3, columns: 2, footer: false }),
];

// The stats, details and reference views load on their own page, so each page's counts check one set of views. A
// load that fails with ERR_NETWORK_CHANGED is a host fault: Chromium aborts every request in flight, also to
// 127.0.0.1, when a network interface comes or goes, such as a Docker container's while it restarts.
const widgets = [
  present("/views/offers-at-a-glance-0a1b2c3d.view.json", statsSummary),
  present("/views/invoice-re-2026-0412-4d5e6f7a.view.json", cloudAiViewSummary(parseCloudAiView(invoice)!)),
  present("/views/overdue-tasks-8b9c0d1e.view.json", {
    view: "table",
    title: tasks.title,
    subtitle: tasks.subtitle,
    rows: tasks.rows.length,
    columns: tasks.columns.length,
    footer: false,
  }),
];

const boxes = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-view-path]")).map((node) => {
      const box = node.getBoundingClientRect();
      return [box.top, box.height].map(Math.round);
    }),
  );

for (const view of [
  { name: "desktop", width: 1280, height: 900, touch: false },
  { name: "phone", width: 390, height: 844, touch: true },
] as const)
  for (const theme of ["light", "dark"] as const)
    test(`a presented view keeps its size while its file loads (${view.name}, ${theme})`, async () => {
      const context = await browser.newContext({
        viewport: { width: view.width, height: view.height },
        isMobile: view.touch,
        hasTouch: view.touch,
        reducedMotion: "reduce",
      });
      try {
        const page = await context.newPage();
        await page.goto(`http://127.0.0.1:${server.port}/?lang=${theme === "dark" ? "de" : "en"}&theme=${theme}`);
        await page.evaluate((value) => window.show(value), blocks);
        await page.waitForSelector("[data-view-path]");
        const loading = await boxes(page);
        await page.waitForSelector('[data-view-path] [data-chart-kind="bar"]');
        await page.waitForSelector('[data-view-path] [data-chart-kind="stat"]');
        expect(await page.locator('[data-view-path] [data-interactive="true"]').count()).toBe(7);
        await page.waitForFunction(() => document.querySelectorAll("[data-view-path] table").length === 2);
        await page.waitForFunction(() => document.querySelectorAll('[data-view-path] [role="status"]').length === 1);
        // Every series name stays inside its chart's column, also on a phone.
        const legends = await page.evaluate(() =>
          Array.from(document.querySelectorAll(".k2b-chart-legend li")).map((item) => {
            const box = item.getBoundingClientRect();
            const frame = item.closest(".k2b-chart-explorer")!.getBoundingClientRect();
            return box.left >= frame.left - 0.5 && box.right <= frame.right + 0.5;
          }),
        );
        expect(legends).toEqual([true, true, true, true]);
        expect(await boxes(page)).toEqual(loading);
        // Up to eight rows, header and totals included, show without scrolling inside the reserved viewport.
        const small = await page.evaluate(() => {
          const wrap = document.querySelector('[data-view-path*="prices-by-region"] .k2b-table-wrap')!;
          return { scroll: wrap.scrollHeight, client: wrap.clientHeight };
        });
        expect(small.scroll).toBeLessThanOrEqual(small.client);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
        if (process.env.VIEW_SHOTS)
          await page.screenshot({ path: `${process.env.VIEW_SHOTS}/views-${view.name}-${theme}.png`, fullPage: true });
      } finally {
        await context.close();
      }
    });

for (const view of [
  { name: "desktop", width: 1280, height: 900, touch: false },
  { name: "phone", width: 390, height: 844, touch: true },
] as const)
  for (const theme of ["light", "dark"] as const)
    test(`stats, a record and references keep their size while their files load (${view.name}, ${theme})`, async () => {
      const context = await browser.newContext({
        viewport: { width: view.width, height: view.height },
        isMobile: view.touch,
        hasTouch: view.touch,
        reducedMotion: "reduce",
      });
      try {
        const page = await context.newPage();
        await page.goto(`http://127.0.0.1:${server.port}/?lang=${theme === "dark" ? "de" : "en"}&theme=${theme}`);
        await page.evaluate((value) => (window as unknown as { show: (blocks: ToolBlock[]) => void }).show(value), widgets);
        await page.waitForSelector("[data-view-path]");
        const loading = await boxes(page);
        await page.waitForFunction(() => document.querySelectorAll("[data-view-path] .k2b-stat-cell").length === 5);
        // The hidden copy that sizes the record keeps its eight rows beside the eight loaded ones.
        await page.waitForFunction(() => document.querySelectorAll("[data-view-path] dt").length === 16);
        await page.waitForFunction(() => document.querySelectorAll("[data-view-path] table").length === 1);
        expect(await page.locator('[data-view-path] [role="status"]').count()).toBe(0);
        expect(await boxes(page)).toEqual(loading);
        // Five tiles leave no empty slot in any column count: the last one reaches the grid's end.
        const gap = await page.evaluate(() => {
          const body = document.querySelector("[data-view-path] .k2b-stat-grid__body")!;
          return Math.abs(body.lastElementChild!.getBoundingClientRect().right - body.getBoundingClientRect().right);
        });
        expect(gap).toBeLessThan(1);
        // Reference pills keep compact rows, so three rows fit the reserved viewport without scrolling.
        const references = await page.evaluate(() => {
          const wrap = document.querySelector('[data-view-path*="overdue-tasks"] .k2b-table-wrap')!;
          return { scroll: wrap.scrollHeight, client: wrap.clientHeight };
        });
        expect(references.scroll).toBeLessThanOrEqual(references.client);
        // A record of eight fields shows them all without scrolling, also where the bank line and the order wrap on a phone.
        const record = await page.evaluate(() => {
          const viewport = Array.from(document.querySelectorAll('[data-view-path*="invoice"] dl')).at(-1)!.parentElement!;
          return { scroll: viewport.scrollHeight, client: viewport.clientHeight };
        });
        expect(record.scroll).toBeLessThanOrEqual(record.client);
        // The host colors a change by whether it is better, and the tile names it with a sign.
        const changes = await page.evaluate(() =>
          Array.from(document.querySelectorAll("[data-view-path] .k2b-stat-cell__accent")).map((node) => [
            node.getAttribute("data-tone"),
            node.textContent,
          ]),
        );
        expect(changes.map(([tone]) => tone)).toEqual(["emerald", "red"]);
        expect(changes[0]![1]).toStartWith("+");
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
        if (process.env.VIEW_SHOTS)
          await page.screenshot({ path: `${process.env.VIEW_SHOTS}/widgets-${view.name}-${theme}.png`, fullPage: true });
      } finally {
        await context.close();
      }
    });

test("a stats trend tooltip uses the item label and number format", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/?lang=en`);
    await page.evaluate((value) => window.show(value), [widgets[0]!]);
    await page.waitForFunction(() => document.querySelectorAll("[data-view-path] .k2b-stat-cell").length === 5);
    const tile = page.locator("[data-view-path] .k2b-stat-cell").filter({
      has: page.locator(".k2b-stat-cell__label", { hasText: /^Acceptance$/ }),
    });
    await tile.locator(".k2b-stat-cell__trend [data-chart-datum] circle").last().hover();
    const tooltip = tile.locator('[role="tooltip"]:popover-open');
    await tooltip.waitFor({ state: "visible" });
    const expected = cloudAiNumberFormatters({ style: "percent" }, "en").value(0.31);
    expect(await tooltip.locator(".k2b-chart__tooltip-title").count()).toBe(0);
    expect(
      await tooltip
        .locator(".k2b-chart__tooltip-row")
        .evaluateAll((rows) =>
          rows.map((row) => [row.querySelector("span")?.textContent?.replace(/:\s*$/, ""), row.querySelector("b")?.textContent]),
        ),
    ).toEqual([["Acceptance", expected]]);
    expect(await tooltip.locator("b").textContent()).toBe(await tile.locator(".k2b-stat-cell__value").textContent());
    expect(await tooltip.textContent()).not.toMatch(/\b[XY]:/);
  } finally {
    await context.close();
  }
});

test("a record reserves the lines of values and labels that wrap on a phone", async () => {
  const context = await browser.newContext({
    viewport: { width: 360, height: 800 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce",
  });
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.evaluate(
      (value) => (window as unknown as { show: (blocks: ToolBlock[]) => void }).show(value),
      [present("/views/delivery-note-1c2d3e4f.view.json", cloudAiViewSummary(parseCloudAiView(note)!))],
    );
    await page.waitForSelector("[data-view-path]");
    const loading = await boxes(page);
    await page.waitForFunction(() => document.querySelectorAll("[data-view-path] dt").length === 10);
    expect(await boxes(page)).toEqual(loading);
    const record = await page.evaluate(() => {
      const [copy, list] = Array.from(document.querySelectorAll("[data-view-path] dl"));
      const heights = (dl: Element) => Array.from(dl.children).map((row) => row.getBoundingClientRect().height);
      return {
        scroll: list!.parentElement!.scrollHeight,
        client: list!.parentElement!.clientHeight,
        copy: heights(copy!),
        list: heights(list!),
      };
    });
    // Every field shows without scrolling; a row's stand-in takes the lines of its value or one more.
    expect(record.scroll).toBeLessThanOrEqual(record.client);
    expect(record.copy).toHaveLength(5);
    record.copy.forEach((height, index) => {
      expect(height).toBeGreaterThanOrEqual(record.list[index]!);
      expect(height).toBeLessThanOrEqual(record.list[index]! + 20);
    });
  } finally {
    await context.close();
  }
});

test("a card shows all of its text on a phone, also a long value, caption and trend", async () => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce",
  });
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.evaluate(
      (value) => (window as unknown as { showCards: (cards: unknown[]) => void }).showCards(value),
      [
        {
          title: "Deploy checks for the production cluster in Frankfurt",
          value: "All 12 deploy checks passed",
          caption: "Compared with the same quarter last year, driven mostly by the new enterprise contracts in the DACH region",
          trendValue: "+12%",
          trendLabel: "versus the same quarter of the previous fiscal year",
          trendDirection: "up",
        },
      ],
    );
    await page.waitForSelector(".k2b-stat-cell");
    const parts = await page.evaluate(() => {
      const cell = document.querySelector(".k2b-stat-cell")!.getBoundingClientRect();
      return Array.from(
        document.querySelectorAll(".k2b-stat-cell__label, .k2b-stat-cell__value, .k2b-stat-cell__sub, .k2b-stat-cell__accent"),
      ).map((node) => {
        const box = node.getBoundingClientRect();
        return {
          name: node.className,
          whole: node.scrollWidth <= node.clientWidth && box.width > 0 && box.right <= cell.right + 0.5,
        };
      });
    });
    expect(parts).toHaveLength(4);
    for (const part of parts) expect(part).toEqual({ name: part.name, whole: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  } finally {
    await context.close();
  }
});

test("a tap on one chart of a linked group moves the cursor in every chart of the group (phone)", async () => {
  const context = await browser.newContext({
    viewport: { width: 360, height: 800 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce",
  });
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.evaluate((value) => window.show(value), [blocks[0]!]);
    const charts = page.locator('[data-view-path] [data-interactive="true"]');
    await page.waitForFunction(() => document.querySelectorAll('[data-view-path] [data-interactive="true"]').length === 2);
    const box = (await charts.first().boundingBox())!;
    await page.touchscreen.tap(box.x + box.width * 0.6, box.y + box.height * 0.4);
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll('[data-view-path] [data-interactive="true"]')).every(
        (chart) => chart.getAttribute("data-inspecting") === "series",
      ),
    );
    // The shared tooltip names the day once, in the reader's format.
    expect(await page.locator(".k2b-chart__tooltip:popover-open").first().textContent()).toContain("Sep");
  } finally {
    await context.close();
  }
});

test("a long legend never squeezes its chart on a phone", async () => {
  const context = await browser.newContext({
    viewport: { width: 360, height: 800 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce",
  });
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.evaluate(
      (value) => window.show(value),
      [
        present("/views/offers-by-office-2d3e4f5a.view.json", { view: "chart", kind: "bar", title: crowded.title }),
        present("/views/offers-by-sales-channel-6b7c8d9e.view.json", { view: "chart", kind: "line", title: named.title }),
      ],
    );
    await page.waitForFunction(() => document.querySelectorAll(".k2b-chart-legend").length === 2);
    const frames = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>(".k2b-chart-explorer__viewport[data-legend]")).map((viewport) => {
        const frame = viewport.getBoundingClientRect();
        const chart = viewport.querySelector(":scope > .k2b-chart")!.getBoundingClientRect();
        const legend = viewport.querySelector<HTMLElement>(":scope > .k2b-chart-legend")!;
        return {
          chart: chart.height / frame.height,
          // The legend scrolls inside the frame; the frame itself never grows or scrolls.
          inside: legend.getBoundingClientRect().bottom <= frame.bottom + 0.5,
          scrolls: legend.scrollHeight > legend.clientHeight,
          frame: viewport.scrollHeight <= viewport.clientHeight + 1,
        };
      }),
    );
    expect(frames).toHaveLength(2);
    for (const frame of frames) {
      expect(frame.chart).toBeGreaterThanOrEqual(0.6 - 0.01);
      expect(frame).toMatchObject({ inside: true, scrolls: true, frame: true });
    }
  } finally {
    await context.close();
  }
});

test("a reference in a table or a record opens through the host with its title and no URL", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.evaluate((value) => (window as unknown as { show: (blocks: ToolBlock[]) => void }).show(value), widgets.slice(1));
    await page.getByRole("button", { name: "Office chairs for the second floor" }).click();
    // Without a title the reference shows its id.
    await page.getByRole("button", { name: "item-3" }).click();
    expect(await page.evaluate(() => (window as unknown as { opened: unknown[] }).opened)).toEqual([
      { title: "Office chairs for the second floor", ref: { type: "spaces.item", id: "item-42" } },
      { title: "item-3", ref: { type: "spaces.item", id: "item-3" } },
    ]);
  } finally {
    await context.close();
  }
});

test("a table omits inherited reference cells and opens footer references through the host", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.evaluate(
      (value) => (window as unknown as { show: (blocks: ToolBlock[]) => void }).show(value),
      [
        present("/views/footer-reference-5a6b7c8d.view.json", {
          view: "table",
          title: "Task references",
          rows: 1,
          columns: 2,
          footer: true,
        }),
      ],
    );
    await page.waitForSelector("[data-view-path] table");
    // A missing cell shows the table's empty mark, not a reference to Object.prototype.
    const missing = page.locator("tbody td").last();
    expect(await missing.textContent()).toBe("—");
    expect(await missing.getByRole("button").count()).toBe(0);
    await page.locator("tfoot").getByRole("button", { name: "All tasks" }).click();
    expect(await page.evaluate(() => (window as unknown as { opened: unknown[] }).opened)).toEqual([
      { title: "All tasks", ref: { type: "spaces.item", id: "item-42" } },
    ]);
  } finally {
    await context.close();
  }
});

test("a view file edited after present shows unavailable instead of what its summary did not reserve", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.evaluate(
      (value) => window.show(value),
      [
        present("/views/unlinked-4e5f6a7b.view.json", groupSummary(linked)),
        present("/views/subtitled-8c9d0e1f.view.json", { view: "chart", kind: "bar", title: chart.title }),
        present("/views/flattened-2f3a4b5c.view.json", statsSummary),
        present("/views/retitled-stats-6a7b8c9d.view.json", statsSummary),
        present("/views/delivery-note-grown-2d3e4f5a.view.json", cloudAiViewSummary(parseCloudAiView(note)!)),
        present("/views/resubtitled-table-7b8c9d0e.view.json", {
          view: "table",
          title: table.title,
          subtitle: table.subtitle,
          rows: table.rows.length,
          columns: table.columns.length,
          footer: true,
        }),
        present("/views/explorer-views-edited-0a1b2c3f.view.json", explorerSummary),
        present("/views/explorer-controls-edited-0a1b2c40.view.json", explorerSummary),
      ],
    );
    // Both charts of the group, the single chart, both stats views, the record, the table and the two edited explorers.
    await page.waitForFunction(() => {
      const statuses = Array.from(document.querySelectorAll('[data-view-path] [role="status"]')).filter((node) => node.textContent?.trim());
      return statuses.length === 9 && statuses.every((node) => node.textContent?.startsWith("This view is no longer available"));
    });
    // Only the invisible size reserve of a stats view may still hold a (hidden, unfocusable) trend sparkline.
    expect(await page.locator('[data-view-path] [data-interactive="true"]:visible').count()).toBe(0);
  } finally {
    await context.close();
  }
});

const explorerViewport = (page: Page) =>
  page.evaluate(() => {
    const box = document.querySelector(".k2b-chart-explorer__viewport")!.getBoundingClientRect();
    return [box.top, box.height].map(Math.round);
  });
/**
 * The frame of a presented explorer whose file the test holds back: every view box and the explorer viewport,
 * measured in one call, so the loaded explorer can never replace the measured nodes halfway.
 */
const explorerLoadingFrame = async (page: Page) => {
  await page.waitForSelector('[data-view-path] .k2b-chart-explorer__viewport [role="status"]');
  return page.evaluate(() => {
    const viewport = document.querySelector(".k2b-chart-explorer__viewport")!.getBoundingClientRect();
    return {
      interactive: document.querySelectorAll('[data-view-path] [data-interactive="true"]').length,
      boxes: Array.from(document.querySelectorAll("[data-view-path]")).map((node) => {
        const box = node.getBoundingClientRect();
        return [box.top, box.height].map(Math.round);
      }),
      viewport: [viewport.top, viewport.height].map(Math.round),
    };
  });
};
const explorerRows = (page: Page) =>
  page
    .locator("tbody .k2b-data-table__row")
    .evaluateAll((rows) => rows.map((row) => Array.from(row.querySelectorAll("td")).map((cell) => cell.textContent?.trim())));
const pickExplorerView = async (page: Page, label: string, german = false) => {
  await page.getByRole("button", { name: german ? "Diagrammansicht" : "Chart view", exact: true }).click();
  await page.getByRole("menuitemradio", { name: label, exact: true }).click();
};
const PointSchema = z.object({
  index: z.number(),
  seriesIndex: z.number(),
  values: z.array(z.object({ key: z.string(), value: z.union([z.string(), z.number()]) })),
});

for (const view of [
  { name: "desktop", width: 1280, height: 900, touch: false },
  { name: "phone", width: 360, height: 800, touch: true },
] as const)
  for (const theme of ["light", "dark"] as const)
    test(`an explorer preserves its frame and shares comparison, filtering and selection (${view.name}, ${theme})`, async () => {
      const context = await browser.newContext({
        viewport: { width: view.width, height: view.height },
        isMobile: view.touch,
        hasTouch: view.touch,
        reducedMotion: "reduce",
      });
      try {
        const page = await context.newPage();
        const german = theme === "dark";
        await page.goto(`http://127.0.0.1:${server.port}/?lang=${german ? "de" : "en"}&theme=${theme}`);
        // Exercise a 320px chat column inside the 360px phone, including the harness's padding.
        if (view.touch)
          await page.locator("main").evaluate((node) => {
            node.style.maxWidth = "352px";
          });
        const path = "/views/offers-by-month-and-region-0a1b2c3d.view.json";
        const loaded = hold(path);
        await page.evaluate((value) => window.show(value), [present(path, explorerSummary)]);
        const frame = await explorerLoadingFrame(page);
        expect(frame.interactive).toBe(0);
        const { boxes: loading, viewport } = frame;
        expect(viewport[1]).toBe(288);
        const stable = async () => {
          expect(await boxes(page)).toEqual(loading);
          expect(await explorerViewport(page)).toEqual(viewport);
        };
        const fits = async () => {
          expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
          const controls = await page.locator(".k2b-chart-explorer").evaluate((node) => {
            const frame = node.getBoundingClientRect();
            const slider = node.querySelector(".k2b-chart-explorer__dimension")!.getBoundingClientRect();
            const filter = node.querySelector(".k2b-filter-chip")!.getBoundingClientRect();
            const pin = node.querySelector(".k2b-chart-explorer__pin")!.getBoundingClientRect();
            return {
              width: frame.width,
              inside: [slider, filter, pin].every((box) => box.left >= frame.left - 0.5 && box.right <= frame.right + 0.5),
              sameRow: Math.abs((filter.top + filter.bottom) / 2 - (pin.top + pin.bottom) / 2) <= 0.5,
              sliderAbove: slider.bottom <= filter.top,
            };
          });
          expect(controls).toMatchObject({ inside: true, sameRow: true, sliderAbove: true });
          if (view.touch) expect(controls.width).toBeLessThanOrEqual(320);
        };
        const shot = async (suffix = "") => {
          if (process.env.VIEW_SHOTS)
            await page.screenshot({ path: `${process.env.VIEW_SHOTS}/explorer-${view.name}-${theme}${suffix}.png` });
        };
        await shot("-loading");
        loaded();
        await page.waitForSelector('[data-view-path] [data-interactive="true"]');
        expect(await page.locator(".k2b-chart-legend li").allTextContents()).toEqual(regions);
        await stable();
        await fits();
        await shot();

        await page.getByRole("button", { name: german ? "Als Vergleich merken" : "Pin as reference" }).click();
        await stable();
        await fits();
        const slider = page.getByRole("slider", { name: "Year", exact: true });
        await slider.focus();
        await page.keyboard.press("ArrowLeft");
        await page.waitForFunction(() => document.querySelector('input[type="range"]')?.getAttribute("aria-valuetext") === "2025");
        await page.waitForSelector('.k2b-chart-legend [data-reference="true"]');
        const expectedLegend = regions.map((region) => `${region} · 2025`).concat(regions.map((region) => `${region} · 2026`));
        expect(await page.locator(".k2b-chart-legend li").allTextContents()).toEqual(expectedLegend);
        expect(await page.locator('.k2b-chart-legend [data-reference="true"][data-style="dashed"]').count()).toBe(3);
        await stable();
        await fits();
        await shot("-compare");
        await page.getByRole("button", { name: german ? "Diagrammansicht" : "Chart view", exact: true }).click();
        expect(await page.getByRole("menuitemradio").allTextContents()).toEqual(["Offers", "Median price", german ? "Tabelle" : "Table"]);
        await shot("-menu");
        await page.getByRole("menuitemradio", { name: "Median price", exact: true }).click();
        await page.waitForSelector('[data-chart-kind="scatter"]');
        await stable();
        await pickExplorerView(page, german ? "Tabelle" : "Table", german);
        await page.waitForSelector("tbody .k2b-data-table__row");
        const expectedRows = explorer.rows.map((row) => [row.year, String(row.month), row.region, String(row.count)]);
        expect((await explorerRows(page)).map((cells) => cells.slice(0, 4))).toEqual(expectedRows);
        expect(await page.locator("tbody .k2b-data-table__row").count()).toBeLessThanOrEqual(100);
        await stable();

        // The table's Region header is a sort button too; the series filter is the chip.
        await page.locator(".k2b-chart-explorer .k2b-filter-chip").getByText("Region", { exact: true }).click();
        const north = page.getByRole("menuitemcheckbox", { name: "North", exact: true });
        expect(await north.getAttribute("aria-checked")).toBe("true");
        await north.click();
        await page.waitForFunction(() => document.querySelectorAll("tbody .k2b-data-table__row").length === 48);
        expect(await north.getAttribute("aria-checked")).toBe("false");
        await page.keyboard.press("Escape");
        const filtered = expectedRows.filter((cells) => cells[2] !== "North");
        expect((await explorerRows(page)).map((cells) => cells.slice(0, 4))).toEqual(filtered);
        await stable();
        await pickExplorerView(page, "Offers", german);
        await page.waitForSelector('[data-chart-kind="line"]');
        expect(await page.locator(".k2b-chart-legend li").allTextContents()).toEqual(
          expectedLegend.filter((label) => !label.startsWith("North")),
        );
        expect(await page.locator('.k2b-chart-legend [data-reference="true"][data-style="dashed"]').count()).toBe(2);
        await stable();
        await fits();

        await pickExplorerView(page, "Median price", german);
        await page.waitForSelector('[data-chart-kind="scatter"]');
        const mark = page.locator("[data-chart-datum]:not([data-chart-reference])").nth(4);
        if (view.touch) await mark.tap();
        else await mark.click();
        await page.waitForSelector("[data-chart-datum][data-selected]");
        const selected = PointSchema.parse(JSON.parse((await mark.getAttribute("data-chart-datum"))!));
        expect(selected).toMatchObject({ index: 4, seriesIndex: 1 });
        // The tooltip names the encoded columns of the picked row, also for a series other than the first.
        const tooltip = await page.locator(".k2b-chart__tooltip:popover-open").first().textContent();
        expect(tooltip).toContain("Median price");
        expect(tooltip).toContain("Month");
        await pickExplorerView(page, german ? "Tabelle" : "Table", german);
        await page.waitForSelector('tbody .k2b-data-table__row[data-selected="true"]');
        expect(await page.locator('tbody .k2b-data-table__row[data-selected="true"] td').allTextContents()).toEqual(
          (await explorerRows(page))[4]!,
        );
        expect((await explorerRows(page))[4]?.slice(0, 3)).toEqual(["2025", "5", "South"]);
        const other = page.locator("tbody .k2b-data-table__row").nth(16);
        if (view.touch) await other.locator("button").tap();
        else await other.locator("button").click();
        expect(await other.getAttribute("data-selected")).toBe("true");
        expect((await explorerRows(page))[16]?.slice(0, 3)).toEqual(["2025", "5", "West"]);
        await pickExplorerView(page, "Median price", german);
        await page.waitForSelector("[data-chart-datum][data-selected]");
        expect(await page.locator("[data-chart-datum][data-selected]").count()).toBe(1);
        const highlighted = PointSchema.parse(
          JSON.parse((await page.locator("[data-chart-datum][data-selected]").getAttribute("data-chart-datum"))!),
        );
        expect(highlighted).toMatchObject({ index: 4, seriesIndex: 2 });
        expect(highlighted.values.find((value) => value.key === "x")?.value).toBe(5);
        await stable();
        await fits();
        await shot("-selected");
        await page.getByRole("button", { name: german ? "Vergleich entfernen: 2026" : "Remove comparison: 2026" }).click();
        await page.waitForFunction(() => !document.querySelector("[data-chart-reference]"));
        await stable();
        await fits();
      } finally {
        await context.close();
      }
    }, 30_000);

test("an explorer keeps its controls on one line inside a phone column with long labels and step names", async () => {
  const context = await browser.newContext({
    viewport: { width: 360, height: 800 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce",
  });
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/`);
    // A 320px chat column inside the 360px phone, including the harness's padding.
    await page.locator("main").evaluate((node) => {
      node.style.maxWidth = "352px";
    });
    const path = "/views/explorer-long-labels-0a1b2c41.view.json";
    const loaded = hold(path);
    await page.evaluate((value) => window.show(value), [present(path, { ...explorerSummary, rows: longExplorer.rows.length })]);
    const frame = await explorerLoadingFrame(page);
    loaded();
    await page.waitForSelector('[data-view-path] [data-interactive="true"]');
    const layout = () =>
      page.evaluate(() => {
        const section = document.querySelector(".k2b-chart-explorer")!;
        const box = section.getBoundingClientRect();
        const controls = Array.from(section.querySelectorAll(".k2b-chart-explorer__dimension, .k2b-filter-chip, .k2b-chart-explorer__pin"));
        return {
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          width: Math.round(box.width),
          track: Math.round(section.querySelector('input[type="range"]')!.getBoundingClientRect().width),
          inside: controls.every((node) => {
            const control = node.getBoundingClientRect();
            return control.left >= box.left - 0.5 && control.right <= box.right + 0.5;
          }),
        };
      });
    expect(await boxes(page)).toEqual(frame.boxes);
    const initial = await layout();
    expect(initial).toMatchObject({ overflow: 0, inside: true });
    expect(initial.width).toBeLessThanOrEqual(320);
    expect(initial.track).toBeGreaterThan(120);

    // Pinning shows the long step name in the pin; stepping shows shorter and longer names. Nothing moves or grows.
    await page.getByRole("button", { name: "Pin as reference" }).click();
    await page.getByRole("slider").focus();
    for (const step of [longSteps[1], longSteps[0]]) {
      await page.keyboard.press("ArrowLeft");
      await page.waitForFunction((label) => document.querySelector('input[type="range"]')?.getAttribute("aria-valuetext") === label, step);
      expect(await layout()).toEqual(initial);
      expect(await boxes(page)).toEqual(frame.boxes);
    }

    // The filter names each region in the color the chart draws it with.
    const legendColor = await page
      .locator(".k2b-chart-legend li", { hasText: "South · 2024" })
      .locator(".k2b-chart-legend__swatch")
      .evaluate((node) => getComputedStyle(node).backgroundColor);
    await page.locator(".k2b-chart-explorer .k2b-filter-chip").tap();
    const filterColor = await page
      .getByRole("menuitemcheckbox", { name: "South", exact: true })
      .locator(".k2b-dropdown__color")
      .evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(filterColor).toBe(legendColor);
  } finally {
    await context.close();
  }
});

test("an explorer table caps the combined current and reference rows at 100", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.evaluate(
      (value) => window.show(value),
      [present("/views/explorer-more-0a1b2c3e.view.json", { ...explorerSummary, rows: largeExplorer.rows.length })],
    );
    await page.waitForSelector('[data-interactive="true"]');
    const frame = await boxes(page);
    await pickExplorerView(page, "Table");
    await page.waitForSelector("tbody .k2b-data-table__row");
    const [initialRows, initialNotes] = await Promise.all([explorerRows(page), page.locator(".k2b-chart-explorer__note").count()]);
    expect(initialRows.map((cells) => cells.slice(0, 3))).toEqual(
      largeExplorer.rows.filter((row) => row.year === "2026").map((row) => [row.year, String(row.month), row.region]),
    );
    expect(initialNotes).toBe(0);
    await page.getByRole("button", { name: "Pin as reference" }).click();
    await page.getByRole("slider", { name: "Year", exact: true }).press("ArrowLeft");
    await page.waitForSelector(".k2b-chart-explorer__note");
    const [rows, note, finalFrame] = await Promise.all([
      explorerRows(page),
      page.locator(".k2b-chart-explorer__note").textContent(),
      boxes(page),
    ]);
    expect(rows).toHaveLength(100);
    expect(note).toContain("Showing 100 of 144 rows");
    expect(rows.map((cells) => cells.slice(0, 3))).toEqual(
      largeExplorer.rows.slice(0, 100).map((row) => [row.year, String(row.month), row.region]),
    );
    expect(finalFrame).toEqual(frame);
  } finally {
    await context.close();
  }
});

test("an explorer table sorts a missing cell last, also in a column named like an Object member", async () => {
  const parsed = parseCloudAiView(memberExplorer);
  if (!parsed) throw new Error("Invalid member explorer");
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.evaluate(
      (block) => window.show([block]),
      present("/views/explorer-member-names-0a1b2c42.view.json", cloudAiViewSummary(parsed)),
    );
    await page.waitForSelector('[data-view-path] [data-interactive="true"]');
    await pickExplorerView(page, "Table");
    const header = page.getByRole("button", { name: "Constructor", exact: true });
    await header.click();
    await page.waitForFunction(() => document.querySelector("tbody tr td")?.textContent?.trim() === "One");
    expect((await explorerRows(page)).map((cells) => cells[0])).toEqual(["One", "Two", "Missing"]);
    await header.click();
    await page.waitForFunction(() => document.querySelector("tbody tr td")?.textContent?.trim() === "Two");
    expect((await explorerRows(page)).map((cells) => cells[0])).toEqual(["Two", "One", "Missing"]);
  } finally {
    await context.close();
  }
});

test("explorer references open the original dataset row after table sorting and copy only titles", async () => {
  const parsed = parseCloudAiView(referenceExplorer);
  if (!parsed) throw new Error("Invalid reference explorer");
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.evaluate(
      (block) => window.show([block]),
      present("/views/product-references-12345678.view.json", cloudAiViewSummary(parsed)),
    );
    await page.waitForSelector('[data-view-path] [data-interactive="true"]');
    await pickExplorerView(page, "Table");
    await page.getByRole("button", { name: "Item", exact: true }).click();
    await page.getByRole("button", { name: "Item", exact: true }).click();
    expect(await page.locator("tbody tr").first().textContent()).toContain("Second product");
    await page.getByRole("button", { name: "Second product", exact: true }).click();
    expect(await page.evaluate(() => window.opened)).toEqual([{ title: "Second product", ref: { type: "spaces.item", id: "second" } }]);
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: (text: string) => {
            document.body.dataset.copied = text;
            return Promise.resolve();
          },
        },
      });
    });
    await page.getByRole("button", { name: "Copy data", exact: true }).click();
    const copied = await page.evaluate(() => document.body.dataset.copied);
    expect(copied).toContain("Second product");
    expect(copied).not.toContain("spaces.item");
    expect(copied).not.toContain("second");
  } finally {
    await context.close();
  }
});
