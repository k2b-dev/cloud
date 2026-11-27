import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";

const axeSource = readFileSync(Bun.resolveSync("axe-core/axe.min.js", import.meta.dir), "utf8");

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

const withPage = async (run: (page: Page) => Promise<void>, width = 1200, scenario = "") => {
  const page = await browser.newPage({ viewport: { width, height: 700 } });
  page.setDefaultTimeout(3000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui" data-case="${scenario}"><div id="root"></div></body></html>`,
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

// W1b (Files activity): entries under day heads. A head is text in 600 with a quiet count, no band and no line; it
// stands before the first entry of its group, also far down the list, and rows count among the rows only.
test(
  "a list of items stands under group heads: text and count, no band or line, kept in the window",
  async () => {
    await withPage(
      async (page) => {
        const head = page.locator('[data-k2-part="List"] .k2-list-head', { hasText: "Tag 1" }).first();
        await head.waitFor();
        const look = await head.evaluate((element) => {
          const style = getComputedStyle(element);
          const words = element.firstElementChild ? getComputedStyle(element.firstElementChild).fontWeight : style.fontWeight;
          return {
            weight: words,
            line: ["top", "bottom"].some((side) => Number.parseFloat(style.getPropertyValue(`border-${side}-width`)) > 0),
            band: style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.backgroundColor !== "transparent",
            next: element.nextElementSibling?.getAttribute("aria-posinset"),
            count: element.textContent?.includes("7"),
          };
        });
        expect(look).toEqual({ weight: "600", line: false, band: false, next: "1", count: true });
        // the eighth entry is the first of day 2 and the eighth row: heads do not count as rows
        expect(await page.evaluate(() => document.querySelector('a[href="#e8"]')?.parentElement?.getAttribute("aria-posinset"))).toBe("8");
        const revealed = await page.evaluate(() => window.__k2Reveal?.("e500")?.getAttribute("aria-posinset") ?? null);
        expect(revealed).toBe("500");
        await settled(page);
        // the head of day 72 (entries 498 to 504) stands right before entry 498
        const before498 = await page.evaluate(
          () => document.querySelector('a[href="#e498"]')?.parentElement?.previousElementSibling?.textContent ?? null,
        );
        expect(before498).toContain("Tag 72");
        expect(await page.locator('[data-k2-part="List"] > *').count()).toBeLessThan(120);
      },
      1200,
      "groups",
    );
  },
  TEST_TIMEOUT,
);

test(
  "a table of 1,000 rows in groups keeps only the rows in view, with their group rows",
  async () => {
    await withPage(
      async (page) => {
        expect(await page.locator(".k2-table tbody tr").count()).toBeLessThan(80);
        await scrollTo(page, '.k2-pane[aria-label="Tabelle"] > .k2-scroll', 20000);
        await settled(page);
        const rows = await page.locator(".k2-table tbody tr:not([data-spacer])").allTextContents();
        expect(rows.length).toBeLessThan(80);
        expect(rows.some((text) => /^Tag \d+/.test(text))).toBe(true);
      },
      1200,
      "groups",
    );
  },
  TEST_TIMEOUT,
);

// W4 (Grids): a base with 1,000 tables put 3,043 elements into its sidebar, which showed only the first screen of
// them. The entries scroll between the title and the foot, and a long group keeps only the entries in view.
test(
  "a sidebar group of 1,000 entries scrolls between title and foot and keeps only the entries in view",
  async () => {
    await withPage(
      async (page) => {
        const entries = page.locator('[data-k2-part="Nav"] [data-k2-part="Nav.Item"]');
        expect(await entries.count()).toBeLessThan(120);
        const scroller = await page.evaluate(() => {
          const nav = document.querySelector('[data-k2-part="Nav"]')!;
          const first = nav.querySelector('[data-k2-part="Nav.Item"]')!;
          let node = first.parentElement;
          while (node && node !== nav && getComputedStyle(node).overflowY !== "auto") node = node.parentElement;
          return node && node !== nav ? true : getComputedStyle(nav).overflowY === "auto";
        });
        expect(scroller).toBe(true);
        await page.locator('[data-k2-part="Nav"] [data-k2-part="Nav.Item"]').first().hover();
        for (let step = 0; step < 60; step++) await page.mouse.wheel(0, 2000);
        await page.locator('[data-k2-part="Nav.Item"]', { hasText: "Tabelle 1000" }).waitFor();
        expect(await page.locator('[data-k2-part="Nav.Item"]', { hasText: "Tabelle 1000" }).isVisible()).toBe(true);
        expect(await page.locator('[data-k2-part="Nav.Item"]', { hasText: "Papierkorb" }).isVisible()).toBe(true);
        expect(await entries.count()).toBeLessThan(120);
      },
      1200,
      "nav",
    );
  },
  TEST_TIMEOUT,
);

// Review of #4211: the neighbour of a parked row across a group head is the next row, never the head.
test(
  "Tab and Shift+Tab out of a parked row cross a group head to the next row",
  async () => {
    await withPage(
      async (page) => {
        const list = '.k2-pane[aria-label="Liste"] > .k2-scroll';
        const focused = () => page.evaluate(() => document.activeElement?.getAttribute("href") ?? document.activeElement?.tagName);
        await page.locator('a[href="#e7"]').focus();
        await scrollTo(page, list, 30000);
        await settled(page);
        await page.keyboard.press("Tab");
        await settled(page);
        expect(await focused()).toBe("#e8");
        await scrollTo(page, list, 30000);
        await settled(page);
        await page.keyboard.press("Shift+Tab");
        await settled(page);
        expect(await focused()).toBe("#e7");
      },
      1200,
      "groups",
    );
  },
  TEST_TIMEOUT,
);

// Review of #4211: the current page of a sidebar is always in the page and shown on load: in a long group, in an open
// fold of a long group (r2), two folds down (r3 P3), and in a short group without a window (r2 P3).
for (const [scenario, name] of [
  ["nav", "Tabelle 700"],
  ["navfold", "Archiv Tabelle 30"],
  ["navdeep", "Archiv 2025 Tabelle 30"],
  ["navshort", "Tabelle 38"],
] as const)
  test(
    `the current entry of a sidebar (${scenario}) is in the page and in view from the start`,
    async () => {
      await withPage(
        async (page) => {
          const current = page.locator('[data-k2-part="Nav"] [aria-current="page"]');
          await current.waitFor();
          await settled(page);
          expect(await current.textContent()).toContain(name);
          const inView = await current.evaluate((element) => {
            const scroller = element.closest(".k2-nav-scroll")!.getBoundingClientRect();
            const box = element.getBoundingClientRect();
            return box.top >= scroller.top - 1 && box.bottom <= scroller.bottom + 1
              ? true
              : `${Math.round(box.top)} in ${Math.round(scroller.top)}-${Math.round(scroller.bottom)} scrollTop ${element.closest(".k2-nav-scroll")!.scrollTop} height ${element.closest(".k2-nav-scroll")!.scrollHeight}`;
          });
          expect(inView).toBe(true);
        },
        1200,
        scenario,
      );
    },
    TEST_TIMEOUT,
  );

// Review of #4211: a group head stands in the list as no entry of it (role presentation); axe finds no fault in it.
test(
  "a list under group heads passes axe",
  async () => {
    await withPage(
      async (page) => {
        await page.addScriptTag({ content: axeSource });
        const violations = await page.evaluate(async () => {
          const axe = (
            window as unknown as {
              axe: {
                run: (context: unknown, options: unknown) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }>;
              };
            }
          ).axe;
          const result = await axe.run(
            { include: [['[data-k2-part="List"]']] },
            {
              runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
              resultTypes: ["violations"],
            },
          );
          return result.violations.map(
            (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`,
          );
        });
        expect(violations).toEqual([]);
      },
      1200,
      "groups",
    );
  },
  TEST_TIMEOUT,
);

// W1b (Files, "Alle Ablagen" with #4340): in a main column with its context column under it, the split scrolls, not the
// column's own scroller, and the window took the whole list (201 rows at 1440 px). The window follows what really scrolls.
test(
  "a list in a main column whose context column stands under it keeps only the rows in view, and its window follows the scroll",
  async () => {
    await withPage(
      async (page) => {
        const shown = () => page.locator('.k2-pane[aria-label="Liste"] [data-k2-part="Row"]').count();
        // the context stands under the list: the split is what scrolls
        expect(await page.locator(".k2-split[data-context]").evaluate((split) => split.scrollHeight > split.clientHeight + 1)).toBe(true);
        expect(await shown()).toBeLessThan(80);
        await scrollTo(page, ".k2-split[data-context]", 20000);
        await settled(page);
        expect(await shown()).toBeLessThan(80);
        const first = await page.evaluate(() => {
          const top = document.querySelector(".k2-split[data-context]")!.getBoundingClientRect().top;
          const row = [...document.querySelectorAll('.k2-pane[aria-label="Liste"] [data-k2-part="Row"]')].find(
            (each) => each.getBoundingClientRect().bottom > top + 1,
          );
          return Number(row?.getAttribute("aria-posinset") ?? 0);
        });
        // the rows in view are the ones far down the list, not the first ones
        expect(first).toBeGreaterThan(300);
      },
      1440,
      "context",
    );
  },
  TEST_TIMEOUT,
);
