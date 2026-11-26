import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle, serverMarkup } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-row-focus.demo";
import { measureV2Layout } from "./testing";

// A row's status and its focus when its own action leaves, and keycaps, in a real engine with v2.css. Runs in Chromium
// and in WebKit (TEST_BROWSER=webkit).

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let bundle: string;
let markup: string;
beforeAll(async () => {
  [bundle, markup, browser] = await Promise.all([demoBundle("../v2-row-focus"), serverMarkup("../v2-row-focus"), launchBrowser()]);
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
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root">${markup}</div></body></html>`,
    );
    await page.addScriptTag({ content: bundle });
    await page.waitForFunction(() => window.__mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};
const row = (page: Page, title: string) => page.locator(".k2-row", { hasText: title });
const focusedIn = (page: Page) =>
  page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return "body";
    return element.getAttribute("aria-label") ?? element.className;
  });

test("server markup: an empty status is already a status, so later words are heard; keycaps carry the keys' names", () => {
  expect(markup.match(/class="k2-row-status" role="status"/g)?.length).toBe(3);
  expect(markup).toContain("Befehlstaste K");
  expect(markup).toContain(">⌘<");
  expect(markup).toContain(">Strg<");
});

test("a row's action that leaves with the focus hands it to the row's next button, to what opens it, or to the row", async () => {
  await withPage(async (page) => {
    // a second button in the row takes it
    await row(page, "lea.brandt").getByRole("button", { name: "Zurückziehen" }).focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll(".k2-row-status:not(:empty)").length === 1);
    expect(await focusedIn(page)).toBe("Link kopieren");
    expect(await row(page, "lea.brandt").getByRole("status").textContent()).toBe("Zurückgezogen");
    // a row that opens a page: its link takes it
    await row(page, "einkauf@").getByRole("button", { name: "Zurückziehen" }).focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll(".k2-row-status:not(:empty)").length === 2);
    expect(await page.evaluate(() => document.activeElement?.classList.contains("k2-row-open"))).toBe(true);
    // nothing else to focus: the row itself, never the page
    await row(page, "tobias.kern").getByRole("button", { name: "Zurückziehen" }).focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll(".k2-row-status:not(:empty)").length === 3);
    expect(await page.evaluate(() => document.activeElement?.classList.contains("k2-row"))).toBe(true);
    expect(await focusedIn(page)).not.toBe("body");
  });
});

test("keycaps: one round cap per key in the meta type; the keys are heard by name", async () => {
  await withPage(async (page) => {
    const caps = await row(page, "Suchen").locator(".k2-kbd-key").allTextContents();
    expect(caps).toEqual(["⌘", "K"]);
    expect(await row(page, "Senden").locator(".k2-kbd-key").allTextContents()).toEqual(["Strg", "↵"]);
    const cap = await row(page, "Suchen").locator(".k2-kbd-key").first().boundingBox();
    expect(cap?.height).toBe(18);
  });
});

for (const width of [1440, 390])
  test(`layout at ${width} px with statuses shown: edges, lines, type roles and grips hold`, async () => {
    await withPage(async (page) => {
      for (const title of ["lea.brandt", "tobias.kern"]) await row(page, title).getByRole("button", { name: "Zurückziehen" }).click();
      await page.waitForFunction(() => document.querySelectorAll(".k2-row-status:not(:empty)").length === 2);
      expect((await measureV2Layout(page, { root: "[data-k2-workspace]" })).problems).toEqual([]);
    }, width);
  });
