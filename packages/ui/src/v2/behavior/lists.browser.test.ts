// Contract test for the v2 listbox (`List`, `Lookup`, the filter bar) on @ui-sdk/core through our Solid 1 adapter.
// Runs in Chromium and in WebKit (TEST_BROWSER=webkit).
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors } from "../../../test/browser";
import { contractCss, demoBundle, openDemo, pattern, serverMarkup } from "../../../test/v2-behavior/harness";

let browser: Browser;
let bundle: string;
let css: string;
let markup: string;
beforeAll(async () => {
  [bundle, css, markup] = await Promise.all([demoBundle("lists"), contractCss(), serverMarkup("lists")]);
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (run: (page: Page) => Promise<void>) => {
  const page = await openDemo(browser, bundle, css, { markup });
  const errors = pageErrors(page);
  try {
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};
/** The text of the focused option. */
const focused = (page: Page) => page.evaluate(() => document.activeElement?.textContent?.replace("✓", "").trim());
const text = (page: Page, testId: string) => page.getByTestId(testId).textContent();

test("server markup: a listbox with its selection", () => {
  expect(markup).toContain('role="listbox"');
  expect(markup).toContain('aria-multiselectable="true"');
  expect(markup).toMatch(/role="option"[^>]*aria-selected="true"/);
});

test("listbox: arrows, Home, End and typeahead move; Space and a press toggle rows; disabled rows stay unselected", async () => {
  await withPage(async (page) => {
    const list = page.getByTestId("listbox");
    await page.getByRole("option", { name: "Angebot Eichenplatten" }).focus();
    await page.keyboard.press("ArrowDown");
    expect(await focused(page)).toBe("Unterlagen drittes Quartal");
    await page.keyboard.press("End");
    expect(await focused(page)).toBe("Fotos vom Tisch");
    await page.keyboard.press("Home");
    expect(await focused(page)).toBe("Angebot Eichenplatten");
    await page.keyboard.press("l");
    expect(await focused(page)).toBe("Lieferung Freitag");
    await page.keyboard.press("Space");
    expect(await text(page, "selected")).toBe("m1,m4");
    await page.getByRole("option", { name: "Angebot Eichenplatten" }).click();
    expect(await text(page, "selected")).toBe("m4");
    // Playwright refuses to press an aria-disabled element; a user's press still reaches it.
    await page.getByRole("option", { name: "Termin Abholung" }).click({ force: true });
    expect(await text(page, "selected")).toBe("m4");
    expect(await list.locator('[aria-selected="true"]').count()).toBe(1);
    expect(await pattern(page, '[role="listbox"]', "listbox")).toBe("ok");
  });
});
