import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";
import type { PeriodValue } from "./period";

declare global {
  interface Window {
    stepFixture?: { value: PeriodValue | null; min?: string; max?: string };
    stepCommits: PeriodValue[];
  }
}

// Where the arrows, the trigger and the way back sit, and that nothing moves while stepping, need a real engine.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "period-picker-steps.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { LocaleProvider, PeriodPicker, periodPresets } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const options = window.stepFixture;
const [value, setValue] = createSignal(options.value);
window.stepCommits = [];
render(() => createComponent(LocaleProvider, { locale: "de", get children() {
  return createComponent(PeriodPicker, {
    "aria-label": "Zeitraum",
    steps: true,
    min: options.min,
    max: options.max,
    get value() { return value(); },
    presets: [periodPresets.thisWeek, periodPresets.lastWeek, periodPresets.thisMonth, periodPresets.lastMonth,
      periodPresets.all({ since: "2019-03-14" })],
    dateConfig: { timeZone: "Europe/Berlin", weekStartsOn: 1 },
    onValueChange: setValue,
    onValueCommit: (next) => window.stepCommits.push(next),
  });
} }), document.getElementById("picker"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the stepping period fixture.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (width: number, options: NonNullable<Window["stepFixture"]>): Promise<Page> => {
  const tab = await browser.newPage({ viewport: { width, height: 700 }, timezoneId: "Europe/Berlin", reducedMotion: "reduce" });
  // Saturday, 7 November 2026, 12:00 in Berlin.
  await tab.clock.install({ time: new Date("2026-11-07T11:00:00Z") });
  await tab.setContent(
    `<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
      `<body class="k2b-ui" style="margin:0"><main style="padding:16px"><div id="picker"></div></main></body></html>`,
  );
  await tab.evaluate((value) => {
    window.stepFixture = value;
  }, options);
  await tab.addScriptTag({ content: script });
  await tab.locator(".k2b-period-picker__trigger").waitFor();
  await settled(tab);
  return tab;
};
const previous = (page: Page) => page.locator(".k2b-period-picker__step").first();
const next = (page: Page) => page.locator(".k2b-period-picker__step").last();
const home = (page: Page) => page.locator(".k2b-period-picker__home");
const shown = (page: Page) => page.locator(".k2b-period-picker__value > span:not([aria-hidden])").innerText();
const boxes = (page: Page) =>
  page.evaluate(() =>
    [".k2b-period-picker__trigger", ".k2b-period-picker__home-slot"].map((selector) => {
      const { x, width } = document.querySelector(selector)!.getBoundingClientRect();
      return { x: Math.round(x), width: Math.round(width) };
    }),
  );
const commits = (page: Page) => page.evaluate(() => window.stepCommits);

describe("PeriodPicker steps", () => {
  test("a week steps to its neighbours, lands on presets where they match, and the way back never moves the row", async () => {
    const page = await load(1280, { value: { preset: "this-week" } });
    try {
      const before = await boxes(page);
      // The current period needs no way back; its place is kept.
      expect(await home(page).isVisible()).toBe(false);
      expect(await previous(page).getAttribute("aria-label")).toBe("Vorheriger Zeitraum");
      await previous(page).click();
      expect(await commits(page)).toEqual([{ preset: "last-week" }]);
      expect(await home(page).innerText()).toBe("Diese Woche");
      expect(await home(page).isVisible()).toBe(true);
      await previous(page).click();
      expect((await commits(page)).at(-1)).toEqual({ start: "2026-10-19", end: "2026-10-25" });
      // A calendar week reads as one.
      expect(await shown(page)).toBe("19.–25. Okt. 2026");
      expect(await boxes(page)).toEqual(before);
      await home(page).click();
      expect((await commits(page)).at(-1)).toEqual({ preset: "this-week" });
      expect(await home(page).isVisible()).toBe(false);
      await next(page).click();
      expect((await commits(page)).at(-1)).toEqual({ start: "2026-11-09", end: "2026-11-15" });
      expect(await boxes(page)).toEqual(before);
    } finally {
      await page.close();
    }
  });

  test("a month steps by whole months and reads as the month", async () => {
    const page = await load(1280, { value: { preset: "this-month" } });
    try {
      await previous(page).click();
      expect((await commits(page)).at(-1)).toEqual({ preset: "last-month" });
      await previous(page).click();
      expect((await commits(page)).at(-1)).toEqual({ start: "2026-09-01", end: "2026-09-30" });
      expect(await shown(page)).toBe("September 2026");
      expect(await home(page).innerText()).toBe("Dieser Monat");
    } finally {
      await page.close();
    }
  });

  test("a free range moves by its own length; All time does not step", async () => {
    const page = await load(1280, { value: { start: "2026-10-28", end: "2026-11-06" } });
    try {
      // Ten days that end before today: the way back leads to the ten days that hold today.
      expect(await home(page).innerText()).toBe("Aktueller Zeitraum");
      await next(page).click();
      expect((await commits(page)).at(-1)).toEqual({ start: "2026-11-07", end: "2026-11-16" });
      expect(await home(page).isVisible()).toBe(false);
    } finally {
      await page.close();
    }
    const all = await load(1280, { value: { preset: "all" } });
    try {
      expect(await previous(all).isDisabled()).toBe(true);
      expect(await next(all).isDisabled()).toBe(true);
      expect(await home(all).isVisible()).toBe(false);
    } finally {
      await all.close();
    }
  });

  test("at min and max the arrow stays focusable, says why, and does not step", async () => {
    const page = await load(1280, { value: { preset: "this-month" }, min: "2026-10-15", max: "2026-11-30" });
    try {
      expect(await next(page).getAttribute("aria-disabled")).toBe("true");
      expect(await next(page).getAttribute("aria-label")).toBe("Nächster Zeitraum: nichts nach dem 30.11.2026");
      // Not natively disabled: it keeps focus, and Enter on it does nothing.
      expect(await next(page).evaluate((button) => (button as HTMLButtonElement).disabled)).toBe(false);
      await next(page).focus();
      await page.keyboard.press("Enter");
      expect(await commits(page)).toEqual([]);
      // October still holds days after min, so it is reachable; September is not.
      expect(await previous(page).getAttribute("aria-disabled")).toBeNull();
      await previous(page).click();
      expect(await previous(page).getAttribute("aria-disabled")).toBe("true");
      expect(await previous(page).getAttribute("aria-label")).toBe("Vorheriger Zeitraum: nichts vor dem 15.10.2026");
      await previous(page).focus();
      expect(await page.evaluate(() => document.activeElement?.classList.contains("k2b-period-picker__step"))).toBe(true);
    } finally {
      await page.close();
    }
  });

  test("on a phone the row fits: arrows, trigger and the way back", async () => {
    const page = await load(390, { value: { preset: "last-week" } });
    try {
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      const right = await page.evaluate(() =>
        Math.round(document.querySelector(".k2b-period-picker__home-slot")!.getBoundingClientRect().right),
      );
      expect(right).toBeLessThanOrEqual(390 - 16);
      expect(await home(page).isVisible()).toBe(true);
    } finally {
      await page.close();
    }
  });
});
