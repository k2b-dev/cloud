import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type axeCore from "axe-core";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

declare global {
  interface Window {
    axe?: typeof axeCore;
    /** Every value the pickers committed, in order, by label. */
    committed?: [string, string | null][];
  }
}

// Focus moves, the slot's box and the committed values need a real engine, so
// the shipped browser build runs with a fixed clock.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const axeSource = readFileSync(Bun.resolveSync("axe-core/axe.min.js", import.meta.dir), "utf8");
// Lives only in memory; its path makes bare imports resolve from this package.
const entry = resolve(import.meta.dir, "date-picker-optional-time.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { DateTimePicker } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const berlin = { timeZone: "Europe/Berlin", locale: "en" };
window.committed = [];
const picker = (label, initial) => {
  const [value, setValue] = createSignal(initial);
  return createComponent(DateTimePicker, {
    label,
    optionalTime: true,
    defaultTime: "17:00",
    clearable: true,
    dateConfig: berlin,
    presets: [{ label: "Tomorrow", value: "2026-10-10" }],
    value,
    onValueChange: (next) => {
      window.committed.push([label, next]);
      setValue(next);
    },
  });
};
render(() => [picker("Due", "2026-10-23"), picker("Timed", "2026-10-23T15:30:00.000Z"), picker("Empty", null)], document.getElementById("app"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the optional time fixture for the browser.");
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

const load = async (options: (typeof viewports)[keyof typeof viewports], theme: "light" | "dark" = "light") => {
  // The device zone is neither UTC nor the picker's zone, so a date that passed through a zone would show.
  const page = await browser.newPage({ ...options, timezoneId: "America/Los_Angeles" });
  await page.clock.install({ time: new Date("2026-10-09T10:00:00.000Z") });
  await page.setContent(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style>` +
      `<style>*, *::before, *::after { transition: none !important }</style></head>` +
      `<body class="k2b-ui" data-theme="${theme}"><main id="app" style="display:flex;flex-direction:column;gap:12px;padding:24px;max-width:320px"></main></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await page.locator(".k2b-date-trigger").first().waitFor();
  return page;
};

const trigger = (page: Page, label: string) => page.getByRole("button", { name: label, exact: true });

const open = async (page: Page, label: string) => {
  await trigger(page, label).click();
  const panel = page.locator(".k2b-date-popover:popover-open");
  await panel.waitFor();
  return panel;
};

const committed = (page: Page) => page.evaluate(() => window.committed);

/** The rounded boxes of the panel and its action row, which adding or removing the time must not change. */
const boxes = (page: Page) =>
  page.locator(".k2b-date-popover:popover-open").evaluate((panel) =>
    [panel, panel.querySelector(".k2b-date-actions")!, panel.querySelector(".k2b-date-apply")!].map((element) => {
      const box = element.getBoundingClientRect();
      return [box.x, box.y, box.width, box.height].map((value) => Math.round(value * 10) / 10);
    }),
  );

describe("DateTimePicker with an optional time", () => {
  test("shows a date key on its own day and commits a chosen day at once", async () => {
    const page = await load(viewports.desktop);
    expect(await page.locator("#" + (await trigger(page, "Due").getAttribute("id")) + "-value").textContent()).toBe("Oct 23, 2026");
    const panel = await open(page, "Due");
    expect(await panel.getByRole("button", { name: "Add time" }).isVisible()).toBe(true);
    expect(await panel.locator("input").count()).toBe(0);
    await panel.locator('[data-date-day="2026-10-24"]').click();
    expect(await page.locator(".k2b-date-popover:popover-open").count()).toBe(0);
    expect(await committed(page)).toEqual([["Due", "2026-10-24"]]);
    await page.close();
  }, 30_000);

  test("applies a date key preset unchanged", async () => {
    const page = await load(viewports.desktop);
    const panel = await open(page, "Empty");
    await panel.getByRole("button", { name: "Tomorrow" }).click();
    expect(await committed(page)).toEqual([["Empty", "2026-10-10"]]);
    await page.close();
  }, 30_000);

  for (const [name, options] of Object.entries(viewports)) {
    for (const theme of ["light", "dark"] as const) {
      test(`adds and removes the time in place without moving the panel (${name}, ${theme})`, async () => {
        const page = await load(options, theme);
        await open(page, "Due");
        const before = await boxes(page);

        await page.getByRole("button", { name: "Add time" }).click();
        const time = page.getByRole("textbox", { name: "Time" });
        expect(await time.evaluate((input) => input === document.activeElement)).toBe(true);
        expect(await time.inputValue()).toBe("17:00");
        expect(await boxes(page)).toEqual(before);

        await page.getByRole("button", { name: "Remove time" }).click();
        expect(await page.getByRole("button", { name: "Add time" }).evaluate((button) => button === document.activeElement)).toBe(true);
        expect(await boxes(page)).toEqual(before);
        await page.close();
      }, 30_000);
    }
  }

  test("commits a date-time in the picker's zone once a time is added, by keyboard", async () => {
    const page = await load(viewports.desktop);
    const panel = await open(page, "Due");
    await panel.getByRole("button", { name: "Add time" }).focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type("0930");
    // With a time, a day only marks the date until Apply.
    await panel.locator('[data-date-day="2026-10-24"]').click();
    expect(await committed(page)).toEqual([]);
    await panel.getByRole("button", { name: "Apply" }).click();
    expect(await committed(page)).toEqual([["Due", "2026-10-24T07:30:00.000Z"]]);
    expect(await page.locator("#" + (await trigger(page, "Due").getAttribute("id")) + "-value").textContent()).toBe("Oct 24, 2026, 09:30");
    await page.close();
  }, 30_000);

  test("opens a timed value with its time and saves the date alone after Remove time", async () => {
    const page = await load(viewports.desktop);
    const panel = await open(page, "Timed");
    expect(await panel.getByRole("textbox", { name: "Time" }).inputValue()).toBe("17:30");
    await panel.getByRole("button", { name: "Remove time" }).click();
    await panel.getByRole("button", { name: "Apply" }).click();
    expect(await committed(page)).toEqual([["Timed", "2026-10-23"]]);
    await page.close();
  }, 30_000);

  for (const theme of ["light", "dark"] as const) {
    for (const withTime of [false, true]) {
      test(`passes axe in the open panel (${withTime ? "with" : "without"} time, ${theme})`, async () => {
        const page = await load(viewports.desktop, theme);
        await page.addScriptTag({ content: axeSource });
        await open(page, withTime ? "Timed" : "Due");
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
      }, 30_000);
    }
  }
});
