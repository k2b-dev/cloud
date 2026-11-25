import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Locator, Page } from "playwright";
import { browserName, launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
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

type Options = { width?: number; touch?: boolean; theme?: "light" | "dark"; slowSheet?: boolean };

// Core loads its sheet module on its own time (a dynamic import, a chunk of its own in an app). The bundle of a slow
// load waits for the page's `__k2LoadSheet()`, so a test can let it come after everything else of the popover.
declare global {
  interface Window {
    __k2LoadSheet?: () => void;
  }
}
const sheetImport = "loading ??= Promise.resolve().then(() => (init_sheet_presentation()";
const slowSheetBundle = () => {
  expect(bundle.split(sheetImport).length).toBe(2);
  return bundle.replace(
    sheetImport,
    "loading ??= new Promise((done) => { window.__k2LoadSheet = done; }).then(() => (init_sheet_presentation()",
  );
};

const withPage = async (
  run: (page: Page) => Promise<void>,
  { width = 1440, touch = false, theme = "light", slowSheet = false }: Options = {},
) => {
  const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: touch, isMobile: touch, colorScheme: theme });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"${theme === "dark" ? ' class="dark"' : ""}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
    );
    await page.addScriptTag({ content: slowSheet ? slowSheetBundle() : bundle });
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
    const order = await page
      .locator(`${menu} > *`)
      .evaluateAll((all) => all.map((el) => (el.classList.contains("k2-msep") ? "—" : el.textContent?.trim())));
    expect(order.at(-2)).toBe("—");
    expect(order.at(-1)).toBe("Verwerfen");
    const line = await box(page.locator(`${menu} > .k2-msep`));
    expect([line.x, line.width, line.height]).toEqual([m.x + 1, m.width - 2, 1]);
    // the words of every entry start at the same x, with or without a symbol
    const starts = await page
      .locator(`${menu} .k2-mi-label`)
      .evaluateAll((all) => [...new Set(all.map((el) => el.getBoundingClientRect().left))]);
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

test("menu: a tick flips in place (the same element) and stands at the end of its entry", async () => {
  await withPage(async (page) => {
    await headMenu(page).click();
    await page.locator(menu).waitFor();
    await settled(page);
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
    // an entry that came in stands where the tick stood: it is a plain deed with its own handler, not the old tick
    const added = page.getByRole("menuitem", { name: "Alle zeigen" });
    expect(await added.getAttribute("aria-checked")).toBeNull();
    expect(await page.getByRole("menuitemcheckbox", { name: "Nur offene zeigen" }).getAttribute("aria-checked")).toBe("false");
    await added.click();
    await closed(page, menu);
    expect(await deeds(page)).toEqual(["open-only:false", "show-all"]);
  });
});

test("menu: sections with headings; a choice is one radio group, choosing closes the menu and moves the tick", async () => {
  await withPage(async (page) => {
    const trigger = page.getByRole("button", { name: "Antwort" });
    await trigger.click();
    await page.locator(menu).waitFor();
    await settled(page);
    // each section is a group named by its heading; a line stands between sections, none inside one
    const groups = await page
      .locator(`${menu} [role=group]`)
      .evaluateAll((all) => all.map((el) => document.getElementById(el.getAttribute("aria-labelledby") ?? "")?.textContent));
    expect(groups).toEqual(["Antwortart", "Absender", "Entwurf"]);
    expect(await page.locator(`${menu} > .k2-msep`).count()).toBe(2);
    expect(await page.locator(`${menu} .k2-mgroup .k2-msep`).count()).toBe(0);
    const options = page.getByRole("menuitemradio");
    expect(await options.count()).toBe(5);
    const reply = page.getByRole("menuitemradio", { name: "Antworten", exact: true });
    expect(await reply.getAttribute("aria-checked")).toBe("true");
    expect(await reply.locator(".k2-mi-tick .k2-icon").count()).toBe(1);
    // the heading: 28 px, its words on the words of the entries
    const heading = await box(page.locator(`${menu} .k2-mh`).first());
    expect(heading.height).toBe(28);
    const words = await page
      .locator(`${menu} .k2-mh`)
      .first()
      .evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return range.getBoundingClientRect().left;
      });
    expect(Math.abs(words - (await box(reply.locator(".k2-mi-label"))).x)).toBeLessThanOrEqual(1);
    await page.getByRole("menuitemradio", { name: "Allen antworten" }).click();
    await closed(page, menu);
    expect(await deeds(page)).toEqual(["kind:all"]);
    // with the keys: the chosen one carries the tick now, and Enter on another sender chooses it
    await trigger.focus();
    await page.keyboard.press("Enter");
    await page.locator(menu).waitFor();
    expect(await page.getByRole("menuitemradio", { name: "Allen antworten" }).getAttribute("aria-checked")).toBe("true");
    expect(await reply.getAttribute("aria-checked")).toBe("false");
    for (let step = 0; step < 4; step++) await page.keyboard.press("ArrowDown");
    expect(await focused(page)).toBe("info@werkstatt.example");
    await page.keyboard.press("Enter");
    await closed(page, menu);
    expect(await deeds(page)).toEqual(["kind:all", "sender:info@werkstatt.example"]);
  });
});

test("menu: the '…' at the end of a row stays where it is while its menu is open", async () => {
  await withPage(async (page) => {
    const button = page.getByRole("button", { name: "Aktionen für Küchenfront" });
    const before = await box(button);
    await button.click();
    await page.locator(menu).waitFor();
    await settled(page);
    expect(await box(button)).toEqual(before);
    await page.keyboard.press("Escape");
    await closed(page, menu);
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
    // the menu stands outside the list: a list holds only its rows
    expect(await page.locator(menu).evaluate((el) => el.closest(".k2-list, [role=list]") === null)).toBe(true);
    expect(await page.locator(".k2-list > *").count()).toBe(3);
    await page.getByRole("menuitem", { name: "Duplizieren" }).click();
    await closed(page, menu);
    expect(await deeds(page)).toEqual(["duplicate:A-1043"]);
    // the "…" at the end of the row opens the same deeds under its button
    await page.getByRole("button", { name: "Aktionen für Regal Archiv" }).click();
    await page.getByRole("menuitem", { name: "Löschen" }).click();
    expect(await deeds(page)).toEqual(["duplicate:A-1043", "delete:A-1044"]);
  });
});

test("context menu: Shift+F10 opens it at the row; a long press shows no link preview of the system", async () => {
  await withPage(async (page) => {
    const row = page.locator(".k2-list > .k2-row").nth(2);
    // iOS opens its own preview on a long press unless the area says no: core's long press binding writes
    // `-webkit-touch-callout: none` on the area. Only iOS keeps that property, so the test reads the mark the same
    // binding leaves in every engine, its delay.
    expect(await row.evaluate((el) => el.style.getPropertyValue("--hold-delay"))).toBe("500ms");
    // Safari (WebKit) fires no context menu event for Shift+F10, a key macOS does not know; there the "…" of the row
    // is the way with the keys (the skill asks for both)
    if (browserName === "webkit") return;
    await row.locator("button, a").first().focus();
    await page.keyboard.press("Shift+F10");
    await page.locator(menu).waitFor();
    await settled(page);
    expect(await focused(page)).toBe("Öffnen");
    await page.keyboard.press("Escape");
    await closed(page, menu);
  });
});

test("tabs: 'Weitere +2' is the button of a menu of the views without a tab; keys open it, a choice runs, Escape returns", async () => {
  await withPage(async (page) => {
    const more = page.getByRole("navigation", { name: "Ansichten" }).getByRole("button", { name: /Weitere/ });
    expect(await more.getAttribute("aria-haspopup")).toBe("menu");
    expect(await more.getAttribute("aria-expanded")).toBe("false");
    // it looks like a tab: the tab's words and count, its chevron, the tab's height
    expect((await more.textContent())?.replace(/\s+/g, "")).toBe("Weitere+2");
    const tab = await box(page.getByRole("navigation", { name: "Ansichten" }).getByRole("button", { name: "Offen" }));
    expect((await box(more)).height).toBe(tab.height);
    await more.focus();
    await page.keyboard.press("Enter");
    await page.locator(menu).waitFor();
    expect(await more.getAttribute("aria-expanded")).toBe("true");
    expect(await page.getByRole("menuitem").allTextContents()).toEqual(["Archiv", "Vorlagen"]);
    expect(await focused(page)).toBe("Archiv");
    await page.keyboard.press("Escape");
    await closed(page, menu);
    expect(await focused(page)).toContain("Weitere");
    // the pointer: a click opens it under the tab, a choice runs and closes it
    await more.click();
    await page.locator(menu).waitFor();
    await settled(page);
    const [t, m] = [await box(more), await box(page.locator(menu))];
    expect(Math.abs(m.x - t.x)).toBeLessThanOrEqual(1);
    await page.getByRole("menuitem", { name: "Vorlagen" }).click();
    await closed(page, menu);
    expect(await deeds(page)).toEqual(["view:vorlagen"]);
  });
});

test("tabs: a new view under 'Weitere' while its menu is open keeps the menu and the focus; a choice returns the focus to the tab", async () => {
  await withPage(async (page) => {
    const more = page.getByRole("navigation", { name: "Ansichten" }).getByRole("button", { name: /Weitere/ });
    await more.focus();
    await page.keyboard.press("Enter");
    await page.locator(menu).waitFor();
    expect(await focused(page)).toBe("Archiv");
    await page.evaluate(() => window.__moreViews?.());
    await page.getByRole("menuitem", { name: "Ansicht 3" }).waitFor();
    expect(await focused(page)).toBe("Archiv");
    expect(await more.getAttribute("aria-expanded")).toBe("true");
    expect((await more.textContent())?.replace(/\s+/g, "")).toBe("Weitere+3");
    await page.keyboard.press("Enter");
    await closed(page, menu);
    expect(await deeds(page)).toEqual(["view:archiv"]);
    expect(await page.evaluate(() => document.activeElement?.textContent?.replace(/\s+/g, ""))).toBe("Weitere+3");
  });
});

// A tab is never cut: a tab without room hides whole and is an entry of the menu of further views; the menu tab
// stays whole. The pane's views have a menu tab ("Weitere"); the head's places have none, so "Mehr" holds them.
for (const width of [1440, 900, 700, 390])
  test(`tabs at ${width} px: every tab that shows is whole, the menu tab too, and the hidden ones are in its menu`, async () => {
    await withPage(
      async (page) => {
        const look = (name: string) =>
          page.evaluate((label) => {
            const nav = document.querySelector(`nav[aria-label="${label}"]`)!;
            const edge = nav.getBoundingClientRect();
            const row = nav.querySelector(".k2-tabs")!.getBoundingClientRect();
            const tabs = [...nav.querySelectorAll<HTMLElement>(".k2-tab")];
            const shown = tabs.filter(
              (tab) => getComputedStyle(tab).visibility !== "hidden" && tab.getBoundingClientRect().top < row.bottom,
            );
            return {
              whole: shown.every((tab) => {
                const box = tab.getBoundingClientRect();
                const inRow = !tab.closest(".k2-tabs") || box.right <= row.right + 0.5;
                return inRow && box.left >= edge.left - 0.5 && box.right <= edge.right + 0.5 && tab.scrollWidth <= tab.clientWidth + 1;
              }),
              hidden: tabs.filter((tab) => tab.hasAttribute("data-overflow")).map((tab) => tab.textContent?.trim()),
              more: shown.filter((tab) => tab.hasAttribute("data-menu")).map((tab) => tab.textContent?.replace(/\s+/g, "")),
            };
          }, name);
        const views = await look("Ansichten");
        expect(views.whole).toBe(true);
        // the app counts its own two entries; the hidden views join the count
        expect(views.more).toEqual([`Weitere+${2 + views.hidden.length}`]);
        const areas = await look("Bereiche");
        expect(areas.whole).toBe(true);
        if (width === 1440) expect([views.hidden, areas.hidden, areas.more]).toEqual([[], [], []]);
        if (width === 390) {
          expect(views.hidden.length).toBeGreaterThan(0);
          expect(areas.hidden.length).toBeGreaterThan(0);
        }
        // the hidden views lead the menu of "Weitere", before its own entries; a hidden tab is no stop of the Tab key
        if (views.hidden.length > 0) {
          await page
            .getByRole("navigation", { name: "Ansichten" })
            .getByRole("button", { name: /Weitere/ })
            .click();
          await page.locator(menu).waitFor();
          const entries = (await page.getByRole("menuitem").allTextContents()).map((text) => text.replace(/\d+$/, "").trim());
          expect(entries).toEqual([...views.hidden.map((text) => text?.replace(/\d+$/, "").trim()), "Archiv", "Vorlagen"]);
          // the first hidden view runs as its tab does: a deed at once, or (with an address) its onNavigate, which
          // runs after the menu closed, in the page's view transition; the test waits for that deed
          const before = (await deeds(page)).length;
          await page.getByRole("menuitem").first().click();
          await closed(page, menu);
          await page.waitForFunction((count) => (window.__deeds?.length ?? 0) > count, before);
          expect((await deeds(page)).at(-1)).toMatch(/^view:/);
        }
        if (areas.hidden.length > 0) {
          expect(areas.more.length).toBe(1);
          expect(areas.more[0]).toBe(`Mehr+${areas.hidden.length}`);
          await page.getByRole("navigation", { name: "Bereiche" }).getByRole("button", { name: /Mehr/ }).click();
          await page.locator(menu).waitFor();
          expect((await page.getByRole("menuitem").allTextContents()).map((text) => text.trim())).toEqual(areas.hidden);
          await page.keyboard.press("Escape");
          await closed(page, menu);
        }
      },
      { width },
    );
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

// A panel behind a button without words in a head keeps the menu's phone contract: the button stays beside the "…",
// and its panel is a sheet from the bottom, the whole width (#4151). On a wide screen it is the floating panel.
for (const width of [1440, 390])
  test(`popover in a head at ${width}: ${width < 768 ? "the button stays and the panel is a sheet" : "the floating panel"}`, async () => {
    await withPage(
      async (page) => {
        const trigger = page.getByRole("button", { name: "Vorschau" });
        expect(await trigger.isVisible()).toBe(true);
        expect(await headMenu(page).isVisible()).toBe(true);
        await (width < 768 ? trigger.tap() : trigger.click());
        const panel = page.locator(".k2-pop");
        await panel.waitFor();
        await settled(page);
        const p = await box(panel);
        if (width < 768) {
          expect(await panel.getAttribute("data-presentation")).toBe("sheet");
          expect([p.x, p.width, Math.round(p.y + p.height)]).toEqual([0, 390, 900]);
          // as high as its content (title, box and three lines), never squeezed to a sliver
          expect(p.height).toBeGreaterThan(120);
        } else {
          expect(await panel.getAttribute("data-presentation")).not.toBe("sheet");
          expect(p.width).toBe(280);
        }
        await page.getByRole("checkbox", { name: "Bilder zeigen" }).waitFor();
        await page.keyboard.press("Escape");
        await closed(page, ".k2-pop");
      },
      width < 768 ? { width, touch: true } : { width },
    );
  });

// The popover's sheet stands on the bottom like a dialog's: when its content gets shorter it is lower in the very next
// frame, never a frame higher up (a tap there would hit the backdrop and close it, #4141), also when core's sheet
// module loads after the panel is open.
for (const [touch, slowSheet] of [
  [false, false],
  [true, false],
  [false, true],
] as const)
  test(`popover sheet${touch ? " on a touch screen" : ""}${slowSheet ? " whose module loads late" : ""}: content that gets shorter keeps its bottom`, async () => {
    await withPage(
      async (page) => {
        const trigger = page.getByRole("button", { name: "Vorschau" });
        await (touch ? trigger.tap() : trigger.click());
        const panel = page.locator(".k2-pop");
        if (slowSheet) {
          await panel.waitFor({ state: "attached" });
          // two frames with the panel in the page, then the module comes
          await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
          expect(await page.evaluate(() => typeof window.__k2LoadSheet)).toBe("function");
          await page.evaluate(() => window.__k2LoadSheet?.());
        }
        await panel.waitFor();
        await settled(page);
        expect(await panel.getAttribute("data-presentation")).toBe("sheet");
        const before = await box(panel);
        expect(Math.round(before.y + before.height)).toBe(900);
        // as high as its content: title, box and three lines, never squeezed to a sliver
        expect(before.height).toBeGreaterThan(120);
        const frames = await page.evaluate(async () => {
          const sheet = document.querySelector(".k2-pop") as HTMLElement;
          // the place each frame is drawn at: read after the frame (a task after its animation frame)
          const drawn = () => new Promise((done) => requestAnimationFrame(() => setTimeout(done)));
          document.querySelector<HTMLInputElement>('.k2-pop input[name="images"]')?.click();
          const places: number[] = [];
          for (let index = 0; index < 4; index++) {
            await drawn();
            const { top, bottom } = sheet.getBoundingClientRect();
            places.push(Math.round(top), Math.round(bottom));
          }
          return places;
        });
        await settled(page);
        const after = await box(panel);
        expect(after.height).toBeLessThan(before.height);
        expect(frames).toEqual([after.y, 900, after.y, 900, after.y, 900, after.y, 900].map(Math.round));
      },
      { width: 390, touch, slowSheet },
    );
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
    // one hint: the browser's own (`title`) gives way while the tip is bound, and the tip is not in the head's bar
    expect(await button.getAttribute("title")).toBeNull();
    expect(await tip.evaluate((el) => el.closest(".k2-bar") === null)).toBe(true);
    await page.mouse.move(700, 600);
    await page.waitForFunction(() => !document.querySelector(".k2-tip:not([hidden])"));
  });
});

test("toast: at the bottom in the middle with Undo; Undo runs and closes it", async () => {
  await withPage(async (page) => {
    // an empty region is no open popover: a page that lets an open popover take Escape first still gets it
    await page.waitForFunction(() => document.querySelector('[data-slot="toast-region"][popover]') !== null);
    expect(await page.evaluate(() => document.querySelector(":popover-open"))).toBeNull();
    // and Escape reaches the page untouched (Mail closes its reader with it)
    await page.evaluate(() => {
      window.__escape = "none";
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") window.__escape = event.defaultPrevented ? "taken" : "page";
      });
    });
    await page.locator("body").focus();
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => window.__escape)).toBe("page");
    await page.getByRole("button", { name: "Speichern" }).click();
    const toast = page.locator(".k2-toast");
    await toast.waitFor();
    await settled(page);
    const t = await box(toast);
    expect(Math.abs(t.x + t.width / 2 - 720)).toBeLessThanOrEqual(1);
    expect(Math.round(900 - (t.y + t.height))).toBe(16);
    expect(t.height).toBe(44);
    expect(await toast.locator(".k2-toast-text").textContent()).toBe("Auftrag gespeichert");
    // the page's one region is the Workspace's, also for a toast asked for above the Workspace (no region of its own)
    expect(
      await page.evaluate(() => [...document.querySelectorAll('[data-slot="toast-region"]')].map((el) => el.closest(".k2-ws") !== null)),
    ).toEqual([true]);
    // a landmark while it holds toasts, named in the page's language
    expect(await page.getByRole("region", { name: "Benachrichtigungen" }).count()).toBe(1);
    // an open on-screen keyboard: core writes its height on the region, and the toast stays above it
    await page.locator(".k2-toasts").evaluate((el) => (el as HTMLElement).style.setProperty("--keyboard-inset", "300px"));
    await settled(page);
    expect(Math.round(900 - ((await box(toast)).y + t.height))).toBe(316);
    await page.getByRole("button", { name: "Rückgängig" }).click();
    await closed(page, ".k2-toast");
    expect(await deeds(page)).toEqual(["save", "undo"]);
    await page.waitForFunction(() => document.querySelectorAll(":popover-open").length === 0);
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
      await page.keyboard.press("Escape");
      await closed(page, menu);
      // the tab "Weitere" opens its menu with a tap, on screen
      await page
        .getByRole("navigation", { name: "Ansichten" })
        .getByRole("button", { name: /Weitere/ })
        .tap();
      await page.locator(menu).waitFor();
      await settled(page);
      const views = await box(page.locator(menu));
      expect(views.x).toBeGreaterThanOrEqual(7);
      expect(views.x + views.width).toBeLessThanOrEqual(390 - 7);
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

// A hidden view with an address opens from the menu the way its tab opens it: in place through its onNavigate, no
// new page (Mail at 1024 px: "Wartet auf Antwort" from "Weitere" loaded the whole page).
test("a hidden tab with an address opens in place from the menu of further views", async () => {
  await withPage(
    async (page) => {
      const nav = page.getByRole("navigation", { name: "Ansichten" });
      expect(await nav.locator('.k2-tab[data-overflow]:has-text("Wartet auf Material")').count()).toBe(1);
      await page.evaluate(() => document.documentElement.setAttribute("data-same-page", ""));
      await nav.getByRole("button", { name: /Weitere/ }).click();
      await page.locator(menu).waitFor();
      const entry = page.getByRole("menuitem", { name: /Wartet auf Material/ });
      expect(await entry.getAttribute("href")).toBe("#material");
      await entry.click();
      await closed(page, menu);
      await page.waitForFunction(() => location.hash === "#material");
      expect(await deeds(page)).toEqual(["view:material"]);
      expect(await page.evaluate(() => document.documentElement.hasAttribute("data-same-page"))).toBe(true);
      // the keyboard: Enter on the entry opens it the same way
      await page.evaluate(() => history.replaceState(null, "", "#"));
      await nav.getByRole("button", { name: /Weitere/ }).focus();
      await page.keyboard.press("Enter");
      await page.locator(menu).waitFor();
      await page.getByRole("menuitem", { name: /Wartet auf Material/ }).focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => location.hash === "#material");
      expect(await deeds(page)).toEqual(["view:material", "view:material"]);
      expect(await page.evaluate(() => document.documentElement.hasAttribute("data-same-page"))).toBe(true);
    },
    { width: 390 },
  );
});

// The menu tab's count grows by the tabs that hide, and a count that gains a digit ("+8" to "+12") makes the tab
// wider, so fewer tabs fit. Tabs measure again in the next frame, never inside the observer's own turn: no
// "ResizeObserver loop" error (WebKit reported one at 390 px in Mail), and the hidden ones still lead the menu.
test("tabs at 390 px whose menu count gains a digit measure again without a resize loop", async () => {
  await withPage(
    async (page) => {
      // nine views of its own: "+9", and with a hidden tab "+1n"
      for (let view = 0; view < 7; view++) await page.evaluate(() => window.__moreViews?.());
      const more = page.getByRole("navigation", { name: "Ansichten" }).getByRole("button", { name: /Weitere/ });
      await page.waitForFunction(() => /\+1\d/.test(document.querySelector('nav[aria-label="Ansichten"] [data-menu]')?.textContent ?? ""));
      // wide, nothing hides ("+9"); narrow, the count grows to "+1n" inside the measurement of the new width
      for (const width of [1440, 390, 1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await settled(page);
      }
      const hidden = await page.locator('nav[aria-label="Ansichten"] .k2-tab[data-overflow]').count();
      expect(hidden).toBeGreaterThan(0);
      expect((await more.textContent())?.replace(/\s+/g, "")).toBe(`Weitere+${9 + hidden}`);
    },
    { width: 390 },
  );
});
