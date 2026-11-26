import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type axeCore from "axe-core";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-menu-panel.demo";

// A menu entry with a panel (`MenuItem.panel`): the panel is a dialog of its own, not a part of the menu. On a wide
// screen it takes the place of the menu its entry stands in, on the phone it is a sheet of its own; its head, Escape and
// the back button lead back. The menu's keys never reach it (a delegated `onKeyDown` in it gets every key, the arrows
// stay with what is in it), Escape closes the innermost layer first (a popover in the panel, then the panel, then the
// menu) and the focus goes back where it came from, and no menu holds a dialog (axe).

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

const withPage = async (run: (page: Page) => Promise<void>, { width = 1440, height = 900, touch = false } = {}) => {
  const page = await browser.newPage({ viewport: { width, height }, hasTouch: touch, isMobile: touch });
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
        // the entry says what it opens and which element that is (on a wide screen its menu gave the panel its place)
        const opener = page.locator('[role="menuitem"]', { hasText: "Notiz und Zeit …" });
        expect(await opener.getAttribute("aria-haspopup")).toBe("dialog");
        expect(await opener.getAttribute("aria-expanded")).toBe("true");
        const controls = await opener.getAttribute("aria-controls");
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

// Review of #4157: a menu inside the panel is the innermost layer; Escape closes it alone, not the panel around it.
test("Escape in a menu inside the panel closes that menu only", async () => {
  await withPage(async (page) => {
    await page.getByRole("button", { name: "Später" }).click();
    await entry(page).click();
    await panel(page).waitFor();
    await panel(page).getByRole("button", { name: "Vorlage" }).click();
    await page.getByRole("menuitem", { name: "Früh" }).waitFor();
    expect(await page.locator('[role="menu"]').count()).toBe(2);
    await page.keyboard.press("Escape");
    await page.getByRole("menuitem", { name: "Früh" }).waitFor({ state: "detached" });
    await settled(page);
    expect(await panel(page).isVisible()).toBe(true);
    expect(await page.locator('[role="menu"]').count()).toBe(1);
    expect(await focused(page)).toBe("Vorlage");
  });
});

// Review of #4157: a disabled panel entry stays shut, to a click and to the keys.
test("a disabled panel entry opens its panel neither on a click nor on Enter, Space or the arrow", async () => {
  await withPage(async (page) => {
    await page.getByRole("button", { name: "Später" }).click();
    const locked = page.getByRole("menuitem", { name: "Gesperrt …" });
    expect(await locked.getAttribute("aria-disabled")).toBe("true");
    await locked.click({ force: true });
    await settled(page);
    expect(await page.getByRole("dialog").count()).toBe(0);
    await locked.focus();
    for (const key of ["Enter", " ", "ArrowRight"]) {
      await page.keyboard.press(key);
      await settled(page);
      expect(await page.getByRole("dialog").count()).toBe(0);
    }
    expect(await page.locator('[role="menu"]').count()).toBe(1);
  });
});

// Review of #4157 (r2): `current` is the value set through an entry; it stands at the end in the app's colour, is part
// of the entry's name, and takes the place of `meta`.
test("an entry's current value stands at its end, set apart, in its name, in place of its meta", async () => {
  await withPage(async (page) => {
    await page.getByRole("button", { name: "Später" }).click();
    const when = page.getByRole("menuitem", { name: /^Wann/ });
    await when.waitFor();
    await settled(page);
    expect(await when.locator(".k2-mi-meta[data-set]").textContent()).toBe("Morgen");
    expect((await when.textContent())?.includes("⌘ W")).toBe(false);
    expect(await page.getByRole("menuitem", { name: "Wann Morgen" }).count()).toBe(1);
    const look = await when.locator(".k2-mi-meta[data-set]").evaluate((element) => getComputedStyle(element).fontWeight);
    expect(Number(look)).toBeGreaterThanOrEqual(600);
  });
});

// Review of #4157 (r2): a choice without a heading: another option closes the menu and is chosen once; the ticked one
// only closes it.
test("a choice without a heading: another option is chosen once and closes the menu, the ticked one only closes it", async () => {
  await withPage(async (page) => {
    await page.getByRole("button", { name: "Später" }).click();
    await page.getByRole("menuitem", { name: /^Wann/ }).hover();
    const today = page.getByRole("menuitemradio", { name: "Heute" });
    await today.waitFor();
    expect(await page.locator('[role="menu"]').nth(1).locator(".k2-mh").count()).toBe(0);
    // no heading, so the group points at none
    expect(await page.locator('[role="menu"]').nth(1).locator('[role="group"]').getAttribute("aria-labelledby")).toBe(null);
    const tomorrow = page.getByRole("menuitemradio", { name: "Morgen" });
    expect(await tomorrow.getAttribute("aria-checked")).toBe("true");
    // the keys: Enter on the ticked option only closes the menu
    await tomorrow.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !document.querySelector('[role="menu"]'));
    expect(await deeds(page)).toEqual([]);
    await page.getByRole("button", { name: "Später" }).click();
    await page.getByRole("menuitem", { name: /^Wann/ }).hover();
    await today.waitFor();
    await today.click();
    await page.waitForFunction(() => !document.querySelector('[role="menu"]'));
    expect(await deeds(page)).toEqual(["when:today"]);
    await page.getByRole("button", { name: "Später" }).click();
    await page.getByRole("menuitem", { name: /^Wann/ }).hover();
    await page.getByRole("menuitemradio", { name: "Heute" }).click();
    await page.waitForFunction(() => !document.querySelector('[role="menu"]'));
    expect(await deeds(page)).toEqual(["when:today"]);
  });
});

// Review of #4157 (r2): the head of a panel's sheet leads back, and says so to a screen reader.
test("on the phone the head of a panel's sheet is named as the way back", async () => {
  await withPage(
    async (page) => {
      await page.getByRole("button", { name: "Später" }).tap();
      await sheetAtRest(page);
      await entry(page).tap();
      await panel(page).waitFor();
      // the panel's own sheet has slid in (a tap while it moves scrolls it)
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLElement>('.k2-pop[data-presentation="sheet"]')?.style.getPropertyValue("--drawer-progress") === "1",
      );
      const back = panel(page).getByRole("button", { name: "Zurück zu Notiz und Zeit …" });
      expect(await back.textContent()).toContain("Notiz und Zeit …");
      await back.tap();
      await panel(page).waitFor({ state: "detached" });
      expect(await page.locator('[role="menu"]').count()).toBe(1);
    },
    { width: 390, touch: true },
  );
});

// Design review of #4157: on a wide screen the panel takes the place of the menu its entry stands in, so no more than
// two layers show; its head leads back, and the menu is there again with the focus on the entry.
test("on a wide screen the panel takes its menu's place, and its head leads back to it", async () => {
  await withPage(async (page) => {
    await page.getByRole("button", { name: "Später" }).click();
    const menu = page.locator('[role="menu"]');
    await menu.waitFor();
    await settled(page);
    const before = await menu.boundingBox();
    await entry(page).click();
    await panel(page).waitFor();
    await settled(page);
    expect(await menu.isVisible()).toBe(false);
    const placed = await panel(page).boundingBox();
    // against the same button, on the same side: it starts where the menu started
    expect(!!before && !!placed && Math.abs(placed.y - before.y) <= 1).toBe(true);
    await panel(page).getByRole("button", { name: "Zurück zu Notiz und Zeit …" }).click();
    await panel(page).waitFor({ state: "detached" });
    expect(await menu.isVisible()).toBe(true);
    expect(await focused(page)).toBe("Notiz und Zeit …");
  });
});

// Review of #4249: a panel stands on the corner its menu grew from. A submenu that opened to the left (the button is
// on the right) grows to the left, so the panel never lies over the menu it came from.
test("a panel in a submenu that opened to the left takes the submenu's place and grows to the left", async () => {
  await withPage(async (page) => {
    await page.getByRole("button", { name: "Später" }).click();
    await page.getByRole("menuitem", { name: /^Wann/ }).hover();
    const submenu = page.locator('[role="menu"]').nth(1);
    await submenu.waitFor();
    expect(await submenu.getAttribute("data-side")).toBe("left");
    const [first, sub] = [await page.locator('[role="menu"]').first().boundingBox(), await submenu.boundingBox()];
    await page.getByRole("menuitem", { name: "Andere Zeit …" }).click();
    const other = page.getByRole("dialog", { name: "Andere Zeit …" });
    await other.waitFor();
    await settled(page);
    expect(await submenu.isVisible()).toBe(false);
    const placed = await other.boundingBox();
    expect(!!sub && !!placed && Math.abs(placed.x + placed.width - (sub.x + sub.width)) <= 1 && Math.abs(placed.y - sub.y) <= 1).toBe(true);
    expect(!!first && !!placed && placed.x + placed.width <= first.x + 1).toBe(true);
  });
});

// Review of #4249: a context menu has no button to stand against; the panel takes the menu's place at the pointer,
// also where the menu turned upwards at the bottom of the window.
for (const [where, height] of [
  ["at the pointer", 900],
  ["turned upwards", 600],
] as const)
  test(`a panel from a context menu ${where} takes the menu's place`, async () => {
    await withPage(
      async (page) => {
        const row = page.getByText("Auftrag", { exact: true });
        const at = await row.boundingBox();
        if (!at) throw new Error("no row");
        // at the bottom of the window the menu has no room below the pointer and turns upwards
        await page.mouse.click(at.x + 4, height < 900 ? height - 12 : at.y + 4, { button: "right" });
        const context = page.locator('[role="menu"]');
        await context.waitFor();
        await settled(page);
        if (height < 900) expect(await context.getAttribute("data-side")).toBe("top");
        const menuBox = await context.boundingBox();
        await page.getByRole("menuitem", { name: "Notiz zur Zeile …" }).click();
        const note = page.getByRole("dialog", { name: "Notiz zur Zeile …" });
        await note.waitFor();
        await settled(page);
        expect(await context.isVisible()).toBe(false);
        const placed = await note.boundingBox();
        expect(!!menuBox && !!placed && Math.abs(placed.x - menuBox.x) <= 1).toBe(true);
        // on screen, whatever room the menu had
        expect(!!placed && placed.y >= 0 && placed.y + placed.height <= height).toBe(true);
      },
      { height },
    );
  });
