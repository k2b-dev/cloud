import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

declare global {
  interface Window {
    dateCommits?: unknown[];
  }
}

// Typing, focus, the popover's place and the phone sheet need a real engine, so the shipped browser build runs
// under Playwright with a frozen clock: today is Monday, 2 November 2026.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "date-picker-typing.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { Button, DatePicker, DateRangePicker } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const dateConfig = { timeZone: "UTC", locale: "de-DE" };
const [due, setDue] = createSignal("2026-11-11");
const [limited, setLimited] = createSignal(null);
const [range, setRange] = createSignal({ start: null, end: null });
window.dateCommits = [];
const commit = (value) => window.dateCommits.push(value);
render(
  () => [
    createComponent(DatePicker, {
      label: "Fällig am", clearable: true, dateConfig, onValueCommit: commit,
      get value() { return due(); }, onValueChange: setDue,
    }),
    createComponent(DatePicker, {
      label: "Im November", min: "2026-11-02", max: "2026-11-30", dateConfig, onValueCommit: commit,
      get value() { return limited(); }, onValueChange: setLimited,
    }),
    createComponent(DateRangePicker, {
      label: "Zeitraum", dateConfig, onValueCommit: commit,
      get value() { return range(); }, onValueChange: setRange,
    }),
    createComponent(Button, { children: "Danach" }),
  ],
  document.getElementById("app"),
);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the typed date fixture for the browser.");
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

const load = async (options: (typeof viewports)[keyof typeof viewports]) => {
  const page = await browser.newPage({ ...options, timezoneId: "UTC", locale: "de-DE" });
  await page.clock.install({ time: new Date("2026-11-02T10:00:00.000Z") });
  await page.setContent(
    `<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style>` +
      `<style>*, *::before, *::after { transition: none !important }</style></head>` +
      `<body class="k2b-ui"><main id="app" style="display:flex;flex-direction:column;gap:12px;padding:24px;max-width:320px"></main></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await page.locator(".k2b-date-field input").first().waitFor();
  return page;
};

const field = (page: Page, name: string) => page.getByRole("combobox", { name, exact: true });
const status = (page: Page, index = 0) => page.locator(".k2b-date-status").nth(index);
const popover = (page: Page) => page.locator(".k2b-date-popover:popover-open");
const commits = (page: Page) => page.evaluate(() => window.dateCommits);
const rounded = (box: { x: number; y: number; width: number; height: number } | null) =>
  box ? [box.x, box.y, box.width, box.height].map((value) => Math.round(value * 100) / 100) : null;

describe("typed date field", () => {
  test("typing shows the meant day before the commit, and Enter commits it", async () => {
    const page = await load(viewports.desktop);
    try {
      expect(await status(page).textContent()).toBe("Mittwoch, in 9 Tagen");
      await field(page, "Fällig am").fill("mi");
      expect(await status(page).textContent()).toBe("→ Mi., 4. Nov. 2026 · nächster Mittwoch");
      expect(await status(page).getAttribute("data-tone")).toBe("draft");
      expect(await commits(page)).toEqual([]);

      await page.keyboard.press("Enter");
      expect(await field(page, "Fällig am").inputValue()).toBe("04.11.2026");
      expect(await commits(page)).toEqual(["2026-11-04"]);
      expect(await status(page).textContent()).toBe("Mittwoch, in 2 Tagen");

      await field(page, "Fällig am").fill("gestern + 34");
      expect(await status(page).textContent()).toBe("→ Sa., 5. Dez. 2026 · gestern + 34 Tage");
      // Leaving the field commits too.
      await page.keyboard.press("Tab");
      expect(await commits(page)).toEqual(["2026-11-04", "2026-12-05"]);
      expect(await field(page, "Fällig am").inputValue()).toBe("05.12.2026");
    } finally {
      await page.close();
    }
  });

  test("a refused text stays for correction, keeps the value, and Escape restores it", async () => {
    const page = await load(viewports.desktop);
    try {
      const input = field(page, "Fällig am");
      await input.fill("31.02.2026");
      // Already named while typing, but only red after the commit.
      expect(await status(page).getAttribute("data-tone")).toBe("rest");
      await page.keyboard.press("Enter");
      expect(await status(page).textContent()).toBe("Der Februar 2026 hat nur 28 Tage.");
      expect(await status(page).getAttribute("data-tone")).toBe("error");
      expect(await input.getAttribute("aria-invalid")).toBe("true");
      expect(await input.inputValue()).toBe("31.02.2026");
      expect(await commits(page)).toEqual([]);

      await page.keyboard.press("Escape");
      expect(await input.inputValue()).toBe("11.11.2026");
      expect(await input.getAttribute("aria-invalid")).toBeNull();
      expect(await status(page).textContent()).toBe("Mittwoch, in 9 Tagen");
    } finally {
      await page.close();
    }
  });

  test("a click opens the calendar below the status line, and typing moves it", async () => {
    const page = await load(viewports.desktop);
    try {
      const input = field(page, "Fällig am");
      await input.click();
      await popover(page).waitFor();
      expect(await input.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(await input.getAttribute("aria-expanded")).toBe("true");
      const line = await status(page).boundingBox();
      const panel = await popover(page).boundingBox();
      expect(panel!.y).toBeGreaterThanOrEqual(line!.y + line!.height);
      // Six weeks in every month, so typing into another month never resizes the open panel.
      expect(await popover(page).locator("[data-date-day]").count()).toBe(42);

      const before = rounded(await popover(page).boundingBox());
      await input.fill("11.2.");
      expect(await popover(page).locator(".k2b-date-calendar__title").textContent()).toContain("Februar 2026");
      expect(await popover(page).locator('[data-date-day="2026-02-11"]').getAttribute("aria-selected")).toBe("true");
      expect(rounded(await popover(page).boundingBox())).toEqual(before);

      await popover(page).locator('[data-date-day="2026-02-12"]').click();
      expect(await popover(page).count()).toBe(0);
      expect(await input.inputValue()).toBe("12.02.2026");
      expect(await commits(page)).toEqual(["2026-02-12"]);
      expect(await input.evaluate((element) => element === document.activeElement)).toBe(true);
    } finally {
      await page.close();
    }
  });

  test("the keyboard opens the calendar on the day, picks there, and returns to the text", async () => {
    const page = await load(viewports.desktop);
    try {
      const input = field(page, "Fällig am");
      await page.keyboard.press("Tab");
      // Tab focus never opens the calendar.
      expect(await input.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(await popover(page).count()).toBe(0);

      await page.keyboard.press("ArrowDown");
      await popover(page).waitFor();
      expect(await page.evaluate(() => document.activeElement?.getAttribute("data-date-day"))).toBe("2026-11-11");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Escape");
      // Escape in the calendar closes it and keeps the text.
      expect(await popover(page).count()).toBe(0);
      expect(await input.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(await input.inputValue()).toBe("11.11.2026");

      await page.keyboard.press("Alt+ArrowDown");
      await popover(page).waitFor();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Enter");
      expect(await input.inputValue()).toBe("12.11.2026");
      expect(await commits(page)).toEqual(["2026-11-12"]);
      expect(await input.evaluate((element) => element === document.activeElement)).toBe(true);
    } finally {
      await page.close();
    }
  });

  test("min and max lock days and refuse typed dates with the nearest allowed day", async () => {
    const page = await load(viewports.desktop);
    try {
      const input = field(page, "Im November");
      await input.click();
      await popover(page).waitFor();
      expect(await popover(page).locator('[data-date-day="2026-11-01"]').isDisabled()).toBe(true);
      expect(await popover(page).locator('[data-date-day="2026-12-01"]').isDisabled()).toBe(true);
      expect(await popover(page).getByRole("button", { name: "Nächster Monat" }).isDisabled()).toBe(true);
      expect(await popover(page).locator(".k2b-date-calendar__limits").textContent()).toBe("ab 02.11.2026bis 30.11.2026");

      await input.fill("1.12.");
      expect(await status(page, 1).textContent()).toBe("Spätestens am 30.11.2026.");
      await page.keyboard.press("Enter");
      expect(await status(page, 1).getAttribute("data-tone")).toBe("error");
      expect(await commits(page)).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("a range takes two typed days, a pasted range, and refuses an end before the start", async () => {
    const page = await load(viewports.desktop);
    try {
      const start = field(page, "Zeitraum: Start");
      const end = field(page, "Zeitraum: Ende");
      await start.fill("11.11.");
      expect(await status(page, 2).textContent()).toBe("→ Mi., 11. Nov. 2026 · Ende fehlt");
      await end.fill("14.11.");
      expect(await status(page, 2).textContent()).toBe("→ Mi., 11. Nov. 2026 – Sa., 14. Nov. 2026 · 4 Tage");
      await page.keyboard.press("Enter");
      expect(await commits(page)).toEqual([{ start: "2026-11-11", end: "2026-11-14" }]);

      await start.focus();
      await page.evaluate(() => {
        const data = new DataTransfer();
        data.setData("text", "1.12. – 3.12.");
        document.activeElement?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      });
      expect(await start.inputValue()).toBe("1.12.");
      expect(await end.inputValue()).toBe("3.12.");

      await end.fill("30.11.");
      await page.keyboard.press("Enter");
      expect(await status(page, 2).textContent()).toBe("Das Ende liegt vor dem Start.");
      expect(await commits(page)).toEqual([{ start: "2026-11-11", end: "2026-11-14" }]);
    } finally {
      await page.close();
    }
  });

  test("no state moves the field, its text or what follows it", async () => {
    const page = await load(viewports.desktop);
    try {
      const input = field(page, "Fällig am");
      const layout = () =>
        page.evaluate(() => {
          const box = (element: Element | null) => {
            const rect = element!.getBoundingClientRect();
            return [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value * 100) / 100);
          };
          const input = document.querySelector<HTMLInputElement>(".k2b-date-field input")!;
          return {
            shell: box(input.closest(".k2b-input-shell")),
            text: box(input),
            next: box(document.querySelectorAll(".k2b-date-field")[1]!),
          };
        });
      const rest = await layout();
      await input.hover();
      expect(await layout()).toEqual(rest);
      await input.click();
      await popover(page).waitFor();
      expect(await layout()).toEqual(rest);
      await input.fill("mi");
      expect(await layout()).toEqual(rest);
      await input.fill("abc");
      await page.keyboard.press("Enter");
      expect(await status(page).getAttribute("data-tone")).toBe("error");
      expect(await layout()).toEqual(rest);
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Datum löschen" }).click();
      expect(await input.inputValue()).toBe("");
      expect(await status(page).textContent()).toBe("");
      expect(await layout()).toEqual(rest);
    } finally {
      await page.close();
    }
  });

  test("on a phone the text brings the keypad and the toggle opens the calendar as a sheet", async () => {
    const page = await load(viewports.phone);
    try {
      const input = field(page, "Fällig am");
      expect(await input.getAttribute("inputmode")).toBe("numeric");
      const shell = rounded(await page.locator(".k2b-date-field .k2b-input-shell").first().boundingBox());
      await input.tap();
      expect(await popover(page).count()).toBe(0);
      expect(await page.locator("dialog[open]").count()).toBe(0);

      const toggle = page.getByRole("button", { name: "Kalender öffnen" }).first();
      await toggle.tap();
      const sheet = page.locator("dialog[open] .k2b-date-sheet");
      await sheet.waitFor();
      const day = sheet.locator('[data-date-day="2026-11-20"]');
      expect((await day.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await day.tap();
      await page.waitForFunction(() => document.querySelector("dialog[open]") === null);
      expect(await input.inputValue()).toBe("20.11.2026");
      expect(await commits(page)).toEqual(["2026-11-20"]);
      expect(await toggle.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(rounded(await page.locator(".k2b-date-field .k2b-input-shell").first().boundingBox())).toEqual(shell);
    } finally {
      await page.close();
    }
  });
});
