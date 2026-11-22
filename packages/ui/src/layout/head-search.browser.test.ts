import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";
import { layoutProblems } from "../layout-check";

// K6, K15: a head with a search and further actions. Wide, the search stands before the actions in the one head line.
// Narrow (a phone, a tablet, a laptop with the sidebar open), it waits behind its icon; the icon opens it in a row of
// its own and focuses its field, Escape closes it and returns focus to the icon, and a field with a value keeps it in
// sight. Nothing in the head line moves when it opens, and nothing overlaps, spills, or is cut, open or closed.
// Desktop windows without touch and with classic visible scrollbars.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "head-search.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { AppWorkspace, ButtonLink, IconButton, TextInput, ViewTabs } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const filled = document.body.dataset.filled === "true";
const icon = (name) => { const node = document.createElement("i"); node.className = name; node.setAttribute("aria-hidden", "true"); return node; };
render(() => createComponent(AppWorkspace, { get children() { return [
  createComponent(AppWorkspace.Sidebar, { id: "navigation", label: "Navigation", get children() {
    return createComponent(AppWorkspace.SidebarSection, { title: "Tables", get children() {
      return ["Devices", "Loans", "Customers"].map((label) => createComponent(AppWorkspace.SidebarItem, { href: "#" + label, children: label }));
    } });
  } }),
  createComponent(AppWorkspace.Head, {
    views: createComponent(ViewTabs, { label: "Views", current: "all", fit: true, max: 8, items: [
      { id: "all", label: "All records", href: "?view=all" }, { id: "lent", label: "On loan", href: "?view=lent" },
      { id: "due", label: "Check due", href: "?view=due" },
    ] }),
    search: createComponent(TextInput, { type: "search", "aria-label": "Search records", placeholder: "Search devices …",
      icon: "ti ti-search", value: () => (filled ? "lamp" : ""), onValueChange: () => {} }),
    searchLabel: "Search records",
    actions: [
      createComponent(ButtonLink, { variant: "secondary", size: "sm", href: "?live", get children() { return [icon("ti ti-arrow-back"), "Back to live records"]; } }),
      createComponent(IconButton, { label: "Actions", size: "sm", variant: "ghost", get children() { return icon("ti ti-dots"); } }),
    ],
    primary: { label: "Add record", icon: "ti ti-plus", href: "?new=1" },
  }),
  createComponent(AppWorkspace.Content, { get children() {
    return createComponent(AppWorkspace.Main, { get children() { return Array.from({ length: 40 }, (_, index) => { const row = document.createElement("p"); row.textContent = "Record " + (index + 1); return row; }); } });
  } }),
]; } }), document.getElementById("app"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the head search fixture.");
const script = await build.outputs[0]!.text();
setDefaultTimeout(30_000);
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser({ ignoreDefaultArgs: ["--hide-scrollbars"] });
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (width: number, filled: boolean): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width, height: 844 }, reducedMotion: "reduce" });
  await page.setContent(
    `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body class="k2b-ui" data-filled="${filled}" style="margin:0"><div id="app" style="height:100dvh"></div></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await page.locator(".k2b-app-workspace__head").waitFor();
  await settled(page);
  return page;
};
const state = (page: Page) =>
  page.evaluate(() => {
    const head = document.querySelector<HTMLElement>(".k2b-app-workspace__head")!;
    const search = head.querySelector<HTMLElement>(".k2b-app-workspace__head-search")!;
    const toggle = head.querySelector<HTMLElement>("[data-app-workspace-head-search-toggle]")!;
    const top = (element: Element | null) => (element ? Math.round(element.getBoundingClientRect().top) : null);
    return {
      searchShown: search.checkVisibility(),
      toggleShown: toggle.checkVisibility(),
      expanded: toggle.getAttribute("aria-expanded"),
      focus: document.activeElement === toggle ? "toggle" : search.contains(document.activeElement) ? "search" : "other",
      // The head line: views, actions, and the primary keep their place when the search opens.
      line: [top(head.querySelector(".k2b-app-workspace__head-views")), top(head.querySelector("[data-workspace-primary]"))],
    };
  });
const problems = async (page: Page) =>
  (await page.evaluate(layoutProblems, { root: ".k2b-app-workspace__head", ignore: ".k2b-app-workspace__resize, .k2b-sr-only" })).problems;

test("1440 px: the search stands in the head line before the actions, without its icon", async () => {
  const page = await open(1440, false);
  try {
    expect(await state(page)).toMatchObject({ searchShown: true, toggleShown: false });
    expect(await problems(page)).toEqual([]);
  } finally {
    await page.close();
  }
});

for (const width of [390, 768, 1100])
  test(`${width} px: the search waits behind its icon, opens in its own row, and Escape returns focus to the icon`, async () => {
    const page = await open(width, false);
    try {
      const closed = await state(page);
      expect(closed).toMatchObject({ searchShown: false, toggleShown: true, expanded: "false" });
      expect(await problems(page)).toEqual([]);

      await page.locator("[data-app-workspace-head-search-toggle]").click();
      await settled(page);
      const opened = await state(page);
      expect(opened).toMatchObject({ searchShown: true, expanded: "true", focus: "search", line: closed.line });
      expect(await problems(page)).toEqual([]);

      await page.keyboard.press("Escape");
      await settled(page);
      expect(await state(page)).toMatchObject({ searchShown: false, expanded: "false", focus: "toggle", line: closed.line });
    } finally {
      await page.close();
    }
  });

for (const width of [390, 768])
  test(`${width} px: a search with a value stays in sight without a click`, async () => {
    const page = await open(width, true);
    try {
      expect(await state(page)).toMatchObject({ searchShown: true, toggleShown: true, expanded: "true" });
      expect(await problems(page)).toEqual([]);
    } finally {
      await page.close();
    }
  });
