import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { browserName, launchBrowser, settled } from "../../test/browser";
import { type LayoutProblems, layoutProblems } from "../layout-check";

// The defects of today's flat shell, written down by the flat kinds of the self-check (Cloud flach K2, K11, K13): lines
// and fills that stop short of their column, near-double lines, grips off their edge, and type outside the roles. The
// shell is the one apps use: head with views, sidebar, status row, a table with a selected row, and a detail column
// with an error notice, with grips on its resizable edges. All data is invented.
//
// This file documents, it does not guard: the snapshot is what the shell shows today. A rebuilt building block removes
// its lines from the snapshot; a new line is a new defect. Record with RECORD_FLAT_FINDINGS=1, once per engine
// (TEST_BROWSER=chromium and webkit).
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
// The shipped faces, so text metrics are the same in Chromium and WebKit.
const assets = "http://k2b-ui.test/";
const fonts = readFileSync(resolve(ui, "dist/plex.css"), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${assets}`);
const snapshotPath = resolve(import.meta.dir, "flat-shell-findings.snapshot.json");
const recording = process.env.RECORD_FLAT_FINDINGS === "1";
type Findings = Pick<LayoutProblems, "shortEdge" | "nearDouble" | "gripOffCenter" | "typeRole">;
const expected: Record<string, Findings> = existsSync(snapshotPath) ? JSON.parse(readFileSync(snapshotPath, "utf8")) : {};

const entry = resolve(import.meta.dir, "flat-shell-findings.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { AppWorkspace, Button, DataTable, DetailPanel, NoticeCard, Section, StatusRow, ViewTabs } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const text = (tag, children) => { const element = document.createElement(tag); element.textContent = children; return element; };
const columns = [
  { id: "number", header: "Order", value: "number", primary: true },
  { id: "customer", header: "Customer", value: "customer" },
  { id: "state", header: "State", value: "state" },
  { id: "amount", header: "Amount", value: "amount", type: "amount", format: { currency: "EUR" } },
];
const rows = Array.from({ length: 14 }, (_, index) => ({
  id: "o" + (index + 1),
  number: "A-" + (4471 + index),
  customer: ["Holzwerk Brandt", "Stadtwerke Auental", "Lackfabrik Nordhaus", "Mira Solberg"][index % 4],
  state: ["Open", "Waiting", "Done"][index % 3],
  amount: 120 + index * 37.5,
}));
render(() => createComponent(AppWorkspace, { get children() { return [
  createComponent(AppWorkspace.Head, {
    get views() { return createComponent(ViewTabs, { label: "Views", current: "all", items: [
      { id: "all", label: "All", href: "?view=all", count: 14 },
      { id: "mine", label: "Assigned to me", href: "?view=mine" },
      { id: "waiting", label: "Waiting", href: "?view=waiting" },
    ] }); },
    primary: { label: "New order", icon: "ti ti-plus", href: "?new=order" },
  }),
  createComponent(AppWorkspace.Sidebar, { id: "folders", label: "Folders", get children() {
    return createComponent(AppWorkspace.SidebarDesktop, { get children() { return createComponent(AppWorkspace.SidebarBody, { get children() {
      return createComponent(AppWorkspace.SidebarSection, { title: "Orders", get children() { return ["Open", "Waiting", "Done", "Archive"].map((label, index) =>
        createComponent(AppWorkspace.SidebarItem, { href: "#" + label, active: index === 0, children: label })); } });
    } }); } });
  } }),
  createComponent(AppWorkspace.Content, { get children() { return [
    createComponent(AppWorkspace.Main, { get children() { return [
      createComponent(StatusRow, { lead: "14 orders", facts: [{ value: "3", label: "waiting" }, { value: "1", label: "overdue" }] }),
      createComponent(DataTable, { columns, rows, getRowId: (row) => row.id, selectedRowId: "o2", surface: "plain", ariaLabel: "Orders" }),
    ]; } }),
    createComponent(AppWorkspace.Detail, { id: "order", open: true, get children() {
      return createComponent(DetailPanel, { get children() { return [
        createComponent(DetailPanel.Header, { title: "A-4472", subtitle: "Stadtwerke Auental" }),
        createComponent(DetailPanel.Body, { get children() { return [
          createComponent(NoticeCard, { tone: "danger", icon: true, title: "The invoice could not be sent.",
            detail: "The mail server refused the connection.", actions: createComponent(Button, { size: "sm", variant: "secondary", children: "Open invoice" }) }),
          createComponent(Section, { title: "Items", icon: "ti ti-box", count: 2, get children() { return [text("div", "Oak cabinet"), text("div", "Brass lamp")]; } }),
          createComponent(Section, { title: "Notes", icon: "ti ti-notes", children: "Collect on Friday." }),
        ]; } }),
      ]; } });
    } }),
  ]; } }),
]; } }), document.getElementById("app"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the flat shell fixture");
const script = await build.outputs[0]!.text();

let browser: Browser;
setDefaultTimeout(30_000);
beforeAll(async () => {
  if (!recording && !expected[browserName])
    throw new Error(`Missing ${browserName} findings. Record them with RECORD_FLAT_FINDINGS=1 TEST_BROWSER=${browserName}.`);
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

test(`today's flat shell at 1440 px in ${browserName}: the findings of the flat kinds`, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  try {
    await page.route(`${assets}**`, (route) =>
      route.fulfill({ path: resolve(ui, "dist", new URL(route.request().url()).pathname.slice(1)) }),
    );
    await page.setContent(
      `<!doctype html><html lang="en"><head><style>${css}</style><style>${fonts}</style></head>` +
        '<body class="k2b-ui" data-theme="light" style="margin:0"><div id="app" style="height:900px"></div></body></html>',
    );
    await page.evaluate(() =>
      Promise.all(
        ["400 13px 'IBM Plex Sans'", "500 13px 'IBM Plex Sans'", "600 13px 'IBM Plex Sans'"].map((font) => document.fonts.load(font)),
      ),
    );
    await page.addScriptTag({ content: script });
    await page.locator(".k2b-app-workspace__detail .k2b-notice-card").waitFor();
    await settled(page);
    const result = await page.evaluate(layoutProblems, { root: "#app", flat: true });
    const findings: Findings = {
      shortEdge: result.shortEdge,
      nearDouble: result.nearDouble,
      gripOffCenter: result.gripOffCenter,
      typeRole: result.typeRole,
    };
    if (recording) writeFileSync(snapshotPath, `${JSON.stringify({ ...expected, [browserName]: findings }, null, 2)}\n`);
    else expect(findings).toEqual(expected[browserName]!);
  } finally {
    await page.close();
  }
});
