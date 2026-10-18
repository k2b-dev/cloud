import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DateContext } from "@k2b/stdlib";
import type { Browser, Locator, Page } from "playwright";
import { launchBrowser } from "../../test/browser";
import type { DateRangeValue } from "./date-picker";

type FixtureOptions = {
  kind?: "date" | "range" | "calendar";
  dateConfig?: DateContext;
  range?: DateRangeValue;
  view?: "month" | "mobile-month" | "week" | "day";
  dayHours?: readonly [number, number];
};

declare global {
  interface Window {
    weekendFixtureOptions?: FixtureOptions;
    weekendCommits: DateRangeValue[];
  }
}

const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "date-picker-weekend.fixture.ts");
// One component per page keeps the phone fixture usable without scrolling past other pickers.
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { Calendar, DatePicker, DateRangePicker } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const options = window.weekendFixtureOptions;
const dateConfig = { timeZone: "UTC", locale: "de-DE", ...options.dateConfig };
const [range, setRange] = createSignal(options.range ?? { start: "2026-10-05", end: "2026-10-06" });
window.weekendCommits = [];
render(() => options.kind === "calendar"
  ? createComponent(Calendar, {
      date: "2026-10-18", view: options.view ?? "month", events: [], dateConfig,
      dayHours: options.dayHours,
      range: options.dayHours ? { from: "2026-10-12", to: "2026-10-19" } : undefined,
    })
  : options.kind === "date"
    ? createComponent(DatePicker, { label: "Date", value: "2026-10-05", dateConfig })
    : createComponent(DateRangePicker, {
        label: "Range", get value() { return range(); }, dateConfig,
        onValueChange: setRange,
        onValueCommit: (value) => window.weekendCommits.push(value),
      }), document.getElementById("app"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the weekend fixture.");
const script = await build.outputs[0]!.text();
const viewports = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
};
type Viewport = (typeof viewports)[keyof typeof viewports];
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (viewport: Viewport, theme: "light" | "dark", options: FixtureOptions = {}): Promise<Page> => {
  const page = await browser.newPage({ ...viewport, timezoneId: "UTC", reducedMotion: "reduce" });
  try {
    await page.clock.install({ time: new Date("2026-10-18T10:00:00Z") });
    await page.setContent(
      `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<style>${css}</style></head><body class="k2b-ui" data-theme="${theme}" style="margin:0">` +
        `<main id="app" style="${options.kind === "calendar" ? "display:flex;height:720px" : "padding:16px;max-width:320px"}"></main></body></html>`,
    );
    await page.evaluate((options) => {
      window.weekendFixtureOptions = options;
    }, options);
    await page.addScriptTag({ content: script });
    await page.locator(options.kind === "calendar" ? ".k2b-content-calendar" : ".k2b-date-trigger").waitFor();
    return page;
  } catch (error) {
    await page.close();
    throw error;
  }
};
const open = async (page: Page) => {
  await page.locator(".k2b-date-trigger").click();
  const panel = page.locator(".k2b-date-popover:popover-open");
  await panel.waitFor();
  return panel;
};
const day = (panel: Locator, key: string) => panel.locator(`[data-date-day="${key}"]`);
const boxes = (panel: Locator) =>
  panel.locator("[data-date-day]").evaluateAll((days) =>
    days.map((day) => {
      const { x, y, width, height } = day.getBoundingClientRect();
      return [x, y, width, height];
    }),
  );
const box = async (element: Locator) => {
  const result = await element.boundingBox();
  if (!result) throw new Error(`No bounding box for ${element}`);
  return result;
};
const near = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1);

/** Resolve tokens through an actual CSS property, so rgb/oklch/color-mix serialization cannot affect equality. */
const backgroundMatches = (element: Locator, token: string) =>
  element.evaluate((element, token) => {
    const probe = document.createElement("span");
    probe.style.backgroundColor = `var(${token})`;
    element.append(probe);
    const actual = getComputedStyle(element).backgroundColor;
    const expected = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return actual === expected;
  }, token);

/**
 * The band is a sibling, so ancestor backgrounds alone miss the painted surface.
 * Paint outer backgrounds first, then the band's color, then inner backgrounds.
 * Outline contrast is against the band beneath the ring, before the button fill.
 */
const contrast = (target: Locator) =>
  target.evaluate((element) => {
    const canvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (!canvas) throw new Error("No canvas to resolve CSS colors.");
    const rgba = (color: string): number[] => {
      canvas.clearRect(0, 0, 1, 1);
      canvas.fillStyle = color;
      canvas.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 0] = canvas.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const over = (top: number[], bottom: number[]): number[] => {
      const alpha = top[3] ?? 0;
      return [0, 1, 2].map((index) => (top[index] ?? 0) * alpha + (bottom[index] ?? 0) * (1 - alpha));
    };
    const luminance = (rgb: number[]): number =>
      rgb.reduce((sum, channel, index) => {
        const value = channel / 255;
        return sum + (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) * ([0.2126, 0.7152, 0.0722][index] ?? 0);
      }, 0);
    const ratio = (top: number[], bottom: number[]) => {
      const a = luminance(over(top, bottom));
      const b = luminance(bottom);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    const grid = element.closest(".k2b-date-grid, .k2b-date-weekdays");
    if (!grid) throw new Error("No date grid around the contrast target.");
    const targetRect = element.getBoundingClientRect();
    const band = [...grid.querySelectorAll(":scope > .k2b-date-weekend")].find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      const center = targetRect.x + targetRect.width / 2;
      return center >= rect.left && center <= rect.right;
    });
    if (!band || element.getAttribute("data-weekend") !== "true") throw new Error("The contrast target must lie on a weekend band.");
    const ancestors: Element[] = [];
    for (let current: Element | null = grid; current; current = current.parentElement) ancestors.unshift(current);
    let surface = [255, 255, 255];
    for (const ancestor of ancestors) surface = over(rgba(getComputedStyle(ancestor).backgroundColor), surface);
    const bandSurface = over(rgba(getComputedStyle(band).backgroundColor), surface);
    const inner: Element[] = [];
    for (let current: Element | null = element; current && current !== grid; current = current.parentElement) inner.unshift(current);
    surface = bandSurface;
    for (const layer of inner) surface = over(rgba(getComputedStyle(layer).backgroundColor), surface);
    const style = getComputedStyle(element);
    return {
      text: ratio(rgba(style.color), surface),
      outline: ratio(rgba(style.outlineColor), bandSurface),
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
      focusVisible: element.matches(":focus-visible"),
    };
  });

describe("locale weekend bands", () => {
  for (const theme of ["light", "dark"] as const) {
    for (const [name, viewport] of Object.entries(viewports)) {
      test(`paints a continuous Sa/So band without moving day boxes (${theme}, ${name})`, async () => {
        const page = await load(viewport, theme, { kind: "date" });
        try {
          const panel = await open(page);
          expect(await panel.locator(".k2b-date-weekdays > .k2b-date-weekend").count()).toBe(1);
          expect(await panel.locator(".k2b-date-grid > .k2b-date-weekend").count()).toBe(1);
          const weekdayBand = panel.locator(".k2b-date-weekdays > .k2b-date-weekend");
          const gridBand = panel.locator(".k2b-date-grid > .k2b-date-weekend");
          const [head, band, row, grid, saturday, sunday] = await Promise.all([
            box(weekdayBand),
            box(gridBand),
            box(panel.locator(".k2b-date-weekdays")),
            box(panel.locator(".k2b-date-grid")),
            box(day(panel, "2026-10-03")),
            box(day(panel, "2026-10-04")),
          ]);
          near(head.x, saturday.x);
          near(head.width, sunday.x + sunday.width - saturday.x);
          near(band.x, head.x);
          near(band.width, head.width);
          near(head.y, row.y);
          near(head.y + head.height, band.y);
          near(band.y + band.height, grid.y + grid.height);
          const lastDay = await box(panel.locator("[data-date-day]").last());
          near(band.y + band.height, lastDay.y + lastDay.height);
          expect(await gridBand.evaluate((band) => getComputedStyle(band).gridColumn)).toBe("6 / span 2");
          expect(await backgroundMatches(weekdayBand, "--k2b-surface-muted")).toBe(true);
          expect(await backgroundMatches(gridBand, "--k2b-surface-muted")).toBe(true);
          expect(await panel.locator('.k2b-date-weekdays > span[data-weekend="true"]').allTextContents()).toEqual(["Sa", "So"]);

          const painted = await boxes(panel);
          const hidden = await page.addStyleTag({ content: ".k2b-date-weekend{display:none!important}" });
          expect(await boxes(panel)).toEqual(painted);
          await hidden.evaluate((style) => style.parentNode?.removeChild(style));
          expect(await boxes(panel)).toEqual(painted);
          await day(panel, "2026-10-24").hover();
          expect(await boxes(panel)).toEqual(painted);
          await page.keyboard.press("Shift");
          await day(panel, "2026-10-24").focus();
          expect(await boxes(panel)).toEqual(painted);
        } finally {
          await page.close();
        }
      });

      test(`keeps weekend text and keyboard focus legible (${theme}, ${name})`, async () => {
        const page = await load(viewport, theme, { range: { start: "2026-10-24", end: "2026-10-26" } });
        try {
          const panel = await open(page);
          // Move away from the trigger and days before reading the normal state.
          await page.mouse.move(0, 0);
          const cases = [
            ["2026-10-10", null, null], // Normal Saturday.
            ["2026-11-01", "data-outside", "true"],
            ["2026-10-18", "aria-current", "date"], // Sunday today.
            ["2026-10-24", "aria-selected", "true"],
            ["2026-10-25", "data-in-range", "true"],
          ] as const;
          for (const [key, attribute, value] of cases) {
            const target = day(panel, key);
            if (attribute) expect(await target.getAttribute(attribute)).toBe(value);
            expect((await contrast(target)).text).toBeGreaterThanOrEqual(4.5);
          }
          for (const weekday of await panel.locator('.k2b-date-weekdays > [data-weekend="true"]').all()) {
            expect((await contrast(weekday)).text).toBeGreaterThanOrEqual(4.5);
          }
          const target = day(panel, "2026-10-10");
          await target.hover();
          expect(await target.evaluate((element) => element.matches(":hover"))).toBe(true);
          expect((await contrast(target)).text).toBeGreaterThanOrEqual(4.5);
          await page.mouse.move(0, 0);
          await page.keyboard.press("Shift");
          await target.focus();
          // A real arrow key moves the roving focus onto Sunday.
          await page.keyboard.press("ArrowRight");
          const focused = day(panel, "2026-10-11");
          const ring = await contrast(focused);
          expect(ring.focusVisible).toBe(true);
          expect(ring.outlineStyle).not.toBe("none");
          expect(ring.outlineWidth).toBeGreaterThan(0);
          expect(ring.outline).toBeGreaterThanOrEqual(3);
        } finally {
          await page.close();
        }
      });

      for (const [dateConfig, columns, expectedDays] of [
        [{ locale: "he-IL" }, ["5 / span 2"], [5, 6]],
        [{ locale: "en-US", firstDayOfWeek: 0 }, ["1 / span 1", "7 / span 1"], [0, 6]],
      ] as const) {
        test(`marks the locale weekend and keeps the configured week start (${dateConfig.locale}, ${theme}, ${name})`, async () => {
          const page = await load(viewport, theme, { kind: "date", dateConfig });
          try {
            const panel = await open(page);
            for (const grid of [".k2b-date-weekdays", ".k2b-date-grid"]) {
              expect(
                await panel
                  .locator(`${grid} > .k2b-date-weekend`)
                  .evaluateAll((bands) => bands.map((band) => getComputedStyle(band).gridColumn)),
              ).toEqual([...columns]);
            }
            const cells = await panel.locator("[data-date-day]").evaluateAll((days) =>
              days.map((day) => ({
                key: day.getAttribute("data-date-day")!,
                weekend: day.getAttribute("data-weekend") === "true",
              })),
            );
            for (const cell of cells) {
              expect(cell.weekend).toBe(expectedDays.some((day) => day === new Date(`${cell.key}T12:00:00Z`).getUTCDay()));
            }
            const headerColumns = await panel
              .locator(".k2b-date-weekdays > span:not(.k2b-date-weekend)")
              .evaluateAll((days) => days.flatMap((day, index) => (day.getAttribute("data-weekend") === "true" ? [index] : [])));
            expect(headerColumns).toEqual(dateConfig.locale === "he-IL" ? [4, 5] : [0, 6]);
          } finally {
            await page.close();
          }
        });
      }
    }
  }
});

const commits = (page: Page) => page.evaluate(() => window.weekendCommits);
const selected = (panel: Locator) =>
  panel.locator('[data-date-day][aria-selected="true"]').evaluateAll((days) => days.map((day) => day.getAttribute("data-date-day")));
const waitForSelection = (page: Page, keys: string[]) =>
  page.waitForFunction((keys) => {
    const selected = [...document.querySelectorAll('.k2b-date-popover:popover-open [data-date-day][aria-selected="true"]')].map((day) =>
      day.getAttribute("data-date-day"),
    );
    return JSON.stringify(selected) === JSON.stringify(keys);
  }, keys);

// launchBrowser selects Chromium or WebKit through TEST_BROWSER; the same input assertions run in both.
describe("complete one-day ranges", () => {
  for (const theme of ["light", "dark"] as const) {
    for (const [name, viewport] of Object.entries(viewports)) {
      for (const [locale, duration] of [
        ["en", "1 day"],
        ["de-DE", "1 Tag"],
      ] as const) {
        test(`commits one day and preserves mouse and keyboard extensions (${locale}, ${theme}, ${name})`, async () => {
          const page = await load(viewport, theme, { dateConfig: { locale } });
          try {
            let panel = await open(page);
            const apply = () => panel.locator(".k2b-date-apply");
            await day(panel, "2026-10-24").click();
            await waitForSelection(page, ["2026-10-24"]);
            expect(await selected(panel)).toEqual(["2026-10-24"]);
            expect(await apply().isEnabled()).toBe(true);
            expect((await panel.locator(".k2b-date-duration").innerText()).trim()).toBe(duration);
            expect(await commits(page)).toEqual([]);
            // Selecting the anchor again leaves the same complete single day.
            await day(panel, "2026-10-24").click();
            expect(await selected(panel)).toEqual(["2026-10-24"]);
            await day(panel, "2026-10-27").hover();
            await page.waitForFunction(
              () =>
                document.querySelector('.k2b-date-popover:popover-open [data-date-day="2026-10-25"]')?.getAttribute("data-in-range") ===
                "true",
            );
            expect(await day(panel, "2026-10-26").getAttribute("data-in-range")).toBe("true");
            await page.mouse.move(0, 0);
            await waitForSelection(page, ["2026-10-24"]);
            expect(await panel.locator('[data-in-range="true"]').count()).toBe(0);
            await apply().click();
            expect(await commits(page)).toEqual([{ start: "2026-10-24", end: "2026-10-24" }]);

            panel = await open(page);
            // Reopening clears the anchor: another day starts a fresh single-day range.
            await page.keyboard.press("Shift");
            await day(panel, "2026-10-22").focus();
            await page.keyboard.press("Enter");
            await waitForSelection(page, ["2026-10-22"]);
            expect(await apply().isEnabled()).toBe(true);
            expect((await panel.locator(".k2b-date-duration").innerText()).trim()).toBe(duration);
            await apply().click();
            expect((await commits(page)).at(-1)).toEqual({ start: "2026-10-22", end: "2026-10-22" });

            panel = await open(page);
            await day(panel, "2026-10-22").focus();
            await page.keyboard.press("Enter");
            await day(panel, "2026-10-25").focus();
            await page.keyboard.press("Space");
            await waitForSelection(page, ["2026-10-22", "2026-10-25"]);
            expect(await day(panel, "2026-10-24").getAttribute("data-in-range")).toBe("true");
            await apply().click();
            const extended = { start: "2026-10-22", end: "2026-10-25" };
            expect((await commits(page)).at(-1)).toEqual(extended);
            // The familiar two-click flow gives exactly the same value, including reversed clicks.
            for (const keys of [
              ["2026-10-22", "2026-10-25"],
              ["2026-10-25", "2026-10-22"],
            ]) {
              panel = await open(page);
              for (const key of keys) await day(panel, key).click();
              await apply().click();
              expect((await commits(page)).at(-1)).toEqual(extended);
            }
            // After extending, a third click begins a new single day.
            panel = await open(page);
            for (const key of ["2026-10-22", "2026-10-25", "2026-10-28"]) await day(panel, key).click();
            await waitForSelection(page, ["2026-10-28"]);
            await apply().click();
            expect((await commits(page)).at(-1)).toEqual({ start: "2026-10-28", end: "2026-10-28" });
          } finally {
            await page.close();
          }
        }, 20_000);
      }
    }
  }
});

describe("Calendar locale weekend", () => {
  for (const theme of ["light", "dark"] as const) {
    for (const [name, viewport] of Object.entries(viewports)) {
      for (const view of ["month", "mobile-month"] as const) {
        test(`shades Friday and Saturday cells and headers (${view}, ${theme}, ${name})`, async () => {
          const page = await load(viewport, theme, { kind: "calendar", view, dateConfig: { locale: "he-IL" } });
          try {
            const calendar = page.locator(".k2b-content-calendar");
            await calendar.locator(".k2b-calendar-month__day").first().waitFor();
            const header = calendar.locator(".k2b-calendar-month__weekday");
            expect(await header.count()).toBe(7);
            const marked = await header.evaluateAll((headers) =>
              headers.flatMap((head, index) => (head.getAttribute("data-weekend") === "true" ? [index] : [])),
            );
            expect(marked).toEqual([4, 5]);
            for (const head of await calendar.locator('.k2b-calendar-month__weekday[data-weekend="true"]').all()) {
              expect(await backgroundMatches(head, "--k2b-calendar-weekend")).toBe(true);
            }
            const cells = await calendar.locator(".k2b-calendar-month__day").evaluateAll((days) =>
              days.map((day) => ({
                key: day.getAttribute("data-calendar-day-key")!,
                weekend: day.getAttribute("data-weekend") === "true",
              })),
            );
            expect(cells.length).toBeGreaterThan(0);
            for (const cell of cells) expect(cell.weekend).toBe([5, 6].includes(new Date(`${cell.key}T12:00:00Z`).getUTCDay()));
            // October 16/17 are inside the month, so the outside-month fill cannot mask this assertion.
            for (const key of ["2026-10-16", "2026-10-17"]) {
              expect(await backgroundMatches(calendar.locator(`[data-calendar-day-key="${key}"]`), "--k2b-calendar-weekend")).toBe(true);
            }
          } finally {
            await page.close();
          }
        });
      }

      test(`aligns dayHours all-day bands with Friday/Saturday columns (${theme}, ${name})`, async () => {
        const page = await load(viewport, theme, { kind: "calendar", view: "week", dayHours: [6, 22], dateConfig: { locale: "he-IL" } });
        try {
          const calendar = page.locator(".k2b-content-calendar");
          await calendar.locator(".k2b-calendar-week__column").last().waitFor({ state: "attached" });
          const heads = calendar.locator('.k2b-calendar-week__head[data-weekend="true"]');
          const columns = calendar.locator('.k2b-calendar-week__column[data-weekend="true"]');
          expect(await heads.count()).toBe(2);
          expect(await columns.count()).toBe(2);
          expect(await heads.evaluateAll((heads) => heads.map((head) => head.getAttribute("data-calendar-head")))).toEqual([
            "2026-10-16",
            "2026-10-17",
          ]);
          expect(await columns.evaluateAll((columns) => columns.map((column) => column.getAttribute("data-calendar-body")))).toEqual([
            "2026-10-16",
            "2026-10-17",
          ]);
          const bands = calendar.locator(".k2b-calendar-week__weekend");
          expect(await bands.count()).toBe(2);
          // Read in one evaluation: no scrolling between a band and its corresponding body column.
          const geometry = await calendar.evaluate((calendar) => {
            const bands = [...calendar.querySelectorAll(".k2b-calendar-week__weekend")];
            const columns = [...calendar.querySelectorAll('.k2b-calendar-week__column[data-weekend="true"]')];
            const rect = (element: Element) => {
              const { x, y, width, height } = element.getBoundingClientRect();
              return { x, y, width, height };
            };
            const row = rect(calendar.querySelector(".k2b-calendar-week__all-day")!);
            return bands.map((band, index) => ({ band: rect(band), column: rect(columns[index]!), row }));
          });
          for (const { band, column, row } of geometry) {
            near(band.x, column.x);
            near(band.width, column.width);
            near(band.y, row.y);
            near(band.height, row.height);
          }
          for (const target of [...(await heads.all()), ...(await columns.all())]) {
            expect(await target.evaluate((target) => getComputedStyle(target).backgroundImage)).not.toBe("none");
          }
          for (const band of await bands.all()) expect(await backgroundMatches(band, "--k2b-calendar-weekend-tint")).toBe(true);
          expect(
            await calendar
              .locator(".k2b-calendar-week__column:not([data-weekend])")
              .first()
              .evaluate((column) => getComputedStyle(column).backgroundImage),
          ).toBe("none");
        } finally {
          await page.close();
        }
      });

      for (const view of ["week", "day"] as const) {
        test(`limits legacy weekend slot tint to week view (${view}, ${theme}, ${name})`, async () => {
          // The frozen Sunday exercises the day-view exclusion on a weekend.
          const page = await load(viewport, theme, { kind: "calendar", view, dateConfig: { locale: "de-DE" } });
          try {
            const grid = page.locator(`.k2b-calendar-time-grid[data-view="${view}"]`);
            await grid.locator(".k2b-calendar-time-grid__column").last().waitFor({ state: "attached" });
            const weekend = grid.locator('.k2b-calendar-time-grid__column[data-weekend="true"]');
            expect(await weekend.count()).toBe(view === "week" ? 2 : 1);
            expect(await grid.locator('.k2b-calendar-time-grid__day[data-weekend="true"]').count()).toBe(view === "week" ? 2 : 1);
            expect(await grid.locator('.k2b-calendar-time-grid__all-day-cell[data-weekend="true"]').count()).toBe(view === "week" ? 2 : 1);
            const images = await weekend
              .locator(".k2b-calendar-time-grid__slot")
              .evaluateAll((slots) => slots.map((slot) => getComputedStyle(slot).backgroundImage));
            expect(images.length).toBeGreaterThan(0);
            for (const image of images) expect(image === "none").toBe(view === "day");
            if (view === "week") {
              const ordinary = await grid
                .locator(".k2b-calendar-time-grid__column:not([data-weekend]) .k2b-calendar-time-grid__slot")
                .evaluateAll((slots) => slots.map((slot) => getComputedStyle(slot).backgroundImage));
              expect(ordinary.length).toBeGreaterThan(0);
              expect(ordinary.every((image) => image === "none")).toBe(true);
            }
          } finally {
            await page.close();
          }
        });
      }
    }
  }
});
