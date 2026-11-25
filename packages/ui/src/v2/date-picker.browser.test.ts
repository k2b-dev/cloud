import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-dates.demo";
import type {} from "../../test/v2-filter.demo";

// DatePicker, DateInput and the period of FilterBar in a real engine with v2.css: the grid keys and roles of core's
// calendar in German (the week from Monday, German month names), typing and picking a date, and a filter's own period
// as "Von …" and "Bis …" whose calendars open beside the editor like submenus (on the phone as the sheet's next step).
// The clock stands on 25 November 2026, so no test depends on the day it runs.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";
const origin = "http://dates.test";
const now = new Date("2026-11-25T10:00:00Z");

let browser: Browser;
let dates: string;
let filter: string;
beforeAll(async () => {
  [dates, filter, browser] = await Promise.all([demoBundle("../v2-dates"), demoBundle("../v2-filter"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

/** Pins only `Date` in the page (timers and frames stay real): the clock flows on from `at`. */
const pinDate = (at: number) => {
  const RealDate = Date;
  const offset = at - RealDate.now(); // real clock: the page's distance to the pinned instant
  class PinnedDate extends RealDate {
    constructor(...args: ConstructorParameters<DateConstructor> | []) {
      if (args.length === 0)
        super(RealDate.now() + offset); // real clock: flows from the pinned instant
      else super(...(args as ConstructorParameters<DateConstructor>));
    }
    static override now() {
      return RealDate.now() + offset; // real clock: flows from the pinned instant
    }
  }
  globalThis.Date = PinnedDate as DateConstructor;
};

const withPage = async (
  bundle: () => string,
  path: string,
  run: (page: Page) => Promise<void>,
  { width = 1440, height = 900, touch = false, timezoneId }: { width?: number; height?: number; touch?: boolean; timezoneId?: string } = {},
) => {
  const page = await browser.newPage({ viewport: { width, height }, hasTouch: touch, isMobile: touch, timezoneId });
  page.setDefaultTimeout(2000);
  await page.addInitScript(pinDate, now.getTime());
  const errors = pageErrors(page);
  await page.route(`${origin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
    }),
  );
  try {
    await page.goto(`${origin}${path}`);
    await page.addScriptTag({ content: bundle() });
    await page.waitForFunction(() => window.__mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

const box = async (page: Page, selector: string) => {
  const found = await page.locator(selector).first().boundingBox();
  if (!found) throw new Error(`no box for ${selector}`);
  return found;
};
const focusedDay = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute("data-value") ?? null);
const param = (page: Page, name: string) => new URL(page.url()).searchParams.get(name);

/** Waits until the element keeps its place for two frames and stands inside the window, such as a sliding sheet. */
const steady = async (page: Page, selector: string) => {
  await page.evaluate((s) => document.querySelector(s)?.removeAttribute("data-test-top"), selector);
  await page.waitForFunction(
    (s) => {
      const element = document.querySelector(s);
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const last = Number(element.getAttribute("data-test-top") ?? "NaN");
      element.setAttribute("data-test-top", String(rect.top));
      return rect.top === last && rect.bottom <= innerHeight + 1;
    },
    selector,
    { polling: 100, timeout: 5000 },
  );
};

// ── DatePicker ─────────────────────────────────────────────────────────────────────────────────────────────────

test("a picker speaks German: month names, the week from Monday, a grid of six weeks that never changes its height", async () => {
  await withPage(
    () => dates,
    "/dates",
    async (page) => {
      const day = page.getByTestId("day");
      expect(await day.locator(".k2-cal-t").textContent()).toBe("November 2026");
      expect(await day.locator(".k2-cal-wd").allTextContents()).toEqual(["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]);
      // screen readers hear a grid named after its month, with rows, column heads and cells
      const grid = day.getByRole("grid", { name: "November 2026" });
      expect(await grid.getByRole("row").count()).toBe(7);
      expect(await grid.getByRole("gridcell").count()).toBe(42);
      expect(await grid.getByRole("columnheader").first().getAttribute("aria-label")).toBe("Montag");
      const chosen = day.locator('[data-value="2026-11-24"]');
      expect(await chosen.getAttribute("aria-selected")).toBe("true");
      expect(await chosen.getAttribute("aria-label")).toContain("24. November 2026");
      // today is the frozen 25 November
      expect(await day.locator('[aria-current="date"]').getAttribute("data-value")).toBe("2026-11-25");
      expect(await day.getByRole("button", { name: "Vorheriger Monat" }).count()).toBe(1);
      // February 2026 starts on a Sunday and has fewer weeks; the picker keeps six, so nothing below it moves
      const before = await box(page, '[data-testid="day"] .k2-dpick');
      for (let step = 0; step < 9; step += 1) await day.getByRole("button", { name: "Vorheriger Monat" }).click();
      expect(await day.locator(".k2-cal-t").textContent()).toBe("Februar 2026");
      expect(await day.locator(".k2-cal-row:not([data-head])").count()).toBe(6);
      await settled(page);
      expect(await box(page, '[data-testid="day"] .k2-dpick')).toEqual(before);
    },
  );
});

test("the keys of a grid: arrows by day and week, PageUp and PageDown by month, Home and End to the week's ends, Enter picks", async () => {
  await withPage(
    () => dates,
    "/dates",
    async (page) => {
      const day = page.getByTestId("day");
      // the chosen day holds the one tab stop of the grid
      expect(await day.locator('[tabindex="0"]').getAttribute("data-value")).toBe("2026-11-24");
      await day.locator('[data-value="2026-11-24"]').focus();
      await page.keyboard.press("ArrowRight");
      expect(await focusedDay(page)).toBe("2026-11-25");
      await page.keyboard.press("ArrowDown");
      expect(await focusedDay(page)).toBe("2026-12-02");
      expect(await day.locator(".k2-cal-t").textContent()).toBe("Dezember 2026");
      await page.keyboard.press("PageUp");
      expect(await focusedDay(page)).toBe("2026-11-02");
      await page.keyboard.press("End");
      expect(await focusedDay(page)).toBe("2026-11-08");
      await page.keyboard.press("Home");
      expect(await focusedDay(page)).toBe("2026-11-02");
      await page.keyboard.press("PageDown");
      expect(await focusedDay(page)).toBe("2026-12-02");
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("Enter");
      expect(await page.getByTestId("day-value").textContent()).toBe("2026-12-01");
      expect(await day.locator('[data-value="2026-12-01"]').getAttribute("aria-selected")).toBe("true");
    },
  );
});

test("with a time a pressed day is only chosen until “Übernehmen”; days before `min` cannot be picked; “Leeren” takes it out", async () => {
  await withPage(
    () => dates,
    "/dates",
    async (page) => {
      const moment = page.getByTestId("moment");
      expect(await moment.locator('[data-value="2026-11-02"]').getAttribute("aria-disabled")).toBe("true");
      await moment.locator('[data-value="2026-11-26"]').click();
      expect(await page.getByTestId("moment-value").textContent()).toBe("2026-11-24T09:00");
      expect(await moment.locator('[data-value="2026-11-26"]').getAttribute("aria-selected")).toBe("true");
      const time = moment.getByRole("textbox", { name: "Uhrzeit" });
      expect(await time.inputValue()).toBe("09:00");
      await time.fill("");
      await time.pressSequentially("1430");
      expect(await time.inputValue()).toBe("14:30");
      await moment.getByRole("button", { name: "Übernehmen" }).click();
      expect(await page.getByTestId("moment-value").textContent()).toBe("2026-11-26T14:30");
      // Enter in the time applies too
      await time.fill("9:05");
      await time.press("Enter");
      expect(await page.getByTestId("moment-value").textContent()).toBe("2026-11-26T09:05");
      await moment.getByRole("button", { name: "Leeren" }).click();
      expect(await page.getByTestId("moment-value").textContent()).toBe("");
    },
  );
});

// ── DateInput ──────────────────────────────────────────────────────────────────────────────────────────────────

test("DateInput: a typed date applies on Enter, text that is no date marks the field, and the form sends the date key", async () => {
  await withPage(
    () => dates,
    "/dates",
    async (page) => {
      const input = page.getByRole("textbox", { name: "Lieferdatum" });
      expect(await input.inputValue()).toBe("15.12.2026");
      await input.fill("3.1.2027");
      await input.press("Enter");
      expect(await page.getByTestId("date").textContent()).toBe("2027-01-03");
      expect(await input.inputValue()).toBe("03.01.2027");
      expect(await page.locator('input[name="delivery"]').inputValue()).toBe("2027-01-03");
      await input.fill("kein Datum");
      await input.press("Enter");
      expect(await input.getAttribute("aria-invalid")).toBe("true");
      expect(await page.locator('[data-k2-part="DateInput"]').getAttribute("data-invalid")).toBe("");
      expect(await page.getByTestId("date").textContent()).toBe("2027-01-03");
      // the next readable date clears the mark
      await input.fill("heute");
      await input.press("Enter");
      expect(await page.getByTestId("date").textContent()).toBe("2026-11-25");
      expect(await input.getAttribute("aria-invalid")).toBeNull();
    },
  );
});

test("DateInput: the calendar opens below the field without moving it, on the chosen day, and gives the pick back", async () => {
  await withPage(
    () => dates,
    "/dates",
    async (page) => {
      const field = await box(page, '[data-k2-part="DateInput"]');
      await page.getByRole("button", { name: "Kalender öffnen" }).click();
      const popup = page.locator(".k2-dpop");
      await popup.waitFor();
      await page.waitForFunction(() => document.activeElement?.getAttribute("data-value") === "2026-12-15");
      expect(await box(page, '[data-k2-part="DateInput"]')).toEqual(field);
      const panel = await box(page, ".k2-dpop");
      expect(panel.y).toBeGreaterThanOrEqual(field.y + field.height);
      expect(await popup.locator(".k2-cal-t").textContent()).toBe("Dezember 2026");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Enter");
      await popup.waitFor({ state: "detached" });
      expect(await page.getByTestId("date").textContent()).toBe("2026-12-16");
      expect(await page.getByRole("textbox", { name: "Lieferdatum" }).inputValue()).toBe("16.12.2026");
      expect(await page.evaluate(() => document.activeElement?.getAttribute("type"))).toBe("text");
      // Escape closes it and the focus returns to its button
      await page.getByRole("button", { name: "Kalender öffnen" }).click();
      await popup.waitFor();
      await page.keyboard.press("Escape");
      await popup.waitFor({ state: "detached" });
      expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Kalender öffnen");
      expect(await page.getByTestId("date").textContent()).toBe("2026-12-16");
    },
  );
});

// ── FilterBar: a period of one's own ───────────────────────────────────────────────────────────────────────────

const editPeriod = async (page: Page, field: "Eingang" | "Gesehen") => {
  await page.getByRole("button", { name: new RegExp(`^Filter ${field} .* bearbeiten$`) }).click();
  await page.locator(".k2-fpop .k2-fed-bounds").waitFor();
};
const bounds = (page: Page) => page.locator(".k2-fpop .k2-fed-bounds .k2-mi");

test("a period's own range: “Von …” and “Bis …” open their calendar beside the editor, and a day applies through the address", async () => {
  await withPage(
    () => filter,
    "/artikel?received=last-7d",
    async (page) => {
      await editPeriod(page, "Eingang");
      expect(await bounds(page).allTextContents()).toEqual(["Von…", "Bis…"]);
      const editor = await box(page, ".k2-fpop");
      const from = await box(page, ".k2-fpop .k2-fed-bounds .k2-mi");
      await bounds(page).first().click();
      const cascade = page.locator(".k2-dpop");
      await cascade.waitFor();
      // like a submenu: to the right of the editor, level with its entry; the editor does not move
      const side = await box(page, ".k2-dpop");
      // its edge on the editor's hairline, as a submenu stands on its menu's
      expect(side.x).toBeGreaterThanOrEqual(editor.x + editor.width - 1);
      expect(Math.abs(side.y - from.y)).toBeLessThanOrEqual(8);
      expect(await box(page, ".k2-fpop")).toEqual(editor);
      expect(await bounds(page).first().getAttribute("data-open")).toBe("");
      await cascade.locator('[data-value="2026-11-03"]').click();
      await cascade.waitFor({ state: "detached" });
      expect(param(page, "received")).toBe("2026-11-03..");
      expect(await page.locator(".k2-fbar-flow .k2-stmt-b").first().textContent()).toBe("Eingang ab 03.11.2026");
      // the editor stays open, the focus is back on its entry, which shows the day
      expect(await page.locator(".k2-fpop").count()).toBe(1);
      expect(await bounds(page).allTextContents()).toEqual(["Von03.11.2026", "Bis…"]);
      await page.waitForFunction(() => document.activeElement?.textContent?.startsWith("Von") === true);
      // the keys of a submenu: ArrowRight opens "Bis", the focus lands on a day, Enter picks it
      await page.keyboard.press("ArrowDown");
      await bounds(page).nth(1).focus();
      await page.keyboard.press("ArrowRight");
      await cascade.waitFor();
      await page.waitForFunction(() => document.activeElement?.getAttribute("data-value") === "2026-11-25");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Enter");
      await cascade.waitFor({ state: "detached" });
      expect(param(page, "received")).toBe("2026-11-03..2026-11-26");
      // Escape closes the calendar only; the editor stays
      await bounds(page).nth(1).click();
      await cascade.waitFor();
      await page.keyboard.press("Escape");
      await cascade.waitFor({ state: "detached" });
      expect(await page.locator(".k2-fpop").count()).toBe(1);
    },
  );
});

test("a day that does not fit says so at its calendar, which stays open, and the address keeps the period", async () => {
  await withPage(
    () => filter,
    "/artikel?received=2026-11-03..2026-11-20",
    async (page) => {
      await editPeriod(page, "Eingang");
      await bounds(page).first().click();
      const cascade = page.locator(".k2-dpop");
      await cascade.waitFor();
      await cascade.locator('[data-value="2026-11-27"]').click();
      await cascade.getByRole("alert").waitFor();
      expect(await cascade.getByRole("alert").textContent()).toBe("„Von“ ist größer als „Bis“. Der Filter gilt so nicht.");
      expect(param(page, "received")).toBe("2026-11-03..2026-11-20");
      expect(await cascade.count()).toBe(1);
      // "Leeren" opens the start of the period
      await cascade.getByRole("button", { name: "Leeren" }).click();
      await cascade.waitFor({ state: "detached" });
      expect(param(page, "received")).toBe("..2026-11-20");
    },
  );
});

test("where there is no room to the right, the calendar opens to the left of the editor", async () => {
  await withPage(
    () => filter,
    "/artikel?received=last-7d",
    async (page) => {
      // the statement stands near the right edge, so its editor reaches it
      await page.evaluate(() => {
        const flow = document.querySelector<HTMLElement>(".k2-fbar-flow");
        if (flow) flow.style.paddingLeft = "560px";
      });
      await editPeriod(page, "Eingang");
      const editor = await box(page, ".k2-fpop");
      expect(editor.x + editor.width + 260).toBeGreaterThan(1024);
      await bounds(page).first().click();
      await page.locator(".k2-dpop").waitFor();
      const side = await box(page, ".k2-dpop");
      expect(side.x + side.width).toBeLessThanOrEqual(editor.x + 1);
      expect(side.x).toBeGreaterThanOrEqual(0);
    },
    { width: 1024 },
  );
});

test("on the phone a bound's calendar is the sheet's next step, with a way back to its period", async () => {
  await withPage(
    () => filter,
    "/artikel?received=last-7d",
    async (page) => {
      await page.locator(".k2-fbar-item:first-child .k2-stmt-b").tap();
      await page.getByRole("dialog", { name: "Eingang" }).waitFor();
      await steady(page, '[role="dialog"]');
      await page.locator(".k2-fsheet .k2-fed-bounds .k2-mi").first().tap();
      const step = page.getByRole("dialog", { name: "Eingang · Von" });
      await step.waitFor();
      expect(await page.locator(".k2-dpop").count()).toBe(0);
      const cell = await box(page, '.k2-fsheet-pick [data-value="2026-11-10"]');
      expect(Math.round(cell.width)).toBe(44);
      // back leads to the period, not to the list of filters
      await page.getByRole("button", { name: "Zurück", exact: true }).tap();
      await page.getByRole("dialog", { name: "Eingang" }).waitFor();
      await page.locator(".k2-fsheet .k2-fed-bounds .k2-mi").first().tap();
      await step.waitFor();
      await page.locator('.k2-fsheet-pick [data-value="2026-11-10"]').tap();
      await page.getByRole("dialog", { name: "Eingang" }).waitFor();
      expect(param(page, "received")).toBe("2026-11-10..");
      expect(await page.locator(".k2-fsheet .k2-fed-bounds .k2-mi").first().textContent()).toBe("Von10.11.2026");
    },
    { width: 390, height: 844, touch: true },
  );
});
