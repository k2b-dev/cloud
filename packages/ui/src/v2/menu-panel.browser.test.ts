import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type axeCore from "axe-core";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-menu-panel.demo";

// A menu entry with a panel (`MenuItem.panel`): the panel is a dialog of its own beside the entry, not a part of the
// menu. So the menu's keys never reach it (a delegated `onKeyDown` in it gets every key), Escape closes the innermost
// layer first (a popover in the panel, then the panel, then the menu) and the focus goes back where it came from, and
// no menu holds a dialog (axe). On the phone the panel is a sheet of its own.

declare global {
  interface Window {
    axe?: typeof axeCore;
  }
}

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const axeSource = readFileSync(Bun.resolveSync("axe-core/axe.min.js", import.meta.dir), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let bundle: string;
beforeAll(async () => {
  [bundle, browser] = await Promise.all([demoBundle("../v2-menu-panel"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (run: (page: Page) => Promise<void>, { width = 1440, touch = false } = {}) => {
  const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: touch, isMobile: touch });
  page.setDefaultTimeout(3000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Panel</title><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
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

const deeds = (page: Page) => page.evaluate(() => window.__deeds ?? []);
const entry = (page: Page) => page.getByRole("menuitem", { name: "Notiz und Zeit …" });
const panel = (page: Page) => page.getByRole("dialog", { name: "Notiz und Zeit …" });
const focused = (page: Page) => page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
/** Waits until the menu's sheet has slid in and stands still for five frames (a tap while it moves would scroll it). */
const sheetAtRest = (page: Page) =>
  page.waitForFunction(
    () => {
      const state = window as unknown as { sheetTop?: number; sheetStill?: number };
      const sheet = document.querySelector<HTMLElement>('.k2-menu[data-presentation="sheet"]');
      const box = sheet?.getBoundingClientRect();
      const placed = !!box && sheet?.style.getPropertyValue("--drawer-progress") === "1" && Math.round(box.bottom) === window.innerHeight;
      state.sheetStill = placed && box?.top === state.sheetTop ? (state.sheetStill ?? 0) + 1 : 0;
      state.sheetTop = box?.top;
      return (state.sheetStill ?? 0) >= 5;
    },
    undefined,
    { polling: "raf", timeout: 5_000 },
  );
/** The rule violations axe finds on the page as it stands. */
const violations = async (page: Page) => {
  await page.addScriptTag({ content: axeSource });
  return page.evaluate(async () => {
    const result = await window.axe!.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "best-practice"] },
    });
    return result.violations.filter((found) => found.id !== "region" && found.id !== "page-has-heading-one").map((found) => found.id);
  });
};

for (const [width, touch] of [
  [1440, false],
  [390, true],
] as const)
  test(`at ${width} px the panel is a dialog of its own beside its entry, outside the menu (axe)`, async () => {
    await withPage(
      async (page) => {
        await page.getByRole("button", { name: "Später" }).click();
        if (width < 768) await sheetAtRest(page);
        await entry(page).click();
        await panel(page).waitFor();
        await settled(page);
        // the entry says what it opens and which element that is
        expect(await entry(page).getAttribute("aria-haspopup")).toBe("dialog");
        expect(await entry(page).getAttribute("aria-expanded")).toBe("true");
        const controls = await entry(page).getAttribute("aria-controls");
        expect(controls && (await panel(page).getAttribute("id")) === controls).toBe(true);
        // no menu holds the dialog, and the menu stays open beside it
        expect(await page.locator('[role="menu"] [role="dialog"]').count()).toBe(0);
        expect(await page.locator('[role="menu"]').count()).toBe(1);
        if (width < 768) expect(await panel(page).getAttribute("data-presentation")).toBe("sheet");
        expect(await violations(page)).toEqual([]);
      },
      { width, touch },
    );
  });

test("a delegated key handler in the panel gets every key; Enter there closes panel and menu", async () => {
  await withPage(async (page) => {
    await page.getByRole("button", { name: "Später" }).click();
    await entry(page).focus();
    // Enter on the entry opens the panel, as it would open a submenu
    await page.keyboard.press("Enter");
    await panel(page).waitFor();
    const note = panel(page).getByRole("textbox", { name: "Notiz" });
    await note.focus();
    await page.keyboard.type("ab");
    expect(await note.inputValue()).toBe("ab");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !document.querySelector('[role="menu"]') && !document.querySelector('[role="dialog"]'));
    expect(await deeds(page)).toEqual(["key:a", "key:b", "key:ArrowLeft", "key:Enter", "note:ab"]);
  });
});

test("Escape closes the innermost layer first: a popover in the panel, then the panel, then the menu", async () => {
  await withPage(async (page) => {
    await page.getByRole("button", { name: "Später" }).click();
    await entry(page).focus();
    await page.keyboard.press("ArrowRight");
    await panel(page).waitFor();
    await panel(page).getByRole("button", { name: "Hinweis" }).click();
    const hint = page.getByRole("dialog", { name: "Hinweis" });
    await hint.waitFor();
    await page.keyboard.press("Escape");
    await hint.waitFor({ state: "detached" });
    expect(await panel(page).isVisible()).toBe(true);
    expect(await focused(page)).toBe("Hinweis");
    await page.keyboard.press("Escape");
    await panel(page).waitFor({ state: "detached" });
    expect(await page.locator('[role="menu"]').count()).toBe(1);
    expect(await focused(page)).toBe("Notiz und Zeit …");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector('[role="menu"]'));
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Später");
  });
});

test("Tab stays inside the panel; a press inside it leaves the menu open", async () => {
  await withPage(async (page) => {
    await page.getByRole("button", { name: "Später" }).click();
    await entry(page).click();
    await panel(page).waitFor();
    for (let step = 0; step < 5; step += 1) await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
    await panel(page).getByRole("textbox", { name: "Notiz" }).click();
    expect(await page.locator('[role="menu"]').count()).toBe(1);
    await panel(page).getByRole("button", { name: "Übernehmen" }).click();
    await page.waitForFunction(() => !document.querySelector('[role="menu"]') && !document.querySelector('[role="dialog"]'));
    // the Tabs went through the text field, which heard them; then the button applied
    expect((await deeds(page)).at(-1)).toBe("apply:");
  });
});

test("on the phone Escape closes the panel's sheet first and leaves the menu open, wherever the focus stood", async () => {
  await withPage(
    async (page) => {
      await page.getByRole("button", { name: "Später" }).tap();
      await sheetAtRest(page);
      await entry(page).tap();
      await panel(page).waitFor();
      await page.keyboard.press("Escape");
      await panel(page).waitFor({ state: "detached" });
      expect(await page.locator('[role="menu"]').count()).toBe(1);
      expect(await focused(page)).toBe("Notiz und Zeit …");
    },
    { width: 390, touch: true },
  );
});
