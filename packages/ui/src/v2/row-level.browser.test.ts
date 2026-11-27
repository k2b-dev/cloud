import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-row-level.client";
import { measureV2Layout } from "./testing";

// Rows at a depth outside a tree, such as the headings of a note: each level stands one step further in, at most five
// steps, and assistive technology hears the level; nothing folds.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-row-level.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (width: number, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width < 768, isMobile: width < 768 });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
    );
    await page.addScriptTag({ content: client });
    await page.waitForFunction(() => window.__k2Mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

/** Level, start of the title and whether it is cut, for each row of the outline. */
const rows = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[aria-label="Inhalt"] > .k2-row, [aria-label="Ohne Ebene"] > .k2-row')].map((row) => {
      const title = row.querySelector<HTMLElement>(".k2-row-title") ?? row;
      return {
        level: row.getAttribute("aria-level"),
        start: Math.round(title.getBoundingClientRect().left - row.getBoundingClientRect().left),
        overflows: title.scrollWidth > title.clientWidth + 1,
        inside: row.getBoundingClientRect().right <= document.documentElement.clientWidth + 0.5,
      };
    }),
  );

for (const width of [1440, 390]) {
  test(`rows at a level: each level one step further in, heard as aria-level, a long sixth stays in the column (${width} px)`, async () => {
    await withPage(width, async (page) => {
      const found = await rows(page);
      expect(found.map((row) => row.level)).toEqual(["1", "2", "3", "4", "5", "6", "2", null]);
      const [one, two, three, four, five, six, again, plain] = found;
      // one step per level, the same step everywhere
      const step = two!.start - one!.start;
      // the content step of the token, the same as a Table tree row's
      expect(step).toBe(20);
      expect(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--k2-level-step").trim())).toBe("20px");
      expect([three!.start, four!.start, five!.start, six!.start]).toEqual([
        one!.start + 2 * step,
        one!.start + 3 * step,
        one!.start + 4 * step,
        one!.start + 5 * step,
      ]);
      expect(again!.start).toBe(two!.start);
      // the first level and a row without one start at the column's edge
      expect(plain!.start).toBe(one!.start);
      // the long title of the sixth level breaks like any row's title and stays whole in the column
      expect(six!.overflows).toBe(false);
      expect(found.every((row) => row.inside)).toBe(true);
      // a level is no tree: nothing folds
      expect(await page.locator("[aria-expanded]").count()).toBe(0);
      const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
      expect(layout.problems).toEqual([]);
    });
  });
}
