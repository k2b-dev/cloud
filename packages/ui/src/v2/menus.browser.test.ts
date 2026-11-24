import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Locator, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle, serverMarkup } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-menus.demo";
import { heights } from "./tokens";

// Menu, Popover and Toast of v2 in a real engine, with v2.css: the shapes of the mockup (entries of 32 px in a menu
// of at least 232 px, lined up with the end of a button on the right, a line before the dangerous deed; a panel of
// 280 px; a toast at the bottom in the middle), and what the behaviour layer promises through them: keys, submenus to
// the side, a context menu at the pointer, ticks that update in place, a hint on hover, Undo, Escape and focus return.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
// Icons take one em without their font, so the layout does not depend on a font file in the test.
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; padding: 8px; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let bundle: string;
let markup: string;
beforeAll(async () => {
  [bundle, markup, browser] = await Promise.all([demoBundle("../v2-menus"), serverMarkup("../v2-menus"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

type Options = { width?: number; touch?: boolean; theme?: "light" | "dark" };

const withPage = async (run: (page: Page) => Promise<void>, { width = 1440, touch = false, theme = "light" }: Options = {}) => {
  const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: touch, isMobile: touch, colorScheme: theme });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"${theme === "dark" ? ' class="dark"' : ""}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
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

const box = async (locator: Locator) => {
  const found = await locator.boundingBox();
  if (!found) throw new Error("no box");
  return found;
};
const deeds = (page: Page) => page.evaluate(() => window.__deeds ?? []);
const focused = (page: Page) => page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
const menu = ".k2-menu";
const headMenu = (page: Page) => page.getByRole("button", { name: "Weitere Aktionen" });
const closed = (page: Page, selector: string) => page.waitForFunction((s) => !document.querySelector(s), selector);

test("server markup: the menu's button is named and says it opens a menu; no popup is sent", () => {
  expect(markup).toContain('aria-label="Weitere Aktionen"');
  expect(markup).toContain('aria-haspopup="menu"');
  expect(markup).toContain("data-keep");
  expect(markup).not.toContain("k2-menu");
  expect(markup).not.toContain("k2-pop");
});

test("menu: under the end of its button, entries of 32 px, at least 232 px, a line before the dangerous deed", async () => {
  await withPage(async (page) => {
    const trigger = headMenu(page);
    await trigger.click();
    await page.locator(menu).waitFor();
    await settled(page);
    const [t, m] = [await box(trigger), await box(page.locator(menu))];
    expect(Math.abs(m.x + m.width - (t.x + t.width))).toBeLessThanOrEqual(1);
    expect(Math.abs(m.y - (t.y + t.height + 4))).toBeLessThanOrEqual(1);
    expect(m.width).toBeGreaterThanOrEqual(232);
    const entries = page.locator(`${menu} > .k2-mi`);
    expect(await entries.count()).toBe(6);
    for (const height of await entries.evaluateAll((all) => all.map((el) => el.getBoundingClientRect().height))) {
      expect(height).toBe(heights.dense);
    }
    // the line stands right before "Verwerfen", reaching the menu's edges
    const order = await page.locator(`${menu} > *`).evaluateAll((all) => all.map((el) => (el.classList.contains("k2-msep") ? "—" : el.textContent?.trim())));
    expect(order.at(-2)).toBe("—");
    expect(order.at(-1)).toBe("Verwerfen");
    const line = await box(page.locator(`${menu} > .k2-msep`));
    expect([line.x, line.width, line.height]).toEqual([m.x + 1, m.width - 2, 1]);
    // the words of every entry start at the same x, with or without a symbol
    const starts = await page.locator(`${menu} .k2-mi-label`).evaluateAll((all) => [...new Set(all.map((el) => el.getBoundingClientRect().left))]);
    expect(starts.length).toBe(1);
    expect(await page.locator(`${menu} .k2-mi[data-danger]`).evaluate((el) => getComputedStyle(el).color)).toBe("rgb(185, 28, 28)");
    await page.getByRole("menuitem", { name: "Auftrag duplizieren" }).click();
    await closed(page, menu);
    expect(await deeds(page)).toEqual(["duplicate"]);
  });
});

test("menu: keys open it, walk it, open the submenu to the side, skip nothing disabled silently, Escape returns focus", async () => {
  await withPage(async (page) => {
    const trigger = headMenu(page);
    await trigger.focus();
    await page.keyboard.press("Enter");
    await page.locator(menu).waitFor();
    expect(await focused(page)).toBe("Als Vorlage speichern");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    expect(await focused(page)).toBe("Verschieben nach");
    await page.keyboard.press("ArrowRight");
    await page.locator(menu).nth(1).waitFor();
    await settled(page);
    expect(await focused(page)).toBe("Werkstatt");
    const [parent, sub] = [await box(page.locator(menu).first()), await box(page.locator(menu).nth(1))];
    // to the side: right of the menu, or left of it where the menu stands at the right edge of the window
    expect(sub.x >= parent.x + parent.width - 1 || sub.x + sub.width <= parent.x + 1).toBe(true);
    // a disabled entry stays in reach of the keys (it can be found), but does nothing
    expect(await page.getByRole("menuitem", { name: "Archiv" }).getAttribute("aria-disabled")).toBe("true");
    await page.keyboard.press("ArrowLeft");
    await page.waitForFunction(() => document.querySelectorAll(".k2-menu").length === 1);
    expect(await focused(page)).toBe("Verschieben nach");
    await page.keyboard.press("Escape");
    await closed(page, menu);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Weitere Aktionen");
    await trigger.click();
    await page.getByRole("menuitem", { name: "Verschieben nach" }).hover();
    await page.getByRole("menuitem", { name: "Lager" }).click();
    await closed(page, menu);
    expect(await deeds(page)).toEqual(["move:lager"]);
  });
});

test("menu: a tick flips in place, its entry keeps the highlight, the tick stands at the end", async () => {
  await withPage(async (page) => {
    await headMenu(page).click();
    const tick = page.getByRole("menuitemcheckbox", { name: "Nur offene zeigen" });
    expect(await tick.getAttribute("aria-checked")).toBe("true");
    const [entry, mark] = [await box(tick), await box(tick.locator(".k2-mi-tick"))];
    expect(Math.round(entry.x + entry.width - (mark.x + mark.width))).toBe(8);
    const element = await tick.elementHandle();
    await tick.click();
    await page.waitForFunction(() => document.querySelector('[role="menuitemcheckbox"]')?.getAttribute("aria-checked") === "false");
    // the same element: new data for an open menu updates its entries in place
    expect(await page.evaluate((el) => el?.isConnected, element)).toBe(true);
    expect(await deeds(page)).toEqual(["open-only:false"]);
  });
});

test("context menu: a right-click on a row opens the row's menu at the pointer; the row keeps its own element", async () => {
  await withPage(async (page) => {
    // no wrapper: the rows are still the list's children
    expect(await page.locator(".k2-list > .k2-row").count()).toBe(3);
    const row = page.locator(".k2-list > .k2-row").nth(1);
    const r = await box(row);
    await page.mouse.click(r.x + 200, r.y + 10, { button: "right" });
    await page.locator(menu).waitFor();
    await settled(page);
    const m = await box(page.locator(menu));
    // at the pointer: core leaves a gap of a few px so the pointer does not rest on the first entry
    expect(Math.abs(m.x - (r.x + 200))).toBeLessThanOrEqual(4);
    expect(Math.abs(m.y - (r.y + 10))).toBeLessThanOrEqual(4);
    await page.getByRole("menuitem", { name: "Duplizieren" }).click();
    await closed(page, menu);
    expect(await deeds(page)).toEqual(["duplicate:A-1043"]);
    // the "…" at the end of the row opens the same deeds under its button
    await page.getByRole("button", { name: "Aktionen für Regal Archiv" }).click();
    await page.getByRole("menuitem", { name: "Löschen" }).click();
    expect(await deeds(page)).toEqual(["duplicate:A-1043", "delete:A-1044"]);
  });
});

test("popover: a panel of 280 px under the start of its button with a title; Escape closes and returns focus", async () => {
  await withPage(async (page) => {
    const trigger = page.getByRole("button", { name: "Filter" });
    await trigger.click();
    const panel = page.locator(".k2-pop");
    await panel.waitFor();
    await settled(page);
    const [t, p] = [await box(trigger), await box(panel)];
    expect(p.width).toBe(280);
    // the button stands in the right half of the head, so the panel lines up with its end
    expect(Math.abs(p.x + p.width - (t.x + t.width))).toBeLessThanOrEqual(1);
    expect(Math.abs(p.y - (t.y + t.height + 4))).toBeLessThanOrEqual(1);
    expect(await panel.evaluate((el) => document.getElementById(el.getAttribute("aria-labelledby") ?? "")?.textContent)).toBe("Filter");
    await page.getByRole("checkbox", { name: "Nur eilige" }).click();
    await page.keyboard.press("Escape");
    await closed(page, ".k2-pop");
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Filter");
  });
});

test("tip: hovering the button shows its hint above it after a moment; the button keeps its own name", async () => {
  await withPage(async (page) => {
    const button = page.getByRole("button", { name: "Aktualisieren" });
    expect(await page.locator(".k2-tip:not([hidden])").count()).toBe(0);
    await button.hover();
    const tip = page.locator(".k2-tip:not([hidden])");
    await tip.waitFor();
    await settled(page);
    expect(await tip.textContent()).toBe("Neu laden");
    const [b, h] = [await box(button), await box(tip)];
    // above the button, or below it where the button stands at the top of the window; never on it
    expect(h.y + h.height <= b.y || h.y >= b.y + b.height).toBe(true);
    expect(await button.getAttribute("aria-describedby")).toBe(await tip.getAttribute("id"));
    await page.mouse.move(700, 600);
    await page.waitForFunction(() => !document.querySelector(".k2-tip:not([hidden])"));
  });
});

test("toast: at the bottom in the middle with Undo; Undo runs and closes it", async () => {
  await withPage(async (page) => {
    await page.getByRole("button", { name: "Speichern" }).click();
    const toast = page.locator(".k2-toast");
    await toast.waitFor();
    await settled(page);
    const t = await box(toast);
    expect(Math.abs(t.x + t.width / 2 - 720)).toBeLessThanOrEqual(1);
    expect(Math.round(900 - (t.y + t.height))).toBe(16);
    expect(t.height).toBe(44);
    expect(await toast.locator(".k2-toast-text").textContent()).toBe("Auftrag gespeichert");
    // a landmark while it holds toasts, named in the page's language
    expect(await page.getByRole("region", { name: "Benachrichtigungen" }).count()).toBe(1);
    await page.getByRole("button", { name: "Rückgängig" }).click();
    await closed(page, ".k2-toast");
    expect(await deeds(page)).toEqual(["save", "undo"]);
  });
});

test("phone: the head keeps the '…', its menu opens on screen; toasts stay inside the width", async () => {
  await withPage(
    async (page) => {
      const trigger = headMenu(page);
      expect(await trigger.isVisible()).toBe(true);
      await trigger.tap();
      await page.locator(menu).waitFor();
      await settled(page);
      // the menu is a popup beside its kept button: the head's rule that hides other buttons must not hide it
      expect(await page.locator(menu).isVisible()).toBe(true);
      const m = await box(page.locator(menu));
      expect(m.x).toBeGreaterThanOrEqual(7);
      expect(m.x + m.width).toBeLessThanOrEqual(390 - 7);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    },
    { width: 390, touch: true },
  );
});

test("dark: the menu is the dark surface with the dark hairline", async () => {
  await withPage(
    async (page) => {
      await headMenu(page).click();
      await page.locator(menu).waitFor();
      const look = await page.locator(menu).evaluate((el) => {
        const style = getComputedStyle(el);
        return [style.backgroundColor, style.borderTopColor];
      });
      expect(look[0]).not.toBe("rgb(255, 255, 255)");
      expect(look[1]).not.toBe("rgb(228, 228, 231)");
    },
    { theme: "dark" },
  );
});
