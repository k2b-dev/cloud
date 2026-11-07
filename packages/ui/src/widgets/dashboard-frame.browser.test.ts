import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../test/browser";

const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "dashboard-frame.fixture.ts");
// Three frames as cells of a section (a third, two thirds, full): a short compact block, a table that reserves its full height, and a bare surface
// around content with its own head. `window.frameState(state)` switches all of them; `window.retries` counts Try again.
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { DashboardFrame, DashboardGrid, DashboardSection, TextInput } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const [state, setState] = createSignal("ready");
window.frameState = setState;
window.retries = 0;
const retry = () => { window.retries += 1; };
const box = (height, text) => { const element = document.createElement("div"); element.style.height = height + "px"; element.textContent = text; return element; };
const rows = (count) => { const table = document.createElement("table"); for (let i = 0; i < count; i++) { const row = table.insertRow(); row.insertCell().textContent = "Row " + i; row.style.height = "36px"; } return table; };
render(() => createComponent(DashboardGrid, { get children() { return createComponent(DashboardSection, { title: "Effect", icon: "ti ti-chart-dots", get children() { return [
  createComponent(DashboardFrame, { width: "third", title: "Balance", subtitle: "October", height: "56px", compact: true, asOf: "09:12", onRetry: retry, empty: "No bookings.", get state() { return state(); }, get children() { return box(40, "amounts"); } }),
  createComponent(DashboardFrame, { width: "twoThirds", title: "Campaigns", subtitle: "Latest 6", asOf: "09:12", onRetry: retry, empty: "No campaign.", emptyIcon: "ti ti-table-off",
    get tools() { return createComponent(TextInput, { type: "search", "aria-label": "Search campaigns", placeholder: "Search" }); },
    get reserve() { return rows(6); }, get state() { return state(); }, get children() { return rows(state() === "ready" || state() === "stale" ? 6 : 0); } }),
  createComponent(DashboardFrame, { width: "full", get children() { return box(200, "explorer"); } }),
]; } }); } }), document.getElementById("host"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle dashboard frame fixture");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const mount = async (page: Page, hostWidth: number) => {
  await page.setContent(
    `<!doctype html><html lang="en"><head><style>${css}</style></head><body class="k2b-ui" data-theme="light" style="margin:0"><div id="host" style="width:${hostWidth}px"></div></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await settled(page);
};
const setState = async (page: Page, state: string) => {
  await page.evaluate((next) => (window as unknown as { frameState: (value: string) => void }).frameState(next), state);
  await settled(page);
};
// Frame, head and body of every frame: nothing may move or resize between states.
const geometry = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".k2b-dashboard-frame")].map((frame) => {
      const rect = (element: Element | null) => {
        if (!element) return null;
        const box = element.getBoundingClientRect();
        return [box.x, box.y, box.width, box.height].map(Math.round);
      };
      return {
        frame: rect(frame),
        header: rect(frame.querySelector(".k2b-dashboard-frame__header")),
        body: rect(frame.querySelector(".k2b-dashboard-frame__body, .k2b-dashboard-frame__stack")),
      };
    }),
  );

for (const width of [1200, 390])
  test(`every state keeps each frame, head and body in place at ${width} px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 1400 }, reducedMotion: "reduce" });
    const errors = pageErrors(page);
    try {
      await mount(page, width);
      const ready = await geometry(page);
      expect(ready.length).toBe(3);
      // Each frame is its own grid cell: a third and two thirds share a row at 1200 px; on a phone each takes the row.
      const grid = await page.locator(".k2b-dashboard-section__grid").evaluate((element) => element.getBoundingClientRect().width);
      const spans = ready.map((entry) => Math.round(((entry.frame![2]! + 16) / (grid + 16)) * 6));
      expect({ width, spans }).toEqual({ width, spans: width === 1200 ? [2, 4, 6] : [6, 6, 6] });
      // The reserved table body is as high as all six rows, also before the rows arrive.
      expect(ready[1]!.body![3]).toBeGreaterThanOrEqual(6 * 36);
      for (const state of ["loading", "empty", "error", "stale", "ready"]) {
        await setState(page, state);
        expect({ width, state, geometry: await geometry(page) }).toEqual({ width, state, geometry: ready });
      }
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

test("Try again is reachable by keyboard in a failure and in a stale note, and calls the host once per press", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  try {
    await mount(page, 1200);
    await setState(page, "error");
    const retries = () => page.evaluate(() => (window as unknown as { retries: number }).retries);
    // Tab order: the compact frame's Try again, then the table's search and its Try again.
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Try again");
    await page.keyboard.press("Enter");
    expect(await retries()).toBe(1);
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Search campaigns");
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Try again");
    await page.keyboard.press("Space");
    expect(await retries()).toBe(2);
    // A failure is announced; the hidden reserve never takes focus.
    expect(await page.locator('.k2b-dashboard-frame [role="alert"]').count()).toBe(2);
    expect(
      await page.locator(".k2b-dashboard-frame__reserve").evaluateAll((nodes) => nodes.every((node) => (node as HTMLElement).inert)),
    ).toBe(true);
    await setState(page, "stale");
    await page.locator("body").focus();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.className)).toBe("k2b-dashboard-frame__link");
    await page.keyboard.press("Enter");
    expect(await retries()).toBe(3);
  } finally {
    await page.close();
  }
}, 30_000);
