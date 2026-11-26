import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import type {} from "../../test/v2-assistant-day.client";
import { bundleV2Entry } from "../../test/v2-bundle";

// A day of an assistant's runs in a state timeline on a v2 screen (test/v2-assistant-day.client.tsx), as lane W7 draws
// the Assistant's day line: the present moment the page passes is a thin line with its word, runs of seconds stay
// visible and keep their links, and runs still to come are outlines that say "geplant".

const css = `${readFileSync(resolve(import.meta.dir, "../v2/v2.css"), "utf8")}\n${readFileSync(resolve(import.meta.dir, "../styles/chart.css"), "utf8")}`;
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-assistant-day.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (width: number, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
    );
    await page.addScriptTag({ content: client });
    await page.waitForFunction(() => window.__k2Mounted === true);
    await page.locator(".k2-canvas > .k2b-chart > .k2b-chart__svg > svg").waitFor();
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

const svg = ".k2-canvas > .k2b-chart > .k2b-chart__svg > svg";

for (const width of [1440, 390]) {
  test(`at ${width}: now is a thin line at the time the page gives, its word whole on the time axis, clear of the controls`, async () => {
    await withPage(width, async (page) => {
      const look = await page.evaluate((selector) => {
        const chart = document.querySelector<SVGSVGElement>(selector)!;
        const line = chart.querySelector<SVGLineElement>(".stdlib-chart-state-now")!;
        const label = chart.querySelector<SVGTextElement>(".stdlib-chart-state-now-label")!;
        // the run that is still going ends now
        const running = [...chart.querySelectorAll<SVGRectElement>(".stdlib-chart-state-region")].find((rect) =>
          rect.closest("[aria-label]")?.getAttribute("aria-label")?.startsWith("Wochenrückblick schreiben"),
        )!;
        const box = chart.getBoundingClientRect();
        const word = label.getBoundingClientRect();
        return {
          text: label.textContent,
          // the word in the colour of its line
          inkOfLine: getComputedStyle(label).fill === getComputedStyle(line).stroke,
          atNow: Math.abs(line.getBoundingClientRect().left - running.getBoundingClientRect().right),
          thin: line.getBoundingClientRect().width <= 1.5,
          whole: word.left >= box.left && word.right <= box.right && word.top >= box.top,
          over: line.getBoundingClientRect().top < running.getBoundingClientRect().top,
          // on the time axis, below the lanes, clear of the controls above them and of the other axis labels
          onAxis: word.top >= running.getBoundingClientRect().bottom,
          clear: [...chart.querySelectorAll<SVGTextElement>(".stdlib-chart-heatmap-label:not(.stdlib-chart-state-now-label)")].every(
            (tick) => {
              const other = tick.getBoundingClientRect();
              return other.right <= word.left || other.left >= word.right || other.bottom <= word.top || other.top >= word.bottom;
            },
          ),
          free: [...(chart.closest(".k2b-chart")?.querySelectorAll("button") ?? [])].every((button) => {
            const other = button.getBoundingClientRect();
            return other.right <= word.left || other.left >= word.right || other.bottom <= word.top || other.top >= word.bottom;
          }),
        };
      }, svg);
      expect(look.text).toBe("Jetzt");
      expect(look.inkOfLine).toBe(true);
      expect(look.atNow).toBeLessThanOrEqual(1);
      expect(look.thin).toBe(true);
      expect(look.whole).toBe(true);
      expect(look.over).toBe(true);
      expect(look.onAxis).toBe(true);
      expect(look.clear).toBe(true);
      expect(look.free).toBe(true);
    });
  });

  test(`at ${width}: a run of seconds stays visible and keeps its link and hint`, async () => {
    await withPage(width, async (page) => {
      const runs = await page.evaluate((selector) => {
        const chart = document.querySelector<SVGSVGElement>(selector)!;
        return [...chart.querySelectorAll<SVGRectElement>(".stdlib-chart-state-region")].map((rect) => ({
          name: rect.closest("[aria-label]")?.getAttribute("aria-label") ?? "",
          units: rect.width.baseVal.value,
          pixels: rect.getBoundingClientRect().width,
        }));
      }, svg);
      // every run, also one of a second on a day, is at least 3 units and about 2 px wide
      expect(runs.length).toBe(16);
      for (const run of runs) {
        expect(run.units).toBeGreaterThanOrEqual(3);
        expect(run.pixels).toBeGreaterThanOrEqual(2);
      }
      // the morning report of four seconds opens its run and says when and how long
      const report = page.locator(`${svg} a[href="/app/assistant/runs/70"]`);
      expect(await report.getAttribute("data-chart-tooltip")).toBe("07:00 · 4 s");
      expect(await report.getAttribute("aria-label")).toBe("Morgenbericht, Erfolgreich");
    });
  });

  test(`at ${width}: a run still to come is an outline in its state's colour that says "geplant", and the legend names it`, async () => {
    await withPage(width, async (page) => {
      const planned = await page.evaluate((selector) => {
        const chart = document.querySelector<SVGSVGElement>(selector)!;
        return [...chart.querySelectorAll<SVGRectElement>(".stdlib-chart-state-region[data-planned]")].map((rect) => {
          const style = getComputedStyle(rect);
          return {
            name: rect.closest("[aria-label]")?.getAttribute("aria-label") ?? "",
            stroke: style.stroke,
            dashed: style.strokeDasharray !== "none",
            faint: Number(style.fillOpacity) < 0.2,
          };
        });
      }, svg);
      expect(planned.length).toBe(6);
      for (const run of planned) {
        expect(run.name.endsWith(", Steht an, geplant")).toBe(true);
        expect(run.stroke).toBe("rgb(100, 116, 139)");
        expect(run.dashed).toBe(true);
        expect(run.faint).toBe(true);
      }
      // a run that happened stays filled
      const done = await page
        .locator(`${svg} a[href="/app/assistant/runs/70"] .stdlib-chart-state-region`)
        .evaluate((rect) => Number(getComputedStyle(rect).fillOpacity));
      expect(done).toBe(1);
      expect(await page.locator(".k2b-chart__legend-item").allTextContents()).toEqual([
        "Erfolgreich",
        "Fehlgeschlagen",
        "Läuft",
        "Steht an",
        "Geplant",
      ]);
    });
  });
}
