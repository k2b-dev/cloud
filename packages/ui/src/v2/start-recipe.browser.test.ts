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

// The words are measured in the real IBM Plex Sans the app ships (packages/ui/dist), not in a wider fallback font, so
// the guard says what a person sees.
const dist = resolve(import.meta.dir, "../../dist");
const html = (body: string) =>
  `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/plex.css"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui">${body}</body></html>`;

const open = async (width: number, state?: string): Promise<{ page: Page; errors: string[] }> => {
  const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width < 768, isMobile: width < 768 });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  await page.route("http://k2-start.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") return route.fulfill({ contentType: "text/html", body: html('<div id="root"></div>') });
    return route.fulfill({ path: resolve(dist, `.${path}`) });
  });
  await page.goto("http://k2-start.test/");
  await page.addScriptTag({ content: `window.__recipe = ${JSON.stringify({ name: "start.tsx", state })};` });
  await page.addScriptTag({ content: bundle });
  await page.waitForFunction(() => window.__mounted === true);
  await page.evaluate(async () => {
    await Promise.all(["400 12px", "500 14px", "600 14px"].map((font) => document.fonts.load(`${font} 'IBM Plex Sans'`)));
  });
  await settled(page);
  return { page, errors };
};

for (const state of [undefined, "grids"])
  for (const width of [1440, 390])
    test(`start.tsx ${state ?? "default"} at ${width} px: no preview cell, card name or quiet line is cut, no name breaks in a word`, async () => {
      const { page, errors } = await open(width, state);
      try {
        const found = await page.evaluate(() => {
          const shown = (element: Element) => getComputedStyle(element).display !== "none";
          const cells = [...document.querySelectorAll(".k2-tile-pv-table :is(th, td)")].filter(shown);
          // a name of one word that does not fit ends in "…" by design; every other name and quiet line reads whole
          const names = [...document.querySelectorAll(".k2-tile-title:not([data-one-word]) > .k2-row-open, .k2-tile-meta")];
          const oneWord = [...document.querySelectorAll(".k2-tile-title[data-one-word] > .k2-row-open")];
          const cut = (element: Element) =>
            element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1;
          return {
            cells: cells.length,
            cutCells: cells.filter(cut).map((cell) => cell.textContent),
            cutNames: names.filter(cut).map((name) => name.textContent),
            oneWordStyle: [
              ...new Set(oneWord.map((name) => `${getComputedStyle(name).whiteSpace} ${getComputedStyle(name).textOverflow}`)),
            ],
            // a name never breaks inside a word: each line of it starts at a word
            midWord: [...document.querySelectorAll(".k2-tile-title:not([data-one-word]) > .k2-row-open")]
              .filter((name) => {
                const text = name.firstChild;
                if (!text || text.nodeType !== Node.TEXT_NODE) return false;
                const range = document.createRange();
                const words = (text.textContent ?? "").split(/(\s+)/);
                let at = 0;
                for (const word of words) {
                  if (word.trim()) {
                    range.setStart(text, at);
                    range.setEnd(text, at + word.length);
                    if (range.getClientRects().length > 1) return true;
                  }
                  at += word.length;
                }
                return false;
              })
              .map((name) => name.textContent),
          };
        });
        expect(found.cells).toBeGreaterThan(0);
        expect(found.cutCells).toEqual([]);
        expect(found.cutNames).toEqual([]);
        expect(found.midWord).toEqual([]);
        for (const style of found.oneWordStyle) expect(style).toBe("nowrap ellipsis");
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
