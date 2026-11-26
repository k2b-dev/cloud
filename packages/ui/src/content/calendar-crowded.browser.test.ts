import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser, settled } from "../../test/browser";

// A day with 30 entries that overlap many deep (the worst week and day of Spaces, W3): in the day and week views a
// band is filled in its colour with a colour edge at its start, its title (at most two whole lines) never ends in a cut
// line or in "…" after every word, and from the third overlapping entry on the rest collapse into "+n", which opens their
// list. The "+n" never cover each other or a band, an open list stays open while the clock runs, and a right-to-left
// page draws the edge and the "+n" on its side.
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
  return {
    id: "e" + index,
    title: titles[index % titles.length] + " " + (index + 1),
    start: at(start),
    end: at(start + 90 + (index % 4) * 30),
    color: ["blue", "amber", "emerald", "violet"][index % 4],
    // a colour the host got wrong: the band keeps a fill and an edge
    ...(index === 0 ? { colorHex: "rot" } : {}),
  };
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

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (view: "week" | "day", width: number, dir: "ltr" | "rtl" = "ltr", time = "2026-11-05T06:30:00+01:00"): Promise<Page> => {
  const touch = width < 768;
  const page = await browser.newPage({
    viewport: { width, height: 900 },
    timezoneId: "Europe/Berlin",
    reducedMotion: "reduce",
    hasTouch: touch,
    isMobile: touch && browserName === "chromium",
  });
  page.setDefaultTimeout(4000);
  // the clock runs, so the free time and now move as they do for a reader
  await page.clock.install({ time: new Date(time) });
  await page.setContent(
    `<!doctype html><html lang="de" dir="${dir}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>body{margin:0}#host{height:100vh;display:flex;flex-direction:column}#host>*{flex:1}</style></head><body class="k2b-ui"><div id="host"></div><script>window.fixtureOptions = ${JSON.stringify({ view })}</script><script>${script}</script></body></html>`,
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
      const rect = band.getBoundingClientRect();
      return [
        {
          id: band.dataset.calendarEntry ?? "",
          top: rect.top,
          bottom: rect.bottom,
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

/** The boxes of the "+n" buttons and of the bands, in the page's pixels. */
const boxes = (page: Page, selector: string) =>
  page.locator(selector).evaluateAll((elements) =>
    elements
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0)
      .map((rect) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })),
  );

type Box = { left: number; right: number; top: number; bottom: number };
const cover = (one: Box, other: Box) =>
  one.left < other.right - 0.5 && other.left < one.right - 0.5 && one.top < other.bottom - 0.5 && other.top < one.bottom - 0.5;

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
        // at most two bands at any time; the rest are counted in "+n" buttons, and together they are all 30
        for (const band of shown)
          expect(shown.filter((other) => other.top <= band.top + 0.5 && other.bottom > band.top + 0.5).length).toBeLessThanOrEqual(2);
        const more = page.locator(".k2b-calendar-more");
        expect(await more.count()).toBeGreaterThan(0);
        const counts = await more.evaluateAll((buttons) => buttons.map((button) => Number(button.textContent?.replace("+", "") ?? 0)));
        expect(shown.length + counts.reduce((sum, count) => sum + count, 0)).toBe(30);
        // no "+n" covers another or a band
        const chips = await boxes(page, ".k2b-calendar-more");
        const drawn = await boxes(page, ".k2b-calendar-band");
        for (const [index, chip] of chips.entries()) {
          expect(chips.filter((other, each) => each !== index && cover(chip, other))).toEqual([]);
          expect(drawn.filter((band) => cover(chip, band))).toEqual([]);
        }
        // "+n" opens the list of the entries it stands for; Escape closes it and gives the focus back to the "+n"
        const first = more.first();
        expect(await first.getAttribute("aria-label")).toMatch(/^\d+ weitere ab \d\d:\d\d$/);
        await first.click();
        const list = page.getByRole("dialog", { name: (await first.getAttribute("aria-label")) ?? "" });
        await list.waitFor();
        expect(await list.locator("[data-calendar-event]").count()).toBe(counts[0] ?? 0);
        await page.keyboard.press("Escape");
        await list.waitFor({ state: "hidden" });
        expect(await first.evaluate((button) => document.activeElement === button)).toBe(true);
      } finally {
        await page.close();
      }
    });

for (const view of ["week", "day"] as const)
  test(`${view}: an open "+n" list stays open with its focus while the clock moves the free time`, async () => {
    // 16:14, after the last entry: the free time starts at 16:15, two minutes later at 16:30
    const page = await open(view, 1440, "ltr", "2026-11-05T16:14:00+01:00");
    try {
      const first = page.locator(".k2b-calendar-more").first();
      await first.click();
      const list = page.locator(".k2b-calendar-popover:popover-open");
      await list.waitFor();
      await list.locator("[data-calendar-event]").first().focus();
      await list.evaluate((element) => element.setAttribute("data-mark", "1"));
      // two minutes on: now moves, and with it the free time of the day
      await page.clock.runFor(120_000);
      await settled(page);
      expect(
        await page.evaluate(() => {
          const open = document.querySelector<HTMLElement>(".k2b-calendar-popover:popover-open");
          return { open: open?.dataset.mark === "1", focus: Boolean(open?.contains(document.activeElement)) };
        }),
      ).toEqual({ open: true, focus: true });
    } finally {
      await page.close();
    }
  });

test('right to left: the edge and the "+n" stand on the right side, also for a selected band', async () => {
  const page = await open("week", 1440, "rtl");
  try {
    const band = page.locator(".k2b-calendar-band[data-calendar-entry='e1']");
    const edge = () => band.evaluate((element) => getComputedStyle(element).boxShadow);
    expect(await edge()).toContain("-3px 0px 0px");
    await band.locator(".k2b-calendar-event").click();
    await page.waitForFunction(() => document.querySelector(".k2b-calendar-band[data-calendar-entry='e1'] [data-selected='true']"));
    expect(await edge()).toContain("-3px 0px 0px");
    // the "+n" at the column's end: on the left of the bands beside it
    const chip = (await boxes(page, ".k2b-calendar-more"))[0]!;
    const beside = (await boxes(page, ".k2b-calendar-band")).filter((rect) => rect.top < chip.bottom && rect.bottom > chip.top);
    expect(beside.length).toBeGreaterThan(0);
    for (const rect of beside) expect(chip.right).toBeLessThanOrEqual(rect.left + 0.5);
  } finally {
    await page.close();
  }
});
