import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-fab-room.client";

// The floating main action on the phone (test/v2-fab-room.client.tsx): scrolled to the end, the last row of the page
// stands above the button, not under it (Weather v4 on the phone: "Ort hinzufügen" covered the last day's rain). One
// pane alone and a split whose panes stand one under the other; the wide screen has no floating action and no room.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-fab-room.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (options: { width: number; split?: boolean }, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width: options.width, height: options.width < 768 ? 844 : 900 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
    );
    if (options.split) await page.evaluate(() => Object.assign(window, { __k2Split: true }));
    await page.addScriptTag({ content: client });
    await page.waitForFunction(() => window.__k2Mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

/**
 * Scrolls to the end as a person does, with the wheel over the page, then reads the last row's bottom and the floating
 * action's top. A script could also scroll a box that clips (`overflow: hidden`) and that no finger moves; the wheel
 * reaches only what really scrolls. It turns the wheel until the last row stops moving: WebKit spreads a turn over
 * several frames.
 */
const atEnd = async (page: Page) => {
  await page.mouse.move(195, 400);
  await settled(page);
  const lastRow = () =>
    page
      .locator('[data-k2-part="Row"]')
      .last()
      .evaluate((row) => row.getBoundingClientRect().bottom);
  let before = Number.NaN;
  for (let now = await lastRow(); now !== before; now = await lastRow()) {
    before = now;
    await page.mouse.wheel(0, 2000);
    await settled(page);
  }
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll<HTMLElement>('[data-k2-part="Row"]')];
    const fab = document.querySelector<HTMLElement>(".k2-fab")!;
    return {
      lastRowBottom: rows.at(-1)!.getBoundingClientRect().bottom,
      fabTop: fab.getBoundingClientRect().top,
      fabShown: getComputedStyle(fab).display !== "none",
    };
  });
};

for (const split of [false, true])
  test(`on the phone the last row of ${split ? "a split" : "a pane"} stands above the floating main action`, async () => {
    await withPage({ width: 390, split }, async (page) => {
      const end = await atEnd(page);
      expect(end.fabShown).toBe(true);
      // 8 px of air between the last row and the button
      expect(end.lastRowBottom).toBeLessThanOrEqual(end.fabTop - 8);
    });
  }, 30_000);

test("the wide screen has no floating action and keeps no room for one", async () => {
  await withPage({ width: 1440 }, async (page) => {
    const room = await page.evaluate(() => {
      const scroll = document.querySelector<HTMLElement>(".k2-ws-main > .k2-pane > .k2-scroll")!;
      return getComputedStyle(scroll, "::after").height;
    });
    expect(["auto", "0px"]).toContain(room);
  });
}, 30_000);
