import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import type {} from "../../test/v2-bar-fold-still.client";
import { bundleV2Entry } from "../../test/v2-bundle";

// Guard: a bar's fold comes to rest. The way out of a selection stands at the bar's end with `margin-left: auto`,
// which reads back as the free room; a fold that counted it as used room folded, freed room and unfolded again, about
// 240 changes a second, and its "…" never stood still long enough to be pressed (#4537, found in #4223).

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0 auto 0 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-bar-fold-still.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

test("a selection bar with its way out at the end comes to rest at every width from 520 to 900 px", async () => {
  const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root" style="width: 900px"></div></body></html>`,
    );
    await page.addScriptTag({ content: client });
    await page.waitForFunction(() => window.__k2Mounted === true);
    await settled(page);
    const restless = await page.evaluate(async () => {
      const root = document.getElementById("root")!;
      const bar = document.querySelector<HTMLElement>(".k2-bar[data-selecting]")!;
      const frame = () => new Promise((done) => requestAnimationFrame(() => done(null)));
      const found: string[] = [];
      for (let width = 900; width >= 520; width -= 4) {
        root.style.width = `${width}px`;
        // a few frames to fold, then the bar must stand still
        for (let index = 0; index < 4; index++) await frame();
        let changes = 0;
        const observer = new MutationObserver((list) => {
          changes += list.length;
        });
        observer.observe(bar, { subtree: true, childList: true, attributes: true });
        for (let index = 0; index < 6; index++) await frame();
        observer.disconnect();
        if (changes > 0) found.push(`${width} px: ${changes} changes`);
      }
      return found;
    });
    expect(restless).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 60_000);
