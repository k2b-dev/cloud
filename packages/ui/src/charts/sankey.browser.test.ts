import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, pageErrors, settled } from "../../test/browser";
import { renderSankeySvg } from "./core/sankey";

const root = resolve(import.meta.dir, "../..");
const spec = {
  kind: "sankey" as const,
  nodes: [
    { id: "a", label: "Clicked", tone: "blue" as const },
    { id: "b", label: "Read", tone: "green" as const },
    { id: "c", label: "Product and blog", tone: "in" as const },
  ],
  links: [
    { source: "a", target: "b", value: 1200 },
    { source: "a", target: "c", value: 200 },
    { source: "b", target: "c", value: 600 },
  ],
};
test("Sankey SSR, calm hover, keyboard, touch, scroll, theme and fixed host states", async () => {
  const ServerChart = (await import(resolve(root, "dist/ssr/content/Chart.js"))).default;
  const server = renderToString(() => createComponent(ServerChart, spec));
  const build = await Bun.build({
    entrypoints: ["sankey-fixture"],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [
      {
        name: "fixture",
        setup(b) {
          b.onResolve({ filter: /^sankey-fixture$/ }, () => ({ path: "fixture", namespace: "fixture" }));
          b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            loader: "ts",
            resolveDir: import.meta.dir,
            contents: `
 import {createComponent,createSignal} from 'solid-js';import {render} from 'solid-js/web';
 import Chart from ${JSON.stringify(resolve(root, "dist/browser/content/Chart.js"))};
 import {ChartExplorer} from ${JSON.stringify(resolve(root, "dist/browser/content/ChartExplorer.js"))};
 import {prepareChartSnapshot} from ${JSON.stringify(resolve(root, "dist/browser/charts/core/snapshot.js"))};
 const spec=${JSON.stringify(spec)}; const [selected,setSelected]=createSignal(null); render(()=>createComponent(Chart,{...spec,get selected(){return selected()},onSelect:s=>setSelected(s.datum)}),document.querySelector('#mount'));
 const [state,setState]=createSignal('data');
 const snapshot=prepareChartSnapshot(spec,{key:s=>String(s.datum.index),tooltip:s=>({title:s.datum.label,rows:s.datum.values.map(v=>({label:'Value',value:v.formatted}))})});
 const populated={chart:snapshot,rows:snapshot.marks.map(m=>({key:m.key}))};
 const empty={chart:{...snapshot,svg:'',marks:[]},rows:[]};
 render(()=>createComponent(ChartExplorer,{title:'Flow states',height:'280px',renderDetails:false,get data(){return ['data','stale'].includes(state())?populated:empty},columns:[{id:'flow',label:'Flow',value:r=>r.key}],get request(){return {status:state()==='loading'?'loading':['error','stale'].includes(state())?'error':'idle',message:'Could not load flows.'}},onRetry:()=>setState('data'),empty:'No flows in this period.'}),document.querySelector('#explorer'));
 document.querySelectorAll('button[data-state]').forEach(button=>button.onclick=()=>setState(button.dataset.state));
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
          `<html><head><style>${css}body{padding:20px;margin:0}article{max-width:900px;border:1px solid #e4e4e7;border-radius:12px;padding:16px}h2{margin:0}#subtitle{height:20px}#frame{height:280px;position:relative}#mount{height:100%}#status{pointer-events:none;position:absolute;inset:60px 0;text-align:center}</style></head><body><section class="k2b-ui"><article><h2>Paths after the click</h2><div id="subtitle">November 2026</div><div id="frame"><div id="mount">${server}</div><p id="status"></p><button id="retry" hidden>Retry</button></div></article><div id="explorer"></div><button data-state="data">Data</button><button data-state="loading">Loading</button><button data-state="empty">Empty</button><button data-state="error">Error</button><button data-state="stale">Stale</button></section><div id="standalone">${renderSankeySvg({ ...spec, inspect: true })}</div></body></html>`,
        );
        await settled(page);
        const before = await page.locator("#mount .k2b-chart__svg > svg").evaluate((e) => e.outerHTML);
        await page.locator("#mount").evaluate((e) => e.replaceChildren());
        await page.addScriptTag({ content: bundle });
        await settled(page);
        expect(await page.locator("#mount .k2b-chart__svg > svg").evaluate((e) => e.outerHTML)).toBe(before);
        const bounds = await page.locator("#mount .k2b-chart__svg > svg").evaluate((svg) => {
          const width = (svg as SVGSVGElement).viewBox.baseVal.width;
          return Array.from(svg.querySelectorAll("[data-chart-datum] text"), (text) => {
            const b = (text as SVGGraphicsElement).getBBox();
            return b.x >= 0 && b.x + b.width <= width;
          });
        });
        expect(bounds.every(Boolean)).toBe(true);
        const frame = page.locator("#explorer .k2b-chart-explorer__viewport");
        const documentBox = (e: Element) => {
          const b = e.getBoundingClientRect();
          return { x: b.x + window.scrollX, y: b.y + window.scrollY, width: b.width, height: b.height };
        };
        const box = await frame.evaluate(documentBox);
        const realBox = await page.locator("#mount .k2b-chart").evaluate(documentBox);
        const lightText = await page
          .locator("#mount text")
          .first()
          .evaluate((e) => getComputedStyle(e).fill);
        const chart = page.locator("#mount .k2b-chart");
        expect(await chart.evaluate((e) => e.scrollLeft)).toBe(0);
        if (width === 390) {
          const viewport = await chart.boundingBox();
          const source = await chart
            .locator("[data-chart-datum]")
            .filter({ has: page.locator("rect") })
            .first()
            .boundingBox();
          expect(source!.x).toBeGreaterThanOrEqual(viewport!.x);
        }
        await chart.focus();
        await settled(page);
        expect(await chart.locator("[data-inspected]").getAttribute("data-chart-datum")).toContain("Clicked");
        await page.keyboard.press("Enter");
        await settled(page);
        expect(await chart.locator("[data-selected]").count()).toBe(1);
        expect(await chart.locator("[data-selected] rect").evaluate((e) => getComputedStyle(e).stroke)).not.toBe("none");
        await page.keyboard.press("End");
        await settled(page);
        expect(await chart.locator("[data-inspected]").getAttribute("data-chart-datum")).toContain("Read → Product and blog");
        if (width === 390) {
          expect(await chart.evaluate((e) => e.scrollLeft)).toBeGreaterThan(0);
        }
        await page.keyboard.press("Home");
        await settled(page);
        expect(await chart.evaluate((e) => e.scrollLeft)).toBe(0);
        await page.keyboard.press("Enter");
        await page.keyboard.press("Escape");
        await chart.evaluate((e) => (e.scrollLeft = 0));
        const mark = chart.locator("[data-chart-datum]").last().locator("rect");
        await mark.hover();
        await settled(page);
        expect(await chart.locator("[data-inspected]").count()).toBe(1);
        expect(await mark.evaluate((e) => getComputedStyle(e).stroke)).not.toBe("none");
        const band = chart.locator(".k2b-chart-sankey-link").last();
        await band.hover();
        await settled(page);
        expect(await band.evaluate((e) => getComputedStyle(e).fillOpacity)).toBe("0.6");
        expect(
          await chart
            .locator(".k2b-chart-sankey-link")
            .first()
            .evaluate((e) => getComputedStyle(e).fillOpacity),
        ).toBe("0.3");
        await page.keyboard.press("Escape");
        await mark.tap();
        await settled(page);
        expect(await chart.locator("[data-inspected]").count()).toBe(1);
        if (width === 390) {
          await chart.focus();
          await page.keyboard.press("ArrowRight");
          await settled(page);
          const position = await chart.evaluate((e) => {
            const m = e.querySelector<SVGGraphicsElement>("[data-inspected]");
            const raw = m?.getAttribute("data-chart-datum"),
              anchor = e.querySelector(".k2b-chart__anchor"),
              tooltip = e.querySelector("[role=tooltip]");
            if (!m || !raw || !anchor || !tooltip) throw new Error("Missing active mark or tooltip");
            const d = JSON.parse(raw);
            const mat = m.getScreenCTM();
            if (!mat) throw new Error("Missing SVG matrix");
            const point = new DOMPoint(...d.anchor).matrixTransform(mat);
            const a = anchor.getBoundingClientRect();
            return { error: Math.abs(a.x - point.x), direction: getComputedStyle(tooltip).direction };
          });
          expect(position.error).toBeLessThan(1);
          expect(position.direction).toBe("ltr");
        }
        const scroll = await chart.evaluate((e) => ({ visible: e.clientWidth, full: e.scrollWidth }));
        if (width === 390) expect(scroll.full).toBeGreaterThan(scroll.visible);
        expect(
          await page
            .locator("#standalone path")
            .first()
            .evaluate((e) => getComputedStyle(e).fill),
        ).toBe("rgb(59, 130, 246)");
        for (const state of ["loading", "empty", "error", "stale", "data"]) {
          await page.locator(`button[data-state=${state}]`).click();
          await settled(page);
          expect(await frame.evaluate(documentBox)).toEqual(box);
          expect(await chart.evaluate(documentBox)).toEqual(realBox);
          expect(await page.locator("#explorer .k2b-chart-explorer").getAttribute("data-state")).toBe(state === "data" ? "data" : state);
          if (state === "error") {
            await page.locator("#explorer .k2b-chart-explorer__state[data-state=error] button").click();
            await settled(page);
            expect(await page.locator("#mount").isVisible()).toBe(true);
          }
        }
        await page.locator("section.k2b-ui").evaluate((e) => e.setAttribute("data-theme", "dark"));
        await settled(page);
        expect(
          await page
            .locator("#mount text")
            .first()
            .evaluate((e) => getComputedStyle(e).fill),
        ).not.toBe(lightText);
        await page.locator("section.k2b-ui").evaluate((e) => e.setAttribute("data-theme", "light"));
        await settled(page);
        await chart.evaluate((e) => (e.scrollLeft = 0));
        await page.keyboard.press("Escape");
        await settled(page);
        if (process.env.CHART_SCREENSHOTS) {
          mkdirSync(process.env.CHART_SCREENSHOTS, { recursive: true });
          await page.locator("article").screenshot({ path: resolve(process.env.CHART_SCREENSHOTS, `sankey-data-light-${width}.png`) });
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
