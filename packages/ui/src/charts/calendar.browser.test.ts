import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, pageErrors, settled } from "../../test/browser";
import { renderCalendarSvg } from "./core/calendar";

const root = resolve(import.meta.dir, "../..");
const spec = {
  kind: "heatmap" as const,
  layout: "calendar" as const,
  scale: "sequential" as const,
  data: Array.from({ length: 420 }, (_, i): [string, number] => [
    new Date(Date.UTC(2025, 0, 6) + i * 86400000).toISOString().slice(0, 10),
    (i * 17) % 211,
  ]),
};
test("Calendar SSR, calm hover, keyboard, touch, scroll, theme and fixed host states", async () => {
  const ServerChart = (await import(resolve(root, "dist/ssr/content/Chart.js"))).default;
  const server = renderToString(() => createComponent(ServerChart, spec));
  const build = await Bun.build({
    entrypoints: ["calendar-fixture"],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [
      {
        name: "fixture",
        setup(b) {
          b.onResolve({ filter: /^calendar-fixture$/ }, () => ({ path: "fixture", namespace: "fixture" }));
          b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            loader: "ts",
            resolveDir: import.meta.dir,
            contents: `
 import {createComponent} from 'solid-js';import {render} from 'solid-js/web';
 import Chart from ${JSON.stringify(resolve(root, "dist/browser/content/Chart.js"))};
 const spec=${JSON.stringify(spec)}; render(()=>createComponent(Chart,spec),document.querySelector('#mount'));
 document.querySelectorAll('[data-state]').forEach(button=>button.onclick=()=>{const state=button.dataset.state;document.querySelector('#mount').hidden=state!=='data'&&state!=='stale';document.querySelector('#status').textContent=state==='loading'?'Loading':state==='empty'?'No observations in this period.':state==='error'?'Could not load observations.':'';document.querySelector('#retry').hidden=state!=='error';document.querySelector('#subtitle').textContent=state==='stale'?'Previous data':'November 2026';});
 document.querySelector('#retry').onclick=()=>document.querySelector('[data-state=data]').click();
 `,
          }));
        },
      },
    ],
  });
  expect(build.success).toBe(true);
  const bundle = await build.outputs[0]!.text();
  const css = await Bun.file(resolve(root, "dist/styles.css")).text();
  const browser = await launchBrowser();
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 800 }, hasTouch: true, reducedMotion: "reduce" });
      try {
        const errors = pageErrors(page);
        await page.setContent(
          `<html><head><style>${css}body{padding:20px;margin:0}article{max-width:900px;border:1px solid #e4e4e7;border-radius:12px;padding:16px}h2{margin:0}#subtitle{height:20px}#frame{height:280px;position:relative}#mount{height:100%}#status{pointer-events:none;position:absolute;inset:60px 0;text-align:center}</style></head><body class="k2b-ui"><article><h2>Opens per day</h2><div id="subtitle">November 2026</div><div id="frame"><div id="mount">${server}</div><p id="status"></p><button id="retry" hidden>Retry</button></div></article><button data-state="data">Data</button><button data-state="loading">Loading</button><button data-state="empty">Empty</button><button data-state="error">Error</button><button data-state="stale">Stale</button><div id="standalone">${renderCalendarSvg({ ...spec, inspect: true })}</div></body></html>`,
        );
        await settled(page);
        const before = await page.locator("#mount .k2b-chart__svg > svg").evaluate((e) => e.outerHTML);
        await page.locator("#mount").evaluate((e) => e.replaceChildren());
        await page.addScriptTag({ content: bundle });
        await settled(page);
        expect(await page.locator("#mount .k2b-chart__svg > svg").evaluate((e) => e.outerHTML)).toBe(before);
        const frame = page.locator("#frame");
        const box = await frame.boundingBox();
        const chart = page.locator("#mount .k2b-chart");
        await chart.focus();
        await settled(page);
        expect(await chart.locator("[data-inspected]").getAttribute("data-chart-datum")).toContain("Sunday, March 1, 2026");
        await page.keyboard.press("Home");
        await page.keyboard.press("ArrowRight");
        await settled(page);
        expect(await chart.locator("[data-inspected]").getAttribute("data-chart-datum")).toContain("Monday, January 13, 2025");
        await page.keyboard.press("ArrowDown");
        await settled(page);
        expect(await chart.locator("[data-inspected]").getAttribute("data-chart-datum")).toContain("Tuesday, January 14, 2025");
        await page.keyboard.press("End");
        await page.keyboard.press("Enter");
        await page.keyboard.press("Escape");
        const mark = chart.locator("[data-chart-datum]").last().locator("rect");
        await mark.hover();
        await settled(page);
        expect(await chart.locator("[data-inspected]").count()).toBe(1);
        expect(await mark.evaluate((e) => getComputedStyle(e).strokeWidth)).toBe("1.5px");
        await page.keyboard.press("Escape");
        await mark.tap();
        await settled(page);
        expect(await chart.locator("[data-inspected]").count()).toBe(1);
        const scroll = await chart.evaluate((e) => ({ visible: e.clientWidth, full: e.scrollWidth }));
        if (width === 390) expect(scroll.full).toBeGreaterThan(scroll.visible);
        expect(
          await page
            .locator("#standalone rect")
            .first()
            .evaluate((e) => getComputedStyle(e).fill),
        ).not.toBe("rgb(0, 0, 0)");
        for (const state of ["loading", "empty", "error", "stale", "data"]) {
          await page.locator(`[data-state=${state}]`).click();
          await settled(page);
          expect(await frame.boundingBox()).toEqual(box);
          if (state === "error") {
            await page.locator("#retry").click();
            await settled(page);
            expect(await page.locator("#mount").isVisible()).toBe(true);
          }
        }
        await page.locator("html").evaluate((e) => e.setAttribute("data-theme", "dark"));
        await settled(page);
        expect(
          await chart
            .locator("rect")
            .first()
            .evaluate((e) => getComputedStyle(e).fill),
        ).not.toBe("rgb(0, 0, 0)");
        await page.locator("html").evaluate((e) => e.setAttribute("data-theme", "light"));
        await settled(page);
        if (process.env.CHART_SCREENSHOTS) {
          mkdirSync(process.env.CHART_SCREENSHOTS, { recursive: true });
          await page.locator("article").screenshot({ path: resolve(process.env.CHART_SCREENSHOTS, `calendar-data-light-${width}.png`) });
        }
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
}, 30000);
