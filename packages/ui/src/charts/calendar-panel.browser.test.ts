import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, pageErrors, settled } from "../../test/browser";
import { prepareChartSnapshot } from "./core/snapshot";

const root = resolve(import.meta.dir, "../..");
const spec = {
  kind: "heatmap" as const,
  layout: "calendar" as const,
  scale: "sequential" as const,
  locale: "en-GB",
  data: Array.from({ length: 182 }, (_, i): [string, number] => [
    new Date(Date.UTC(2026, 4, 11) + i * 86400000).toISOString().slice(0, 10),
    i,
  ]),
};
const snapshot = prepareChartSnapshot(spec, { key: (s) => String(s.datum.index), tooltip: (s) => ({ title: s.datum.label, rows: [] }) });
const rows = snapshot.marks.map((m) => ({ key: m.key }));
const columns = [{ id: "day", label: "Day", value: (r: { key: string }) => r.key }];

let panelBrowser: Awaited<ReturnType<typeof launchBrowser>>;
let panelServer: string;
let panelScript: string;
beforeAll(async () => {
  const { ChartExplorer: ServerExplorer } = await import(resolve(root, "dist/ssr/content/ChartExplorer.js"));
  const server = renderToString(() =>
    createComponent(ServerExplorer, {
      title: "Opens per day",
      description: "Last 26 weeks",
      inset: "1rem",
      data: { chart: snapshot, rows },
      columns,
      renderDetails: false,
      request: { status: "idle" },
    }),
  );
  const build = await Bun.build({
    entrypoints: ["calendar-panel"],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [
      {
        name: "panel",
        setup(b) {
          b.onResolve({ filter: /^calendar-panel$/ }, () => ({ path: "entry", namespace: "panel" }));
          b.onLoad({ filter: /.*/, namespace: "panel" }, () => ({
            loader: "ts",
            resolveDir: import.meta.dir,
            contents: `
    import {createComponent,createSignal} from 'solid-js';import {render} from 'solid-js/web';
    import {ChartExplorer} from ${JSON.stringify(resolve(root, "dist/browser/content/ChartExplorer.js"))};
    const snapshot=${JSON.stringify(snapshot)}, rows=${JSON.stringify(rows)};
    const [state,setState]=createSignal('data'),[view,setView]=createSignal('chart');
    const data=()=>['data','stale'].includes(state());
    render(()=>createComponent(ChartExplorer,{title:'Opens per day',description:'Last 26 weeks',inset:'1rem',renderDetails:false,
    get data(){return data()?{chart:snapshot,rows}:{rows:[]}},
    columns:[{id:'day',label:'Day',value:r=>r.key}],
    get view(){return view()},onViewChange:setView,
    get request(){return {status:state()==='loading'?'loading':['error','stale'].includes(state())?'error':'idle',reason:'Could not load observations.'}},
    onRetry:()=>setState('data')
    }),document.getElementById('mount'));
    document.querySelectorAll('button[data-state]').forEach(b=>b.onclick=()=>setState(b.dataset.state));
    document.getElementById('table').onclick=()=>setView(view()==='table'?'chart':'table');
  `,
          }));
        },
      },
    ],
  });
  expect(build.success).toBe(true);
  panelServer = server;
  panelScript = await build.outputs[0]!.text();
  panelBrowser = await launchBrowser();
});
afterAll(async () => {
  await panelBrowser?.close();
});

for (const width of [390, 800, 1440, 1920])
  test(`26-week calendar fills its real panel and reserves all states at ${width}px`, async () => {
    const browser = panelBrowser;
    const server = panelServer;
    {
      const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: true, reducedMotion: "reduce" });
      try {
        const errors = pageErrors(page);
        await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${await Bun.file(resolve(root, "dist/styles.css")).text()}
        body{margin:0;font-family:Arial}.grid{display:grid;grid-template-columns:2fr 1fr;gap:20px;padding:24px}.panel{min-width:0;border:1px solid #ddd;padding:16px;border-radius:12px}@media(max-width:860px){.grid{grid-template-columns:1fr}}@media(max-width:700px){.grid{padding:16px}.panel{padding:12px}}
        </style></head><body><section class="k2b-ui"><div class="grid"><article class="panel" id="mount">${server}</article><aside>Opens by country</aside></div>
        ${["data", "loading", "empty", "error", "stale"].map((s) => `<button data-state="${s}">${s}</button>`).join("")}<button id="table">Table</button></section></body></html>`);
        await settled(page);
        // The server frame already opens at the newest end, before mounting.
        const serverChart = page.locator(".k2b-chart"),
          serverNewest = await serverChart.locator("[data-chart-datum] rect").last().boundingBox(),
          serverViewport = await serverChart.boundingBox();
        expect(await serverChart.evaluate((e) => e.scrollLeft)).toBe(0);
        expect(serverNewest!.x).toBeGreaterThanOrEqual(serverViewport!.x);
        expect(serverNewest!.x + serverNewest!.width).toBeLessThanOrEqual(serverViewport!.x + serverViewport!.width + 1);
        const gaps = await serverChart.evaluate((e) => {
          const label = e.querySelector("[data-calendar-weekdays] text")!.getBoundingClientRect(),
            cell = Array.from(e.querySelectorAll("[data-chart-datum] rect"))
              .map((r) => r.getBoundingClientRect())
              .filter((r) => r.left >= label.right - 0.1)
              .sort((a, b) => a.left - b.left)[0]!,
            legend = e.querySelector("[data-calendar-legend]")!,
            start = legend.querySelector("text")!.getBoundingClientRect(),
            swatch = legend.querySelector("rect")!.getBoundingClientRect();
          return { day: cell.left - label.right, legend: swatch.left - start.right };
        });
        const mask = await serverChart.locator("[data-calendar-weekdays] > rect").boundingBox();
        expect(mask!.x).toBeLessThanOrEqual(serverViewport!.x);
        expect(gaps.day).toBeGreaterThanOrEqual(0);
        expect(gaps.day).toBeLessThanOrEqual(8);
        expect(gaps.legend).toBeGreaterThan(0);
        expect(gaps.legend).toBeLessThanOrEqual(10);
        const serverPinned = await serverChart
          .locator("[data-calendar-pinned] text")
          .evaluateAll((nodes) => nodes.map((e) => e.getBoundingClientRect().toJSON()));
        const svg = await page.locator(".k2b-chart__svg > svg").evaluate((e) => e.outerHTML);
        const serverStyle = await serverChart.evaluate((e) => (e as HTMLElement).style.cssText);
        const box = (e: Element) => {
          const b = e.getBoundingClientRect();
          return { x: b.x + scrollX, y: b.y + scrollY, width: b.width, height: b.height };
        };
        const panel = page.locator(".panel"),
          viewport = page.locator(".k2b-chart-explorer__viewport");
        const initial = await panel.evaluate(box),
          initialViewport = await viewport.evaluate(box);
        await page.locator("#mount").evaluate((e) => e.replaceChildren());
        await page.addScriptTag({ content: panelScript });
        await settled(page);
        expect(await page.locator(".k2b-chart__svg > svg").evaluate((e) => e.outerHTML)).toBe(svg);
        expect(await panel.evaluate(box)).toEqual(initial);
        expect(await viewport.evaluate(box)).toEqual(initialViewport);
        const chart = page.locator(".k2b-chart"),
          drawing = page.locator(".k2b-chart__svg");
        expect(await chart.evaluate((e) => (e as HTMLElement).style.cssText)).toBe(serverStyle);
        expect(
          await chart.locator("[data-calendar-pinned] text").evaluateAll((nodes) => nodes.map((e) => e.getBoundingClientRect().toJSON())),
        ).toEqual(serverPinned);
        const cell = await chart.locator("[data-chart-datum] rect").last().boundingBox();
        const chartBox = await chart.boundingBox(),
          drawingBox = await drawing.boundingBox();
        expect(Math.abs(cell!.width - cell!.height)).toBeLessThan(0.2);
        expect(cell!.width).toBeGreaterThanOrEqual(13.9);
        expect(cell!.width).toBeLessThanOrEqual(32.1);
        const expectedWidth = Math.min(snapshot.maxWidth!, Math.max(snapshot.minWidth!, chartBox!.width));
        expect(Math.abs(drawingBox!.width - expectedWidth)).toBeLessThan(1);
        expect(Math.abs(drawingBox!.height + 16 - initialViewport.height)).toBeLessThan(1);
        expect(
          Math.abs(
            drawingBox!.width > chartBox!.width
              ? drawingBox!.x + drawingBox!.width - chartBox!.x - chartBox!.width
              : drawingBox!.x - chartBox!.x,
          ),
        ).toBeLessThan(1);
        const scroll = await chart.evaluate((e) => ({ left: e.scrollLeft, full: e.scrollWidth, width: e.clientWidth }));
        expect(scroll.full > scroll.width + 1).toBe(chartBox!.width < snapshot.minWidth! - 1);
        expect(scroll.left).toBe(0);
        expect(cell!.x + cell!.width).toBeLessThanOrEqual(chartBox!.x + chartBox!.width + 1);
        const legend = await chart.locator("[data-calendar-legend]").boundingBox();
        expect(drawingBox!.y + drawingBox!.height - legend!.y - legend!.height).toBeLessThan(16);
        expect(legend!.y + legend!.height).toBeLessThanOrEqual(chartBox!.y + (await chart.evaluate((e) => e.clientHeight)));
        expect(
          await chart.locator("[data-calendar-month]").evaluateAll((nodes) => {
            const visible = nodes.filter((e) => getComputedStyle(e).visibility !== "hidden");
            return visible.every((e, i) => i === 0 || e.getBoundingClientRect().left >= visible[i - 1]!.getBoundingClientRect().right);
          }),
        ).toBe(true);
        if (process.env.CHART_SCREENSHOTS)
          await page.screenshot({ path: `${process.env.CHART_SCREENSHOTS}/calendar-data-light-${width}.png`, fullPage: true });
        await chart.evaluate((e) => (e.scrollLeft = -e.scrollWidth));
        await settled(page);
        const oldScroll = await chart.evaluate((e) => e.scrollLeft);
        await chart.locator("[data-chart-datum] rect").first().tap();
        await settled(page);
        expect(await chart.evaluate((e) => e.scrollLeft)).toBe(oldScroll);
        expect(await chart.locator("[data-selected]").count()).toBe(1);
        await page.keyboard.press("Escape");
        for (const state of ["loading", "empty", "error", "stale", "data"]) {
          await page.locator(`button[data-state="${state}"]`).click();
          await settled(page);
          expect(await panel.evaluate(box)).toEqual(initial);
          expect(await viewport.evaluate(box)).toEqual(initialViewport);
          if (state === "error") {
            await page.locator(".k2b-chart-explorer__state button").click();
            await settled(page);
            expect(await panel.evaluate(box)).toEqual(initial);
          }
        }
        await page.locator("#table").click();
        await settled(page);
        expect(await panel.evaluate(box)).toEqual(initial);
        expect((await viewport.evaluate(box)).height).toBe(initialViewport.height + 16);
        if (width === 1920) {
          await page.locator("#table").click();
          await page.setViewportSize({ width: 390, height: 900 });
          await settled(page);
          expect(await chart.evaluate((e) => e.scrollLeft)).toBe(0);
          const newest = await chart.locator("[data-chart-datum] rect").last().boundingBox(),
            visible = await chart.boundingBox();
          expect(newest!.x + newest!.width).toBeLessThanOrEqual(visible!.x + visible!.width + 1);
          await page.setViewportSize({ width, height: 900 });
          await settled(page);
          expect(await panel.evaluate(box)).toEqual(initial);
        }
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }
  });

for (const emptySnapshot of [false, true])
  test(`calendar first load ${emptySnapshot ? "with an empty snapshot" : "without a snapshot"} keeps its frame and intrinsic width`, async () => {
    const initialData = emptySnapshot
      ? {
          chart: prepareChartSnapshot({ ...spec, data: [] }, { key: (s) => String(s.datum.index), tooltip: () => ({ rows: [] }) }),
          rows: [],
        }
      : { rows: [] };
    const { ChartExplorer: ServerExplorer } = await import(resolve(root, "dist/ssr/content/ChartExplorer.js"));
    const server = renderToString(() =>
      createComponent(ServerExplorer, {
        title: "Opens per day",
        description: "Last 26 weeks",
        data: initialData,
        columns,
        request: { status: "loading" },
        renderDetails: false,
      }),
    );
    const build = await Bun.build({
      entrypoints: ["calendar-first-load"],
      target: "browser",
      conditions: ["browser"],
      format: "iife",
      plugins: [
        {
          name: "first-load",
          setup(b) {
            b.onResolve({ filter: /^calendar-first-load$/ }, () => ({ path: "entry", namespace: "first-load" }));
            b.onLoad({ filter: /.*/, namespace: "first-load" }, () => ({
              loader: "ts",
              resolveDir: import.meta.dir,
              contents: `
        import {createComponent,createSignal} from 'solid-js';import {render} from 'solid-js/web';
        import {ChartExplorer} from ${JSON.stringify(resolve(root, "dist/browser/content/ChartExplorer.js"))};
        const [ready,setReady]=createSignal(false), snapshot=${JSON.stringify(snapshot)},rows=${JSON.stringify(rows)};
        render(()=>createComponent(ChartExplorer,{title:'Opens per day',description:'Last 26 weeks',renderDetails:false,
          get data(){return ready()?{chart:snapshot,rows}:${JSON.stringify(initialData)}}, columns:[{id:'day',label:'Day',value:r=>r.key}],
          get request(){return {status:ready()?'idle':'loading'}}
        }),document.getElementById('mount'));
        document.getElementById('load').onclick=()=>setReady(!ready());
      `,
            }));
          },
        },
      ],
    });
    expect(build.success).toBe(true);
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage({ viewport: { width: 900, height: 900 }, reducedMotion: "reduce" });
      const errors = pageErrors(page);
      await page.setContent(
        `<!doctype html><style>${await Bun.file(resolve(root, "dist/styles.css")).text()}body{margin:24px;font-family:Arial}.host{display:inline-block;max-width:100%;border:1px solid #ddd;padding:16px}</style><main class="k2b-ui"><article class="host" id="mount">${server}</article><button id="load">Load</button></main>`,
      );
      await settled(page);
      const box = (e: Element) => {
        const b = e.getBoundingClientRect();
        return { width: b.width, height: b.height };
      };
      const host = page.locator(".host"),
        viewport = page.locator(".k2b-chart-explorer__viewport");
      const first = await host.evaluate(box),
        reserve = await viewport.evaluate(box);
      // Compare intrinsic header sizing in this engine/font. A magic width
      // assumes Chromium's control metrics and misses the actual collapse class.
      const headerWidth = await host.evaluate((element) => {
        const reference = element.cloneNode(true) as HTMLElement;
        reference.removeAttribute("id");
        reference.style.cssText = "position:absolute;visibility:hidden";
        const explorer = reference.querySelector<HTMLElement>(".k2b-chart-explorer")!;
        explorer.style.containerType = "normal";
        explorer.querySelector(".k2b-chart-explorer__viewport")!.remove();
        element.after(reference);
        const width = reference.getBoundingClientRect().width;
        reference.remove();
        return width;
      });
      expect(headerWidth).toBeGreaterThan(0);
      expect(Math.abs(first.width - headerWidth)).toBeLessThan(1);
      expect(await page.locator(".k2b-chart-explorer").evaluate((e) => getComputedStyle(e).containerType)).toBe("normal");
      await page.locator("#mount").evaluate((e) => e.replaceChildren());
      await page.addScriptTag({ content: await build.outputs[0]!.text() });
      await settled(page);
      expect(await host.evaluate(box)).toEqual(first);
      expect(await viewport.evaluate(box)).toEqual(reserve);
      for (let i = 0; i < 3; i++) {
        await page.locator("#load").click();
        await settled(page);
        expect(await host.evaluate(box)).toEqual(first);
        expect(await viewport.evaluate(box)).toEqual(reserve);
      }
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

test("calendar reserve fits a classic 15px horizontal scrollbar", async () => {
  const { ChartExplorer } = await import(resolve(root, "dist/ssr/content/ChartExplorer.js"));
  const server = renderToString(() =>
    createComponent(ChartExplorer, {
      title: "Opens per day",
      data: { chart: snapshot, rows },
      columns,
      renderDetails: false,
    }),
  );
  const browser = await launchBrowser({ ignoreDefaultArgs: ["--hide-scrollbars"] });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 }, hasTouch: false });
    const errors = pageErrors(page);
    await page.setContent(
      `<!doctype html><style>${await Bun.file(resolve(root, "dist/styles.css")).text()}body{margin:16px;font-family:Arial}.k2b-ui .k2b-chart{scrollbar-color:auto}.k2b-chart::-webkit-scrollbar{height:15px;width:15px}</style><main class="k2b-ui">${server}</main>`,
    );
    await settled(page);
    const chart = page.locator(".k2b-chart");
    expect(await chart.evaluate((e) => (e as HTMLElement).offsetHeight - e.clientHeight)).toBe(15);
    const legend = await chart.locator("[data-calendar-legend]").boundingBox(),
      box = await chart.boundingBox();
    expect(legend!.y + legend!.height).toBeLessThanOrEqual(box!.y + (await chart.evaluate((e) => e.clientHeight)));
    expect(await page.locator(".k2b-chart-explorer__viewport").evaluate((e) => e.scrollHeight - e.clientHeight)).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
