import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, pageErrors, settled } from "../../test/browser";
import { renderParetoSvg } from "./core/pareto";
import { renderTreemapSvg } from "./core/treemap";

const root = resolve(import.meta.dir, "../..");
const cases = [
  {
    kind: "treemap" as const,
    locale: "de",
    groups: ["Furniture", "Other"],
    data: [
      { label: "Chairs", group: "Furniture", value: 1234.5 },
      { label: "Tables", group: "Furniture", value: 900 },
      { label: "Lights", group: "Other", value: 500 },
      { label: "Art", group: "Other", value: 330 },
      { label: "Other", group: "Other", value: 200 },
      { label: "Zero", group: "Other", value: 0 },
    ],
  },
  {
    kind: "pareto" as const,
    locale: "de",
    labels: ["Current", "Previous"] as [string, string],
    data: [
      { label: "Nordrhein", value: 1234.5, prev: 1000 },
      { label: "East", value: 900, prev: 700 },
      { label: "South", value: 500, prev: 600 },
      { label: "Rest", rest: true, value: 100, prev: 120 },
    ],
  },
];
for (const spec of cases)
  test(`${spec.kind}: SSR, calm hover, selected outline, keyboard, touch, theme, labels and fixed chart boxes`, async () => {
    const ServerChart = (await import(resolve(root, "dist/ssr/content/Chart.js"))).default;
    const server = renderToString(() => createComponent(ServerChart, spec));
    const build = await Bun.build({
      entrypoints: ["distribution-fixture"],
      target: "browser",
      conditions: ["browser"],
      format: "iife",
      plugins: [
        {
          name: "fixture",
          setup(b) {
            b.onResolve({ filter: /^distribution-fixture$/ }, () => ({ path: "fixture", namespace: "fixture" }));
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
 render(()=>createComponent(ChartExplorer,{title:'Calendar states',height:'280px',renderDetails:false,get data(){return ['data','stale'].includes(state())?populated:empty},columns:[{id:'day',label:'Day',value:r=>r.key}],get request(){return {status:state()==='loading'?'loading':['error','stale'].includes(state())?'error':'idle',message:'Could not load observations.'}},onRetry:()=>setState('data'),empty:'No observations in this period.'}),document.querySelector('#explorer'));
 document.querySelectorAll('button[data-state]').forEach(button=>button.onclick=()=>{setState(button.dataset.state);if(state()==='data')setSelected(null);document.querySelector('#retry').hidden=state()!=='error';document.querySelector('#subtitle').textContent=state()==='stale'?'Previous data':'November 2026';});
 document.querySelector('#retry').onclick=()=>document.querySelector('button[data-state=data]').click();
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
            `<html><head><style>${css}body{padding:20px;margin:0}article{max-width:900px;border:1px solid #e4e4e7;border-radius:12px;padding:16px}h2{margin:0}#subtitle{height:20px}#frame{height:280px;position:relative}#mount{height:100%}#status{pointer-events:none;position:absolute;inset:60px 0;text-align:center}</style></head><body><section class="k2b-ui"><article><h2>${spec.kind === "treemap" ? "Inventory by category" : "Revenue by region"}</h2><div id="subtitle">November 2026</div><div id="frame"><div id="mount">${server}</div><p id="status"></p><button id="retry" hidden>Retry</button></div></article><div id="explorer"></div><button data-state="data">Data</button><button data-state="loading">Loading</button><button data-state="empty">Empty</button><button data-state="error">Error</button><button data-state="stale">Stale</button></section><div id="standalone">${spec.kind === "treemap" ? renderTreemapSvg({ ...spec, inspect: true }) : renderParetoSvg({ ...spec, inspect: true })}</div></body></html>`,
          );
          await settled(page);
          const before = await page.locator("#mount .k2b-chart__svg > svg").evaluate((e) => e.outerHTML);
          await page.locator("#mount").evaluate((e) => e.replaceChildren());
          await page.addScriptTag({ content: bundle });
          await settled(page);
          expect(await page.locator("#mount .k2b-chart__svg > svg").evaluate((e) => e.outerHTML)).toBe(before);
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
          if (spec.kind === "pareto") {
            const label = chart.locator("[data-chart-datum] text").first();
            expect(await label.textContent()).toBe("Nordrhein");
            const bounds = await label.boundingBox();
            expect(bounds!.x).toBeGreaterThanOrEqual(realBox.x);
          } else {
            expect(await chart.locator('[data-chart-datum*="Zero"]').count()).toBe(0);
          }
          await chart.focus();
          await settled(page);
          expect(await chart.locator("[data-inspected]").getAttribute("data-chart-datum")).toContain(
            spec.kind === "treemap" ? "Chairs" : "Nordrhein",
          );
          expect(await chart.locator("[role=tooltip]").textContent()).toContain("1.234,5");
          expect(await chart.locator("[role=tooltip]").textContent()).toContain(spec.kind === "treemap" ? "Bereich" : "Current");
          await page.keyboard.press("Enter");
          await settled(page);
          expect(await chart.locator("[data-selected]").count()).toBe(1);
          const mark = chart.locator("[data-chart-datum]").first().locator("rect").first();
          if (spec.kind === "treemap") expect(await mark.evaluate((e) => getComputedStyle(e).strokeWidth)).toBe("1.5px");
          else
            expect(await chart.locator("[data-selected] .k2b-chart-category-band").evaluate((e) => getComputedStyle(e).fill)).not.toBe(
              "rgba(0, 0, 0, 0)",
            );
          if (spec.kind === "pareto")
            expect(await chart.locator("[data-selected] .k2b-chart-pareto-hatch").evaluate((e) => getComputedStyle(e).stroke)).not.toBe(
              "none",
            );
          await page.keyboard.press("End");
          await settled(page);
          expect(await chart.locator("[data-inspected]").getAttribute("data-chart-datum")).toContain(
            spec.kind === "pareto" ? "Rest" : "Other",
          );
          await page.keyboard.press("Escape");
          await mark.hover();
          await settled(page);
          expect(await chart.locator("[data-inspected]").count()).toBe(1);
          expect(
            await chart
              .locator("[data-chart-datum]")
              .last()
              .evaluate((e) => getComputedStyle(e).opacity),
          ).toBe("1");
          await page.keyboard.press("Escape");
          await mark.tap();
          await settled(page);
          expect(await chart.locator("[data-inspected]").count()).toBe(1);
          expect(
            await page
              .locator("#standalone [data-chart-datum] rect")
              .first()
              .evaluate((e) => getComputedStyle(e).fill),
          ).not.toBe("rgb(0, 0, 0)");
          // Every visible treemap label stays inside its real cell, including the phone's inverse text scaling.
          if (spec.kind === "treemap") {
            const labels = await chart.locator("[data-chart-datum]").evaluateAll((groups) =>
              groups.flatMap((g) => {
                const rect = g.querySelector("rect")!.getBoundingClientRect();
                return Array.from(g.querySelectorAll("text")).map((t) => {
                  const text = t.getBoundingClientRect();
                  return text.x >= rect.x - 1 && text.right <= rect.right + 1 && text.bottom <= rect.bottom + 1;
                });
              }),
            );
            expect(labels.every(Boolean)).toBe(true);
          }
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
            await page
              .locator("article")
              .screenshot({ path: resolve(process.env.CHART_SCREENSHOTS, `${spec.kind}-data-light-${width}.png`) });
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
