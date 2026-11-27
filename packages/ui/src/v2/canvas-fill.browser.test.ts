import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-canvas-fill.client";

// A drawing that is the whole pane (`Canvas height="fill"`, test/v2-canvas-fill.client.tsx): a chat column with a
// history that scrolls in its own scroller and a composer under it. The pane ends on the screen, the composer stays in
// sight, the history scrolls inside, and the page does not scroll: alone in its pane and in a split, 1440 and 390 px.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
// the page of the test, and the chat's own CSS: inside a Canvas, CSS is free
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }" +
  ".chat { display: flex; flex-direction: column; min-height: 0; } .chat-history { flex: 1; min-height: 0; overflow: auto; }" +
  ".chat-message { margin: 0; padding: 8px 16px; } .chat-composer { margin: 8px 16px; flex-shrink: 0; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-canvas-fill.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (width: number, layout: "pane" | "split", run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
    );
    await page.evaluate((layout) => Object.assign(window, { __k2Layout: layout }), layout);
    await page.addScriptTag({ content: client });
    await page.waitForFunction(() => window.__k2Mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

for (const layout of ["pane", "split"] as const)
  for (const width of [1440, 390])
    test(`${layout} at ${width}: a chat that is the whole pane keeps its composer in sight and scrolls its history inside`, async () => {
      await withPage(width, layout, async (page) => {
        const where = () =>
          page.evaluate(() => {
            const pane = document.querySelector(".k2-canvas[data-fill]")!.closest(".k2-pane")!.getBoundingClientRect();
            const composer = document.querySelector(".chat-composer")!.getBoundingClientRect();
            const history = document.querySelector<HTMLElement>(".chat-history")!;
            return {
              pane: pane.bottom <= innerHeight + 0.5,
              composer: composer.top >= 0 && composer.bottom <= innerHeight + 0.5,
              tall: history.scrollHeight > history.clientHeight + 100,
              page: document.scrollingElement!.scrollHeight <= innerHeight,
              scrolled: history.scrollTop,
            };
          });
        expect(await where()).toEqual({ pane: true, composer: true, tall: true, page: true, scrolled: 0 });
        // the history scrolls in its own scroller, and the composer stays where it was
        const before = await page.locator(".chat-composer").boundingBox();
        await page.mouse.move(width / 2, 300);
        await page.mouse.wheel(0, 1500);
        await page.waitForFunction(() => document.querySelector<HTMLElement>(".chat-history")!.scrollTop > 0);
        const after = await where();
        expect(after.scrolled).toBeGreaterThan(0);
        expect(after.composer).toBe(true);
        expect((await page.locator(".chat-composer").boundingBox())?.y).toBe(before?.y);
      });
    });
