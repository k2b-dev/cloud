import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-chart-axes.client";

// The labels of a chart's two axes meet at the corner where the axes meet: the lowest value left of the value axis,
// the first time under the time axis (test/v2-chart-axes.client.tsx: Pulse and Venue draw "0" or "10" beside
// "07:00"). No two labels of a chart draw over each other, at the widths of a desktop and a phone and in Canvases of
// different heights.

const css = `${readFileSync(resolve(import.meta.dir, "../v2/v2.css"), "utf8")}\n${readFileSync(resolve(import.meta.dir, "../styles/chart.css"), "utf8")}`;
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-chart-axes.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (width: number, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width, height: 1200 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
    );
    await page.addScriptTag({ content: client });
    await page.waitForFunction(() => window.__k2Mounted === true);
    await page.locator(".k2b-chart__svg > svg").first().waitFor();
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

for (const width of [1440, 390])
  test(`at ${width}: no two axis labels of a chart draw over each other, at the corner either`, async () => {
    await withPage(width, async (page) => {
      const overlaps = await page.evaluate(() =>
        [...document.querySelectorAll(".k2b-chart")].flatMap((chart) => {
          const name = chart.closest(".k2-sec")?.querySelector("h3")?.textContent ?? "";
          const labels = [...chart.querySelectorAll(".k2b-chart__svg text.stdlib-chart-tick-label")]
            .filter((text) => Number(getComputedStyle(text).opacity) > 0 && text.textContent)
            .map((text) => ({ text: text.textContent ?? "", box: text.getBoundingClientRect() }));
          const found: string[] = [];
          for (let a = 0; a < labels.length; a++)
            for (let b = a + 1; b < labels.length; b++) {
              const one = labels[a]!.box;
              const two = labels[b]!.box;
              const across = Math.min(one.right, two.right) - Math.max(one.left, two.left);
              const down = Math.min(one.bottom, two.bottom) - Math.max(one.top, two.top);
              if (across > 0.5 && down > 0.5) found.push(`${name}: "${labels[a]!.text}" and "${labels[b]!.text}"`);
            }
          return found;
        }),
      );
      expect(overlaps).toEqual([]);
    });
  });
