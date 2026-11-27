import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-nested-split.client";
import { measureV2Layout } from "./testing";

// A split inside a column (Files, pairing; a record's detail with its info column): nothing runs past the window, and
// every grip stands centred on a line of 1 px, at the widths of a tablet and a desktop (W1b, #4229: the detail ended at
// 1027 px in a window of 1024, and the grip of its line stood 1 px off a line 3 px wide).

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0 0 0 66px; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-nested-split.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (kind: "files" | "record", width: number, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
    );
    await page.addScriptTag({ content: `window.__k2Case = ${JSON.stringify(kind)};` });
    await page.addScriptTag({ content: client });
    await page.waitForFunction(() => window.__k2Mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

for (const [kind, widths] of [
  ["files", [1024, 1100, 1280, 1440]],
  ["record", [1024, 1440, 1680, 1920]],
] as const)
  for (const width of widths)
    test(`${kind} at ${width} px: nothing runs past the window, and every grip stands centred on its line`, async () => {
      await withPage(kind, width, async (page) => {
        const past = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>("[data-k2-workspace] *")]
            .filter((element) => element.getClientRects().length > 0 && element.getBoundingClientRect().right > innerWidth + 0.5)
            .map(
              (element) =>
                `${element.tagName.toLowerCase()}.${element.className} ends at ${Math.round(element.getBoundingClientRect().right)}`,
            )
            .slice(0, 5),
        );
        expect([kind, width, past]).toEqual([kind, width, []]);
        const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
        expect([kind, width, layout.problems.filter((problem) => problem.startsWith("grip"))]).toEqual([kind, width, []]);
      });
    }, 30_000);
