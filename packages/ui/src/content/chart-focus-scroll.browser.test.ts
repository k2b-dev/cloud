import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../test/browser";

const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "chart-focus-scroll.fixture.ts");
// A live chart and a prepared snapshot, both below the fold: focusing either one scrolls it into view.
const fixture = `
import { createComponent, render } from "solid-js/web";
import { Chart, ChartSnapshotView, createChartCursor, prepareChartSnapshot } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const linked = createChartCursor();
const line = [{ label: "Visits", data: [{ x: 1, y: 3 }, { x: 2, y: 5 }, { x: 3, y: 4 }] }];
const data = [{ label: "Search", value: 1840 }, { label: "Mail", value: 1260 }, { label: "Social", value: 920 }];
const snapshot = prepareChartSnapshot({ kind: "bar", data }, {
  key: ({ datum }) => String(datum.index),
  tooltip: ({ datum }) => ({ title: datum.label, rows: [{ label: "Value", value: String(datum.values[0]?.value) }] }),
});
render(() => [
  (() => { const spacer = document.createElement("div"); spacer.style.height = "1400px"; return spacer; })(),
  createComponent(Chart, { kind: "bar", class: "live", data, style: { height: "240px" } }),
  (() => { const spacer = document.createElement("div"); spacer.style.height = "1400px"; return spacer; })(),
  createComponent(ChartSnapshotView, { snapshot, selectedKey: null, onSelect: () => {}, style: { height: "240px" } }),
  (() => { const spacer = document.createElement("div"); spacer.style.height = "1400px"; return spacer; })(),
  // Two line charts on one cursor: inspecting one shows the same X in the other.
  createComponent(Chart, { kind: "line", class: "linked-a", cursor: linked, series: line, style: { height: "200px" } }),
  createComponent(Chart, { kind: "line", class: "linked-b", cursor: linked, series: line, style: { height: "200px" } }),
  (() => { const spacer = document.createElement("div"); spacer.style.height = "1400px"; return spacer; })(),
], document.getElementById("host"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle chart focus scroll fixture");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const mount = async (page: Page) => {
  await page.setContent(
    `<!doctype html><html lang="en"><head><style>${css}</style></head><body class="k2b-ui" data-theme="light" style="margin:0"><div id="host" style="width:720px"></div></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await settled(page);
};
const frames = (page: Page, count: number) =>
  page.evaluate(
    (n) =>
      new Promise<void>((done) =>
        (function next(left: number) {
          left ? requestAnimationFrame(() => next(left - 1)) : done();
        })(n),
      ),
    count,
  );
// The open tooltip of a chart and the distance between its box and the chart's inspected anchor.
const charts = { live: 0, snapshot: 1, "linked-a": 2, "linked-b": 3 } as const;
const tooltipOf = (page: Page, selector: keyof typeof charts) =>
  page.evaluate((index) => {
    const container = document.querySelectorAll<HTMLElement>(".k2b-chart")[index]!;
    const tooltip = container.querySelector<HTMLElement>('[role="tooltip"]')!;
    const anchor = container.querySelector<HTMLElement>(".k2b-chart__anchor")!.getBoundingClientRect();
    const box = tooltip.getBoundingClientRect();
    return {
      open: tooltip.matches(":popover-open"),
      nearAnchor: Math.abs(box.bottom - anchor.top) < 40 || Math.abs(box.top - anchor.bottom) < 40,
      inView: box.top >= 0 && box.bottom <= window.innerHeight,
    };
  }, charts[selector]);

for (const chart of ["live", "snapshot"] as const)
  test(`focusing a ${chart} chart below the fold scrolls it into view and keeps its tooltip at the first value`, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = pageErrors(page);
    try {
      await mount(page);
      const before = await page.evaluate(() => window.scrollY);
      await page.evaluate((index) => document.querySelectorAll<HTMLElement>(".k2b-chart")[index]!.focus(), chart === "live" ? 0 : 1);
      // The scroll that focus causes arrives in a later frame than the focus that opened the tooltip.
      await frames(page, 4);
      expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(before);
      expect(await tooltipOf(page, chart)).toEqual({ open: true, nearAnchor: true, inView: true });
      // Scrolling the page further moves the tooltip with its mark while the chart keeps focus.
      await page.evaluate(() => window.scrollBy(0, 60));
      await frames(page, 4);
      expect(await tooltipOf(page, chart)).toEqual({ open: true, nearAnchor: true, inView: true });
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

test("a linked chart's tooltip moves with its mark while the focused chart keeps the cursor", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await mount(page);
    await page.evaluate(() => document.querySelectorAll<HTMLElement>(".k2b-chart")[2]!.focus());
    await frames(page, 4);
    await page.evaluate(() => window.scrollBy(0, 80));
    await frames(page, 4);
    expect(await tooltipOf(page, "linked-a")).toEqual({ open: true, nearAnchor: true, inView: true });
    expect(await tooltipOf(page, "linked-b")).toMatchObject({ open: true, nearAnchor: true });
  } finally {
    await page.close();
  }
}, 30_000);

test("a tooltip opened by the pointer still closes when the page scrolls", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await mount(page);
    const chart = page.locator(".k2b-chart").nth(1);
    await chart.scrollIntoViewIfNeeded();
    // Let the scroll event of bringing the chart into view pass before the pointer arrives.
    await frames(page, 4);
    const box = (await chart.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.6);
    await frames(page, 4);
    expect((await tooltipOf(page, "snapshot")).open).toBe(true);
    await page.evaluate(() => window.scrollBy(0, 60));
    await frames(page, 4);
    expect((await tooltipOf(page, "snapshot")).open).toBe(false);
  } finally {
    await page.close();
  }
}, 30_000);
