import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, pageErrors, settled } from "../../test/browser";
import { renderBubbleSvg } from "./core/bubble";
import { renderRadarSvg } from "./core/radar";

const root = resolve(import.meta.dir, "../..");
const cases = [
  {
    kind: "bubble" as const,
    groups: ["North", "South"],
    xLabel: "Visits",
    yLabel: "Opens",
    sizeLabel: "Audience",
    averages: true,
    data: [
      { label: "Letter A", group: "North", x: 1, y: 2, size: 4 },
      { label: "Letter B", group: "North", x: 4, y: 8, size: 16 },
      { label: "Letter C", group: "South", x: 8, y: 4, size: 8 },
      { label: "Same place", group: "South", x: 4, y: 8, size: 9 },
    ],
  },
  {
    kind: "radar" as const,
    axes: ["Quality", "Speed", "Cost", "Access"],
    max: 5,
    unit: "points",
    series: [
      { label: "Plan A", data: [4, 3, 2, 5] },
      { label: "Plan B", data: [2, 4, 4, 3] },
    ],
  },
];
for (const spec of cases)
  test(`${spec.kind}: real SVG SSR parity, inspection, axis keyboard, touch, states, phone and dark`, async () => {
    const ServerChart = (await import(resolve(root, "dist/ssr/content/Chart.js"))).default;
    const server = renderToString(() => createComponent(ServerChart, spec));
    const build = await Bun.build({
      entrypoints: ["fixture"],
      target: "browser",
      conditions: ["browser"],
      format: "iife",
      plugins: [
        {
          name: "fixture",
          setup(b) {
            b.onResolve({ filter: /^fixture$/ }, () => ({ path: "fixture", namespace: "fixture" }));
            b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
              loader: "ts",
              resolveDir: import.meta.dir,
              contents: `
 import {createComponent,createSignal} from 'solid-js';import {render} from 'solid-js/web';
 import Chart from ${JSON.stringify(resolve(root, "dist/browser/content/Chart.js"))};
 import {ChartExplorer} from ${JSON.stringify(resolve(root, "dist/browser/content/ChartExplorer.js"))};
 import {prepareChartSnapshot} from ${JSON.stringify(resolve(root, "dist/browser/charts/core/snapshot.js"))};
 const spec=${JSON.stringify(spec)};const [selection,setSelection]=createSignal(null);render(()=>createComponent(Chart,{...spec,get selected(){return selection()},onSelect:s=>setSelection(s.datum)}),document.querySelector('#mount'));
 const [state,setState]=createSignal('data');const snapshot=prepareChartSnapshot(spec,{key:s=>String(s.datum.index),tooltip:s=>({title:s.datum.label,rows:s.datum.values.map(f=>({label:f.key,value:f.formatted??String(f.value)}))})});const populated={chart:snapshot,rows:snapshot.marks.map(m=>({key:m.key}))};const empty={chart:{...snapshot,svg:'',marks:[]},rows:[]};
 render(()=>createComponent(ChartExplorer,{title:'Chart states',height:'280px',renderDetails:false,get data(){return ['data','stale'].includes(state())?populated:empty},columns:[{id:'name',label:'Name',value:r=>r.key}],get request(){return {status:state()==='loading'?'loading':['error','stale'].includes(state())?'error':'idle',message:'Could not load data.'}},onRetry:()=>setState('data'),empty:'No observations in this period.'}),document.querySelector('#explorer'));
 document.querySelectorAll('button[data-switch]').forEach(b=>b.onclick=()=>{setState(b.dataset.switch);if(b.dataset.switch==='data')setSelection(null)});
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
        const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: true, reducedMotion: "reduce" });
        try {
          const errors = pageErrors(page);
          const core = spec.kind === "bubble" ? renderBubbleSvg({ ...spec, inspect: true }) : renderRadarSvg({ ...spec, inspect: true });
          await page.setContent(
            `<html><head><style>${css}body{padding:20px;margin:0}article{max-width:900px;border:1px solid #e4e4e7;border-radius:12px;padding:16px}h2{margin:0 0 12px}#mount{height:280px}</style></head><body><section class="k2b-ui"><article><h2>${spec.kind === "bubble" ? "Campaign reach and engagement" : "Compare two plans"}</h2><div id="mount">${server}</div></article><div id="explorer"></div>${["data", "loading", "empty", "error", "stale"].map((s) => `<button data-switch="${s}">${s}</button>`).join("")}</section><div id="standalone">${core}</div></body></html>`,
          );
          await settled(page);
          const before = await page.locator("#mount .k2b-chart__svg > svg").evaluate((e) => e.outerHTML);
          await page.locator("#mount").evaluate((e) => e.replaceChildren());
          await page.addScriptTag({ content: bundle });
          await settled(page);
          expect(await page.locator("#mount .k2b-chart__svg > svg").evaluate((e) => e.outerHTML)).toBe(before);
          const chart = page.locator("#mount .k2b-chart");
          const documentBox = (e: Element) => {
            const b = e.getBoundingClientRect();
            return { x: b.x + window.scrollX, y: b.y + window.scrollY, width: b.width, height: b.height };
          };
          const box = await chart.evaluate(documentBox);
          const viewport = page.locator("#explorer .k2b-chart-explorer__viewport");
          const frame = await viewport.evaluate(documentBox);
          const light = await chart
            .locator("text")
            .first()
            .evaluate((e) => getComputedStyle(e).fill);
          await chart.focus();
          await page.keyboard.press("Home");
          await settled(page);
          expect(await chart.locator("[data-inspected]").count()).toBe(1);
          const first = await chart.locator("[data-inspected]").getAttribute("data-chart-datum");
          await page.keyboard.press("ArrowRight");
          await settled(page);
          expect(await chart.locator("[data-inspected]").getAttribute("data-chart-datum")).not.toBe(first);
          if (spec.kind === "radar") {
            const paints = await chart
              .locator("[data-inspected] circle")
              .evaluateAll((elements) => elements.map((e) => ({ fill: getComputedStyle(e).fill, stroke: getComputedStyle(e).stroke })));
            expect(paints).toHaveLength(2);
            expect(paints[0]!.fill).not.toBe(paints[1]!.fill);
            for (const paint of paints) expect(paint.stroke).toBe(paint.fill);
            expect(await chart.locator("[role=tooltip]").textContent()).toContain("Plan A");
            expect(await chart.locator("[role=tooltip]").textContent()).toContain("Plan B");
            expect(await chart.locator("[role=tooltip]").textContent()).toContain("/ 5 points");
          }
          await page.keyboard.press("Enter");
          await settled(page);
          expect(await chart.locator("[data-selected]").count()).toBe(1);
          expect(
            await chart
              .locator("[data-selected] circle")
              .first()
              .evaluate((e) => getComputedStyle(e).strokeWidth),
          ).toBe("3px");
          await page.keyboard.press("Escape");
          await settled(page);
          expect(await chart.locator("[data-inspected]").count()).toBe(0);
          const mark =
            spec.kind === "radar" ? chart.locator("[data-chart-datum]").last() : chart.locator("[data-chart-datum] circle").last();
          await mark.hover();
          await settled(page);
          expect(await chart.locator("[data-inspected]").count()).toBe(1);
          expect(
            await chart
              .locator("[data-chart-datum] circle")
              .last()
              .evaluate((e) => getComputedStyle(e).opacity),
          ).toBe("1");
          await mark.tap();
          await settled(page);
          expect(await chart.locator("[data-selected]").count()).toBe(1);
          if (spec.kind === "bubble") {
            expect(await chart.locator(".k2b-chart-average").count()).toBe(2);
            expect(await chart.textContent()).toContain("Unweighted average");
            const geometry = await chart.evaluate((e) => {
              const circles = Array.from(e.querySelectorAll<SVGCircleElement>("[data-chart-datum] circle"));
              const labels = Array.from(e.querySelectorAll<SVGTextElement>(".k2b-chart-bubble-label"));
              const rects = labels.map((e) => e.getBoundingClientRect());
              return {
                ratio: Math.pow(
                  circles
                    .find((c) => Number(c.getAttribute("r")) === Math.max(...circles.map((c) => Number(c.getAttribute("r")))))!
                    .getBoundingClientRect().width /
                    circles.find((c) => JSON.parse(c.parentElement!.getAttribute("data-chart-datum")!).index === 0)!.getBoundingClientRect()
                      .width,
                  2,
                ),
                count: labels.length,
                overlap: rects.some((a, i) =>
                  rects.some((b, j) => i !== j && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top),
                ),
              };
            });
            expect(geometry.ratio).toBeCloseTo(4);
            expect(geometry.count).toBeLessThan(spec.data.length);
            expect(geometry.overlap).toBe(false);
          } else {
            expect(await chart.locator("[data-chart-datum]").count()).toBe(4);
            expect(await chart.locator(".k2b-chart-radar-axis").count()).toBe(4);
          }
          expect(
            await page
              .locator("#standalone [data-chart-datum] circle")
              .first()
              .evaluate((e) => getComputedStyle(e).fill),
          ).toBe("rgb(59, 130, 246)");
          for (const state of ["loading", "empty", "error", "stale", "data"]) {
            await page.locator(`button[data-switch=${state}]`).click();
            await settled(page);
            expect(await viewport.evaluate(documentBox)).toEqual(frame);
            expect(await chart.evaluate(documentBox)).toEqual(box);
            expect(await page.locator("#explorer .k2b-chart-explorer").getAttribute("data-state")).toBe(state);
            if (state === "error") {
              await page.locator("#explorer .k2b-chart-explorer__state[data-state=error] button").click();
              await settled(page);
              expect(await page.locator("#explorer .k2b-chart-explorer").getAttribute("data-state")).toBe("data");
            }
          }
          await page.locator("section.k2b-ui").evaluate((e) => e.setAttribute("data-theme", "dark"));
          await settled(page);
          expect(
            await chart
              .locator("text")
              .first()
              .evaluate((e) => getComputedStyle(e).fill),
          ).not.toBe(light);
          await page.locator("section.k2b-ui").evaluate((e) => e.setAttribute("data-theme", "light"));
          await page.keyboard.press("Escape");
          await settled(page);
          await page.locator("button[data-switch=data]").click();
          await page.mouse.move(0, 0);
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
