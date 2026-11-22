import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser } from "playwright";
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
  test(`a changed folder poll keeps scroll and focus at ${width}px`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 700 }, reducedMotion: "reduce" });
    const tab = await context.newPage();
    const errors = pageErrors(tab);
    try {
      await tab.clock.install();
      await tab.goto(new URL("app/filesv2?base=demo&sort=name&order=asc&type=all&groupFolders=true&rows=60", server.url).href);
      const rows = tab.locator(".filesv2-list__row:not(.filesv2-list__row--virtual)");
      await rows.nth(59).waitFor();
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
    } finally {
      await context.close();
    }
  });
