// Contract test for Select and Combobox on @ui-sdk/core through our Solid 1 adapter. Both lean on core's list
// internals (`api.internal`, `instance.use(feature)`), so this is the first test to fail when an update moves them.
// Runs in Chromium and in WebKit (TEST_BROWSER=webkit).
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../test/browser";
import { contractCss, demoBundle, focusedName, heard, openDemo, pattern, serverMarkup } from "../../../test/v2-behavior/harness";

let browser: Browser;
let bundle: string;
let css: string;
let markup: string;
beforeAll(async () => {
  [bundle, css, markup] = await Promise.all([demoBundle("select"), contractCss(), serverMarkup("select")]);
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (run: (page: Page) => Promise<void>, width = 1440, height = 900) => {
  const page = await openDemo(browser, bundle, css, { width, height, markup });
  const errors = pageErrors(page);
  try {
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};
const content = '[data-slot="select-content"]';
const comboContent = '[data-slot="combobox-content"]';
// A select that showed a value before its list opened keeps the list mounted but hidden from then on (`prepare`).
const closed = (page: Page, selector: string) =>
  page
    .locator(selector)
    .waitFor({ state: "hidden" })
    .then(() => true);
const shown = (page: Page, selector: string) =>
  page
    .locator(selector)
    .waitFor()
    .then(() => true);
const highlighted = (page: Page, selector: string) =>
  page.evaluate((s) => document.querySelector(`${s} [data-highlighted]`)?.textContent?.replace("✓", "").trim(), selector);
const text = (page: Page, testId: string) => page.getByTestId(testId).textContent();
const visibleOptions = (page: Page, selector: string) =>
  page.$$eval(`${selector} [role="option"]:not([hidden])`, (items) => items.map((item) => item.textContent?.replace("✓", "").trim()));

test("server markup: the select shows its value's label before the list ever opened; the list is absent", () => {
  expect(markup).toContain('data-slot="select-trigger"');
  expect(markup).toContain('aria-haspopup="listbox"');
  expect(markup).toContain(">In Arbeit<");
  expect(markup).not.toContain('data-slot="select-content"');
  expect(markup).toContain('data-slot="combobox-chip"');
  expect(markup).toContain('role="combobox"');
});

test("select: opens on the selected option, arrows skip disabled options, Enter chooses and returns focus", async () => {
  await withPage(async (page) => {
    const trigger = page.getByTestId("select-trigger");
    expect((await trigger.textContent())?.trim()).toBe("In Arbeit");
    await trigger.click();
    expect(await shown(page, content)).toBe(true);
    expect(await trigger.getAttribute("aria-expanded")).toBe("true");
    // A pointer opens without a visible highlight and moves focus into the list on a later frame (WebKit takes longer);
    // the first arrow then moves on from the selected option.
    await page.waitForFunction((s) => document.querySelector(s)?.contains(document.activeElement), content);
    await page.keyboard.press("ArrowDown");
    expect(await highlighted(page, content)).toBe("Erledigt");
    await page.keyboard.press("ArrowDown");
    expect(await highlighted(page, content)).toBe("Wartet");
    await page.keyboard.press("Enter");
    expect(await closed(page, content)).toBe(true);
    expect(await text(page, "select-value")).toBe("waiting");
    expect((await trigger.textContent())?.trim()).toBe("Wartet");
    expect(await focusedName(page)).toBe("select-trigger");
    // checkPattern works the list with keys itself, so it runs on a fresh open.
    await trigger.click();
    expect(await shown(page, content)).toBe(true);
    expect(await pattern(page, content, "listbox")).toBe("ok");
  });
});

test("select: keyboard opens it, typeahead moves the highlight, Escape closes without a change", async () => {
  await withPage(async (page) => {
    const trigger = page.getByTestId("select-trigger");
    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    expect(await shown(page, content)).toBe(true);
    await page.waitForFunction((s) => document.querySelector(`${s} [data-highlighted]`), content);
    await page.keyboard.press("o");
    expect(await highlighted(page, content)).toBe("Offen");
    await page.keyboard.press("Escape");
    expect(await closed(page, content)).toBe(true);
    expect(await text(page, "select-value")).toBe("doing");
    expect(await focusedName(page)).toBe("select-trigger");
    // A click on an option chooses it; an outside press closes without a change.
    await trigger.click();
    await page.getByRole("option", { name: "Offen" }).click();
    expect(await closed(page, content)).toBe(true);
    expect(await text(page, "select-value")).toBe("open");
    await trigger.click();
    expect(await shown(page, content)).toBe(true);
    await page.mouse.click(1200, 800);
    expect(await closed(page, content)).toBe(true);
    expect(await text(page, "select-value")).toBe("open");
  });
});

test("select with several values: the list stays open while options toggle, the trigger names them", async () => {
  await withPage(async (page) => {
    const trigger = page.getByTestId("multi-trigger");
    await trigger.click();
    expect(await shown(page, content)).toBe(true);
    await page.getByRole("option", { name: "Offen" }).click();
    await page.getByRole("option", { name: "Erledigt" }).click();
    expect(await page.locator(content).isVisible()).toBe(true);
    expect(await text(page, "multi-value")).toBe("open,done");
    expect(await page.locator(`${content} [aria-selected="true"]`).count()).toBe(2);
    await page.getByRole("option", { name: "Offen" }).click();
    expect(await text(page, "multi-value")).toBe("done");
    await page.keyboard.press("Escape");
    expect(await closed(page, content)).toBe(true);
    expect((await trigger.textContent())?.trim()).toBe("Erledigt");
  });
});

test("combobox: typing filters the list, Enter adds the highlighted person as a chip, no match shows the empty state", async () => {
  await withPage(async (page) => {
    const input = page.getByTestId("combobox-input");
    expect(await page.locator("[data-chip]").count()).toBe(1);
    await input.click();
    await input.pressSequentially("er");
    expect(await shown(page, comboContent)).toBe(true);
    await page.waitForFunction((s) => document.querySelectorAll(`${s} [role="option"]:not([hidden])`).length === 3, comboContent);
    expect(await visibleOptions(page, comboContent)).toEqual(["Anna Berg", "Bernd Kraus", "Dora Ernst"]);
    // Core's own list announcement is English ("3 results"); ours follows the page's locale.
    expect(await heard(page, "3 Treffer")).toBe(true);
    expect(await input.getAttribute("aria-expanded")).toBe("true");
    expect(await focusedName(page)).toBe("combobox-input");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    expect(await highlighted(page, comboContent)).toBe("Bernd Kraus");
    expect(await input.getAttribute("aria-activedescendant")).toBeTruthy();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll("[data-chip]").length === 2);
    expect(await text(page, "combobox-value")).toBe("anna,bernd");
    expect(await pattern(page, '[data-slot="combobox-input"]', "combobox")).toBe("ok");
    await input.fill("zzz");
    await page.getByText("Keine Treffer").waitFor();
    expect(await visibleOptions(page, comboContent)).toEqual([]);
    await page.keyboard.press("Escape");
    expect(await closed(page, comboContent)).toBe(true);
    expect(await focusedName(page)).toBe("combobox-input");
  });
});

test("combobox: a chip's remove button and Backspace in an empty field take values out", async () => {
  await withPage(async (page) => {
    await page.getByRole("button", { name: "Anna Berg entfernen" }).click();
    expect(await heard(page, "Anna Berg entfernt")).toBe(true);
    await page.waitForFunction(() => document.querySelectorAll("[data-chip]").length === 0);
    expect(await text(page, "combobox-value")).toBe("");
    const input = page.getByTestId("combobox-input");
    await input.click();
    await page.getByRole("option", { name: "Carla Dietz" }).click();
    await page.waitForFunction(() => document.querySelectorAll("[data-chip]").length === 1);
    await input.focus();
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.waitForFunction(() => document.querySelectorAll("[data-chip]").length === 0);
    expect(await text(page, "combobox-value")).toBe("");
  });
});

test("phone: the select list stays on screen", async () => {
  await withPage(
    async (page) => {
      await page.getByTestId("select-trigger").click();
      expect(await shown(page, content)).toBe(true);
      await settled(page);
      const box = await page.locator(content).boundingBox();
      expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    },
    390,
    844,
  );
});
