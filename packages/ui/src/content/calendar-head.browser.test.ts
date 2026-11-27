import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser } from "../../test/browser";

// On a phone the server's page switches the calendar's views before any script runs: the head's view button opens
// its list through `popovertarget`, and the views in it are the host's links.
const dist = resolve(import.meta.dir, "../../dist");
const css = readFileSync(resolve(dist, "styles.css"), "utf8");
const { Calendar } = await import(resolve(dist, "ssr/index.js"));

const markup = (view: "week" | "day") =>
  renderToString(() =>
    createComponent(Calendar, {
      view,
      date: "2026-11-05",
      timeZone: "Europe/Berlin",
      dayHours: [7, 21],
      events: [{ id: "a", title: "Planung Q1", start: "2026-11-05T09:00:00+01:00", end: "2026-11-05T10:00:00+01:00" }],
      getViewHref: (target: string) => `/calendar?view=${target}`,
      getDateHref: (date: Date, target: string) => `/calendar?view=${target}&date=${date.toISOString().slice(0, 10)}`,
    }),
  );

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

for (const view of ["week", "day"] as const)
  test(`${view}, 390 px, no script: the view button opens the views as links`, async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, javaScriptEnabled: false });
    const page = await context.newPage();
    try {
      page.setDefaultTimeout(4000);
      await page.setContent(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="k2b-ui"><div style="height:100vh;display:flex;flex-direction:column">${markup(view)}</div></body></html>`,
      );
      const trigger = page.locator(".k2b-calendar-view-menu__trigger");
      expect(await trigger.isVisible()).toBe(true);
      await trigger.click();
      const links = page.locator(".k2b-calendar-view-menu__list:popover-open a.k2b-calendar-view-menu__item");
      await links.first().waitFor();
      expect(await links.allTextContents()).toEqual(["Day", "Week", "Month", "Year"]);
      expect(await links.evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute("href")))).toEqual(
        ["day", "week", "month", "year"].map((target) => `/calendar?view=${target}`),
      );
      expect(await links.filter({ hasText: view === "week" ? "Week" : "Day" }).getAttribute("aria-current")).toBe("page");
    } finally {
      await context.close();
    }
  });
