import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type axeCore from "axe-core";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";
import type { PeriodValue } from "./period";

declare global {
  interface Window {
    axe?: typeof axeCore;
    periodFixture?: { value: PeriodValue | null; weekStartsOn?: 0 | 1 };
    periodCommits: PeriodValue[];
  }
}

const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const axeSource = readFileSync(Bun.resolveSync("axe-core/axe.min.js", import.meta.dir), "utf8");
const entry = resolve(import.meta.dir, "period-picker.fixture.ts");
// A card header as in an evaluation: the title takes the free space, the picker and a link sit right-aligned.
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { LocaleProvider, PeriodPicker, periodPresets } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const options = window.periodFixture;
const [value, setValue] = createSignal(options.value);
window.periodCommits = [];
render(() => createComponent(LocaleProvider, { locale: "de", get children() {
  return createComponent(PeriodPicker, {
    "aria-label": "Zeitraum",
    get value() { return value(); },
    presets: [periodPresets.today, periodPresets.thisWeek, periodPresets.thisMonth, periodPresets.lastMonth,
      periodPresets.thisYear, periodPresets.all({ since: "2019-03-14" })],
    dateConfig: { timeZone: "Europe/Berlin", weekStartsOn: options.weekStartsOn },
    onValueChange: setValue,
    onValueCommit: (next) => window.periodCommits.push(next),
  });
} }), document.getElementById("picker"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the period picker fixture.");
const script = await build.outputs[0]!.text();

const desktop = { viewport: { width: 1280, height: 860 } };
const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (
  viewport: typeof desktop | typeof phone,
  options: { value: PeriodValue | null; weekStartsOn?: 0 | 1 } = { value: { preset: "this-month" } },
  theme: "light" | "dark" = "light",
): Promise<Page> => {
  const page = await browser.newPage({ ...viewport, timezoneId: "America/New_York", reducedMotion: "reduce" });
  try {
    // 00:30 on Sunday 8 November 2026 in Berlin, still 18:30 on Saturday in the browser's New York: the picker must use Berlin.
    await page.clock.install({ time: new Date("2026-11-07T23:30:00Z") });
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<style>${css}</style></head><body class="k2b-ui" data-theme="${theme}" style="margin:0;background:var(--k2b-surface)">` +
        `<main style="padding:16px"><header id="head" style="display:flex;align-items:center;gap:12px;max-width:760px;margin-left:auto">` +
        `<h3 style="flex:1;min-width:0;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Umsatz nach Kanal</h3>` +
        `<div id="picker"></div><a id="link" href="#">Alle Auswertungen</a></header></main></body></html>`,
    );
    await page.evaluate((options) => {
      window.periodFixture = options;
    }, options);
    await page.addScriptTag({ content: script });
    await page.locator(".k2b-period-picker__trigger").waitFor();
    return page;
  } catch (error) {
    await page.close();
    throw error;
  }
};
const trigger = (page: Page) => page.locator(".k2b-period-picker__trigger");
const popover = (page: Page) => page.locator(".k2b-period-picker__popover:popover-open");
const option = (page: Page, name: string) => page.getByRole("option", { name: new RegExp(`^${name}`) });
const rect = (page: Page, selector: string) =>
  page.locator(selector).evaluate((element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  });
const focused = (page: Page) => page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");

describe("PeriodPicker", () => {
  test("keyboard: opens on the selected preset, moves, picks, and returns focus without moving its neighbours", async () => {
    const page = await load(desktop);
    await settled(page);
    const before = { trigger: await rect(page, ".k2b-period-picker__trigger"), link: await rect(page, "#link") };
    expect(await trigger(page).getAttribute("aria-label")).toBe("Zeitraum: Dieser Monat · 1.–30. Nov.");

    await trigger(page).focus();
    await page.keyboard.press("Enter");
    await popover(page).waitFor();
    expect(await trigger(page).getAttribute("aria-expanded")).toBe("true");
    expect(await focused(page)).toStartWith("Dieser Monat");
    expect(await option(page, "Dieser Monat").getAttribute("aria-selected")).toBe("true");
    // Home, End and the arrows rove through the list; End lands on "Custom range".
    await page.keyboard.press("End");
    expect(await focused(page)).toStartWith("Frei wählen");
    await page.keyboard.press("Home");
    expect(await focused(page)).toStartWith("Heute");
    await page.keyboard.press("ArrowUp");
    expect(await focused(page)).toStartWith("Frei wählen");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    expect(await focused(page)).toStartWith("Dieses Jahr");
    await page.keyboard.press("Enter");

    expect(await popover(page).count()).toBe(0);
    expect(await page.evaluate(() => window.periodCommits)).toEqual([{ preset: "this-year" }]);
    expect(await page.evaluate(() => document.activeElement?.classList.contains("k2b-period-picker__trigger"))).toBe(true);
    await settled(page);
    expect(await trigger(page).textContent()).toContain("Dieses Jahr · 2026");
    // The trigger reserved its widest text, so neither it nor the link beside it moved.
    expect(await rect(page, ".k2b-period-picker__trigger")).toEqual(before.trigger);
    expect(await rect(page, "#link")).toEqual(before.link);
    await page.close();
  });

  test("Escape closes without a change and returns focus", async () => {
    const page = await load(desktop);
    await trigger(page).click();
    await popover(page).waitFor();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    expect(await popover(page).count()).toBe(0);
    expect(await page.evaluate(() => window.periodCommits)).toEqual([]);
    expect(await page.evaluate(() => document.activeElement?.classList.contains("k2b-period-picker__trigger"))).toBe(true);
    await page.close();
  });

  test("presets resolve in the configured time zone and week start, not the browser's", async () => {
    // Berlin is already Sunday 8 November; New York is still Saturday.
    const page = await load(desktop, { value: { preset: "today" } });
    expect(await trigger(page).textContent()).toContain("Heute · So., 8. Nov.");
    await trigger(page).click();
    expect(await option(page, "Diese Woche").textContent()).toContain("2.–8. Nov.");
    await page.close();
    const sunday = await load(desktop, { value: { preset: "this-week" }, weekStartsOn: 0 });
    expect(await trigger(sunday).textContent()).toContain("Diese Woche · 8.–14. Nov.");
    await sunday.close();
  });

  test("custom range: two months in the same popover, picked by clicks, applied once, inside the viewport", async () => {
    const page = await load(desktop);
    await trigger(page).click();
    await option(page, "Frei wählen").click();
    const editor = popover(page).locator(".k2b-period-picker__editor");
    await editor.waitFor();
    // The list stays beside the editor; the selection does not change before Apply.
    expect(await option(page, "Dieser Monat").count()).toBe(1);
    expect(await page.evaluate(() => window.periodCommits)).toEqual([]);
    expect(await editor.locator(".k2b-date-calendar").count()).toBe(2);
    // Starts from the selected preset's days; the second month shows its end.
    expect(await editor.getByLabel("Von").inputValue()).toBe("01.11.2026");
    expect(await editor.getByLabel("Bis").inputValue()).toBe("30.11.2026");
    expect(await editor.locator('[data-date-day="2026-11-01"]:not([data-hidden])').count()).toBe(1);
    await settled(page);
    const box = await rect(page, ".k2b-period-picker__popover");
    expect(box.x).toBeGreaterThanOrEqual(8);
    expect(box.x + box.width).toBeLessThanOrEqual(1280 - 8);

    await editor.locator('[data-date-day="2026-10-26"]:not([data-hidden])').click();
    // One click is a one-day range already; the second click extends it.
    expect(await editor.locator(".k2b-date-duration").textContent()).toContain("1 Tag");
    await editor.locator('[data-date-day="2026-11-04"]:not([data-hidden])').click();
    expect(await editor.locator(".k2b-date-duration").textContent()).toContain("10 Tage");
    await editor.getByRole("button", { name: "Übernehmen" }).click();

    expect(await popover(page).count()).toBe(0);
    expect(await page.evaluate(() => window.periodCommits)).toEqual([{ start: "2026-10-26", end: "2026-11-04" }]);
    expect(await trigger(page).textContent()).toContain("26.10. – 04.11.2026 · 10 Tage");
    // Reopening a custom range opens on the editor with its days.
    await trigger(page).click();
    expect(await popover(page).locator(".k2b-period-picker__editor").count()).toBe(1);
    expect(await option(page, "Frei wählen").getAttribute("aria-selected")).toBe("true");
    await page.close();
  });

  test("custom range: arrow keys cross into the second month without paging", async () => {
    const page = await load(desktop, { value: { start: "2026-10-30", end: "2026-10-31" } });
    await trigger(page).click();
    const editor = popover(page).locator(".k2b-period-picker__editor");
    await editor.waitFor();
    const titles = () => editor.locator(".k2b-date-calendar__title").allTextContents();
    const opened = await titles();
    expect(opened).toEqual(["September 2026", "Oktober 2026"]);
    await editor.locator('[data-date-day="2026-09-30"]:not([data-hidden])').focus();
    await page.keyboard.press("ArrowRight");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-date-day"))).toBe("2026-10-01");
    expect(await titles()).toEqual(opened);
    // Leaving the second month pages by one month at a time.
    await page.keyboard.press("PageDown");
    await page.keyboard.press("PageDown");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-date-day"))).toBe("2026-12-01");
    expect(await titles()).toEqual(["November 2026", "Dezember 2026"]);
    await page.close();
  });

  test("custom range: months stay whole at month ends, and the editor follows the window width", async () => {
    // A range ending on 31 March opens on February and March, not March and April.
    const page = await load(desktop, { value: { start: "2027-03-01", end: "2027-03-31" } });
    await trigger(page).click();
    const editor = popover(page).locator(".k2b-period-picker__editor");
    await editor.waitFor();
    const titles = () => editor.locator(".k2b-date-calendar__title").allTextContents();
    expect(await titles()).toEqual(["Februar 2027", "März 2027"]);
    // Stepping on from a month end never skips a month.
    const next = editor.getByRole("button", { name: /Nächster Monat|Next month/ });
    await next.click();
    expect(await titles()).toEqual(["März 2027", "April 2027"]);
    await next.click();
    expect(await titles()).toEqual(["April 2027", "Mai 2027"]);
    // Narrow the window: the second month goes; widen it again: it comes back.
    await page.setViewportSize({ width: 700, height: 860 });
    await settled(page);
    expect(await editor.locator(".k2b-date-calendar").count()).toBe(1);
    await page.setViewportSize(desktop.viewport);
    await settled(page);
    expect(await editor.locator(".k2b-date-calendar").count()).toBe(2);
    await page.close();
  });

  test("typed days: errors stay in the popover, with the field named, and a fixed text applies", async () => {
    const page = await load(desktop);
    await trigger(page).click();
    await option(page, "Frei wählen").click();
    const editor = popover(page).locator(".k2b-period-picker__editor");
    const from = editor.getByLabel("Von");
    await settled(page);
    const months = await rect(page, ".k2b-period-picker__months");
    await from.fill("31.11.2026");
    await from.press("Tab");
    await settled(page);
    expect(await from.getAttribute("aria-invalid")).toBe("true");
    const message = await from.getAttribute("aria-describedby");
    expect(await page.locator(`#${message}`).textContent()).toContain("30 Tage");
    expect(await editor.getByRole("button", { name: "Übernehmen" }).isDisabled()).toBe(true);
    // The error line has its place reserved: the calendar does not move.
    expect(await rect(page, ".k2b-period-picker__months")).toEqual(months);

    await from.fill("02.11.2026");
    await editor.getByLabel("Bis").fill("06.11.2026");
    await editor.getByLabel("Bis").press("Enter");
    expect(await page.evaluate(() => window.periodCommits)).toEqual([{ start: "2026-11-02", end: "2026-11-06" }]);
    await page.close();
  });

  test("phone: a bottom sheet with the list, and the calendar behind Custom range with a way back", async () => {
    const page = await load(phone);
    await trigger(page).click();
    const sheet = page.locator(".k2b-date-sheet");
    await sheet.waitFor();
    // The sheet has its own id, and the trigger points at what is shown.
    expect(await trigger(page).getAttribute("aria-controls")).toBe(await sheet.getAttribute("id"));
    await sheet.getByRole("option", { name: /^Frei wählen/ }).focus();
    await page.keyboard.press("Enter");
    expect(await sheet.locator(".k2b-date-calendar").count()).toBe(1);
    // The focused option went away with the list; focus continues on the calendar's day.
    await settled(page);
    expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-date-day"))).toBe(true);
    expect(await sheet.getByRole("listbox").count()).toBe(0);
    await sheet.getByRole("button", { name: "Zurück zu den Vorgaben" }).click();
    await sheet.getByRole("option", { name: /^Letzter Monat/ }).click();
    // The sheet commits once its close has finished, which WebKit reports after the sheet left the page.
    await page.waitForFunction(() => window.periodCommits.length > 0);
    expect(await sheet.count()).toBe(0);
    expect(await page.evaluate(() => window.periodCommits)).toEqual([{ preset: "last-month" }]);
    expect(await trigger(page).textContent()).toContain("Letzter Monat · 1.–31. Okt.");
    await page.close();
  });

  for (const theme of ["light", "dark"] as const) {
    test(`passes axe with the list and the calendar open (${theme})`, async () => {
      const page = await load(desktop, { value: { preset: "this-month" } }, theme);
      await page.addScriptTag({ content: axeSource });
      await trigger(page).click();
      await option(page, "Frei wählen").click();
      await popover(page).locator(".k2b-period-picker__editor").waitFor();
      const violations = await page.evaluate(async () => {
        const result = await window.axe!.run(document.body, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
          resultTypes: ["violations"],
        });
        return result.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`);
      });
      expect(violations).toEqual([]);
      await page.close();
    });
  }
});
