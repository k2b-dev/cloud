import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { launchWithScrollbars, settled } from "../../test/browser";
import { layoutProblems, scrollbarWidth } from "../layout-check";

// Error class (flat QA for 0.84, B6 class): on a tablet a list and its detail stood side by side, the list squeezed
// ("Proble…") and Main scrolled sideways, as on the admin app list at 768 px. K12: a tablet (an app area of 48 to
// 64 rem) shows one level at a time with its back step and a Detail as a drawer; from 64 rem two levels stand side by
// side. Main never scrolls sideways. With classic visible scrollbars.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "workspace-tablet.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { AppWorkspace } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const kind = document.body.dataset.kind;
const rows = (prefix, count) => Array.from({ length: count }, (_, index) => {
  const row = document.createElement("p");
  row.textContent = prefix + " " + (index + 1) + ": Problems with the delivery of scheduled events";
  return row;
});
const main = () => kind === "levels"
  // Shaped like the admin app list: a wide list level beside the open app's level.
  ? createComponent(AppWorkspace.Main, { level: "app", get children() { return [
      createComponent(AppWorkspace.MainPane, { id: "apps", label: "Apps", heading: "page", href: "#apps", defaultSize: 560, minSize: 360, get children() { return rows("App", 20); } }),
      createComponent(AppWorkspace.MainPane, { id: "app", label: "Grids · Events", href: "#app", get children() { return rows("Event", 20); } }),
    ]; } })
  : createComponent(AppWorkspace.Main, { get children() { return rows("Row", 30); } });
render(() => createComponent(AppWorkspace, { get children() { return [
  createComponent(AppWorkspace.Sidebar, { id: "navigation", label: "Navigation", get children() {
    return createComponent(AppWorkspace.SidebarSection, { title: "Admin", get children() {
      return ["Apps", "People", "Settings"].map((label) => createComponent(AppWorkspace.SidebarItem, { href: "#" + label, children: label }));
    } });
  } }),
  createComponent(AppWorkspace.Content, { get children() { return [
    main(),
    kind === "detail" ? createComponent(AppWorkspace.Detail, { id: "record", open: true, get children() { return rows("Fact", 6); } }) : null,
  ]; } }),
]; } }), document.getElementById("app"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the tablet workspace fixture.");
const script = await build.outputs[0]!.text();
setDefaultTimeout(30_000);
let browser: Browser;
beforeAll(async () => {
  browser = await launchWithScrollbars();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

for (const kind of ["levels", "detail"] as const)
  for (const width of [768, 1100])
    test(`${kind} at ${width} px: ${width < 1024 ? "one column at a time" : "side by side"}, and Main never scrolls sideways`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      try {
        await page.setContent(
          `<!doctype html><html lang="en"><head><style>${css}</style></head><body class="k2b-ui" data-kind="${kind}" style="margin:0"><div id="app" style="height:100vh"></div></body></html>`,
        );
        await page.addScriptTag({ content: script });
        await page.locator(".k2b-app-workspace__main").waitFor();
        await settled(page);
        const shape = await page.evaluate(() => {
          const main = document.querySelector<HTMLElement>(".k2b-app-workspace__main")!;
          const shown = (selector: string) =>
            [...document.querySelectorAll<HTMLElement>(selector)].filter((node) => node.getClientRects().length > 0);
          return {
            mainSideways: main.scrollWidth - main.clientWidth,
            levels: shown("[data-workspace-level]").length,
            back: shown(".k2b-app-workspace__level-back").length > 0,
            detailColumn: shown(".k2b-app-workspace__detail").length,
            detailToggle: shown("[data-app-workspace-detail-toggle]").length,
          };
        });
        expect(await page.evaluate(scrollbarWidth)).toBeGreaterThan(0);
        const tablet = width < 1024;
        expect(shape.mainSideways).toBeLessThanOrEqual(0);
        if (kind === "levels") expect({ levels: shape.levels, back: shape.back }).toEqual({ levels: tablet ? 1 : 2, back: tablet });
        else expect({ column: shape.detailColumn, toggle: shape.detailToggle }).toEqual({ column: tablet ? 0 : 1, toggle: tablet ? 1 : 0 });
        const found = await page.evaluate(layoutProblems, { root: ".k2b-app-workspace", ignore: ".k2b-app-workspace__resize" });
        expect(found.problems).toEqual([]);
      } finally {
        await page.close();
      }
    });
