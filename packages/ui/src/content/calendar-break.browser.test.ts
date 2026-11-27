import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser, settled } from "../../test/browser";

// Breaks from the worst and empty weeks of Spaces (break-ui v4): on a phone an all-day bar that began before the first
// day on screen shows its title beside the all-day label, never a fragment of it under the label; and an opened day or
// week never shows an hour label cut by the sticky head, at any height of the view.
const dist = resolve(import.meta.dir, "../../dist");
const css = readFileSync(resolve(dist, "styles.css"), "utf8");
const entry = resolve(import.meta.dir, "calendar-break.fixture.ts");
const fixture = `
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { Calendar } from ${JSON.stringify(resolve(dist, "browser/index.js"))};
const options = window.fixtureOptions;
const events = options.empty ? [] : [
  { id: "leave", title: "Aleksandra Wiśniewska-Kowalczyk · parental leave until the end of January", start: "2026-10-26", end: "2026-11-02", allDay: true },
  { id: "away", title: "Sam Example · away", start: "2026-10-26", end: "2026-10-29", allDay: true },
];
render(() => createComponent(Calendar, { view: options.view, date: "2026-10-27", events, timeZone: "Europe/Berlin", dayHours: [7, 22] }), document.getElementById("host"));
`;
const build = await Bun.build({
  entrypoints: [entry],
  files: { [entry]: fixture },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the break-ui calendar fixture.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (view: "week" | "day", width: number, height: number, empty: boolean, dir: "ltr" | "rtl" = "ltr"): Promise<Page> => {
  const touch = width < 768;
  const page = await browser.newPage({
    viewport: { width, height },
    hasTouch: touch,
    isMobile: touch && browserName === "chromium",
    timezoneId: "Europe/Berlin",
  });
  page.setDefaultTimeout(4000);
  await page.clock.install({ time: new Date("2026-10-27T10:40:00+01:00") });
  await page.setContent(
    `<!doctype html><html lang="en" dir="${dir}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>body{margin:0}#host{height:100vh;display:flex;flex-direction:column}#host>*{flex:1}</style></head><body class="k2b-ui"><div id="host"></div><script>window.fixtureOptions = ${JSON.stringify({ view, empty })}</script><script>${script}</script></body></html>`,
  );
  await page.locator(".k2b-content-calendar").waitFor();
  await settled(page);
  return page;
};

test("week, 390 px: all-day bars that began before the first day on screen show their titles beside the label", async () => {
  const page = await open("week", 390, 844, false);
  try {
    const label = await page.locator(".k2b-calendar-week__all-day-label").evaluate((element) => element.getBoundingClientRect().right);
    for (const title of ["Aleksandra Wiśniewska-Kowalczyk", "Sam Example · away"]) {
      const box = await page
        .locator(".k2b-calendar-week__all-day .k2b-calendar-event__title", { hasText: title })
        .first()
        .evaluate((element) => element.getBoundingClientRect().toJSON());
      // its first letters stand on the screen, right of the label, never a fragment under or left of it
      expect({ title, left: box.left >= label - 0.5 }).toEqual({ title, left: true });
    }
  } finally {
    await page.close();
  }
});

test("week, 390 px, right to left: the titles stand left of the label, which is on the right", async () => {
  const page = await open("week", 390, 844, false, "rtl");
  try {
    const label = await page.locator(".k2b-calendar-week__all-day-label").evaluate((element) => element.getBoundingClientRect().left);
    for (const title of ["Aleksandra Wiśniewska-Kowalczyk", "Sam Example · away"]) {
      const box = await page
        .locator(".k2b-calendar-week__all-day .k2b-calendar-event__title", { hasText: title })
        .first()
        .evaluate((element) => element.getBoundingClientRect().toJSON());
      expect({ title, beside: box.right <= label + 0.5 && box.right > 0 }).toEqual({ title, beside: true });
    }
  } finally {
    await page.close();
  }
});

for (const view of ["week", "day"] as const)
  for (const width of [1440, 390])
    test(`${view}, ${width} px, no entries: no hour label stands half under the head, at any height`, async () => {
      for (const height of [640, 700, 760, 820, 880, 940]) {
        const page = await open(view, width, height, true);
        try {
          const cut = await page.evaluate((current) => {
            const head = document.querySelector(
              current === "week" ? ".k2b-calendar-week__top" : ".k2b-calendar-days__day .k2b-calendar-days__head",
            );
            const bottom = head?.getBoundingClientRect().bottom ?? 0;
            return [...document.querySelectorAll<HTMLElement>(current === "week" ? ".k2b-calendar-week__hour" : ".k2b-calendar-days__hour")]
              .map((label) => ({ text: label.textContent, box: label.getBoundingClientRect() }))
              .filter(({ box }) => box.height > 0 && box.top < bottom - 0.5 && box.bottom > bottom + 0.5)
              .map(({ text }) => text);
          }, view);
          expect({ height, cut }).toEqual({ height, cut: [] });
        } finally {
          await page.close();
        }
      }
    }, 60_000);
