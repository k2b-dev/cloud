import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-quiet-state.client";

// A quiet state (`Chip status quiet`, test/v2-quiet-state.client.tsx): the dot in the colour of its state and the word
// in the ink of the text, without the tinted round of a chip, on the same height as a chip, named by its word.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-quiet-state.client.tsx", "dom"), launchBrowser()]);
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
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

for (const width of [1440, 390])
  test(`at ${width}: a quiet state is its coloured dot and its word in the ink of the text, as high as a chip`, async () => {
    await withPage(width, async (page) => {
      const found = await page.evaluate(() => {
        const ink = getComputedStyle(document.querySelector(".k2-row-l1")!).color;
        const chips = [...document.querySelectorAll('[data-k2-part="Chip"]')];
        return {
          ink,
          states: chips.map((chip) => {
            const style = getComputedStyle(chip);
            return {
              word: chip.textContent,
              background: style.backgroundColor,
              color: style.color,
              dot: getComputedStyle(chip.querySelector(".k2-dot")!).backgroundColor,
              height: Math.round(chip.getBoundingClientRect().height),
            };
          }),
        };
      });
      const [aktiv, verzug, gestoppt, loud] = found.states;
      // the colour only on the dot, in the tone of the state
      expect([aktiv!.dot, verzug!.dot, gestoppt!.dot]).toEqual(["rgb(16, 185, 129)", "rgb(245, 158, 11)", "rgb(239, 68, 68)"]);
      for (const quiet of [aktiv!, verzug!, gestoppt!]) {
        expect(quiet.background).toBe("rgba(0, 0, 0, 0)");
        expect(quiet.color).toBe(found.ink);
        expect(quiet.height).toBe(loud!.height);
      }
      // the full chip beside them keeps its tinted round
      expect(loud!.background).not.toBe("rgba(0, 0, 0, 0)");
      // the word carries the meaning: the dot says nothing of its own
      expect(await page.getByText("Verzug", { exact: true }).count()).toBe(1);
      expect(
        await page
          .locator('[data-k2-part="Chip"][data-quiet] .k2-dot')
          .evaluateAll((dots) => dots.map((dot) => dot.getAttribute("aria-label"))),
      ).toEqual([null, null, null]);
    });
  });
