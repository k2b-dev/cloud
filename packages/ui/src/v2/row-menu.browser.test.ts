import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-row-menu.client";

// A row that opens its entry and holds a menu (test/v2-row-menu.client.tsx): the menu lies inside the row in the page,
// so a choice in it must not reach the row's own click and open the row too.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-row-menu.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

test("a choice in a row's menu is the menu's alone: the row does not open, and a click on the row still does", async () => {
  const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
    );
    await page.addScriptTag({ content: client });
    await page.waitForFunction(() => window.__k2Mounted === true);
    await settled(page);
    await page.getByRole("button", { name: "Aktionen für Unterlagen Lindqvist" }).click();
    await page.getByRole("menuitem", { name: "Link widerrufen" }).click();
    await settled(page);
    expect(await page.evaluate(() => ({ opened: window.__k2Opened, chosen: window.__k2Chosen }))).toEqual({ opened: [], chosen: ["a"] });
    // the row itself still opens on a click outside its controls
    await page.getByRole("cell", { name: "Fotos Baustelle" }).first().click();
    expect(await page.evaluate(() => window.__k2Opened)).toEqual(["b"]);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});
