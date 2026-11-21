import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser, settled } from "../../test/browser";
import { layoutProblems } from "../layout-check";

// Error class (flat QA for 0.84, B3, B6, B7, B8, B9): a head that wraps into two or three rows, a path that scrolls or
// runs under the actions, or a view strip that scrolls sideways, each at one width only. K1, K15: the head is one row
// at every width (56 px, 44 px on a phone, where only the filters may follow in their own row); when room runs short
// the actions give way first, then the views move into "More +n" and the path's front levels wait behind "…". No
// strip scrolls sideways except the filters, which fade. Heads shaped like Mail (many views, search, primary), Files
// (a path, a segment, and an action), and Spaces (views and filters), with classic visible scrollbars.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "head-one-row.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { AppWorkspace, Breadcrumbs, Button, FilterChip, IconButton, SegmentedControl, ViewTabs } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const kind = document.body.dataset.kind;
const icon = (name) => { const node = document.createElement("i"); node.className = name; node.setAttribute("aria-hidden", "true"); return node; };
const views = (labels) => createComponent(ViewTabs, { label: "Views", current: "0", max: labels.length,
  items: labels.map((label, index) => ({ id: String(index), label, href: "?view=" + index, count: index === 0 ? 12 : undefined })) });
const head = {
  mail: () => createComponent(AppWorkspace.Head, {
    views: views(["Inbox", "Assigned to me", "Waiting", "Done", "Sent", "Drafts"]),
    actions: createComponent(IconButton, { label: "Search", size: "sm", variant: "ghost", get children() { return icon("ti ti-search"); } }),
    primary: { label: "New message", icon: "ti ti-pencil", href: "?compose" },
  }),
  files: () => createComponent(AppWorkspace.Head, {
    views: createComponent(Breadcrumbs, { label: "Path", items: [
      { label: "Files", href: "#files" }, { label: "Projects", href: "#projects" }, { label: "Customer workshops 2026", href: "#workshops" },
      { label: "North warehouse", href: "#north" }, { label: "Projektunterlagen und Protokolle" },
    ] }),
    actions: createComponent(SegmentedControl, { label: "Layout", value: "list", onValueChange: () => {}, options: [
      { value: "list", label: "List", icon: "ti ti-list" }, { value: "grid", label: "Grid", icon: "ti ti-layout-grid" },
    ] }),
    primary: { label: "Upload", icon: "ti ti-upload", href: "?upload" },
  }),
  spaces: () => createComponent(AppWorkspace.Head, {
    views: views(["Board", "List", "Calendar", "Timeline", "Files", "Activity"]),
    filters: [
      createComponent(FilterChip, { label: "Tags", icon: "ti ti-tag", value: [], onValueChange: () => {}, options: [{ options: [{ value: "a", label: "Customer" }] }] }),
      createComponent(FilterChip, { label: "Assigned", icon: "ti ti-user", value: [], onValueChange: () => {}, options: [{ options: [{ value: "me", label: "Me" }] }] }),
    ],
    primary: { label: "New task", icon: "ti ti-plus", href: "?new" },
  }),
}[kind];
render(() => createComponent(AppWorkspace, { get children() { return [
  createComponent(AppWorkspace.Sidebar, { id: "navigation", label: "Navigation", get children() {
    return createComponent(AppWorkspace.SidebarSection, { title: "Places", get children() {
      return ["One", "Two", "Three"].map((label) => createComponent(AppWorkspace.SidebarItem, { href: "#" + label, children: label }));
    } });
  } }),
  head(),
  createComponent(AppWorkspace.Content, { get children() {
    return createComponent(AppWorkspace.Main, { get children() { return Array.from({ length: 30 }, (_, index) => { const row = document.createElement("p"); row.textContent = "Row " + (index + 1); return row; }); } });
  } }),
]; } }), document.getElementById("app"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the one-row head fixture.");
const script = await build.outputs[0]!.text();
setDefaultTimeout(30_000);
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser({ ignoreDefaultArgs: ["--hide-scrollbars"] });
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

for (const kind of ["mail", "files", "spaces"] as const)
  for (const width of [390, 768, 1100, 1440])
    test(`${kind}-like head at ${width} px: one row, no strip scrolls sideways, the view mark lies on the head line`, async () => {
      const phone = width < 768;
      const page = await browser.newPage({ viewport: { width, height: 844 }, reducedMotion: "reduce", isMobile: phone, hasTouch: phone });
      try {
        await page.setContent(
          `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body class="k2b-ui" data-kind="${kind}" style="margin:0"><div id="app" style="height:100dvh"></div></body></html>`,
        );
        await page.addScriptTag({ content: script });
        await page.locator(".k2b-app-workspace__head").waitFor();
        await settled(page);
        const head = await page.evaluate(() => {
          const element = document.querySelector<HTMLElement>(".k2b-app-workspace__head")!;
          const box = element.getBoundingClientRect();
          const line = parseFloat(getComputedStyle(element).getPropertyValue("--k2b-workspace-head-line")) || 0;
          const shown = (selector: string) =>
            [...element.querySelectorAll<HTMLElement>(selector)].filter((node) => node.getClientRects().length > 0);
          // The first row's parts: views or the path, and the actions with the primary. Filters may follow on a phone.
          const parts = shown(".k2b-app-workspace__head-views, .k2b-app-workspace__head-actions, [data-workspace-primary]").map((node) => {
            const rect = node.getBoundingClientRect();
            return Math.round(rect.top + rect.height / 2 - box.top);
          });
          const filters = shown(".k2b-app-workspace__head-filters")[0]?.getBoundingClientRect();
          const current = element.querySelector('.k2b-view-tabs__tab[aria-current="page"]');
          return {
            line,
            // Without a filter row the head is exactly one line tall.
            height: Math.round((filters && filters.top >= box.top + line - 1 ? filters.top : box.bottom) - box.top),
            centres: [...new Set(parts)].length,
            centre: parts[0] ?? null,
            mark: current ? Math.round(current.getBoundingClientRect().bottom - box.top) : null,
            sideways: [...element.querySelectorAll<HTMLElement>("*")]
              .filter((node) => !node.closest(".k2b-app-workspace__head-filters"))
              .filter(
                (node) => getComputedStyle(node).overflowX !== "visible" && node.clientWidth > 1 && node.scrollWidth > node.clientWidth + 1,
              )
              .map((node) => `${node.tagName.toLowerCase()}.${node.className.split(" ")[0]} ${node.scrollWidth}/${node.clientWidth}`),
          };
        });
        expect(head.line).toBe(phone ? 44 : 56);
        expect({ height: head.height, centres: head.centres, sideways: head.sideways }).toEqual({
          height: head.line,
          centres: 1,
          sideways: [],
        });
        // Every first-row part is centred in the head line; the open view's mark lies on it.
        expect(Math.abs(head.centre! - head.line / 2)).toBeLessThanOrEqual(1);
        if (kind !== "files") expect(head.mark).toBe(head.line);
        const found = await page.evaluate(layoutProblems, { root: ".k2b-app-workspace__head", ignore: ".k2b-app-workspace__resize" });
        expect(found.problems).toEqual([]);
      } finally {
        await page.close();
      }
    });
