import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-table-row-menu.client";

// A table whose rows open their detail, with a "…" menu in each row (test/v2-table-row-menu.client.tsx): choosing an
// item runs the item and its dialog, never the row's own link, by pointer and by key, and the focus comes back to the
// menu's button when the dialog closes (Mail's admin #4324: the row opened instead).

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-table-row-menu.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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

const deeds = (page: Page) => page.evaluate(() => window.__deeds ?? []);
const focused = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent?.trim() ?? "");
const trigger = (page: Page) => page.getByRole("button", { name: "Aktionen für info@werkstatt.example" });
const dialog = (page: Page) => page.getByRole("dialog", { name: "Postfach umbenennen" });

test("a pointer on an item of a row's menu runs the item and its dialog, not the row's link", async () => {
  await withPage(async (page) => {
    await trigger(page).click();
    await page.getByRole("menuitem", { name: "Umbenennen" }).click();
    await dialog(page).waitFor();
    await settled(page);
    expect([await deeds(page), await page.evaluate(() => location.hash)]).toEqual([["rename:info"], ""]);
    await page.keyboard.press("Escape");
    await dialog(page).waitFor({ state: "hidden" });
    await settled(page);
    expect(await focused(page)).toBe("Aktionen für info@werkstatt.example");
    expect([await deeds(page), await page.evaluate(() => location.hash)]).toEqual([["rename:info"], ""]);
    // the row itself still opens, by a click on its empty end (the row hands it to its link)
    const end = await page.getByRole("button", { name: "Aktionen für buero@werkstatt.example" }).boundingBox();
    if (!end) throw new Error("no menu button in the second row");
    await page.mouse.click(end.x - 24, end.y + end.height / 2);
    await page.waitForFunction(() => location.hash === "#open=buero");
  });
});

test("the keyboard on an item of a row's menu runs the item and its dialog, not the row's link", async () => {
  await withPage(async (page) => {
    await trigger(page).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menuitem", { name: "Umbenennen" }).waitFor();
    await page.keyboard.press("Enter");
    await dialog(page).waitFor();
    await settled(page);
    expect([await deeds(page), await page.evaluate(() => location.hash)]).toEqual([["rename:info"], ""]);
    await page.getByRole("button", { name: "Fertig" }).click();
    await dialog(page).waitFor({ state: "hidden" });
    await settled(page);
    expect(await focused(page)).toBe("Aktionen für info@werkstatt.example");
    expect([await deeds(page), await page.evaluate(() => location.hash)]).toEqual([["rename:info"], ""]);
  });
});

// A table inside a dialog: the dialog stands around the whole table, not in a row, so a click on a row still opens it.
test("a table inside a dialog opens its rows by a click on them", async () => {
  await withPage(async (page) => {
    await page.getByRole("button", { name: "Verwalten" }).click();
    const table = page.getByRole("table", { name: "Postfächer im Dialog" });
    await table.waitFor();
    await settled(page);
    // the empty end of the second row, beside its link
    const cell = await table.getByRole("cell", { name: "buero@werkstatt.example" }).boundingBox();
    if (!cell) throw new Error("no second row in the dialog");
    await page.mouse.click(cell.x + cell.width - 12, cell.y + cell.height / 2);
    await page.waitForFunction(() => location.hash === "#manage=buero");
  });
});
