import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type axeCore from "axe-core";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

declare global {
  interface Window {
    axe?: typeof axeCore;
  }
}

// Cell size, the dot's paint and the midnight timer need a real engine with a
// controllable clock, so the shipped browser build runs under Playwright's clock.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const axeSource = readFileSync(Bun.resolveSync("axe-core/axe.min.js", import.meta.dir), "utf8");
// Lives only in memory; its path makes bare imports resolve from this package.
const entry = resolve(import.meta.dir, "date-picker-today.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { DatePicker, DateRangePicker } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const berlin = { timeZone: "Europe/Berlin", locale: "en" };
render(
  () => [
    createComponent(DatePicker, { label: "Due", value: null, dateConfig: berlin }),
    createComponent(DatePicker, { label: "Picked", value: "2026-10-09", dateConfig: berlin }),
    createComponent(DatePicker, { label: "Sent", value: null, dateConfig: { timeZone: "America/New_York", locale: "en" } }),
    createComponent(DateRangePicker, { label: "Window", value: { start: "2026-09-14", end: "2026-09-18" }, dateConfig: berlin }),
  ],
  document.getElementById("app"),
);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the date picker fixture for the browser.");
const script = await build.outputs[0]!.text();

const viewports = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

/** 23:59 in Berlin and 17:59 in New York on 9 October 2026. */
const beforeBerlinMidnight = new Date("2026-10-09T21:59:00.000Z");

const load = async (
  options: (typeof viewports)[keyof typeof viewports],
  theme: "light" | "dark" = "light",
  time = beforeBerlinMidnight,
) => {
  // The browser's own zone is neither picker's zone; today must follow `dateConfig`.
  const page = await browser.newPage({ ...options, timezoneId: "Pacific/Auckland" });
  await page.clock.install({ time });
  await page.setContent(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style>` +
      `<style>*, *::before, *::after { transition: none !important }</style></head>` +
      `<body class="k2b-ui" data-theme="${theme}"><main id="app" style="display:flex;flex-direction:column;gap:12px;padding:24px;max-width:320px"></main></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await page.locator(".k2b-date-trigger").first().waitFor();
  return page;
};

const openPicker = async (page: Page, label: string) => {
  await page.getByRole("button", { name: label, exact: true }).click();
  const panel = page.locator(".k2b-date-popover:popover-open");
  await panel.waitFor();
  return panel;
};

type Cell = { key: string; today: boolean; name: string; box: number[] };

/** Every day of the open panel with its rounded box, today mark and accessible name. */
const cells = (page: Page): Promise<Cell[]> =>
  page.locator(".k2b-date-popover:popover-open [data-date-day]").evaluateAll((buttons) =>
    buttons.map((button) => {
      const box = button.getBoundingClientRect();
      return {
        key: button.getAttribute("data-date-day") ?? "",
        today: button.getAttribute("aria-current") === "date",
        name: button.getAttribute("aria-label") ?? "",
        box: [box.x, box.y, box.width, box.height].map((value) => Math.round(value * 100) / 100),
      };
    }),
  );

const todayKeys = (list: Cell[]) => list.filter((cell) => cell.today).map((cell) => cell.key);

describe("date pickers mark today", () => {
  for (const [name, options] of Object.entries(viewports)) {
    test(`moves the mark at midnight in the picker's zone without resizing a cell (${name})`, async () => {
      const page = await load(options);
      await openPicker(page, "Due");
      const before = await cells(page);
      expect(todayKeys(before)).toEqual(["2026-10-09"]);
      expect(before.find((cell) => cell.today)?.name).toBe("Today, Friday, October 9, 2026");
      // The mark draws inside its cell: each column keeps one width and every day one height.
      expect(new Set(before.map((cell) => cell.box[3])).size).toBe(1);
      for (let column = 0; column < 7; column += 1) {
        expect(new Set(before.filter((_, index) => index % 7 === column).map((cell) => cell.box[2])).size).toBe(1);
      }

      await page.clock.runFor(2 * 60_000);
      const after = await cells(page);
      expect(todayKeys(after)).toEqual(["2026-10-10"]);
      expect(after.find((cell) => cell.today)?.name).toBe("Today, Saturday, October 10, 2026");
      expect(after.map((cell) => cell.box)).toEqual(before.map((cell) => cell.box));
      await page.close();
    });
  }

  test("keeps New York on its own day when Berlin has passed midnight", async () => {
    const page = await load(viewports.desktop);
    await page.clock.runFor(2 * 60_000);
    await openPicker(page, "Sent");
    expect(todayKeys(await cells(page))).toEqual(["2026-10-09"]);
    await page.close();
  });

  for (const theme of ["light", "dark"] as const) {
    test(`paints today in the accent and keeps the dot visible on a selected today (${theme})`, async () => {
      const page = await load(viewports.desktop, theme);
      const paint = (selector: string) =>
        page.locator(selector).evaluate((button) => {
          const dot = getComputedStyle(button, "::after");
          return {
            color: getComputedStyle(button).color,
            background: getComputedStyle(button).backgroundColor,
            dot: { content: dot.content, position: dot.position, width: dot.width, background: dot.backgroundColor },
            action: getComputedStyle(document.body).getPropertyValue("--k2b-action"),
          };
        });

      await openPicker(page, "Due");
      const plain = await paint('.k2b-date-popover:popover-open [data-date-day="2026-10-08"]');
      const today = await paint('.k2b-date-popover:popover-open [data-date-day="2026-10-09"]');
      expect(today.color).not.toBe(plain.color);
      expect(plain.dot.content).toBe("none");
      expect(today.dot).toEqual({ content: '""', position: "absolute", width: "4px", background: today.color });
      await page.keyboard.press("Escape");

      await openPicker(page, "Picked");
      const selected = await paint('.k2b-date-popover:popover-open [data-date-day="2026-10-09"]');
      // The filled selection stays; number and dot take its contrasting color.
      expect(selected.background).not.toBe("rgba(0, 0, 0, 0)");
      expect(selected.color).toBe("rgb(255, 255, 255)");
      expect(selected.dot.background).toBe("rgb(255, 255, 255)");
      await page.close();
    });
  }

  test("marks today subtly on a day outside the visible month", async () => {
    // September's panel ends on Sunday 4 October.
    const page = await load(viewports.desktop, "light", new Date("2026-10-02T10:00:00.000Z"));
    await openPicker(page, "Window");
    const day = (key: string) => page.locator(`.k2b-date-popover:popover-open [data-date-day="${key}"]`);
    expect(await day("2026-10-02").getAttribute("data-outside")).toBe("true");
    expect(await day("2026-10-02").getAttribute("aria-current")).toBe("date");
    const [todayColor, otherColor] = await Promise.all(
      ["2026-10-02", "2026-10-01"].map((key) => day(key).evaluate((button) => getComputedStyle(button).color)),
    );
    expect(todayColor).not.toBe(otherColor);
    await page.close();
  });

  for (const theme of ["light", "dark"] as const) {
    for (const label of ["Due", "Picked", "Window"]) {
      test(`passes axe with today in the open panel (${label}, ${theme})`, async () => {
        const page = await load(viewports.desktop, theme);
        await page.addScriptTag({ content: axeSource });
        await openPicker(page, label);
        const violations = await page.evaluate(async () => {
          const result = await window.axe!.run(".k2b-date-popover:popover-open", {
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
            resultTypes: ["violations"],
          });
          return result.violations.map(
            (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`,
          );
        });
        expect(violations).toEqual([]);
        await page.close();
      });
    }
  }
});
