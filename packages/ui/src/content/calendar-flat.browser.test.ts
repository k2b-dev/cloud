import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser, settled } from "../../test/browser";

// In a v2 screen the calendar is the content of its Canvas: it lies flat, without an edge or rounded corners of its own,
// so the lines of the structure around it stand once (no box in a box). Outside a Canvas, as on v1 pages, it stays a card.
const dist = resolve(import.meta.dir, "../../dist");
const css = `${readFileSync(resolve(dist, "styles.css"), "utf8")}\n${readFileSync(resolve(dist, "v2.css"), "utf8")}`;
const entry = resolve(import.meta.dir, "calendar-flat.fixture.ts");
const fixture = `
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { Calendar } from ${JSON.stringify(resolve(dist, "browser/index.js"))};
import { Canvas } from ${JSON.stringify(resolve(dist, "browser/v2/index.js"))};
const options = window.fixtureOptions;
const events = [
  { id: "a", title: "Planung Q1", start: "2026-11-05T09:00:00+01:00", end: "2026-11-05T10:30:00+01:00", color: "amber" },
  { id: "b", title: "Kundentermin", start: "2026-11-06T14:00:00+01:00", end: "2026-11-06T15:00:00+01:00", color: "violet" },
];
const calendar = (testid) => createComponent(Calendar, {
  view: options.view,
  date: "2026-11-05",
  events,
  timeZone: "Europe/Berlin",
  ...(options.view === "month" ? {} : { dayHours: [7, 21] }),
  "data-testid": testid,
});
render(() => options.canvas
  ? createComponent(Canvas, { label: "Kalender", get children() { return calendar("flat"); } })
  : calendar("card"), document.getElementById("host"));
`;
const build = await Bun.build({
  entrypoints: [entry],
  files: { [entry]: fixture },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the flat calendar fixture.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (view: "month" | "week", width: number, canvas: boolean): Promise<Page> => {
  const touch = width < 768;
  const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: touch, isMobile: touch && browserName === "chromium" });
  page.setDefaultTimeout(4000);
  await page.clock.install({ time: new Date("2026-11-05T10:20:00+01:00") });
  await page.setContent(
    `<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>body{margin:0}#host{height:100vh;display:flex;flex-direction:column}#host>*{flex:1}</style></head><body class="k2b-ui k2-ui"><div id="host"></div><script>window.fixtureOptions = ${JSON.stringify({ view, canvas })}</script><script>${script}</script></body></html>`,
  );
  await page.locator(".k2b-content-calendar").waitFor();
  await settled(page);
  return page;
};

/** The calendar's own edge: border widths and corner radius, as the page draws them. */
const edge = (page: Page) =>
  page.locator(".k2b-content-calendar").evaluate((calendar) => {
    const style = getComputedStyle(calendar);
    return [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth, style.borderTopLeftRadius].join(
      " ",
    );
  });

for (const view of ["month", "week"] as const)
  for (const width of [1440, 390])
    test(`${view}, ${width} px: in a v2 Canvas the calendar lies flat, elsewhere it stays a card`, async () => {
      const flat = await open(view, width, true);
      try {
        expect(await edge(flat)).toBe("0px 0px 0px 0px 0px");
        // one line under the head block: the head itself draws none, the grid's first row draws the one
        expect(await flat.locator(".k2b-calendar-header").evaluate((head) => getComputedStyle(head).borderBottomWidth)).toBe("0px");
      } finally {
        await flat.close();
      }
      const card = await open(view, width, false);
      try {
        expect(await edge(card)).toMatch(/^1px 1px 1px 1px [1-9]/);
      } finally {
        await card.close();
      }
    });
