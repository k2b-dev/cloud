import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser, settled } from "../../test/browser";
import { layoutProblems } from "../layout-check";

// Error class (flat QA for 0.84): the core's parts (DetailPanel, sections, a table) and the shell (AppWorkspace with
// its Detail column) each passed their own tests, but together the Detail sat 8 px inside its column, its head line
// lay 9 px below Main's, its lines stopped before the edges, a table scrolled sideways, and the head wrapped. This test
// puts both together, with classic visible scrollbars, at 1100 and 1440 px, with few and many rows:
// - K9, K12: the Detail column is 380 px and flush with the workspace's top, end, and bottom edges;
// - K1: Main's head and the Detail's head are exactly 56 px and share one head line, the head row never wraps;
// - K2, K5a: the panel's text starts 20 px after the column's hairline, its topic lines run from edge to edge;
// - nothing overlaps, spills, is cut, or draws a double line, and no container scrolls sideways.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "detail-in-shell.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { AppWorkspace, DataTable, DetailPanel, IconButton, Section, ViewTabs } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const many = document.body.dataset.rows === "many";
const element = (tag, text) => { const node = document.createElement(tag); node.textContent = text; return node; };
const people = Array.from({ length: many ? 60 : 3 }, (_, index) => ({
  id: "p" + index,
  name: ["Ada Lovelace", "Grace Hopper", "Katherine Johnson", "Hedy Lamarr"][index % 4] + " " + (index + 1),
  email: "person" + (index + 1) + "@example.com",
  updated: new Date(Date.UTC(2026, 10, 1 + (index % 20))),
}));
const orders = Array.from({ length: many ? 25 : 2 }, (_, index) => ({
  id: "o" + index,
  order: "Order " + (1000 + index),
  date: new Date(Date.UTC(2026, 9, 1 + (index % 28))),
  amount: 120.5 + index * 17,
}));
render(() => createComponent(AppWorkspace, { resizable: true, get children() { return [
  createComponent(AppWorkspace.Sidebar, { id: "people-navigation", label: "People", get children() {
    return createComponent(AppWorkspace.SidebarSection, { title: "Books", get children() {
      return ["Team", "Customers", "Suppliers"].map((label, index) => createComponent(AppWorkspace.SidebarItem, { href: "#" + label, active: index === 0, children: label }));
    } });
  } }),
  createComponent(AppWorkspace.Head, {
    views: createComponent(ViewTabs, { label: "Views", current: "all", items: [
      { id: "all", label: "All", href: "?view=all", count: people.length },
      { id: "favorites", label: "Favorites", href: "?view=favorites" },
      { id: "recent", label: "Recent", href: "?view=recent" },
      { id: "shared", label: "Shared", href: "?view=shared" },
    ] }),
    actions: createComponent(IconButton, { label: "Search", size: "sm", variant: "ghost", get children() { return element("i", ""); } }),
    primary: { label: "New contact", icon: "ti ti-plus", href: "?new" },
  }),
  createComponent(AppWorkspace.Content, { get children() { return [
    createComponent(AppWorkspace.Main, { get children() { return createComponent(DataTable, {
      ariaLabel: "People", rows: people, getRowId: (row) => row.id, selectedRowId: "p0",
      columns: [{ id: "name", header: "Name", value: "name" }, { id: "email", header: "Email", value: "email" }, { id: "updated", header: "Updated", value: "updated" }],
    }); } }),
    createComponent(AppWorkspace.Detail, { id: "person", open: true, get children() { return createComponent(DetailPanel, { get children() { return [
      createComponent(DetailPanel.Header, { title: people[0].name }),
      createComponent(DetailPanel.Body, { get children() { return [
        createComponent(Section, { title: "Contact", get children() { return element("p", people[0].email + ", +49 30 1234567"); } }),
        createComponent(Section, { title: "Orders", get children() { return createComponent(DataTable, {
          ariaLabel: "Orders", rows: orders, getRowId: (row) => row.id,
          columns: [{ id: "order", header: "Order", value: "order" }, { id: "date", header: "Date", value: "date" }, { id: "amount", header: "Amount", value: "amount" }],
        }); } }),
        createComponent(Section, { title: "Notes", get children() {
          return Array.from({ length: many ? 12 : 1 }, (_, index) => element("p", "Prefers mail in the morning; call before noon. Note " + (index + 1) + "."));
        } }),
      ]; } }),
    ]; } }); } }),
  ]; } }),
]; } }), document.getElementById("app"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the detail-in-shell fixture.");
const script = await build.outputs[0]!.text();
setDefaultTimeout(30_000);
let browser: Browser;
beforeAll(async () => {
  // Classic scrollbars as a desktop with a mouse draws them, so their tracks take room as they do for people.
  browser = await launchBrowser({ ignoreDefaultArgs: ["--hide-scrollbars"] });
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

for (const width of [1100, 1440])
  for (const rows of ["few", "many"] as const)
    test(`${width} px, ${rows} rows: the Detail column is flush, shares Main's 56 px head line, and nothing spills or scrolls sideways`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      try {
        await page.setContent(
          `<!doctype html><html lang="en"><head><style>${css}</style></head><body class="k2b-ui" data-rows="${rows}" style="margin:0"><div id="app" style="height:100vh"></div></body></html>`,
        );
        await page.addScriptTag({ content: script });
        await page.locator(".k2b-detail-panel__header").waitFor();
        await settled(page);
        const geometry = await page.evaluate(() => {
          const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
          const round = (value: number) => Math.round(value * 10) / 10;
          const workspace = box(".k2b-app-workspace");
          const detail = box(".k2b-app-workspace__detail");
          const panel = box(".k2b-detail-panel");
          const head = box(".k2b-app-workspace__head");
          const header = box(".k2b-detail-panel__header");
          const range = document.createRange();
          range.selectNodeContents(document.querySelector(".k2b-detail-panel__heading h2")!);
          const title = range.getBoundingClientRect();
          const body = document.querySelector<HTMLElement>(".k2b-detail-panel__body")!;
          // Only a classic scrollbar's fixed track, kept so nothing moves when the body starts to scroll, lies after a line.
          const track = body.offsetWidth - body.clientWidth;
          const line = document.querySelector(".k2b-detail-panel__body > .k2b-section:not(:first-child)")!.getBoundingClientRect();
          // Every box that clips or scrolls sideways and holds more than it shows; a visually hidden 1 px box is skipped.
          const sideways = [...document.querySelectorAll<HTMLElement>(".k2b-app-workspace *")]
            .filter((element) => {
              const style = getComputedStyle(element);
              return style.overflowX !== "visible" && element.clientWidth > 1 && element.scrollWidth > element.clientWidth + 1;
            })
            .map((element) => `${element.className.split(" ")[0]} ${element.scrollWidth}/${element.clientWidth}`);
          return {
            width: round(detail.width),
            edges: [round(detail.top - workspace.top), round(workspace.right - detail.right), round(workspace.bottom - detail.bottom)],
            panel: [round(panel.left - detail.left), round(panel.width - detail.width)],
            heights: [round(head.height), round(header.height)],
            headLine: round(header.bottom - head.bottom),
            textEdge: round(title.left - detail.left),
            topicLine: [round(line.left - detail.left), round(detail.right - line.right - track)],
            sideways,
          };
        });
        expect(geometry).toEqual({
          width: 380,
          edges: [0, 0, 0],
          panel: [0, 0],
          heights: [56, 56],
          headLine: 0,
          textEdge: 20,
          topicLine: [0, 0],
          sideways: [],
        });
        // The grips lie over their column lines on purpose (K13).
        const found = await page.evaluate(layoutProblems, { root: ".k2b-app-workspace", ignore: ".k2b-app-workspace__resize" });
        expect(found.problems).toEqual([]);
      } finally {
        await page.close();
      }
    });
