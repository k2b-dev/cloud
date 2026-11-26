import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Locator, Page } from "playwright";
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
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; overflow: auto; } .ti { display: inline-block; width: 1em; height: 1em; }";
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
  {
    width = 1440,
    height = 900,
    touch = false,
    timezoneId,
    lang = "de",
    at = now,
  }: { width?: number; height?: number; touch?: boolean; timezoneId?: string; lang?: string; at?: Date } = {},
) => {
  const page = await browser.newPage({ viewport: { width, height }, hasTouch: touch, isMobile: touch, timezoneId });
  page.setDefaultTimeout(2000);
  await page.addInitScript(pinDate, at.getTime());
  const errors = pageErrors(page);
  await page.route(`${origin}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
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
      // core's time input: hour and minute as spinbuttons on the German 24-hour clock, never the browser's time field
      const time = moment.getByRole("group", { name: "Uhrzeit" });
      const hour = time.getByRole("spinbutton", { name: "Stunde" });
      const minute = time.getByRole("spinbutton", { name: "Minute" });
      expect(await moment.locator('input[type="time"]').count()).toBe(0);
      expect(await time.locator('[data-type="dayPeriod"]').count()).toBe(0);
      expect([await hour.inputValue(), await minute.inputValue()]).toEqual(["09", "00"]);
      // typed digits fill the hour, then the minute
      await hour.focus();
      await page.keyboard.type("1430");
      expect([await hour.inputValue(), await minute.inputValue()]).toEqual(["14", "30"]);
      // the arrows step the segment that has the focus
      await hour.press("ArrowUp");
      await minute.press("ArrowDown");
      expect([await hour.inputValue(), await minute.inputValue()]).toEqual(["15", "29"]);
      await moment.getByRole("button", { name: "Übernehmen" }).click();
      expect(await page.getByTestId("moment-value").textContent()).toBe("2026-11-26T15:29");
      // Enter in a segment applies too
      await minute.focus();
      await page.keyboard.type("05");
      await minute.press("Enter");
      expect(await page.getByTestId("moment-value").textContent()).toBe("2026-11-26T15:05");
      // an emptied segment is no time: "Übernehmen" is off and Enter gives nothing
      await minute.press("Backspace");
      await minute.press("Backspace");
      expect(await minute.inputValue()).toBe("");
      expect(await moment.getByRole("button", { name: "Übernehmen" }).isDisabled()).toBe(true);
      await hour.press("Enter");
      expect(await page.getByTestId("moment-value").textContent()).toBe("2026-11-26T15:05");
      await moment.getByRole("button", { name: "Leeren" }).click();
      expect(await page.getByTestId("moment-value").textContent()).toBe("");
    },
  );
});

test("the time follows the @k2b/ui locale: American English has twelve hours and AM/PM", async () => {
  await withPage(
    () => dates,
    "/dates",
    async (page) => {
      const time = page.getByTestId("moment").getByRole("group", { name: "Time" });
      const value = (type: string) => time.locator(`[data-type="${type}"]`).inputValue();
      expect([await value("hour"), await value("minute"), await value("dayPeriod")]).toEqual(["09", "00", "AM"]);
      await time.locator(`[data-type="hour"]`).focus();
      await page.keyboard.type("0230p");
      expect([await value("hour"), await value("minute"), await value("dayPeriod")]).toEqual(["02", "30", "PM"]);
      await page.getByTestId("moment").getByRole("button", { name: "Apply" }).click();
      expect(await page.getByTestId("moment-value").textContent()).toBe("2026-11-24T14:30");
    },
    { lang: "en-US" },
  );
});

// ── Delta review of #4224 (4005781): each test failed before its fix ───────────────────────────────────────────

/** Pastes text into an element as the clipboard would. */
const paste = (target: Locator, text: string) =>
  target.evaluate((element, pasted) => {
    const data = new DataTransfer();
    data.setData("text/plain", pasted);
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);

test("Enter takes what was just typed into a segment, and never sends the form around the picker", async () => {
  await withPage(
    () => dates,
    "/dates",
    async (page) => {
      const picker = page.getByTestId("switch");
      const minute = picker.getByRole("spinbutton", { name: "Minute" });
      await minute.focus();
      await page.keyboard.type("1");
      await page.keyboard.press("Enter");
      expect(await page.getByTestId("switch-value").textContent()).toBe("2026-11-24T09:01");
      await settled(page);
      expect(await page.evaluate(() => window.__dates ?? [])).toEqual([]);
    },
  );
});

test("a change between a 24-hour and a 12-hour locale shows the same time, also one just edited", async () => {
  await withPage(
    () => dates,
    "/dates",
    async (page) => {
      const picker = page.getByTestId("switch");
      const value = (type: string) => picker.locator(`.k2-time [data-type="${type}"]`).inputValue();
      const language = page.getByRole("button", { name: "Sprache wechseln" });
      // German: 14:32, then American English: 2:32 PM
      await picker.locator('.k2-time [data-type="hour"]').focus();
      await page.keyboard.type("1432");
      await language.click();
      await picker.locator('.k2-time [data-type="dayPeriod"]').waitFor();
      expect([await value("hour"), await value("minute"), await value("dayPeriod")]).toEqual(["02", "32", "PM"]);
      // edited in American English, back to German: the afternoon stays the afternoon
      await picker.locator('.k2-time [data-type="minute"]').focus();
      await page.keyboard.type("45");
      await language.click();
      await picker.locator('.k2-time [data-type="dayPeriod"]').waitFor({ state: "detached" });
      expect([await value("hour"), await value("minute")]).toEqual(["14", "45"]);
      await picker.getByRole("button", { name: "Übernehmen" }).click();
      expect(await page.getByTestId("switch-value").textContent()).toBe("2026-11-24T14:45");
    },
  );
});

test("a pasted time is read in the forms people write it; one that is no time says so and applies nothing", async () => {
  await withPage(
    () => dates,
    "/dates",
    async (page) => {
      const moment = page.getByTestId("moment");
      const hour = moment.getByRole("spinbutton", { name: "Stunde" });
      const minute = moment.getByRole("spinbutton", { name: "Minute" });
      for (const [pasted, shown] of [
        ["1430", ["14", "30"]],
        ["9:30", ["09", "30"]],
        ["17.05", ["17", "05"]],
      ] as const) {
        await paste(hour, pasted);
        expect([await hour.inputValue(), await minute.inputValue()]).toEqual([...shown]);
      }
      await paste(hour, "abends");
      await moment.getByRole("alert").waitFor();
      expect(await moment.getByRole("alert").textContent()).toBe("Keine Uhrzeit. Schreib sie wie 14:30.");
      expect(await moment.locator(".k2-time").getAttribute("data-invalid")).toBe("");
      expect([await hour.inputValue(), await minute.inputValue()]).toEqual(["17", "05"]);
      // the next time clears the mark
      await paste(minute, "18:10");
      expect(await moment.getByRole("alert").count()).toBe(0);
      await moment.getByRole("button", { name: "Übernehmen" }).click();
      expect(await page.getByTestId("moment-value").textContent()).toBe("2026-11-24T18:10");
    },
  );
  await withPage(
    () => dates,
    "/dates",
    async (page) => {
      const time = page.getByTestId("moment").locator(".k2-time");
      await paste(time.locator('[data-type="hour"]'), "02:30 PM");
      const value = (type: string) => time.locator(`[data-type="${type}"]`).inputValue();
      expect([await value("hour"), await value("minute"), await value("dayPeriod")]).toEqual(["02", "30", "PM"]);
    },
    { lang: "en-US" },
  );
});

test("an empty segment says so in the locale's words", async () => {
  await withPage(
    () => dates,
    "/dates",
    async (page) => {
      const minute = page.getByTestId("moment").getByRole("spinbutton", { name: "Minute" });
      await minute.press("Backspace");
      await minute.press("Backspace");
      expect(await minute.inputValue()).toBe("");
      expect(await minute.getAttribute("aria-valuetext")).toBe("leer");
    },
  );
});
// ── Delta review of #4224 (5510c42): each test failed before its fix ───────────────────────────────────────────

/** Fails at once instead of waiting forever when the page no longer answers (a loop in its main thread). */
const answers = (page: Page) =>
  Promise.race([
    page.evaluate(() => true),
    new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), 1500);
    }),
  ]);

test("an empty segment in English stays “Empty”, and the page goes on answering", async () => {
  await withPage(
    () => dates,
    "/dates",
    async (page) => {
      const minute = page.getByTestId("moment").locator('.k2-time [data-type="minute"]');
      await minute.focus();
      await page.keyboard.press("Backspace");
      await page.keyboard.press("Backspace");
      expect(await answers(page)).toBe(true);
      expect(await minute.getAttribute("aria-valuetext")).toBe("Empty");
    },
    { lang: "en-US" },
  );
});

test("a 24-hour English locale names its own example and reads a pasted day period", async () => {
  await withPage(
    () => dates,
    "/dates",
    async (page) => {
      const moment = page.getByTestId("moment");
      const time = moment.locator(".k2-time");
      await paste(time.locator('[data-type="hour"]'), "abends");
      expect(await moment.getByRole("alert").textContent()).toBe("Not a time. Write it like 14:30.");
      await paste(time.locator('[data-type="hour"]'), "2:30 PM");
      expect(await time.locator('[data-type="dayPeriod"]').count()).toBe(0);
      expect([await time.locator('[data-type="hour"]').inputValue(), await time.locator('[data-type="minute"]').inputValue()]).toEqual([
        "14",
        "30",
      ]);
    },
    { lang: "en-GB" },
  );
});

test("the mark of an unreadable paste goes with the next time, also the same time, and with typing", async () => {
  await withPage(
    () => dates,
    "/dates",
    async (page) => {
      const moment = page.getByTestId("moment");
      const hour = moment.getByRole("spinbutton", { name: "Stunde" });
      // an empty clipboard changes nothing and says nothing
      await paste(hour, "");
      expect(await moment.getByRole("alert").count()).toBe(0);
      await paste(hour, "abends");
      await moment.getByRole("alert").waitFor();
      // the time it already holds
      await paste(hour, "09:00");
      expect(await moment.getByRole("alert").count()).toBe(0);
      expect(await moment.locator(".k2-time").getAttribute("data-invalid")).toBeNull();
      await paste(hour, "abends");
      await moment.getByRole("alert").waitFor();
      await hour.focus();
      await page.keyboard.type("09");
      expect(await moment.getByRole("alert").count()).toBe(0);
    },
  );
});

test("Enter with Ctrl, Cmd or Alt applies nothing, as core takes nothing then", async () => {
  await withPage(
    () => dates,
    "/dates",
    async (page) => {
      // a new day is chosen, so a pick would show: with a modifier Enter gives nothing
      const picker = page.getByTestId("switch");
      await picker.locator('[data-value="2026-11-26"]').click();
      // a day is no submit button of the form around the picker
      await settled(page);
      expect(await page.evaluate(() => window.__dates ?? [])).toEqual([]);
      const minute = picker.getByRole("spinbutton", { name: "Minute" });
      await minute.focus();
      for (const chord of ["Control+Enter", "Meta+Enter", "Alt+Enter"]) await page.keyboard.press(chord);
      expect(await page.getByTestId("switch-value").textContent()).toBe("2026-11-24T09:00");
      // nor does it send the form around the picker with the time it held before
      await settled(page);
      expect(await page.evaluate(() => window.__dates ?? [])).toEqual([]);
    },
  );
});

test("Shift+Enter is Enter: it takes what was typed, inside a form too, and sends nothing", async () => {
  await withPage(
    () => dates,
    "/dates",
    async (page) => {
      const minute = page.getByTestId("switch").getByRole("spinbutton", { name: "Minute" });
      await minute.focus();
      await page.keyboard.type("1");
      await page.keyboard.press("Shift+Enter");
      expect(await page.getByTestId("switch-value").textContent()).toBe("2026-11-24T09:01");
      await settled(page);
      expect(await page.evaluate(() => window.__dates ?? [])).toEqual([]);
    },
  );
});

// ── view="weeks": six weeks ahead ───────────────────────────────────────────────────────────────────────────────

const axeSource = readFileSync(Bun.resolveSync("axe-core/axe.min.js", import.meta.dir), "utf8");

/** The days the six weeks of a demo section show, in order, with the row and column they stand in. */
const shownDays = (page: Page, testId = "weeks") =>
  page.getByTestId(testId).evaluate((section) => {
    const cells = [...section.querySelectorAll<HTMLElement>("[data-weeks] [data-value]")];
    const tops = [...new Set(cells.map((cell) => Math.round(cell.getBoundingClientRect().top)))].sort((a, b) => a - b);
    const lefts = [...new Set(cells.map((cell) => Math.round(cell.getBoundingClientRect().left)))].sort((a, b) => a - b);
    return cells.map((cell) => ({
      date: cell.dataset.value ?? "",
      row: tops.indexOf(Math.round(cell.getBoundingClientRect().top)),
      column: lefts.indexOf(Math.round(cell.getBoundingClientRect().left)),
      text: cell.textContent ?? "",
    }));
  });
/** The first day a demo section's six weeks show, by the order of the days (no geometry). */
const firstShown = (page: Page, testId = "weeks") =>
  page.getByTestId(testId).locator("[data-weeks] [data-value]").first().getAttribute("data-value");

for (const width of [1440, 390])
  test(`${width} px: late in a month the weeks start with this week and go on into the next months, one row per week`, async () => {
    await withPage(
      () => dates,
      "/dates",
      async (page) => {
        const weeks = page.getByTestId("weeks");
        const days = await shownDays(page);
        // Wednesday 25 November 2026: the week from Monday 23 November, six weeks to Sunday 3 January
        expect(days.length).toBe(42);
        expect(days[0]?.date).toBe("2026-11-23");
        expect(days.at(-1)?.date).toBe("2027-01-03");
        expect(new Set(days.map((day) => day.row)).size).toBe(6);
        expect(new Set(days.map((day) => day.column)).size).toBe(7);
        // a week over the end of a month is one row: Monday 30 November and Tuesday 1 December side by side
        const monday = days.find((day) => day.date === "2026-11-30");
        const first = days.find((day) => day.date === "2026-12-01");
        expect(first?.row).toBe(monday?.row);
        expect(first?.column).toBe(1);
        // where a month starts, its name stands; screen readers hear the whole date
        expect(first?.text).toBe("Dez");
        expect(days.find((day) => day.date === "2027-01-01")?.text).toBe("Jan");
        // a month's first day is named with the short month it shows ("Dez"), so its visible text is in its name
        expect(await weeks.locator('[data-value="2026-12-01"]').getAttribute("aria-label")).toBe("Dienstag, 1. Dez. 2026");
        expect(await weeks.locator('[data-value="2026-12-02"]').getAttribute("aria-label")).toBe("Mittwoch, 2. Dezember 2026");
        expect(await weeks.locator(".k2-cal-t").textContent()).toBe("November 2026 – Januar 2027");
        expect(await weeks.locator('[data-value="2026-11-24"]').getAttribute("aria-disabled")).toBe("true");
        // ONE grid for screen readers: a row of seven column heads and six rows of seven days
        const grid = weeks.getByRole("grid");
        expect(await grid.count()).toBe(1);
        expect(await grid.getByRole("row").count()).toBe(7);
        expect(await grid.getByRole("columnheader").count()).toBe(7);
        expect(await grid.getByRole("columnheader").first().getAttribute("aria-label")).toBe("Montag");
        expect(await grid.getByRole("gridcell").count()).toBe(42);
        // the picker fits the window
        const picker = await box(page, '[data-testid="weeks"] .k2-dpick');
        expect(picker.x + picker.width).toBeLessThanOrEqual(width);
      },
      { width },
    );
  });

test("the six weeks pass axe", async () => {
  await withPage(
    () => dates,
    "/dates",
    async (page) => {
      await page.addScriptTag({ content: axeSource });
      const violations = await page.evaluate(async () => {
        const axe = (
          window as unknown as { axe: { run: (context: unknown, options: unknown) => Promise<{ violations: { id: string }[] }> } }
        ).axe;
        const result = await axe.run(
          { include: [['[data-testid="weeks"]'], ['[data-testid="weeks-max"]']] },
          { resultTypes: ["violations"] },
        );
        return result.violations.map((violation) => violation.id);
      });
      expect(violations).toEqual([]);
    },
  );
});

for (const lang of ["en-US", "de-u-fw-sun"])
  test(`${lang}: the week starts on Sunday in the heads and in the days alike`, async () => {
    await withPage(
      () => dates,
      "/dates",
      async (page) => {
        const grid = page.getByTestId("weeks").getByRole("grid");
        expect(await grid.getByRole("columnheader").first().getAttribute("aria-label")).toBe(lang === "en-US" ? "Sunday" : "Sonntag");
        expect(await firstShown(page)).toBe("2026-11-22");
        // Home goes to the start of the week the heads show
        await page.getByTestId("weeks").locator('[data-value="2026-12-02"]').focus();
        await page.keyboard.press("Home");
        expect(await focusedDay(page)).toBe("2026-11-29");
      },
      { lang },
    );
  });

test("the keys move the six weeks by whole weeks, never their height; the buttons by six weeks, not before `min`", async () => {
  await withPage(
    () => dates,
    "/dates",
    async (page) => {
      const weeks = page.getByTestId("weeks");
      const height = (await box(page, '[data-testid="weeks"] [data-weeks]')).height;
      await weeks.locator('[data-value="2026-11-25"]').focus();
      // a month ahead is still in the six weeks: nothing moves
      await page.keyboard.press("PageDown");
      expect(await focusedDay(page)).toBe("2026-12-25");
      expect(await firstShown(page)).toBe("2026-11-23");
      // another month ahead lies behind them: they move until its week is the last
      await page.keyboard.press("PageDown");
      expect(await focusedDay(page)).toBe("2027-01-25");
      expect(await firstShown(page)).toBe("2026-12-21");
      await page.keyboard.press("ArrowDown");
      expect(await focusedDay(page)).toBe("2027-02-01");
      expect(await firstShown(page)).toBe("2026-12-28");
      // back up: the first week follows the focus; never before `min`
      await page.keyboard.press("PageUp");
      await page.keyboard.press("PageUp");
      expect(await focusedDay(page)).toBe("2026-12-01");
      expect(await firstShown(page)).toBe("2026-11-30");
      await page.keyboard.press("PageUp");
      expect(await focusedDay(page)).toBe("2026-11-25");
      expect(await firstShown(page)).toBe("2026-11-23");
      await settled(page);
      expect((await box(page, '[data-testid="weeks"] [data-weeks]')).height).toBe(height);
      // Enter picks the focused day
      await page.keyboard.press("Enter");
      expect(await page.getByTestId("weeks-value").textContent()).toBe("2026-11-25");
      // the buttons: six weeks on, and back, never before the week of `min`; a blocked button keeps the focus
      const back = weeks.getByRole("button", { name: "Sechs Wochen zurück" });
      expect(await back.getAttribute("aria-disabled")).toBe("true");
      await weeks.getByRole("button", { name: "Sechs Wochen weiter" }).click();
      expect(await firstShown(page)).toBe("2027-01-04");
      await back.click();
      expect(await firstShown(page)).toBe("2026-11-23");
      expect(await back.getAttribute("aria-disabled")).toBe("true");
      // a blocked button is still a button: pressed, it changes nothing and keeps the focus
      await back.focus();
      await page.keyboard.press("Enter");
      expect(await firstShown(page)).toBe("2026-11-23");
      expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Sechs Wochen zurück");
    },
  );
});

test("`max` ends the weeks: the next six are blocked and the keys stop at its day", async () => {
  await withPage(
    () => dates,
    "/dates",
    async (page) => {
      const weeks = page.getByTestId("weeks-max");
      const next = weeks.getByRole("button", { name: "Sechs Wochen weiter" });
      expect(await next.getAttribute("aria-disabled")).toBe("true");
      await next.focus();
      await page.keyboard.press("Enter");
      expect(await firstShown(page, "weeks-max")).toBe("2026-11-23");
      expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Sechs Wochen weiter");
      await weeks.locator('[data-value="2026-12-25"]').focus();
      await page.keyboard.press("PageDown");
      expect(await focusedDay(page)).toBe("2026-12-31");
      expect(await weeks.locator('[data-value="2027-01-01"]').getAttribute("aria-disabled")).toBe("true");
    },
  );
});

test("the weeks follow a value set from elsewhere and a change of the locale, with six rows always", async () => {
  await withPage(
    () => dates,
    "/dates",
    async (page) => {
      await page.getByRole("button", { name: "Auf 1. März setzen" }).click();
      expect(await page.getByTestId("weeks").locator('[data-value="2027-03-01"]').getAttribute("aria-selected")).toBe("true");
      await page.getByRole("button", { name: "Wochensprache umstellen" }).click();
      await settled(page);
      const days = await shownDays(page, "weeks-switch");
      expect(days[0]?.date).toBe("2026-11-22");
      expect(days.length).toBe(42);
      expect(new Set(days.map((day) => day.row)).size).toBe(6);
      expect(await page.getByTestId("weeks-switch").getByRole("columnheader").first().getAttribute("aria-label")).toBe("Sunday");
    },
  );
});

test("without `min` the weeks start with today in the picker's zone, never the zone of the browser or the server", async () => {
  // Sunday 29 November, 12:00 UTC: already Monday 30 November in Kiritimati (UTC+14), still Sunday in New York
  await withPage(
    () => dates,
    "/dates",
    async (page) => {
      expect(await firstShown(page, "weeks-zone")).toBe("2026-11-30");
      expect(await firstShown(page, "weeks-utc")).toBe("2026-11-23");
    },
    { timezoneId: "America/New_York", at: new Date("2026-11-29T12:00:00Z") },
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
      // the form is not valid while the field holds no date, so it never sends the old one
      const valid = () => page.evaluate(() => document.querySelector("form")?.checkValidity());
      expect(await valid()).toBe(false);
      expect(await input.evaluate((element: HTMLInputElement) => element.validationMessage)).toBe(
        "Kein Datum. Schreib es wie im Kalender, etwa 24.11.2026.",
      );
      // the next readable date clears the mark
      await input.fill("heute");
      await input.press("Enter");
      expect(await page.getByTestId("date").textContent()).toBe("2026-11-25");
      expect(await input.getAttribute("aria-invalid")).toBeNull();
      expect(await valid()).toBe(true);
    },
  );
});

test("DateInput: a date key must name a real day; 29 February only in a leap year", async () => {
  await withPage(
    () => dates,
    "/dates",
    async (page) => {
      const input = page.getByRole("textbox", { name: "Lieferdatum" });
      for (const typed of ["2026-02-30", "2027-02-29", "2026-13-01", "29.02.2027"]) {
        await input.fill(typed);
        await input.press("Enter");
        expect(await input.getAttribute("aria-invalid")).toBe("true");
        expect(await input.inputValue()).toBe(typed);
        expect(await page.getByTestId("date").textContent()).toBe("2026-12-15");
      }
      await input.fill("2028-02-29");
      await input.press("Enter");
      expect(await page.getByTestId("date").textContent()).toBe("2028-02-29");
      expect(await input.inputValue()).toBe("29.02.2028");
      expect(await input.getAttribute("aria-invalid")).toBeNull();
    },
  );
});

test("a day outside `min` and `max` is never picked, also when it is the value already", async () => {
  await withPage(
    () => dates,
    "/dates",
    async (page) => {
      // with a time: the day before `min` stays shown, but "Übernehmen" and Enter in the time give nothing
      const moment = page.getByTestId("locked-moment");
      expect(await moment.locator('[data-value="2026-11-02"]').getAttribute("aria-selected")).toBe("true");
      expect(await moment.getByRole("button", { name: "Übernehmen" }).isDisabled()).toBe(true);
      await moment.getByRole("spinbutton", { name: "Minute" }).press("Enter");
      // without a time: a press on the locked chosen day gives nothing either
      const day = page.getByTestId("locked-day");
      await day.locator('[data-value="2026-11-02"]').click({ force: true });
      await day.locator('[data-value="2026-11-02"]').dispatchEvent("keydown", { key: "Enter" });
      await settled(page);
      expect(await page.evaluate(() => window.__dates ?? [])).toEqual([]);
      // a day inside the bounds is picked as usual
      await day.locator('[data-value="2026-11-04"]').click();
      expect(await page.evaluate(() => window.__dates ?? [])).toEqual(["2026-11-04"]);
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
      // Each step changes the sheet's height, and the sheet follows its new height a frame late (under load several
      // frames): it stands at its old top with its lower part below the window (#4141). A tap in that moment finds the
      // day outside the window and does not land (CI: "element is outside of the viewport"), so each tap waits until
      // the sheet stands.
      await page.locator(".k2-fsheet .k2-fed-bounds .k2-mi").first().tap();
      const step = page.getByRole("dialog", { name: "Eingang · Von" });
      await step.waitFor();
      await steady(page, '[role="dialog"]');
      expect(await page.locator(".k2-dpop").count()).toBe(0);
      const cell = await box(page, '.k2-fsheet-pick [data-value="2026-11-10"]');
      expect(Math.round(cell.width)).toBe(44);
      // back leads to the period, not to the list of filters
      await page.getByRole("button", { name: "Zurück", exact: true }).tap();
      await page.getByRole("dialog", { name: "Eingang" }).waitFor();
      await steady(page, '[role="dialog"]');
      await page.locator(".k2-fsheet .k2-fed-bounds .k2-mi").first().tap();
      await step.waitFor();
      await steady(page, '[role="dialog"]');
      await page.locator('.k2-fsheet-pick [data-value="2026-11-10"]').tap();
      await page.getByRole("dialog", { name: "Eingang" }).waitFor();
      expect(param(page, "received")).toBe("2026-11-10..");
      expect(await page.locator(".k2-fsheet .k2-fed-bounds .k2-mi").first().textContent()).toBe("Von10.11.2026");
    },
    { width: 390, height: 844, touch: true },
  );
});
