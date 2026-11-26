import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-state-timeline.client";

// The state timeline on a v2 screen (test/v2-state-timeline.client.tsx: long lane names, eight states with their own
// colours), as lane C found it in gateway-ops (#4205): a state's colour wins over the series colour, in its regions and
// in the legend; lane names and the legend stay inside the chart at every width.

const css = `${readFileSync(resolve(import.meta.dir, "../v2/v2.css"), "utf8")}\n${readFileSync(resolve(import.meta.dir, "../styles/chart.css"), "utf8")}`;
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-state-timeline.client.tsx", "dom"), launchBrowser()]);
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
    await page.locator(".k2b-chart__svg > svg").waitFor();
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

for (const width of [1440, 390])
  test(`at ${width}: a state's own colour fills its regions and its swatch in the legend`, async () => {
    await withPage(width, async (page) => {
      const fills = await page.evaluate(() => {
        const chart = document.querySelector(".k2b-chart__svg > svg")!;
        const region = (state: string) =>
          [...chart.querySelectorAll(".stdlib-chart-state-region")].find((rect) =>
            rect.closest("[aria-label]")?.getAttribute("aria-label")?.endsWith(state),
          );
        const swatches = [...chart.closest(".k2b-chart")!.querySelectorAll(".stdlib-chart-legend rect, .k2b-chart__legend rect")].map(
          (rect) => getComputedStyle(rect).fill,
        );
        return {
          failed: region("Fehlgeschlagen") ? getComputedStyle(region("Fehlgeschlagen")!).fill : "none",
          ok: region("Erfolgreich") ? getComputedStyle(region("Erfolgreich")!).fill : "none",
          swatches: swatches.slice(0, 4),
        };
      });
      expect(fills.failed).toBe("rgb(239, 68, 68)");
      expect(fills.ok).toBe("rgb(16, 185, 129)");
      expect(fills.swatches).toEqual(["rgb(16, 185, 129)", "rgb(239, 68, 68)", "rgb(59, 130, 246)", "rgb(245, 158, 11)"]);
    });
  });

for (const width of [1440, 390])
  test(`at ${width}: lane names and the legend stay inside the chart, every lane and every state shown`, async () => {
    await withPage(width, async (page) => {
      const found = await page.evaluate(() => {
        const host = document.querySelector(".k2b-chart")!;
        const box = host.getBoundingClientRect();
        const svg = host.querySelector(".k2b-chart__svg > svg")!;
        const at = (rect: DOMRect) =>
          `${Math.round(rect.left - box.left)}..${Math.round(rect.right - box.left)} of ${Math.round(box.width)}`;
        const plotLeft = Math.min(
          ...[...svg.querySelectorAll(".stdlib-chart-state-region")].map((rect) => rect.getBoundingClientRect().left),
        );
        // The right edge of what a lane name paints: its own end, or the clip of the group it stands in.
        const paintedRight = (text: Element) => {
          let right = text.getBoundingClientRect().right;
          for (let node = text.parentElement; node && node !== svg; node = node.parentElement) {
            const id = /url\(#([^)]+)\)/.exec(node.getAttribute("clip-path") ?? "")?.[1];
            const shape = id ? svg.querySelector<SVGRectElement>(`[id="${id}"] rect`) : null;
            const matrix = node instanceof SVGGraphicsElement ? node.getScreenCTM() : null;
            if (shape && matrix)
              right = Math.min(right, new DOMPoint(shape.x.baseVal.value + shape.width.baseVal.value, 0).matrixTransform(matrix).x);
          }
          return right;
        };
        const lanes = [...svg.querySelectorAll(".stdlib-chart-state-label")];
        const lanesOutside = lanes
          .filter((text) => text.getBoundingClientRect().left < box.left - 0.5 || paintedRight(text) > plotLeft + 0.5)
          .map(
            (text) =>
              `${text.textContent} ${at(text.getBoundingClientRect())}, painted to ${Math.round(paintedRight(text) - box.left)}, plot from ${Math.round(plotLeft - box.left)}`,
          );
        const outside = [...svg.querySelectorAll("text:not(.stdlib-chart-state-label)")]
          .map((text) => ({ text: text.textContent ?? "", rect: text.getBoundingClientRect() }))
          .filter(({ rect }) => rect.width > 0 && (rect.left < box.left - 0.5 || rect.right > box.right + 0.5))
          .map(({ text, rect }) => `${text} ${at(rect)}`);
        // The legend's entries, wherever the chart draws them, each whole in the chart and in view.
        const legend = [...host.querySelectorAll(".k2b-chart__legend-item, .stdlib-chart-legend text")];
        const scrollport = host.querySelector(".k2b-chart__legend")?.getBoundingClientRect() ?? box;
        const legendOutside = legend
          .map((entry) => ({ text: entry.textContent ?? "", rect: entry.getBoundingClientRect() }))
          .filter(
            ({ rect }) =>
              rect.left < box.left - 0.5 ||
              rect.right > box.right + 0.5 ||
              rect.top < scrollport.top - 0.5 ||
              rect.bottom > Math.min(scrollport.bottom, box.bottom) + 0.5,
          )
          .map(({ text, rect }) => `${text} ${at(rect)}`);
        return { lanesOutside, outside, legendOutside, lanes: lanes.length, legend: legend.length };
      });
      expect(found.lanesOutside).toEqual([]);
      expect(found.outside).toEqual([]);
      expect(found.legendOutside).toEqual([]);
      expect(found.lanes).toBe(6);
      expect(found.legend).toBe(8);
    });
  });
