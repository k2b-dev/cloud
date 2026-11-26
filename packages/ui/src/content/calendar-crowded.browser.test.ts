import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser, settled } from "../../test/browser";

// A day with 30 entries that overlap many deep (the worst week and day of Spaces, W3): in the day and week views a
// band is filled in its colour with a colour edge at its start, its title (at most two whole lines) never ends in a cut
// line or in "…" after every word, and from the third overlapping entry on the rest collapse into "+n", which opens their
// list.
const packageRoot = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(packageRoot, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "calendar-crowded.fixture.ts");
const fixture = `
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { Calendar } from ${JSON.stringify(resolve(packageRoot, "dist/browser/index.js"))};
const options = window.fixtureOptions;
const titles = [
  "Jährliche Sicherheitsunterweisung für alle Lagermitarbeitenden einschließlich Aushilfen und Nachtschicht",
  "X",
  "Benachrichtigungseinstellungen im Lagerverwaltungssystem prüfen",
  "Standup",
  "Lieferantencall Spedition Nord",
  "Đặng Thị Ngọc Hân · Rückruf",
];
const pad = (value) => String(value).padStart(2, "0");
const at = (minute) => "2026-11-05T" + pad(Math.floor(minute / 60)) + ":" + pad(minute % 60) + ":00+01:00";
const events = Array.from({ length: 30 }, (_, index) => {
  const start = 7 * 60 + Math.floor(index / 3) * 40 + (index % 3) * 10;
  return { id: "e" + index, title: titles[index % titles.length] + " " + (index + 1), start: at(start), end: at(start + 90 + (index % 4) * 30), color: ["blue", "amber", "emerald", "violet"][index % 4] };
});
render(() => createComponent(Calendar, { view: options.view, date: "2026-11-05", events, timeZone: "Europe/Berlin", dayHours: [7, 21] }), document.getElementById("host"));
`;
const build = await Bun.build({
  entrypoints: [entry],
  files: { [entry]: fixture },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the crowded calendar fixture.");
const script = await build.outputs[0]!.text();

/** Starts the page's wall clock at `at`; only `Date` changes, so timers and frames keep running. */
const pinPageClock = (at: number) => {
  const RealDate = Date;
  const offset = at - RealDate.now();
  class PinnedDate extends RealDate {
    constructor(...args: ConstructorParameters<DateConstructor> | []) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...(args as ConstructorParameters<DateConstructor>));
    }
    static override now() {
      return RealDate.now() + offset;
    }
  }
  globalThis.Date = PinnedDate as DateConstructor;
};

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (view: "week" | "day", width: number): Promise<Page> => {
  const touch = width < 768;
  const page = await browser.newPage({
    viewport: { width, height: 900 },
    timezoneId: "Europe/Berlin",
    reducedMotion: "reduce",
    hasTouch: touch,
    isMobile: touch && browserName === "chromium",
  });
  page.setDefaultTimeout(4000);
  await page.evaluate(pinPageClock, Date.parse("2026-11-05T06:30:00+01:00"));
  await page.setContent(
    `<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>body{margin:0}#host{height:100vh;display:flex;flex-direction:column}#host>*{flex:1}</style></head><body class="k2b-ui"><div id="host"></div><script>window.fixtureOptions = ${JSON.stringify({ view })}</script><script>${script}</script></body></html>`,
  );
  await page.locator(".k2b-calendar-band").first().waitFor();
  await settled(page);
  return page;
};

/** Every band of 5 November: its title's lines, how far the title reaches, and whether a line is wider than the band. */
const bands = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".k2b-calendar-band")].flatMap((band) => {
      const title = band.querySelector<HTMLElement>(".k2b-calendar-event__title");
      const event = band.querySelector<HTMLElement>(".k2b-calendar-event");
      if (!title || !event || band.getBoundingClientRect().width === 0) return [];
      const inner = event.getBoundingClientRect();
      const padding = Number.parseFloat(getComputedStyle(event).paddingBottom);
      const box = title.getBoundingClientRect();
      const line = Number.parseFloat(getComputedStyle(title).lineHeight);
      return [
        {
          id: band.dataset.calendarEntry ?? "",
          left: Math.round(band.getBoundingClientRect().left),
          width: band.getBoundingClientRect().width,
          // the title ends inside the band's padding box, not cut by its edge
          inside: box.bottom <= inner.bottom - padding + 0.5,
          // a whole number of lines
          whole: Math.abs(box.height / line - Math.round(box.height / line)) < 0.05,
          // a title of several lines has no line wider than itself: then no word ends in "…" of its own (a title of one
          // line may end in "…" once)
          wide: getComputedStyle(title).whiteSpace !== "nowrap" && title.scrollWidth > title.clientWidth + 1,
          titleFirst: Boolean(
            title.nextElementSibling?.matches(".k2b-calendar-event__meta") || !band.querySelector(".k2b-calendar-event__meta"),
          ),
          lines: Math.round(box.height / line),
          // filled in its colour, with a colour edge of 3 px at its start
          filled: getComputedStyle(band).backgroundColor !== "rgb(255, 255, 255)",
          edge: getComputedStyle(band).boxShadow.includes("3px 0px 0px"),
        },
      ];
    }),
  );

for (const view of ["week", "day"] as const)
  for (const width of [1440, 390])
    test(`${view}, ${width} px: 30 overlapping entries keep whole lines, no "…" per word, and the rest collapse into "+n"`, async () => {
      const page = await open(view, width);
      try {
        const shown = await bands(page);
        expect(shown.length).toBeGreaterThan(0);
        for (const band of shown) {
          expect({
            id: band.id,
            inside: band.inside,
            whole: band.whole,
            wide: band.wide,
            titleFirst: band.titleFirst,
            twoLinesAtMost: band.lines <= 2,
            filled: band.filled,
            edge: band.edge,
          }).toEqual({
            id: band.id,
            inside: true,
            whole: true,
            wide: false,
            titleFirst: true,
            twoLinesAtMost: true,
            filled: true,
            edge: true,
          });
        }
        // at most a few columns side by side; the rest are counted in "+n" buttons, and together they are all 30
        const columns = new Set(shown.map((band) => band.left)).size;
        // two side by side, one in the narrow days of a phone's week
        expect(columns).toBeLessThanOrEqual(view === "week" && width < 768 ? 1 : 2);
        const more = page.locator(".k2b-calendar-more");
        expect(await more.count()).toBeGreaterThan(0);
        const counts = await more.evaluateAll((buttons) => buttons.map((button) => Number(button.textContent?.replace("+", "") ?? 0)));
        expect(shown.length + counts.reduce((sum, count) => sum + count, 0)).toBe(30);
        // "+n" opens the list of its hour, with every entry it stands for
        const first = more.first();
        expect(await first.getAttribute("aria-label")).toMatch(/^\d+ weitere um \d\d:\d\d$/);
        await first.click();
        const list = page.getByRole("dialog", { name: (await first.getAttribute("aria-label")) ?? "" });
        await list.waitFor();
        expect(await list.locator("[data-calendar-event]").count()).toBe(counts[0] ?? 0);
        await page.keyboard.press("Escape");
        await list.waitFor({ state: "hidden" });
      } finally {
        await page.close();
      }
    });
