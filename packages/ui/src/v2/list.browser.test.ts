import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-list.client";

// A list keeps the place someone works on when new entries arrive on top, also in Safari, which ships no CSS scroll
// anchoring; its pane carries the key under which the page keeps its scroll position for back and forward. The page
// switches scroll anchoring off (`overflow-anchor: none`): Chromium and the WebKit build of Playwright have it, and
// would hold the place without the list.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; padding: 8px; } .ti { display: inline-block; width: 1em; height: 1em; } .k2-scroll { overflow-anchor: none; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-list.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (run: (page: Page) => Promise<void>, width = 1440) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
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

const scroller = (page: Page) => page.locator('.k2-pane[aria-label="Liste"] > .k2-scroll');
const topOf = (page: Page, name: string) =>
  page.evaluate((text) => {
    const view = document.querySelector('.k2-pane[aria-label="Liste"] > .k2-scroll')!.getBoundingClientRect();
    const row = [...document.querySelectorAll(".k2-row")].find((each) => each.textContent?.includes(text))!;
    return row.getBoundingClientRect().top - view.top;
  }, name);

test("the pane keeps its scroll position under its key", async () => {
  await withPage(async (page) => {
    expect(await scroller(page).getAttribute("data-scroll-preserve")).toBe("liste");
  });
});

test("new entries on top leave the focused entry where it was", async () => {
  await withPage(async (page) => {
    await scroller(page).evaluate((element) => element.scrollTo({ top: 600 }));
    await page.getByRole("button", { name: "Eintrag 20", exact: true }).focus();
    await settled(page);
    const before = await topOf(page, "Eintrag 20");
    await page.evaluate(() => window.__k2Prepend?.(3));
    await page.locator(".k2-row", { hasText: "Neu 3" }).waitFor({ state: "attached" });
    await settled(page);
    expect(await topOf(page, "Eintrag 20")).toBe(before);
  });
});

test("entries taken away above leave the focused entry where it was", async () => {
  await withPage(async (page) => {
    await scroller(page).evaluate((element) => element.scrollTo({ top: 600 }));
    await page.getByRole("button", { name: "Eintrag 20", exact: true }).focus();
    await settled(page);
    const before = await topOf(page, "Eintrag 20");
    await page.evaluate(() => window.__k2Remove?.(["Eintrag 1", "Eintrag 2", "Eintrag 3"]));
    await page.waitForFunction(() => document.querySelectorAll(".k2-row").length === 37);
    await settled(page);
    expect(await topOf(page, "Eintrag 20")).toBe(before);
  });
});

test("without a focused entry the first visible entry holds its place", async () => {
  await withPage(async (page) => {
    await scroller(page).evaluate((element) => element.scrollTo({ top: 600 }));
    await settled(page);
    const first = await page.evaluate(() => {
      const view = document.querySelector('.k2-pane[aria-label="Liste"] > .k2-scroll')!.getBoundingClientRect();
      const row = [...document.querySelectorAll(".k2-row")].find((each) => each.getBoundingClientRect().top >= view.top)!;
      return row.querySelector(".k2-row-title")!.textContent!;
    });
    const before = await topOf(page, first);
    await page.evaluate(() => window.__k2Prepend?.(3));
    await page.locator(".k2-row", { hasText: "Neu 3" }).waitFor({ state: "attached" });
    await settled(page);
    expect(await topOf(page, first)).toBe(before);
  });
});

test("when the focused entry goes itself, the entry after it takes its place", async () => {
  await withPage(async (page) => {
    await scroller(page).evaluate((element) => element.scrollTo({ top: 600 }));
    await page.getByRole("button", { name: "Eintrag 20", exact: true }).focus();
    await settled(page);
    const before = await topOf(page, "Eintrag 20");
    // one entry above goes too, so without a place to hold everything would move up by a row
    await page.evaluate(() => window.__k2Remove?.(["Eintrag 2", "Eintrag 20"]));
    await page.locator(".k2-row", { hasText: "Eintrag 20" }).waitFor({ state: "detached" });
    await settled(page);
    expect(await topOf(page, "Eintrag 21")).toBe(before);
  });
});

test("where the browser anchors scrolling itself, the place moves no second time", async () => {
  await withPage(async (page) => {
    await page.addStyleTag({ content: ".k2-ui .k2-scroll { overflow-anchor: auto; }" });
    await scroller(page).evaluate((element) => element.scrollTo({ top: 600 }));
    await page.getByRole("button", { name: "Eintrag 20", exact: true }).focus();
    await settled(page);
    const before = await topOf(page, "Eintrag 20");
    await page.evaluate(() => window.__k2Prepend?.(3));
    await page.locator(".k2-row", { hasText: "Neu 3" }).waitFor({ state: "attached" });
    await settled(page);
    expect(await topOf(page, "Eintrag 20")).toBe(before);
  });
});

test("a detail closed in place gives the focus back to the row that opened it", async () => {
  await withPage(async (page) => {
    const row = page.getByRole("button", { name: "Eintrag 3", exact: true });
    await row.focus();
    await page.keyboard.press("Enter");
    // on the phone the detail is the page, with its way back
    const back = page.getByRole("button", { name: "Liste", exact: true });
    await back.waitFor();
    await back.focus();
    await page.keyboard.press("Enter");
    await page.locator(".k2-pane[data-detail]").waitFor({ state: "detached" });
    await settled(page);
    expect(await page.evaluate(() => document.activeElement?.closest(".k2-row")?.querySelector(".k2-row-title")?.textContent)).toBe(
      "Eintrag 3",
    );
  }, 390);
});

test("at the very top new entries show up", async () => {
  await withPage(async (page) => {
    await page.evaluate(() => window.__k2Prepend?.(2));
    await page.locator(".k2-row", { hasText: "Neu 2" }).waitFor();
    await settled(page);
    expect(await scroller(page).evaluate((element) => element.scrollTop)).toBe(0);
    // the first of the new entries stands at the top of the column
    expect(await topOf(page, "Neu 1")).toBe(0);
  });
});
