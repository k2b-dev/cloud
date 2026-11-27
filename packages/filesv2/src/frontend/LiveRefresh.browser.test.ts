import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../ui/test/browser";
import { fixture, longDirectory } from "./Pagination.browser-fixture";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: fixture });
  browser = await launchBrowser();
}, 30000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

// #3991: a folder poll that brings a change (one file renamed) updates that row only. The other rows keep their
// elements, so the list keeps its scroll position and a focused control in a row keeps its focus.
for (const width of [1440, 390])
  describe(`a folder of 60 files at ${width}px`, () => {
    let context: BrowserContext;
    let tab: Page;
    let errors: string[];
    // The page is the fixture: loading it and its first rendering belong to setup, not to the 5 s of the test.
    // WebKit's first rendering of a new page took 3.7 s at 1440x700 in CI's image (0.7 s at 390), which left the test
    // too little time for the behavior it checks (#4189).
    beforeAll(async () => {
      context = await browser.newContext({ viewport: { width, height: 700 }, reducedMotion: "reduce" });
      tab = await context.newPage();
      errors = pageErrors(tab);
      await tab.clock.install();
      await tab.goto(new URL("app/filesv2?base=demo&sort=name&order=asc&type=all&groupFolders=true&rows=60", server.url).href);
      await tab.locator(".filesv2-list__row:not(.filesv2-list__row--virtual)").nth(59).waitFor();
      await settled(tab);
    }, 30000);
    afterAll(async () => {
      await context?.close();
    });

    test("a changed folder poll keeps scroll and focus", async () => {
      const rows = tab.locator(".filesv2-list__row:not(.filesv2-list__row--virtual)");
      const row = rows.filter({ hasText: "Datei 40.txt" });
      const details = row.locator(".filesv2-list__info");
      await details.focus();
      await settled(tab);
      // The nearest ancestor that scrolls the list, whichever box that is at this width.
      const scroller = await row.evaluateHandle((element) => {
        for (let node = element.parentElement; node; node = node.parentElement)
          if (node.scrollHeight > node.clientHeight && /(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node;
        return document.scrollingElement!;
      });
      const scrollTop = await scroller.evaluate((element) => element.scrollTop);
      expect(scrollTop).toBeGreaterThan(0);
      await details.evaluate((element) => ((element as HTMLElement & { marked?: boolean }).marked = true));

      let polled = 0;
      await tab.route("**/api/filesv2/bases/demo/entries?**", async (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.get("type") === "directories") return route.fulfill({ json: { ...longDirectory(60, true), items: [] } });
        polled += 1;
        return route.fulfill({ json: longDirectory(60, true) });
      });
      await tab.clock.runFor(20_000);
      await rows.filter({ hasText: "Umbenannt 01.txt" }).waitFor();
      await settled(tab);

      expect(polled).toBeGreaterThan(0);
      expect(await scroller.evaluate((element) => element.scrollTop)).toBe(scrollTop);
      expect(await tab.evaluate(() => (document.activeElement as HTMLElement & { marked?: boolean }).marked === true)).toBe(true);
      expect(await details.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(errors).toEqual([]);
    });
  });
