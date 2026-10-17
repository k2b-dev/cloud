import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser } from "../../test/browser";

const ui = resolve(import.meta.dir, "../..");
let browser: Browser;
let script: string;
let css: string;
beforeAll(async () => {
  css = await Bun.file(resolve(ui, "dist/styles.css")).text();
  const entry = resolve(import.meta.dir, "workspace-print.fixture.ts");
  const build = await Bun.build({
    entrypoints: [entry],
    files: {
      [entry]: `
import { createComponent, render } from "solid-js/web";
import { AppWorkspace } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const article = document.createElement("article");
article.id = "rows";
article.innerHTML = Array.from({ length: 120 }, (_, i) => '<p>Row ' + (i + 1) + '. Field observations recorded by an invented team.</p>').join('');
const detail = document.createElement("article");
detail.textContent = "Printable detail";
if (location.hash === '#detail') detail.setAttribute("data-print-region", "");
render(() => createComponent(AppWorkspace, {
  get children() { return [
    createComponent(AppWorkspace.Sidebar, { label: "Navigation", get children() { return createComponent(AppWorkspace.SidebarDesktop, { children: "Sidebar" }); } }),
    createComponent(AppWorkspace.Content, { get children() { return [
      createComponent(AppWorkspace.Main, { children: article }),
      createComponent(AppWorkspace.Detail, { id: "detail", open: true, children: detail }),
    ]; } }),
    createComponent(AppWorkspace.BottomDrawer, { id: "drawer", open: true, children: "Drawer" }),
  ]; }
}), document.getElementById("app"));`,
    },
    target: "browser",
    // Solid's browser build: an SSR plugin that another test file registers must not change it.
    conditions: ["browser"],
    format: "iife",
  });
  if (!build.success) throw new AggregateError(build.logs, "Workspace print fixture");
  script = await build.outputs[0]!.text();
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});
for (const region of [false, true])
  test(
    region ? "a region in Detail survives generic detail hiding" : "without a target, Main flows and workspace controls disappear",
    async () => {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      try {
        await page.setContent(
          `<html><head><style>${css}</style></head><body class="k2b-ui"><div id="app" style="height:900px"></div></body></html>`,
        );
        if (region)
          await page.evaluate(() => {
            location.hash = "detail";
          });
        await page.addScriptTag({ content: script });
        expect(await page.locator(".k2b-app-workspace__sidebar").boundingBox()).not.toBeNull();
        expect(await page.locator(".k2b-app-workspace__detail").boundingBox()).not.toBeNull();
        expect(await page.locator(".k2b-app-workspace__drawer").boundingBox()).not.toBeNull();
        expect(await page.locator(".k2b-app-workspace__resize").count()).toBeGreaterThan(0);
        await page.emulateMedia({ media: "print" });
        for (const selector of [
          ".k2b-app-workspace__sidebar",
          ".k2b-app-workspace__drawer",
          ".k2b-app-workspace__resize",
          ...(region ? [".k2b-app-workspace__main"] : [".k2b-app-workspace__detail"]),
        ]) {
          for (const el of await page.locator(selector).all())
            expect({ selector, box: await el.boundingBox() }).toEqual({ selector, box: null });
        }
        if (region) {
          expect(await page.locator("[data-print-region]").boundingBox()).not.toBeNull();
          expect(await page.locator("[data-print-region]").textContent()).toBe("Printable detail");
        } else {
          const boxes = await page.locator("#rows p").evaluateAll((els) =>
            els.map((el) => {
              const r = el.getBoundingClientRect();
              return { top: r.top, height: r.height };
            }),
          );
          expect(boxes).toHaveLength(120);
          expect(boxes.every((box) => box.height > 0)).toBe(true);
          expect(boxes.at(-1)!.top).toBeGreaterThan(900);
          const layout = await page
            .locator(".k2b-app-workspace__main")
            .evaluate((el) => ({ overflow: getComputedStyle(el).overflowY, height: el.clientHeight, scrollHeight: el.scrollHeight }));
          expect(layout.overflow).toBe("visible");
          expect(layout.height).toBeGreaterThanOrEqual(layout.scrollHeight - 1);
        }
      } finally {
        await page.close();
      }
    },
  );
