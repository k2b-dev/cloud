import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { appHostCss } from "../../../ui/test/app-host-fixture";
import { launchBrowser } from "../../../ui/test/browser";

let browser: Browser;
let css: string;
beforeAll(async () => {
  css = await appHostCss(resolve(import.meta.dir, "app.css"));
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

// Pins app chrome to Cloud's host, including a narrow app inside a wide window.
// The 952/792px cases fail with viewport queries; wide cases guard the column form.
test("Notebooks chrome beside a panel matches a window as wide as its host", async () => {
  for (const [windowWidth, host] of [
    [1440, 952],
    [1440, 792],
    [1680, 1192],
    [1680, 1032],
  ] as const) {
    const page = await browser.newPage({ viewport: { width: windowWidth, height: 900 }, reducedMotion: "reduce" });
    try {
      const markup = `<div style="width:100%"><div class="notebook-document-surface" data-full-width><div class="notebook-note-preview__content">Reading column</div></div><div class="notebooks-navigation-toggle">Navigation</div><div class="notebooks-navigation-toggle" data-navigation-hidden>Hidden navigation</div></div>`;
      const content = (narrowed: boolean) =>
        `<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui" style="margin:0;display:flex">${narrowed ? `<div style="container:k2b-app-area / inline-size;width:${host}px;flex:none">${markup}</div><aside style="flex:1">Panel</aside>` : markup}</body></html>`;
      const measure = () =>
        page.evaluate(() => {
          const surface = document.querySelector(".notebook-document-surface")!;
          const column = document.querySelector(".notebook-note-preview__content")!;
          return {
            measure: getComputedStyle(surface).getPropertyValue("--notebook-measure").trim(),
            readingWidth: column.getBoundingClientRect().width,
            navigation: Array.from(document.querySelectorAll(".notebooks-navigation-toggle")).map(
              (element) => getComputedStyle(element).display,
            ),
          };
        });
      await page.setContent(content(true));
      const besidePanel = await measure();
      await page.setViewportSize({ width: host, height: 900 });
      await page.setContent(content(false));
      expect(besidePanel, `${windowWidth}px window / ${host}px host`).toEqual(await measure());
      expect(besidePanel.measure).toBe(host < 1024 ? "44rem" : "100%");
      expect(besidePanel.readingWidth).toBe(host < 1024 ? 704 : host);
      expect(besidePanel.navigation).toEqual(host < 1024 ? ["none", "flex"] : ["flex", "flex"]);
    } finally {
      await page.close();
    }
  }
});
