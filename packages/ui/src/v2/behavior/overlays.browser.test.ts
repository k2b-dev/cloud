// Contract test for the v2 overlays on @ui-sdk/core through our Solid 1 adapter (ported from the spike's
// test/overlays.ts): server markup, mount, Dialog, Menu, Popover, ui-sdk's own checkPattern, phone width.
// Runs on every @ui-sdk/core update, in Chromium and in WebKit (TEST_BROWSER=webkit).
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, Locator, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../test/browser";
import { contractCss, demoBundle, focusedName, focusInside, openDemo, pattern, serverMarkup } from "../../../test/v2-behavior/harness";

let browser: Browser;
let bundle: string;
let css: string;
let markup: string;
beforeAll(async () => {
  [bundle, css, markup] = await Promise.all([demoBundle("overlays"), contractCss(), serverMarkup("overlays")]);
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const open = (width = 1440, height = 900) => openDemo(browser, bundle, css, { width, height, markup });
const box = async (locator: Locator) => {
  const found = await locator.boundingBox();
  if (!found) throw new Error("no box");
  return found;
};
const near = (a: number, b: number, tolerance = 3) => Math.abs(a - b) <= tolerance;
const closed = (page: Page, selector: string) => page.waitForFunction((s) => !document.querySelector(s), selector).then(() => true);
const shown = (page: Page, selector: string) =>
  page
    .locator(selector)
    .waitFor()
    .then(() => true);
const withPage = async (run: (page: Page) => Promise<void>, width?: number, height?: number) => {
  const page = await open(width, height);
  const errors = pageErrors(page);
  try {
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

const dialog = '[data-slot="dialog-content"]';
const menu = '[data-slot="menu-content"]';
const popover = '[data-slot="popover-content"]';

test("server markup: triggers carry slot and ARIA attributes, closed popups are absent", () => {
  for (const part of [
    'data-slot="dialog-trigger"',
    'data-slot="menu-trigger"',
    'aria-haspopup="menu"',
    'aria-expanded="false"',
    'data-slot="popover-trigger"',
  ]) {
    expect(markup).toContain(part);
  }
  expect(markup).not.toContain('data-slot="dialog-content"');
  expect(markup).not.toContain('data-slot="menu-content"');
});

test("dialog: opens centred and modal, traps focus, closes on Escape and returns focus", async () => {
  await withPage(async (page) => {
    const trigger = page.getByTestId("dialog-trigger");
    await trigger.click();
    expect(await shown(page, dialog)).toBe(true);
    await settled(page);
    const centred = await box(page.locator(dialog));
    expect(near(centred.x + centred.width / 2, 720, 2) && near(centred.y + centred.height / 2, 450, 2)).toBe(true);
    expect(
      await page.locator(dialog).evaluate((el) => ({
        role: el.getAttribute("role"),
        modal: el.getAttribute("aria-modal"),
        name: document.getElementById(el.getAttribute("aria-labelledby") ?? "")?.textContent,
      })),
    ).toEqual({ role: "dialog", modal: "true", name: "Neue Nachricht" });
    expect(await focusInside(page, dialog)).toBe(true);
    expect(await trigger.getAttribute("data-open")).not.toBeNull();
    for (const key of ["Tab", "Shift+Tab"]) {
      for (let step = 0; step < 7; step++) {
        await page.keyboard.press(key);
        expect(await focusInside(page, dialog)).toBe(true);
      }
    }
    await settled(page);
    // The page behind is inert to the pointer.
    expect(
      await page.evaluate(() => {
        const behind = document.querySelector('[data-testid="menu-trigger"]');
        if (!behind) return false;
        const r = behind.getBoundingClientRect();
        return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) !== behind;
      }),
    ).toBe(true);
    expect(await pattern(page, dialog, "dialog")).toBe("ok");
    await page.keyboard.press("Escape");
    expect(await closed(page, dialog)).toBe(true);
    expect(await focusedName(page)).toBe("dialog-trigger");
  });
});

// Guard for the error class the spike found: core marks a change that arrives through the options (a controlled
// `open`) as `delivered`; an adapter that skips such notifications never opens or closes a controlled dialog.
test("dialog: controlled open and close from the app also return focus", async () => {
  await withPage(async (page) => {
    const trigger = page.getByTestId("dialog-trigger");
    await trigger.focus();
    await page.keyboard.press("Enter");
    expect(await shown(page, dialog)).toBe(true);
    await page.locator('input[name="to"]').fill("anna@example.org");
    await page.getByRole("button", { name: "Abbrechen" }).click();
    expect(await closed(page, dialog)).toBe(true);
    expect(await focusedName(page)).toBe("dialog-trigger");
    await trigger.click();
    expect(await shown(page, dialog)).toBe(true);
    await page.getByRole("button", { name: "Senden" }).click();
    expect(await closed(page, dialog)).toBe(true);
    expect(await page.getByTestId("actions-status").textContent()).toBe("Gesendet");
    await trigger.click();
    expect(await shown(page, dialog)).toBe(true);
    await page.getByRole("button", { name: "Schließen" }).click();
    expect(await closed(page, dialog)).toBe(true);
    expect(await focusedName(page)).toBe("dialog-trigger");
  });
});

test("menu: Enter opens on the first item; arrows, Home, End, typeahead; Escape returns focus; a click acts", async () => {
  await withPage(async (page) => {
    const trigger = page.getByTestId("menu-trigger");
    await trigger.focus();
    await page.keyboard.press("Enter");
    expect(await shown(page, menu)).toBe(true);
    expect(await trigger.getAttribute("aria-expanded")).toBe("true");
    expect(await focusedName(page)).toBe("Als gelesen markieren");
    await settled(page);
    const [t, m] = [await box(trigger), await box(page.locator(menu))];
    expect(near(m.y, t.y + t.height + 4) && near(m.x + m.width, t.x + t.width)).toBe(true);
    for (const [key, name] of [
      ["ArrowDown", "Archivieren"],
      ["End", "Löschen"],
      ["Home", "Als gelesen markieren"],
      ["l", "Löschen"],
    ] as const) {
      await page.keyboard.press(key);
      expect(await focusedName(page)).toBe(name);
    }
    await page.keyboard.press("Escape");
    expect(await closed(page, menu)).toBe(true);
    expect(await focusedName(page)).toBe("menu-trigger");
    await trigger.click();
    await page.getByRole("menuitem", { name: "Archivieren" }).click();
    expect(await closed(page, menu)).toBe(true);
    expect(await page.getByTestId("actions-status").textContent()).toBe("Archiviert");
    await trigger.click();
    // A pointer-opened menu moves focus in on the next frame.
    await page.waitForFunction((s) => document.querySelector(s)?.contains(document.activeElement), menu);
    expect(await pattern(page, menu, "menu")).toBe("ok");
  });
});

test("popover: placed start-aligned below the trigger, focus inside, Escape and an outside press close it", async () => {
  await withPage(async (page) => {
    const trigger = page.getByTestId("filter-trigger");
    await trigger.click();
    expect(await shown(page, popover)).toBe(true);
    await settled(page);
    const [t, p] = [await box(trigger), await box(page.locator(popover))];
    expect(near(p.y, t.y + t.height + 6) && near(p.x, t.x)).toBe(true);
    expect(await focusInside(page, popover)).toBe(true);
    await page.keyboard.press("Escape");
    expect(await closed(page, popover)).toBe(true);
    expect(await focusedName(page)).toBe("filter-trigger");
    await trigger.click();
    expect(await shown(page, popover)).toBe(true);
    await page.mouse.click(900, 600);
    expect(await closed(page, popover)).toBe(true);
  });
});

test("phone: the menu and the dialog stay on screen, no horizontal overflow", async () => {
  await withPage(
    async (page) => {
      await page.getByTestId("menu-trigger").click();
      expect(await shown(page, menu)).toBe(true);
      await settled(page);
      const m = await box(page.locator(menu));
      expect(m.x >= 7 && m.x + m.width <= 390 - 7).toBe(true);
      await page.keyboard.press("Escape");
      expect(await closed(page, menu)).toBe(true);
      await page.getByTestId("dialog-trigger").click();
      expect(await shown(page, dialog)).toBe(true);
      await settled(page);
      const d = await box(page.locator(dialog));
      expect(d.x >= 0 && d.x + d.width <= 390 && d.y >= 0).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    },
    390,
    844,
  );
});
