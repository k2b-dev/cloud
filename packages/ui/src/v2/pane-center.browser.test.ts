import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-pane-center.client";
import { measureV2Layout } from "./testing";
import { textEdge } from "./tokens";

// W2/W4 (the first start of Notebooks and Grids): with no notebook yet the page holds one line and four ways to start.
// Without help they stood at the left of a wide pane, the four cards in a grid made for five, and at its top. A pane
// with `center` holds its content in the middle at the measure of four cards and in the middle of the height where it
// fits; `Tiles perRow={4}` lets four share a row and grow with it. On the phone it starts at the top.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-pane-center.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (viewport: { width: number; height: number }, tiles: number, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui" data-tiles="${tiles}"><div id="root"></div></body></html>`,
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

const read = (page: Page) =>
  page.evaluate(() => {
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width };
    };
    const scroll = document.querySelector(".k2-pane > .k2-scroll")!;
    return {
      scroll: box(scroll),
      lead: box(document.querySelector(".k2-text")!),
      tiles: box(document.querySelector(".k2-tiles")!),
      tile: Array.from(document.querySelectorAll(".k2-tile")).map(box),
      overflows: scroll.scrollHeight > scroll.clientHeight,
    };
  });

// the measure of four cards of 240 px with their 12 px gaps, between the two text edges
const measure = (edge: number) => 4 * 240 + 3 * 12 + 2 * edge;

for (const width of [1440, 1920])
  test(`a centred pane holds one line and four cards in the middle of the page at ${width} px`, async () => {
    await withPage({ width, height: 900 }, 4, async (page) => {
      const found = await read(page);
      const edge = textEdge.wide;
      // in the middle across: as much room on the left as on the right, at the measure of four cards
      expect(Math.round(found.tiles.width)).toBe(measure(edge));
      expect(Math.abs(found.tiles.left - found.scroll.left - (found.scroll.right - found.tiles.right))).toBeLessThanOrEqual(1);
      // the line stands over the cards, on the same text edge, with room between them
      expect(Math.round(found.lead.left)).toBe(Math.round(found.tiles.left));
      expect(found.tiles.top - found.lead.bottom).toBeGreaterThanOrEqual(12);
      // four cards in one row, each at least 240 px, sharing the row evenly
      expect(new Set(found.tile.map((tile) => Math.round(tile.top))).size).toBe(1);
      for (const tile of found.tile) expect(tile.width).toBeGreaterThanOrEqual(240);
      // in the middle of the height: as much room above the line as below the cards
      const above = found.lead.top - found.scroll.top;
      const below = found.scroll.bottom - found.tiles.bottom;
      expect(above).toBeGreaterThan(100);
      expect(Math.abs(above - below)).toBeLessThanOrEqual(1);
      expect((await measureV2Layout(page, { root: "#root" })).problems).toEqual([]);
    });
  });

// W4 (Grids): beside Cloud's rail at 1024 px four cards fell into 3 + 1. Where four do not fit in one row, a row holds
// half of them: 2 × 2, both rows full; below 240 px they stand one under the other.
for (const variant of ["plain"] as const)
  for (const width of [900, 1024])
    test(`where four ${variant} tiles do not fit in one row at ${width} px, they stand 2 × 2, never 3 + 1`, async () => {
      await withPage({ width, height: 900 }, 4, async (page) => {
        const found = await read(page);
        const rows = new Map<number, number>();
        for (const tile of found.tile) rows.set(Math.round(tile.top), (rows.get(Math.round(tile.top)) ?? 0) + 1);
        expect([...rows.values()]).toEqual([2, 2]);
        for (const tile of found.tile) expect(tile.width).toBeGreaterThanOrEqual(240);
        expect((await measureV2Layout(page, { root: "#root" })).problems).toEqual([]);
      });
    });

test("a centred pane whose content is taller than the page starts at the top and scrolls, nothing cut away above", async () => {
  await withPage({ width: 1440, height: 400 }, 40, async (page) => {
    const found = await read(page);
    expect(found.overflows).toBe(true);
    // the line is the first thing under the top of the pane, as in any pane
    expect(Math.round(found.lead.top - found.scroll.top)).toBe(textEdge.wide);
    expect(new Set(found.tile.map((tile) => Math.round(tile.top))).size).toBe(10);
  });
});

test("on the phone a centred pane starts at the top with the normal edge and the cards under each other", async () => {
  await withPage({ width: 390, height: 844 }, 4, async (page) => {
    const found = await read(page);
    expect(Math.round(found.tiles.width)).toBe(390);
    // the text edge above it, so it never touches the head of the page; the cards a gap below
    expect(Math.round(found.lead.top - found.scroll.top)).toBe(textEdge.phone);
    expect(found.tiles.top - found.lead.bottom).toBeGreaterThanOrEqual(12);
    const lefts = new Set(found.tile.map((tile) => Math.round(tile.left)));
    expect(lefts).toEqual(new Set([textEdge.phone]));
    expect((await measureV2Layout(page, { root: "#root" })).problems).toEqual([]);
  });
});
