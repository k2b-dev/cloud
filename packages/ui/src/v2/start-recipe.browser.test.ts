import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-recipes.entry";

// The first start (recipe start.tsx, review of #4505): a preview cell cut with "…" reads as cheap, so the values a
// recipe teaches are short enough that no visible cell of any preview is cut, at 1440 px and on the phone, in Notebooks'
// default and in the Grids state. A card's name reads whole too (two lines on the phone).

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let bundle: string;
beforeAll(async () => {
  [bundle, browser] = await Promise.all([demoBundle("../v2-recipes"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const open = async (width: number, state?: string): Promise<{ page: Page; errors: string[] }> => {
  const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width < 768, isMobile: width < 768 });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  await page.setContent(
    `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
  );
  await page.addScriptTag({ content: `window.__recipe = ${JSON.stringify({ name: "start.tsx", state })};` });
  await page.addScriptTag({ content: bundle });
  await page.waitForFunction(() => window.__mounted === true);
  await settled(page);
  return { page, errors };
};

for (const state of [undefined, "grids"])
  for (const width of [1440, 390])
    test(`start.tsx ${state ?? "default"} at ${width} px: no preview cell and no card name is cut`, async () => {
      const { page, errors } = await open(width, state);
      try {
        const found = await page.evaluate(() => {
          const shown = (element: Element) => getComputedStyle(element).display !== "none";
          const cells = [...document.querySelectorAll(".k2-tile-pv-table :is(th, td)")].filter(shown);
          const names = [...document.querySelectorAll(".k2-tile-title > .k2-row-open")];
          const cut = (element: Element) =>
            element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1;
          return {
            cells: cells.length,
            cutCells: cells.filter(cut).map((cell) => cell.textContent),
            cutNames: names.filter(cut).map((name) => name.textContent),
          };
        });
        expect(found.cells).toBeGreaterThan(0);
        expect(found.cutCells).toEqual([]);
        expect(found.cutNames).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
