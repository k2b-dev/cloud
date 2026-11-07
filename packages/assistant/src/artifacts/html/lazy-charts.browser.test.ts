import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../../../ui/test/browser";
import type { AppFrameAssets } from "./assets";
import { buildBaseCss, buildChartModule, buildPrelude } from "./build-assets";
import type { AppFiles } from "./compose";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let assets: AppFrameAssets;
beforeAll(async () => {
  const prelude = await buildPrelude();
  assets = {
    prelude,
    preludeHash: `'sha256-${new Bun.CryptoHasher("sha256").update(prelude).digest("base64")}'`,
    baseCss: await buildBaseCss(),
    chartModule: await buildChartModule(),
  };
  const built = await Bun.build({
    entrypoints: [new URL("./lazy-charts-browser-harness.ts", import.meta.url).pathname],
    target: "browser",
    format: "iife",
  });
  if (!built.success) throw new AggregateError(built.logs, "chart harness build failed");
  const harness = await built.outputs[0]!.text();
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/harness.js") return new Response(harness, { headers: { "content-type": "text/javascript" } });
      if (path === "/assets.js")
        return new Response(`globalThis.lazyChartAssets=${JSON.stringify(assets)}`, { headers: { "content-type": "text/javascript" } });
      return new Response(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Offline charts</title><style>html,body{margin:0;height:100%}main{display:flex;height:100vh}.studio-app-frame{border:0;width:100%;height:100%}</style></head><body><main></main><script src="/assets.js"></script><script src="/harness.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  browser = await launchBrowser();
}, 120_000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

const app = (page: Page) => page.frameLocator("iframe.studio-app-frame").frameLocator("iframe");
const ready = (page: Page) => page.waitForFunction(() => globalThis.lazyChartHarness.events.some((event) => event.type === "ready"));
const counted = "globalThis.__chartLoads=(globalThis.__chartLoads??0)+1;";
const delayed = `${counted}await new Promise(resolve=>{globalThis.__releaseCharts=resolve});`;
const files = (script: string): AppFiles => ({
  "index.html":
    '<main><h1>Offline report</h1><button id="draw">Draw distributions</button><div id="charts"></div><p id="after">Report notes</p><output id="result"></output></main>',
  "style.css":
    "body{margin:0;padding:24px;background:var(--k2b-background);color:var(--k2b-text)}h1{font-size:24px}#charts{display:grid;gap:24px;margin-block:24px}.card{min-width:0;padding:16px;border:1px solid var(--k2b-border);border-radius:8px}",
  "app.js": script,
});
const histogram = '{kind:"histogram",title:"Delivery days",data:[1,2,2,3,4,4,5],format:v=>"Day "+v}';
const draw = `document.querySelector("#draw").addEventListener("click",()=>{
  document.querySelector("#charts").innerHTML=cloud.html\`<section class="card">\${cloud.chart(${histogram})}</section><section class="card">\${cloud.chart({kind:"gauge",title:"On time",value:75})}</section>\`;
  document.querySelector('[data-chart-kind="histogram"]').addEventListener("click",()=>{document.querySelector("#result").textContent="Chart selected";});
});`;
async function open(width: number, source = assets.chartModule!, theme: "light" | "dark" = "light", script = draw) {
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/`);
  // Cold first use after the host assets arrived: even an unavailable origin cannot affect drawing.
  await context.setOffline(true);
  const requests: string[] = [];
  page.on("request", (request) => {
    if (/^https?:/.test(request.url())) requests.push(request.url());
  });
  await page.evaluate(({ files, source, theme }) => globalThis.lazyChartHarness.mount(files, { chartModule: source, theme }), {
    files: files(script),
    source,
    theme,
  });
  await ready(page);
  return { page, context, requests };
}
const boxes = (page: Page) =>
  app(page)
    .locator("#charts")
    .evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      after: document.querySelector("#after")!.getBoundingClientRect().top,
    }));
const release = (page: Page) =>
  app(page)
    .locator("body")
    .evaluate(() => Reflect.get(globalThis, "__releaseCharts")());

for (const width of [1200, 390])
  for (const theme of ["light", "dark"] as const)
    test(`rare charts draw offline without moving their boxes, ${width}px ${theme}`, async () => {
      const { page, context, requests } = await open(width, delayed + assets.chartModule, theme);
      try {
        expect(
          await app(page)
            .locator("body")
            .evaluate(() => Reflect.get(globalThis, "__chartLoads") ?? 0),
        ).toBe(0);
        await app(page).locator("#draw").click();
        await app(page)
          .locator("body")
          .evaluate(
            () =>
              new Promise<void>((resolve) => {
                const poll = () => (Reflect.get(globalThis, "__releaseCharts") ? resolve() : requestAnimationFrame(poll));
                poll();
              }),
          );
        const loading = await boxes(page);
        expect(await app(page).locator('[aria-busy="true"]').count()).toBe(2);
        expect(await app(page).getByRole("status").first().textContent()).toBe("Loading chart …");
        if (process.env.CHART_LOADING_SHOTS && theme === "light") {
          await mkdir(process.env.CHART_LOADING_SHOTS, { recursive: true });
          await page.screenshot({ path: `${process.env.CHART_LOADING_SHOTS}/charts-loading-light-${width}.png` });
        }
        await release(page);
        await app(page).locator('[data-chart-kind="histogram"] svg').waitFor();
        await app(page).locator('[data-chart-kind="gauge"] svg').waitFor();
        expect(await boxes(page)).toEqual(loading);
        expect(await app(page).locator("[data-chart-pending]").count()).toBe(0);
        expect(await app(page).locator(".k2b-chart__table").count()).toBe(2);
        await app(page).locator('[data-chart-kind="histogram"]').dispatchEvent("click");
        expect(await app(page).locator("#result").textContent()).toBe("Chart selected");
        const mark = app(page).locator('[data-chart-kind="histogram"] [data-chart-datum]').first();
        await mark.dispatchEvent("pointermove", { pointerType: "mouse", clientX: 100, clientY: 150 });
        await app(page).locator('[data-chart-kind="histogram"]').focus();
        await app(page).locator('[data-chart-kind="histogram"]').press("ArrowRight");
        await app(page).locator('[data-chart-kind="histogram"] .k2b-chart__tooltip').waitFor();
        expect(await app(page).locator('[data-chart-kind="histogram"] .k2b-chart__tooltip').textContent()).toContain("Day ");
        await app(page).locator('[data-chart-kind="histogram"]').press("Escape");
        await app(page).locator("#draw").click();
        expect(await app(page).locator("[data-chart-pending]").count()).toBe(0);
        expect(
          await app(page)
            .locator("body")
            .evaluate(() => Reflect.get(globalThis, "__chartLoads")),
        ).toBe(1);
        const snapshot = await page.evaluate(() => globalThis.lazyChartHarness.snapshot());
        expect(snapshot).toContain("Delivery days");
        expect(snapshot).not.toContain("Loading chart");
        expect(requests).toEqual([]);
        expect(
          await page.evaluate(() =>
            globalThis.lazyChartHarness.events.filter(
              (event) => event.type === "error" || (event.type === "log" && event.level === "error"),
            ),
          ),
        ).toEqual([]);
        if (process.env.CHART_LOADING_SHOTS && theme === "light") {
          await mkdir(process.env.CHART_LOADING_SHOTS, { recursive: true });
          await page.screenshot({ path: `${process.env.CHART_LOADING_SHOTS}/charts-ready-light-${width}.png` });
        }
      } finally {
        await context.close();
      }
    });

test("a failed rare import stays in its box and retries offline", async () => {
  const source = `${counted}if(globalThis.__chartLoads===1)throw new Error("fixture failure");${assets.chartModule}`;
  const { page, context, requests } = await open(390, source);
  try {
    await app(page).locator("#draw").click();
    await app(page).getByRole("button", { name: "Try again" }).first().waitFor();
    const failed = await boxes(page);
    if (process.env.CHART_LOADING_SHOTS) {
      await mkdir(process.env.CHART_LOADING_SHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.CHART_LOADING_SHOTS}/charts-error-light-390.png` });
    }
    expect(await app(page).getByRole("alert").count()).toBe(2);
    await app(page).getByRole("button", { name: "Try again" }).first().click();
    await app(page).locator('[data-chart-kind="histogram"] svg').waitFor();
    await app(page).getByRole("button", { name: "Try again" }).click();
    await app(page).locator('[data-chart-kind="gauge"] svg').waitFor();
    expect(await boxes(page)).toEqual(failed);
    expect(
      await app(page)
        .locator("body")
        .evaluate(() => Reflect.get(globalThis, "__chartLoads")),
    ).toBe(2);
    expect(requests).toEqual([]);
  } finally {
    await context.close();
  }
});

test("calendar heatmaps load offline with stable phone geometry and their newest week visible", async () => {
  const script = `document.querySelector("#draw").addEventListener("click",()=>{
document.querySelector("#charts").innerHTML=cloud.chart({kind:"heatmap",layout:"calendar",title:"Deliveries",scale:"sequential",data:[["2026-01-01",1],["2026-12-31",2]]});
});`;
  const { page, context, requests } = await open(390, delayed + assets.chartModule, "light", script);
  try {
    await app(page).locator("#draw").click();
    await app(page)
      .locator("body")
      .evaluate(
        () =>
          new Promise<void>((resolve) => {
            const poll = () => (Reflect.get(globalThis, "__releaseCharts") ? resolve() : requestAnimationFrame(poll));
            poll();
          }),
      );
    const loading = await boxes(page);
    await release(page);
    await app(page).locator("svg[data-calendar]").waitFor();
    expect(await boxes(page)).toEqual(loading);
    const chart = app(page).locator('[data-chart-kind="heatmap"]');
    expect(await chart.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    await chart.focus();
    await chart.press("End");
    await chart.locator(".k2b-chart__tooltip").waitFor();
    expect(await chart.locator(".k2b-chart__tooltip").textContent()).toContain("2026");
    expect(requests).toEqual([]);
  } finally {
    await context.close();
  }
});

test("ready, snapshots and PDFs include rare drawings; stale placeholders are not repainted", async () => {
  const script = `document.querySelector("#charts").innerHTML=cloud.chart(${histogram});
const removed=document.querySelector("#charts").firstElementChild;
removed.remove();
document.querySelector("#charts").innerHTML=cloud.chart({kind:"heatmap",data:[]});
await cloud.pdf.render({html:cloud.html\`<h1>Delivery</h1>\${cloud.chart(${histogram})}\`});
document.querySelector("#result").textContent="PDF ready";`;
  const { page, context, requests } = await open(390, counted + assets.chartModule, "light", script);
  try {
    expect(await app(page).locator("#result").textContent()).toBe("PDF ready");
    expect(await app(page).locator(".k2b-chart").count()).toBe(1);
    expect(await app(page).locator("[data-chart-pending]").count()).toBe(0);
    expect(await app(page).locator('[data-chart-kind="heatmap"] svg').count()).toBe(1);
    const pdf = await page.evaluate(() => globalThis.lazyChartHarness.pdfs[0]);
    const pdfHtml = pdf && typeof pdf === "object" && "html" in pdf && typeof pdf.html === "string" ? pdf.html : "";
    expect(pdfHtml).toContain("<svg");
    expect(pdfHtml).toContain("Day ");
    expect(pdfHtml).toContain("k2b-chart__table");
    expect(pdfHtml).not.toContain("data-chart-pending");
    expect(requests).toEqual([]);
  } finally {
    await context.close();
  }
});

test("snapshots wait for charts without waiting for unrelated cloud calls", async () => {
  const { page, context, requests } = await open(
    390,
    delayed + assets.chartModule,
    "light",
    `${draw}
document.querySelector("#draw").addEventListener("click",()=>{void cloud.ai.text({prompt:"fixture"});});`,
  );
  try {
    await app(page).locator("#draw").click();
    await page.waitForFunction(() => globalThis.lazyChartHarness.waiting);
    // This snapshot is requested while both the module and the AI call are held.
    await page.evaluate(() => {
      Reflect.set(globalThis, "chartSnapshot", globalThis.lazyChartHarness.snapshot());
    });
    await app(page)
      .locator("body")
      .evaluate(
        () =>
          new Promise<void>((resolve) => {
            const poll = () => (Reflect.get(globalThis, "__releaseCharts") ? resolve() : requestAnimationFrame(poll));
            poll();
          }),
      );
    await release(page);
    const snapshot = await page.evaluate(() => Reflect.get(globalThis, "chartSnapshot"));
    expect(snapshot).toContain("Delivery days");
    expect(snapshot).toContain("k2b-chart__table");
    expect(snapshot).not.toContain("data-chart-pending");
    expect(await page.evaluate(() => globalThis.lazyChartHarness.waiting)).toBe(true);
    await page.evaluate(() => globalThis.lazyChartHarness.release());
    expect(requests).toEqual([]);
  } finally {
    await page.evaluate(() => globalThis.lazyChartHarness.release()).catch(() => {});
    await context.close();
  }
});

test("more than 200 undrawn charts survive redraw-cache churn, delayed insertion and reuse in PDFs", async () => {
  const script = `const saved=cloud.chart({kind:"gauge",title:"First chart",value:75,format:v=>"Custom "+v});
const charts=cloud.html\`\${saved}\${Array.from({length:201},(_,i)=>cloud.chart({kind:"gauge",title:"Gauge "+i,value:i%100}))}\`;
for(let i=0;i<201;i++)cloud.chart({kind:"line",series:[]});
await cloud.pdf.render({html:charts});
document.querySelector("#charts").innerHTML=charts;
await cloud.pdf.render({html:charts});
document.querySelector("#result").textContent="PDF ready";`;
  const { page, context, requests } = await open(390, counted + assets.chartModule, "light", script);
  try {
    expect(await app(page).locator("#result").textContent()).toBe("PDF ready");
    expect(await app(page).locator(".k2b-chart svg").count()).toBe(202);
    expect(await app(page).locator("[data-chart-pending]").count()).toBe(0);
    expect(await app(page).locator(".k2b-chart").first().textContent()).toContain("Custom 75");
    const pdfs = await page.evaluate(() => globalThis.lazyChartHarness.pdfs);
    expect(pdfs).toHaveLength(2);
    for (const pdf of pdfs) {
      const content = pdf && typeof pdf === "object" && "html" in pdf && typeof pdf.html === "string" ? pdf.html : "";
      expect(content.match(/class="k2b-chart"/g)).toHaveLength(202);
      expect(content).toContain("Custom 75");
      expect(content).not.toContain("data-chart-pending");
    }
    expect(requests).toEqual([]);
  } finally {
    await context.close();
  }
});
