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
const files: Record<string, unknown> = {
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
const blocks = [
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
        await page.waitForFunction(() => document.querySelectorAll("[data-view-path] table").length === 2);
        await page.waitForFunction(() => document.querySelectorAll('[data-view-path] [role="status"]').length === 1);
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
