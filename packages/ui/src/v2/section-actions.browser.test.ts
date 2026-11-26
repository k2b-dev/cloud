import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-section-actions.client";
import { measureV2Layout } from "./testing";
import { textEdge } from "./tokens";

// W2 (26.11.): on the phone a section's deeds keep only their symbol, and the rule hid their words with
// `display: none`, so a deed lost its name for assistive technology, and a deed without a symbol showed nothing at all.
// A section's deed keeps its name at every width; one without a symbol keeps its words in sight.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-section-actions.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (width: number, run: (page: Page) => Promise<void>, which = "") => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui" data-case="${which}"><div id="root"></div></body></html>`,
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

for (const width of [390, 1440])
  test(`a section's deeds keep their names at ${width} px; one without a symbol keeps its words`, async () => {
    await withPage(width, async (page) => {
      for (const name of ["Neuer Vorgang", "Alle ansehen"]) {
        const deed = page.getByRole("button", { name, exact: true });
        expect(await deed.isVisible()).toBe(true);
      }
      const shown = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".k2-sh .k2-btn")).map((button) => {
          const words = button.querySelector(".k2-btn-label")!.getBoundingClientRect();
          return { name: button.textContent?.trim(), words: words.width > 1 && words.height > 1 };
        }),
      );
      // on the phone the deed with a symbol shows only the symbol; the one without keeps its words
      expect(shown).toEqual([
        { name: "Neuer Vorgang", words: width >= 768 },
        { name: "Alle ansehen", words: true },
      ]);
    });
  });

// S2 (Core admin): tabs in a detail's status slot stood on the edge of the pane instead of the text edge, unlike the
// same tabs as the head of a pane.
for (const width of [390, 1440])
  test(`tabs in a detail's status slot start on the text edge at ${width} px`, async () => {
    await withPage(
      width,
      async (page) => {
        const inset = await page.evaluate(() => {
          const tab = document.querySelector("[data-slot='status'] .k2-tab")!.getBoundingClientRect();
          const pane = document.querySelector(".k2-pane[data-detail]")!.getBoundingClientRect();
          return Math.round(tab.left - pane.left);
        });
        expect(inset).toBe(width < textEdge.phoneBelow ? textEdge.phone : textEdge.wide);
        expect((await measureV2Layout(page, { root: "#root" })).problems).toEqual([]);
      },
      "status-tabs",
    );
  });
