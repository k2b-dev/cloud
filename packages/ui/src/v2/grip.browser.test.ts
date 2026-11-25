import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-grip.client";

// A grip stands in the vertical middle of the part of its line that is in sight (mockup resize.js, Valentin 22.11.:
// "Griff mittig auf der Höhe dieser Linie"): a line that runs below the window keeps its grip in the window, and the
// grip follows when the column scrolls.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-grip.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width: 1024, height: 600 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
    );
    await page.addScriptTag({ content: client });
    await page.waitForFunction(() => window.__k2Mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

/** Where the grip of the line between the columns stands, and the middle of the part of that line in sight. */
const measure = (page: Page) =>
  page.evaluate(() => {
    const grip = document.querySelector(".k2-split > .k2-seam > .k2-grip")!;
    const line = grip.parentElement!.getBoundingClientRect();
    const scroller = document.querySelector('.k2-pane[aria-label="Akte"] > .k2-scroll')!.getBoundingClientRect();
    const top = Math.max(line.top, scroller.top);
    const bottom = Math.min(line.bottom, scroller.bottom);
    const box = grip.getBoundingClientRect();
    return { grip: Math.round(box.top + box.height / 2), middle: Math.round((top + bottom) / 2), below: line.bottom > scroller.bottom };
  });

test("a grip stands in the middle of the part of its line in sight, and follows when the column scrolls", async () => {
  await withPage(async (page) => {
    const before = await measure(page);
    // the line runs below the window: the middle of the whole line would be out of the middle of what is seen
    expect(before.below).toBe(true);
    expect(Math.abs(before.grip - before.middle)).toBeLessThanOrEqual(1);
    await page.locator('.k2-pane[aria-label="Akte"] > .k2-scroll').evaluate((scroller) => scroller.scrollTo({ top: 200 }));
    await settled(page);
    const after = await measure(page);
    expect(after.middle).not.toBe(before.middle);
    expect(Math.abs(after.grip - after.middle)).toBeLessThanOrEqual(1);
  });
});
