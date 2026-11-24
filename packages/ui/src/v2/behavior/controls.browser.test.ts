// Contract test for Tabs, Tooltip, Checkbox and Switch on @ui-sdk/core through our Solid 1 adapter.
// Runs in Chromium and in WebKit (TEST_BROWSER=webkit).
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { hoverInPlace, launchBrowser, launchHookMs, pageErrors } from "../../../test/browser";
import { contractCss, demoBundle, focusedName, openDemo, pattern, serverMarkup } from "../../../test/v2-behavior/harness";

let browser: Browser;
let bundle: string;
let css: string;
let markup: string;
beforeAll(async () => {
  [bundle, css, markup] = await Promise.all([demoBundle("controls"), contractCss(), serverMarkup("controls")]);
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
const text = (page: Page, testId: string) => page.getByTestId(testId).textContent();
const tooltip = '[data-slot="tooltip-content"]';

test("server markup: tabs, the selected panel, checkbox and switch carry their roles and state", () => {
  expect(markup).toContain('role="tablist"');
  expect(markup).toContain('aria-selected="true"');
  expect(markup).toContain(">Postfach<");
  expect(markup).toContain('role="checkbox"');
  expect(markup).toContain('aria-checked="false"');
  expect(markup).toContain('role="switch"');
  // A tooltip's content stays in the page, closed, so its trigger is described before it ever opens. Guard for the
  // boolean attribute class: core writes `hidden: ""`, which Solid 1 dropped as falsy until the adapter made it `true`.
  expect(markup).toMatch(/data-slot="tooltip-content"[^>]*\shidden/);
  // Inactive panels and their content are not rendered at all.
  expect(markup).not.toContain("Ablage");
});

// Guard for eager children: the content of a part that comes and goes was created with the part, so an inactive
// panel's components mounted on detached DOM and were never disposed.
test("tabs: an inactive panel's content mounts only when its tab is selected and is disposed when it goes", async () => {
  await withPage(async (page) => {
    expect(await page.evaluate(() => window.__panelMounts ?? 0)).toBe(0);
    await page.getByRole("tab", { name: "Mail" }).focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => window.__panelMounts === 1);
    expect(await page.evaluate(() => window.__panelCleanups ?? 0)).toBe(0);
    await page.keyboard.press("Home");
    await page.waitForFunction(() => window.__panelCleanups === 1);
    expect(await page.evaluate(() => window.__panelMounts)).toBe(1);
  });
});

test("tabs: arrows move and select, a disabled tab takes focus but is never selected, Home and End jump", async () => {
  await withPage(async (page) => {
    await page.getByRole("tab", { name: "Mail" }).focus();
    await page.keyboard.press("ArrowRight");
    expect(await focusedName(page)).toBe("Dateien");
    expect(await text(page, "tab")).toBe("files");
    expect(await page.getByRole("tabpanel").textContent()).toBe("Ablage");
    // APG: disabled tabs stay focusable so they can be discovered.
    await page.keyboard.press("ArrowRight");
    expect(await focusedName(page)).toBe("Chat");
    expect(await text(page, "tab")).toBe("files");
    await page.keyboard.press("ArrowRight");
    expect(await focusedName(page)).toBe("Aufgaben");
    await page.keyboard.press("Home");
    expect(await focusedName(page)).toBe("Mail");
    await page.keyboard.press("End");
    expect(await text(page, "tab")).toBe("tasks");
    expect(await pattern(page, '[role="tablist"]', "tabs")).toBe("ok");
  });
});

test("tooltip: keyboard focus shows it, Escape hides it; hover shows it after the delay", async () => {
  await withPage(async (page) => {
    const trigger = page.getByTestId("tooltip-trigger");
    expect(await page.locator(tooltip).isVisible()).toBe(false);
    // Keyboard focus (not a script's focus()) shows a tooltip at once.
    await page.getByTestId("before-tooltip").focus();
    await page.keyboard.press("Tab");
    expect(await focusedName(page)).toBe("tooltip-trigger");
    await page.locator(tooltip).waitFor();
    expect(await page.locator(tooltip).textContent()).toBe("Archivieren");
    await page.keyboard.press("Escape");
    await page.locator(tooltip).waitFor({ state: "hidden" });
    await page.getByTestId("checkbox").focus();
    // hover: no geometry is read after the hover.
    await hoverInPlace(trigger);
    await page.locator(tooltip).waitFor();
    expect(await page.locator(tooltip).isVisible()).toBe(true);
  });
});

test("checkbox and switch: a click and Space toggle them, the hidden form input follows", async () => {
  await withPage(async (page) => {
    const box = page.getByTestId("checkbox");
    await box.click();
    expect(await text(page, "checked")).toBe("true");
    expect(await box.getAttribute("aria-checked")).toBe("true");
    await page.keyboard.press("Space");
    expect(await text(page, "checked")).toBe("false");
    expect(await pattern(page, '[data-testid="checkbox"]', "checkbox")).toBe("ok");
    const toggle = page.getByTestId("switch");
    await toggle.focus();
    await page.keyboard.press("Space");
    expect(await text(page, "switched")).toBe("false");
    expect(await toggle.getAttribute("aria-checked")).toBe("false");
    await toggle.click();
    expect(await text(page, "switched")).toBe("true");
    expect(await page.locator('input[name="notify"]').evaluate((input) => (input instanceof HTMLInputElement ? input.checked : null))).toBe(
      true,
    );
    expect(await pattern(page, '[data-testid="switch"]', "switch")).toBe("ok");
  });
});
