import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-grips.client";

// On a touch screen a column grip stays visible (#4291); after a touch on the head it takes a target of 44 x 44 px
// until a touch lands elsewhere, and before that a tap beside a title stays the title's. A focus in the head shows the
// grips as a pointer on it does. Fixture: test/v2-grips.client.tsx (a table with two column grips) in a 1400 px window,
// a tablet held across: below 768 px the column grips leave (the table's columns follow their pane). Chromium and
// WebKit.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss = "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-grips.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (run: (page: Page) => Promise<void>, touch: boolean) => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 }, hasTouch: touch });
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

/** Whether each column grip shows (its opacity). */
const shown = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".k2-table thead .k2-cgrip")].map((grip) => getComputedStyle(grip).opacity === "1"),
  );

test("touch: the grips stay visible; a touch on the head gives each a 44 px target, a touch elsewhere takes it back", async () => {
  await withPage(async (page) => {
    expect((await shown(page)).every(Boolean)).toBe(true);
    const box = (await page.locator('.k2-cgrip[aria-label="Betreff"]').boundingBox())!;
    const head = (await page.locator(".k2-table thead th").first().boundingBox())!;
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2, top: head.y };
    // 20 px to either side of its line, and from the top of the head 44 px down (the scroller ends at the head's top)
    const hits = () =>
      page.evaluate(
        ({ x, y, top }) =>
          [
            [x - 20, y],
            [x + 20, y],
            [x, top + 2],
            [x, top + 42],
          ].map(([px, py]) => document.elementFromPoint(px!, py!)?.matches(".k2-cgrip") ?? false),
        centre,
      );
    expect(await hits()).toEqual([false, false, false, false]);
    await page.touchscreen.tap(box.x - 60, centre.y);
    await settled(page);
    expect(await hits()).toEqual([true, true, true, true]);
    await page.touchscreen.tap(700, 600);
    await settled(page);
    expect(await hits()).toEqual([false, false, false, false]);
  }, true);
});

test("a focus in the head shows every grip of it, as a pointer on the head does", async () => {
  await withPage(async (page) => {
    expect(await shown(page)).toEqual([false, false]);
    await page.locator('.k2-cgrip[aria-label="Betreff"]').focus();
    await settled(page);
    expect(await shown(page)).toEqual([true, true]);
  }, false);
});
