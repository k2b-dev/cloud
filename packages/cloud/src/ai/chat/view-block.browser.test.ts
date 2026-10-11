import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../../../ui/test/browser";
import type { AiTurnBlock } from "../protocol";

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
const files: Record<string, unknown> = {
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
};

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
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
        const file = files[url.searchParams.get("path") ?? ""];
        return Bun.sleep(400).then(() =>
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
        await page.evaluate((value) => (window as unknown as { show: (blocks: ToolBlock[]) => void }).show(value), blocks);
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
    await page.evaluate((value) => (window as unknown as { show: (blocks: ToolBlock[]) => void }).show(value), [blocks[0]!]);
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
      (value) => (window as unknown as { show: (blocks: ToolBlock[]) => void }).show(value),
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

test("a view file edited after present shows unavailable instead of what its summary did not reserve", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.evaluate(
      (value) => (window as unknown as { show: (blocks: ToolBlock[]) => void }).show(value),
      [
        present("/views/unlinked-4e5f6a7b.view.json", groupSummary(linked)),
        present("/views/subtitled-8c9d0e1f.view.json", { view: "chart", kind: "bar", title: chart.title }),
      ],
    );
    // Both charts of the group and the single chart.
    await page.waitForFunction(() => {
      const statuses = Array.from(document.querySelectorAll('[data-view-path] [role="status"]'));
      return statuses.length === 3 && statuses.every((node) => node.textContent?.startsWith("This view is no longer available"));
    });
    expect(await page.locator('[data-view-path] [data-interactive="true"]').count()).toBe(0);
  } finally {
    await context.close();
  }
});
