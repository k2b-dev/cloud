import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-menu-search.demo";

// A v2 Menu with `search`, as a task board's "+" uses it: the field on top keeps the focus, the arrows move the
// highlight (core's command, no keys of our own), sections and entries filter, the first match is highlighted so Enter
// runs it, and a text no entry matches becomes the fallback entry ("Leere Aufgabe „…“"). Below `from` it is a plain menu.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";
const origin = "http://menu-search.test";

let browser: Browser;
let bundle: string;
beforeAll(async () => {
  [bundle, browser] = await Promise.all([demoBundle("../v2-menu-search"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (search: string, run: (page: Page) => Promise<void>, { width = 1440, touch = false } = {}) => {
  const page = await browser.newPage({ viewport: { width, height: 800 }, hasTouch: touch, isMobile: touch });
  page.setDefaultTimeout(3000);
  const errors = pageErrors(page);
  await page.route(`${origin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
    }),
  );
  try {
    await page.goto(`${origin}/aufgaben${search ? `?${search}` : ""}`);
    await page.addScriptTag({ content: bundle });
    await page.waitForFunction(() => window.__mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

const menu = ".k2-menu.k2-msearch";
const labels = (page: Page) => page.locator(`${menu} .k2-mi .k2-mi-label`).allTextContents();
const deeds = (page: Page) => page.evaluate(() => window.__deeds ?? []);
const open = async (page: Page) => {
  await page.getByRole("button", { name: "Neu" }).click();
  await page.locator(menu).waitFor();
  await page.waitForFunction((selector) => document.activeElement?.matches(`${selector} input`) === true, menu);
};

test("the search stands on top with the focus; entries and sections filter, accents and case do not matter", async () => {
  await withPage("", async (page) => {
    await open(page);
    expect(await page.locator(`${menu} .k2-mh`).allTextContents()).toEqual(["Werkstatt", "Laden"]);
    expect(await labels(page)).toHaveLength(11);
    const field = page.getByRole("combobox", { name: "Vorlage suchen" });
    await field.fill("mobel");
    // the fallback stands after the matches, for a task without a template
    expect(await labels(page)).toEqual(["Möbel aufarbeiten", "Leere Aufgabe „mobel“"]);
    // a section's heading finds all of its entries
    await field.fill("laden");
    expect(await page.locator(`${menu} .k2-mh`).allTextContents()).toEqual(["Laden", "Ohne Vorlage"]);
    expect(await labels(page)).toEqual([
      "Schaufenster umbauen",
      "Palette annehmen",
      "Fotos für den Shop",
      "Preisschilder drucken",
      "Inventur Halle B",
      "Leere Aufgabe „laden“",
    ]);
    // the field stays where it is while the entries change below it
    await settled(page);
    const top = (await page.locator(`${menu} .k2-msearch-field`).boundingBox())?.y;
    await field.fill("palette");
    await settled(page);
    expect((await page.locator(`${menu} .k2-msearch-field`).boundingBox())?.y).toBe(top);
  });
});

test("the first match is highlighted, so Enter runs it; the arrows move the highlight and the menu closes", async () => {
  await withPage("", async (page) => {
    await open(page);
    await page.keyboard.type("palette");
    const highlighted = () => page.locator(`${menu} .k2-mi[data-highlighted] .k2-mi-label`).textContent();
    expect(await highlighted()).toBe("Palette annehmen");
    await page.keyboard.press("ArrowDown");
    expect(await highlighted()).toBe("Leere Aufgabe „palette“");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await page.locator(menu).waitFor({ state: "hidden" });
    expect(await deeds(page)).toEqual(["task:Palette annehmen"]);
  });
});

test("a text no entry matches leaves the fallback alone, and Enter runs it with the text", async () => {
  await withPage("", async (page) => {
    await open(page);
    await page.keyboard.type("Palette tauschen");
    expect(await labels(page)).toEqual(["Leere Aufgabe „Palette tauschen“"]);
    await page.keyboard.press("Enter");
    await page.locator(menu).waitFor({ state: "hidden" });
    expect(await deeds(page)).toEqual(["task:Palette tauschen"]);
    expect(await page.getByRole("listitem").allTextContents()).toEqual(["Palette tauschenOffen"]);
  });
});

test("Escape first empties the search, then closes the menu and gives the focus back to its button", async () => {
  await withPage("", async (page) => {
    await open(page);
    await page.keyboard.type("pal");
    await page.keyboard.press("Escape");
    expect(await page.getByRole("combobox", { name: "Vorlage suchen" }).inputValue()).toBe("");
    expect(await labels(page)).toHaveLength(11);
    await page.keyboard.press("Escape");
    await page.locator(menu).waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.textContent === "Neu");
  });
});

test("below `from` the same entries are a plain menu with its own keys", async () => {
  await withPage("few", async (page) => {
    await page.getByRole("button", { name: "Neu" }).click();
    await page.getByRole("menu").waitFor();
    expect(await page.locator(menu).count()).toBe(0);
    expect(await page.getByRole("menuitem").allTextContents()).toHaveLength(5);
  });
});

test("phone: the field stays on top of the open menu, inside the window", async () => {
  await withPage(
    "",
    async (page) => {
      await page.getByRole("button", { name: "Neu" }).tap();
      await page.locator(menu).waitFor();
      await settled(page);
      const box = await page.locator(menu).boundingBox();
      const field = await page.locator(`${menu} .k2-msearch-field`).boundingBox();
      if (!box || !field) throw new Error("no box");
      expect(box.x).toBeGreaterThanOrEqual(7);
      expect(box.x + box.width).toBeLessThanOrEqual(390 - 7);
      expect(field.y - box.y).toBeLessThanOrEqual(9);
      // a long hint gives way before the words: the template's name is whole, its hint is cut
      const name = page.locator(`${menu} .k2-mi`, { hasText: "Möbel aufarbeiten" });
      expect(await name.locator(".k2-mi-label").evaluate((label) => label.scrollWidth <= label.clientWidth)).toBe(true);
      // the list scrolls under the field, which keeps its place
      await page.locator(`${menu} .k2-msearch-list`).evaluate((list) => list.scrollBy(0, 200));
      await settled(page);
      expect((await page.locator(`${menu} .k2-msearch-field`).boundingBox())?.y).toBe(field.y);
    },
    { width: 390, touch: true },
  );
});

test("a deed that returns a Promise keeps its entry busy and the menu open; a failure says so, and it runs again", async () => {
  await withPage("async", async (page) => {
    await open(page);
    await page.keyboard.type("Palette tauschen");
    const entry = page.locator(`${menu} .k2-mi`, { hasText: "Leere Aufgabe „Palette tauschen“" });
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.__answer !== undefined);
    expect(await entry.getAttribute("aria-busy")).toBe("true");
    expect(await page.locator(menu).isVisible()).toBe(true);
    // the server refuses: the menu stays with the text, and says so
    await page.evaluate(() => window.__answer?.fail());
    await page.locator(`${menu} [role='alert']`).waitFor();
    expect(await page.locator(`${menu} [role='alert']`).textContent()).toBe("Das hat nicht geklappt. Versuch es noch einmal.");
    await page.waitForFunction((selector) => !document.querySelector(selector)?.hasAttribute("aria-busy"), `${menu} .k2-mi`);
    expect(await page.getByRole("combobox", { name: "Vorlage suchen" }).inputValue()).toBe("Palette tauschen");
    // again: it succeeds, the menu closes, the task is there
    await page.evaluate(() => {
      window.__answer = undefined;
    });
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.__answer !== undefined);
    expect(await page.locator(`${menu} [role='alert']`).count()).toBe(0);
    await page.evaluate(() => window.__answer?.ok());
    await page.locator(menu).waitFor({ state: "hidden" });
    expect(await deeds(page)).toEqual(["task:Palette tauschen"]);
  });
});
