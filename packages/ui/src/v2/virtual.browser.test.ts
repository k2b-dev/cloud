import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-virtual.client";

// The virtual window of v2 lists and tables (review of #4211): cells that live with their row, the reading place
// across a change of width, Tab out of a row that scrolled away, measured rows that are let go, a reveal by key. The
// page switches scroll anchoring off, as Safari has none, so the window itself must hold the place.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
/** Scrolling 40,000 px a frame at a time takes WebKit a few seconds. */
const TEST_TIMEOUT = 20_000;
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; } .k2-scroll, .k2-table-scroll { overflow-anchor: none; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-virtual.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

/** Counts the elements each ResizeObserver of the page watches now. */
const countObserved = () => {
  const observe = ResizeObserver.prototype.observe;
  const unobserve = ResizeObserver.prototype.unobserve;
  const disconnect = ResizeObserver.prototype.disconnect;
  const own = new Map<ResizeObserver, Set<Element>>();
  ResizeObserver.prototype.observe = function (target, options) {
    if (!own.has(this)) own.set(this, new Set());
    own.get(this)!.add(target);
    return observe.call(this, target, options);
  };
  ResizeObserver.prototype.unobserve = function (target) {
    own.get(this)?.delete(target);
    return unobserve.call(this, target);
  };
  ResizeObserver.prototype.disconnect = function () {
    own.delete(this);
    return disconnect.call(this);
  };
  (window as unknown as { __k2Watched: () => number }).__k2Watched = () => [...own.values()].reduce((sum, set) => sum + set.size, 0);
};

const withPage = async (run: (page: Page) => Promise<void>, width = 1200) => {
  const page = await browser.newPage({ viewport: { width, height: 700 } });
  page.setDefaultTimeout(3000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
    );
    await page.evaluate(countObserved);
    await page.addScriptTag({ content: client });
    await page.waitForFunction(() => window.__k2Mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

/** Scrolls a scroller step by step, a frame each, as a person does. */
const scrollTo = (page: Page, selector: string, top: number) =>
  page.evaluate(
    async ({ selector, top }) => {
      const scroller = document.querySelector<HTMLElement>(selector)!;
      while (Math.abs(scroller.scrollTop - top) > 1) {
        const step = Math.sign(top - scroller.scrollTop) * Math.min(400, Math.abs(top - scroller.scrollTop));
        const before = scroller.scrollTop;
        scroller.scrollTop += step;
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        if (scroller.scrollTop === before) break;
      }
    },
    { selector, top },
  );
/** The place of the first row whose bottom is in view: its position in the list and its distance to the top. */
const firstInView = (page: Page) =>
  page.evaluate(() => {
    const scroller = document.querySelector('.k2-pane[aria-label="Liste"] > .k2-scroll')!;
    const top = scroller.getBoundingClientRect().top;
    const row = [...scroller.querySelectorAll('[data-k2-part="Row"]')].find((each) => each.getBoundingClientRect().bottom > top + 1)!;
    return { at: row.getAttribute("aria-posinset"), top: Math.round(row.getBoundingClientRect().top - top) };
  });

test(
  "a table's cells beyond its first page show the live value after their row scrolled away and back",
  async () => {
    await withPage(async (page) => {
      const table = '.k2-pane[aria-label="Tabelle"] .k2-table-scroll';
      await scrollTo(page, table, 4000);
      await page.locator('[data-cell="r100"]').waitFor();
      await scrollTo(page, table, 0);
      await scrollTo(page, table, 4000);
      await page.locator('[data-cell="r100"]').waitFor();
      await page.evaluate(() => window.__k2Tick?.());
      expect(await page.locator('[data-cell="r100"]').textContent()).toBe("r100:1");
    });
  },
  TEST_TIMEOUT,
);

test(
  "a change of width keeps the first row in view where it was",
  async () => {
    await withPage(async (page) => {
      await scrollTo(page, '.k2-pane[aria-label="Liste"] > .k2-scroll', 12000);
      await settled(page);
      const before = await firstInView(page);
      await page.setViewportSize({ width: 820, height: 700 });
      await settled(page);
      const narrow = await firstInView(page);
      expect(narrow.at).toBe(before.at);
      await settled(page);
      await page.setViewportSize({ width: 1200, height: 700 });
      await settled(page);
      const after = await firstInView(page);
      expect(after.at).toBe(before.at);
      expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(2);
    });
  },
  TEST_TIMEOUT,
);

test(
  "Tab out of a focused row that scrolled away goes to the next row, not to the window",
  async () => {
    await withPage(async (page) => {
      await page.locator('a[href="#e7"]').focus();
      await scrollTo(page, '.k2-pane[aria-label="Liste"] > .k2-scroll', 30000);
      await settled(page);
      await page.keyboard.press("Tab");
      await settled(page);
      expect(await page.evaluate(() => document.activeElement?.getAttribute("href"))).toBe("#e8");
      await page.keyboard.press("Shift+Tab");
      expect(await page.evaluate(() => document.activeElement?.getAttribute("href"))).toBe("#e7");
    });
  },
  TEST_TIMEOUT,
);

test(
  "rows that leave the page are no longer measured",
  async () => {
    await withPage(async (page) => {
      await scrollTo(page, '.k2-pane[aria-label="Liste"] > .k2-scroll', 40000);
      await scrollTo(page, '.k2-pane[aria-label="Tabelle"] .k2-table-scroll', 6000);
      await settled(page);
      const watched = await page.evaluate(() => (window as unknown as { __k2Watched: () => number }).__k2Watched());
      const rows = await page.locator('[data-k2-part="Row"], .k2-table tbody tr').count();
      expect(watched).toBeLessThanOrEqual(rows + 20);
    });
  },
  TEST_TIMEOUT,
);

test(
  "a row far away is brought into view by its key, and its row is given back",
  async () => {
    await withPage(async (page) => {
      const row = await page.evaluate(() => {
        const element = window.__k2Reveal?.("e700");
        const view = document.querySelector('.k2-pane[aria-label="Liste"] > .k2-scroll')!.getBoundingClientRect();
        const box = element?.getBoundingClientRect();
        return {
          at: element?.getAttribute("aria-posinset") ?? null,
          inView: !!box && box.top >= view.top - 1 && box.bottom <= view.bottom + 1,
        };
      });
      expect(row).toEqual({ at: "700", inView: true });
    });
  },
  TEST_TIMEOUT,
);
