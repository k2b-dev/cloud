import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { appAccentStyle } from "../../../cloud/src/ssr/app-appearance";
import { appColors } from "../../../cloud/src/ssr/app-color";
import { appHostCss } from "../../../ui/test/app-host-fixture";
import { launchBrowser, settled } from "../../../ui/test/browser";

let browser: Browser;
let css: string;
beforeAll(async () => {
  css = await appHostCss(resolve(import.meta.dir, "app.css"));
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});
const rgb = (hex: string) => `rgb(${[1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)).join(", ")})`;

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`filesv2 selection uses the app fill at ${viewport.width}px`, async () => {
    const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
    try {
      const page = await context.newPage();
      await page.setContent(`<!doctype html><html><head><style>${css}</style></head>
        <body class="k2b-ui"><main class="app-accent-scope" style="${appAccentStyle("#0f766e")}">
          <div class="filesv2-list" data-selecting="true"><div class="filesv2-list__row filesv2-list__row--active" aria-selected="true"><span class="filesv2-list__name">Project</span></div></div>
          <span id="platform" style="background:var(--k2b-selected);color:var(--k2b-action)"></span>
        </main></body></html>`);
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate((theme) => {
          document.documentElement.className = theme;
        }, theme);
        await settled(page);
        const colors = await page.evaluate(() => ({
          fill: getComputedStyle(document.querySelector(".filesv2-list__row")!).backgroundColor,
          platform: getComputedStyle(document.querySelector("#platform")!).backgroundColor,
          ink: getComputedStyle(document.querySelector(".filesv2-list__name")!).color,
          action: getComputedStyle(document.querySelector("#platform")!).color,
        }));
        expect(colors.fill, theme).toBe(rgb(appColors("#0f766e")[theme].selected));
        expect(colors.fill, theme).not.toBe(colors.platform);
        expect(colors.ink, theme).toBe(rgb(appColors("#0f766e")[theme].ink));
        expect(colors.ink, theme).not.toBe(colors.action);
      }
    } finally {
      await context.close();
    }
  }, 30_000);
}
