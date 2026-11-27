import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { renderChartSvg } from "./core/render";

// The extras of a line chart (bands, a colour scale, a track of bars under the plot) in a real engine, with the sheets as they
// ship: in colour the scaled line paints with its gradient; in forced colors every mark takes a system colour, the
// line the text's, bars and bands the muted one, so each stays apart from the page.

const hour = 3_600_000;
const start = Date.UTC(2026, 10, 27, 0);
const hours = Array.from({ length: 24 }, (_, index) => start + index * hour);
const svg = renderChartSvg(
  {
    kind: "line",
    timeAxis: { timeZone: "UTC" },
    series: [
      {
        label: "Temperatur",
        data: hours.map((x, index) => ({ x, y: -2 + index * 0.75 })),
        colorScale: [
          { value: 0, tone: "blue" },
          { value: 10, tone: "amber" },
          { value: 20, tone: "red" },
        ],
      },
    ],
    bands: [{ from: start, to: start + 7 * hour, label: "Nacht" }],
    track: { label: "Regen", data: hours.map((x, index) => ({ x, y: index * 3 })) },
  },
  480,
  240,
);

let browser: Browser;
let css: string;
beforeAll(async () => {
  css = await Bun.file(resolve(import.meta.dir, "../../dist/styles.css")).text();
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const look = async (forced: boolean) => {
  const page = await browser.newPage({ viewport: { width: 600, height: 400 } });
  const errors = pageErrors(page);
  try {
    if (forced) await page.emulateMedia({ forcedColors: "active" });
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style></head><body class="k2b-ui"><div class="k2b-chart" style="width:480px;height:240px"><div class="k2b-chart__svg">${svg}</div></div><span id="text" style="color:CanvasText"></span><span id="muted" style="color:GrayText"></span></body></html>`,
    );
    await settled(page);
    const found = await page.evaluate(() => {
      const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
      return {
        line: style(".k2b-line-scaled").stroke,
        bar: style(".k2b-line-bar").fill,
        band: style(".k2b-line-band").fill,
        text: style("#text").color,
        muted: style("#muted").color,
      };
    });
    expect(errors).toEqual([]);
    return found;
  } finally {
    await page.close();
  }
};

test("in colour the scaled line paints with its gradient", async () => {
  const found = await look(false);
  expect(found.line).toMatch(/^url\("?#k2b-line-scale-/);
});

test("in forced colors the scaled line takes the text colour, bars and bands the muted one", async () => {
  const found = await look(true);
  expect(found.line).toBe(found.text);
  expect(found.bar).toBe(found.muted);
  expect(found.band).toBe(found.muted);
  expect(found.line).not.toBe(found.bar);
});
