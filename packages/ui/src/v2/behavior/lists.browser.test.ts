// Contract test for the v2 listbox (`List`) and tree (`Nav`) on @ui-sdk/core through our Solid 1 adapter.
// Runs in Chromium and in WebKit (TEST_BROWSER=webkit).
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors } from "../../../test/browser";
import { contractCss, demoBundle, heard, openDemo, pattern, serverMarkup } from "../../../test/v2-behavior/harness";

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
/** The text of the focused tree item's label or the focused option. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement;
    const label = active?.querySelector(':scope > .option [data-slot="tree-label"]');
    return (label ?? active)?.textContent?.replace("✓", "").trim();
  });
const item = (page: Page, value: string) => page.locator(`[data-slot="tree-item"]:has(> .option [data-folder="${value}"])`);
const text = (page: Page, testId: string) => page.getByTestId(testId).textContent();

test("server markup: a tree with the current page marked and branches collapsed, a listbox with its selection", () => {
  const first = markup.slice(0, markup.indexOf('data-testid="nested-tree"'));
  expect(first).toContain('role="tree"');
  expect(first).toMatch(/role="treeitem"[^>]*aria-current="page"/);
  expect((first.match(/aria-expanded="false"/g) ?? []).length).toBe(2);
  // A collapsed branch's children do not exist yet.
  expect(first).not.toContain("Eichentisch");
  expect(markup).toContain('role="listbox"');
  expect(markup).toContain('aria-multiselectable="true"');
  expect(markup).toMatch(/role="option"[^>]*aria-selected="true"/);
});

const nestedItem = (page: Page, value: string) => page.locator(`[data-slot="tree-item"]:has(> .option [data-nested="${value}"])`);

// A nested current page needs its ancestors expanded (`defaultExpanded`): core only knows rendered items.
test("tree: a nested current page is marked, rendered with its ancestors open, and holds the tab stop", async () => {
  const nested = markup.slice(markup.indexOf('data-testid="nested-tree"'));
  expect(nested).toMatch(/role="treeitem"[^>]*aria-current="page"/);
  expect(nested).toContain(">Spam<");
  await withPage(async (page) => {
    expect(await nestedItem(page, "spam").getAttribute("aria-current")).toBe("page");
    expect(await nestedItem(page, "spam").getAttribute("aria-level")).toBe("3");
    expect(await nestedItem(page, "more").getAttribute("aria-expanded")).toBe("true");
    expect(await nestedItem(page, "hidden").getAttribute("aria-expanded")).toBe("true");
    expect(await page.getByTestId("nested-tree").locator('[role="treeitem"][tabindex="0"]').count()).toBe(1);
    expect(await nestedItem(page, "spam").getAttribute("tabindex")).toBe("0");
  });
});

test("tree: a branch whose children fail to load says so in the page's language", async () => {
  await withPage(async (page) => {
    await page.locator('[data-nested="remote"]').click();
    expect(await heard(page, "Fernordner konnte nicht geladen werden.")).toBe(true);
  });
});

test("tree: arrows move, Right expands and enters, Left leaves and collapses, Home, End, typeahead, Enter acts", async () => {
  await withPage(async (page) => {
    await item(page, "inbox").focus();
    await page.keyboard.press("ArrowDown");
    expect(await focused(page)).toBe("Projekte");
    expect(await page.locator('[data-folder="oak"]').count()).toBe(0);
    await page.keyboard.press("ArrowRight");
    expect(await item(page, "projects").getAttribute("aria-expanded")).toBe("true");
    await page.locator('[data-folder="oak"]').waitFor();
    await page.keyboard.press("ArrowRight");
    expect(await focused(page)).toBe("Eichentisch");
    await page.keyboard.press("Enter");
    expect(await text(page, "opened")).toBe("oak");
    await page.keyboard.press("ArrowLeft");
    expect(await focused(page)).toBe("Projekte");
    await page.keyboard.press("ArrowLeft");
    expect(await item(page, "projects").getAttribute("aria-expanded")).toBe("false");
    await page.locator('[data-folder="oak"]').waitFor({ state: "detached" });
    await page.keyboard.press("End");
    expect(await focused(page)).toBe("Mehr");
    await page.keyboard.press("Home");
    expect(await focused(page)).toBe("Posteingang");
    await page.keyboard.press("m");
    expect(await focused(page)).toBe("Mehr");
    expect(await pattern(page, '[role="tree"]', "tree")).toBe("ok");
  });
});

test("tree: a press on a branch opens it, a nested branch (Ausgeblendet) opens inside, a press on a leaf acts", async () => {
  await withPage(async (page) => {
    await page.locator('[data-folder="more"]').click();
    await page.locator('[data-folder="hidden"]').click();
    await page.locator('[data-folder="spam"]').waitFor();
    expect(await item(page, "spam").getAttribute("aria-level")).toBe("3");
    await page.locator('[data-folder="archive"]').click();
    expect(await text(page, "opened")).toBe("archive");
  });
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
