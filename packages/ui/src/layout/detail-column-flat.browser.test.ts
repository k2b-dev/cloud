import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser, settled } from "../../test/browser";
import { layoutProblems } from "../layout-check";

// K1, K2, K5a, K9, K12: the Detail column beside Main adds no inset, padding, or scroll inset of its own. It is
// 380 px wide (60 px wider from 1920 px of host width) and reaches the workspace's top, end, and bottom edges; the
// panel fills it. So the panel's head line lies on Main's head line, its text starts 20 px from the column's
// hairline, and its topic lines run from edge to edge.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "detail-column-flat.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { AppWorkspace, DetailPanel, Section } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const text = (tag, value) => { const element = document.createElement(tag); element.textContent = value; return element; };
render(() => createComponent(AppWorkspace, { resizable: false, get children() { return [
  createComponent(AppWorkspace.Head, { primary: { label: "New record", icon: "ti ti-plus", href: "?new" } }),
  createComponent(AppWorkspace.Content, { get children() { return [
    createComponent(AppWorkspace.Main, { get children() { return Array.from({ length: 12 }, (_, index) => text("p", "Record " + (index + 1))); } }),
    createComponent(AppWorkspace.Detail, { id: "record", open: true, get children() { return createComponent(DetailPanel, { get children() { return [
      createComponent(DetailPanel.Header, { title: "Selected record" }),
      createComponent(DetailPanel.Body, { get children() { return [
        createComponent(Section, { title: "Contact", get children() { return text("p", "Ada Lovelace, ada@example.com"); } }),
        createComponent(Section, { title: "Notes", get children() { return text("p", "Prefers mail in the morning."); } }),
      ]; } }),
    ]; } }); } }),
  ]; } }),
]; } }), document.getElementById("app"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the detail column fixture.");
const script = await build.outputs[0]!.text();
setDefaultTimeout(30_000);
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

for (const [width, column] of [
  [1440, 380],
  [1920, 440],
] as const)
  test(`${width} px: the Detail column is ${column} px, flush, and shares Main's head line and the 20 px text edge`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    try {
      await page.setContent(
        `<!doctype html><html lang="en"><head><style>${css}</style><style>.k2b-ui .k2b-app-workspace{border:0;--k2b-workspace-radius:0px}</style></head><body class="k2b-ui" style="margin:0"><div id="app" style="height:100vh"></div></body></html>`,
      );
      await page.addScriptTag({ content: script });
      await page.locator(".k2b-detail-panel__header").waitFor();
      await settled(page);
      const geometry = await page.evaluate(() => {
        const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
        const workspace = box(".k2b-app-workspace");
        const detail = box(".k2b-app-workspace__detail");
        const panel = box(".k2b-detail-panel");
        const head = box(".k2b-app-workspace__head");
        const header = box(".k2b-detail-panel__header");
        // Where the title's text starts.
        const range = document.createRange();
        range.selectNodeContents(document.querySelector(".k2b-detail-panel__heading h2")!);
        const title = range.getBoundingClientRect();
        const line = document.querySelector<HTMLElement>(".k2b-detail-panel__body > .k2b-section:not(:first-child)")!;
        const lineBox = line.getBoundingClientRect();
        const style = getComputedStyle(document.querySelector(".k2b-app-workspace__detail")!);
        const round = (value: number) => Math.round(value * 10) / 10;
        return {
          width: round(detail.width),
          // The column reaches the workspace's top, end, and bottom edges.
          edges: [round(detail.top - workspace.top), round(workspace.right - detail.right), round(workspace.bottom - detail.bottom)],
          padding: style.padding,
          scrollInset: style.getPropertyValue("--k2b-detail-panel-scroll-inset").trim(),
          // The panel fills the column: the host adds nothing around it.
          panel: [round(panel.left - detail.left), round(panel.width - detail.width)],
          // K1: one head line across Main and Detail, 56 px below the top.
          headLine: [round(head.bottom - workspace.top), round(header.bottom - workspace.top)],
          // K5a: the panel's text starts 20 px after the column's hairline.
          textEdge: round(title.left - detail.left),
          // K2: a topic line runs from the column's edge to its edge.
          topicLine: [round(lineBox.left - detail.left), round(detail.right - lineBox.right)],
        };
      });
      expect(geometry).toEqual({
        width: column,
        edges: [0, 0, 0],
        padding: "0px",
        scrollInset: "0rem",
        panel: [0, 0],
        headLine: [56, 56],
        textEdge: 20,
        topicLine: [0, 0],
      });
      const found = await page.evaluate(layoutProblems, {
        root: ".k2b-app-workspace",
        ignore: ".k2b-app-workspace__resize, .k2b-app-workspace__head-primary-label",
      });
      expect(found.problems).toEqual([]);
    } finally {
      await page.close();
    }
  });
