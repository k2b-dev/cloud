import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-table-row-menu-repro.client";

// Mail's repro (#4324): a `Menu` in a cell of a `Table` whose rows `open` a page. Picking a menu item must run the
// item (it opens a dialog here) and must not open the row. The same table without `open` is the control.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-table-row-menu-repro.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withTable = async (linked: boolean, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
  page.setDefaultTimeout(3000);
  const errors = pageErrors(page);
  try {
    await page.route("**/table*", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>html,body{margin:0}#root{padding:8px}.ti{display:inline-block;width:1em;height:1em}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
      }),
    );
    await page.goto(`http://k2.test/table${linked ? "?open=1" : ""}`);
    await page.addScriptTag({ content: client });
    await page.waitForFunction(() => window.__k2Mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

const pickDelete = async (page: Page) => {
  await page.getByRole("button", { name: "Aktionen für phish.example.org" }).click();
  await page.getByRole("menuitem", { name: "Löschen" }).click();
};

test("control: in a table without row links, picking a menu item opens its dialog", async () => {
  await withTable(false, async (page) => {
    await pickDelete(page);
    await page.getByRole("dialog", { name: "Regel löschen?" }).waitFor();
    expect(await page.evaluate(() => window.__k2Picked)).toEqual(["r1"]);
  });
}, 30_000);

test("repro: in a table whose rows open a page, picking a menu item opens its dialog and leaves the row closed", async () => {
  await withTable(true, async (page) => {
    await pickDelete(page);
    // expected: the item ran, its dialog is open, and the address still names no row
    expect(await page.evaluate(() => window.__k2Picked)).toEqual(["r1"]);
    await page.getByRole("dialog", { name: "Regel löschen?" }).waitFor();
    expect(new URL(page.url()).hash).toBe("");
  });
}, 30_000);
