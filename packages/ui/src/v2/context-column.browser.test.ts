import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-context.client";
import type { Kind } from "../../test/v2-context.fixture";
import { measureV2Layout } from "./testing";

// The context column (`Pane side`) stands beside the main column only where its split holds both: the main column at
// its minimum and the context at its default width. With less it gives way to the end of the main column, in the flow of
// the split, so the main column is never squeezed and nothing is hidden. The same primitive serves a context column
// beside a form (`form`), one beside a table that needs a large screen (`table`, `side={{ from: 1400 }}`) and a detail
// that becomes two columns under its one head on a large screen (`detail`). The split's own rule decides from its width,
// so the server's page and the live one are the same. The window is set like Cloud's shell, 66 px beside the workspace.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0 0 0 66px; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
let server: (kind: Kind) => { html: string; script: string };
const temp = mkdtempSync(resolve(tmpdir(), "k2-v2-context-"));
beforeAll(async () => {
  const serverFile = resolve(temp, "server.js");
  await Bun.write(serverFile, await bundleV2Entry("v2-context.server.tsx", "ssr"));
  ({ render: server } = (await import(serverFile)) as { render: typeof server });
  [client, browser] = await Promise.all([bundleV2Entry("v2-context.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
  rmSync(temp, { recursive: true, force: true });
});

type Box = { x: number; y: number; width: number; height: number };
const boxOf = (page: Page, selector: string): Promise<Box | null> =>
  page.evaluate((selector) => {
    const found = document.querySelector(selector)?.getBoundingClientRect();
    return found
      ? { x: Math.round(found.x), y: Math.round(found.y), width: Math.round(found.width), height: Math.round(found.height) }
      : null;
  }, selector);
/** The main column of the split that holds the context column, and the context column itself. */
const mainOf = (kind: Kind) => (kind === "detail" ? 'section[aria-label="Was sie ist"]' : 'section[aria-label="Haupt"]');
const side = 'section[aria-label="Kontext"]';

/** The page as the server sent it; with `live` hydrated over it, which fails on any node the client makes differently. */
const withPage = async (width: number, kind: Kind, live: boolean, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  const { html, script } = server(kind);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${script}<style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root">${html}</div></body></html>`,
    );
    if (live) {
      await page.addScriptTag({ content: `window.__k2Kind = ${JSON.stringify(kind)};` });
      await page.addScriptTag({ content: client });
      await page.waitForFunction(() => window.__k2Hydrated === true);
    }
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

/** Beside: the context column at its default width (its line included) right of the main column, both from the top. */
const expectBeside = (where: string, mainBox: Box, sideBox: Box, sideWidth: number) => {
  expect([where, sideBox.y]).toEqual([where, mainBox.y]);
  expect([where, sideBox.x >= mainBox.x + mainBox.width]).toEqual([where, true]);
  expect([where, sideBox.width]).toEqual([where, sideWidth - 1]);
  // the main column keeps at least its minimum beside it
  expect([where, mainBox.width >= 400]).toEqual([where, true]);
};

/** Given way: the context column under the main column, as wide as it, and the main column as wide as the split. */
const expectBelow = async (where: string, page: Page, mainBox: Box, sideBox: Box) => {
  const split = await boxOf(page, ".k2-split[data-context]");
  if (!split) throw new Error(`${where}: the split is missing`);
  expect([where, sideBox.x, sideBox.width]).toEqual([where, mainBox.x, mainBox.width]);
  expect([where, mainBox.width]).toEqual([where, split.width]);
  // right under the main column and its line: no empty band between them, also when the main column is short
  expect([where, sideBox.y - (mainBox.y + mainBox.height)]).toEqual([where, 1]);
  // nothing is hidden: the column scrolls in one piece, and at its end the context column is in view
  await page.locator(side).scrollIntoViewIfNeeded();
  const after = await boxOf(page, side);
  expect([where, after !== null && after.y < 800 && after.y + Math.min(after.height, 100) <= 800]).toEqual([where, true]);
  // no grip on a line that moves nothing
  expect([where, await page.locator(".k2-split[data-context] > .k2-seam .k2-grip").locator("visible=true").count()]).toEqual([where, 0]);
};

/** The split that holds the context column: how far it scrolls and how far its content reaches. */
const scrollOf = (page: Page) =>
  page.evaluate(() => {
    const split = document.querySelector('section[aria-label="Kontext"]')?.parentElement;
    if (!split) throw new Error("no split");
    return { top: split.scrollTop, height: split.scrollHeight, client: split.clientHeight, bottom: split.getBoundingClientRect().bottom };
  });

const cases: { kind: Kind; width: number; beside: boolean }[] = [
  { kind: "form", width: 1024, beside: false },
  { kind: "form", width: 1440, beside: true },
  { kind: "form", width: 1920, beside: true },
  { kind: "short", width: 1024, beside: false },
  { kind: "table", width: 1024, beside: false },
  { kind: "table", width: 1440, beside: false },
  { kind: "table", width: 1920, beside: true },
  { kind: "detail", width: 1440, beside: false },
  { kind: "detail", width: 1680, beside: true },
  { kind: "detail", width: 1920, beside: true },
];

describe("a context column stands beside its main column only where there is room", () => {
  for (const { kind, width, beside } of cases)
    test(`${kind} at ${width} px: ${beside ? "beside" : "at the end of the main column"}, the same before and after hydration`, async () => {
      const seen: unknown[] = [];
      for (const live of [false, true])
        await withPage(width, kind, live, async (page) => {
          const where = `${kind} ${width} px ${live ? "live" : "server"}`;
          const mainBox = await boxOf(page, mainOf(kind));
          const sideBox = await boxOf(page, side);
          if (!mainBox || !sideBox) throw new Error(`${where}: a column is missing`);
          seen.push([mainBox, sideBox]);
          // the page as it opens keeps the v2 rules; below, the column is scrolled to the context
          const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
          expect([where, layout.problems]).toEqual([where, []]);
          expect([where, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)]).toEqual([where, true]);
          if (beside) expectBeside(where, mainBox, sideBox, kind === "detail" ? 320 : 340);
          else await expectBelow(where, page, mainBox, sideBox);
        });
      // the server's page and the live one put the columns in the same places
      expect(seen[1]).toEqual(seen[0]);
    }, 30_000);

  test("side by side, a wheel over the line scrolls nothing: the split is no scroller there", async () => {
    await withPage(1440, "form", true, async (page) => {
      const seam = await boxOf(page, ".k2-split[data-context] > .k2-seam");
      if (!seam) throw new Error("no line");
      await page.mouse.move(seam.x, seam.y + 200);
      await page.mouse.wheel(0, 2000);
      await settled(page);
      const scroll = await scrollOf(page);
      expect([scroll.top, scroll.height <= scroll.client]).toEqual([0, true]);
    });
  }, 30_000);

  test("given way, the split scrolls to the end of its content and no further", async () => {
    await withPage(1024, "form", true, async (page) => {
      await page.evaluate(() => {
        const split = document.querySelector('section[aria-label="Kontext"]')?.parentElement;
        if (split) split.scrollTop = 1_000_000;
      });
      await settled(page);
      const scroll = await scrollOf(page);
      const context = await boxOf(page, side);
      expect(scroll.top).toBe(scroll.height - scroll.client);
      // the end of the context column is the end of the scroller: no empty run below it
      expect(Math.abs((context?.y ?? 0) + (context?.height ?? 0) - scroll.bottom) <= 1).toBe(true);
    });
  }, 30_000);

  test("a column a grip made wider never makes the context wrap above its room; columns shrink as in every split", async () => {
    await withPage(1400, "form", true, async (page) => {
      await page.locator(".k2-split[data-context] > .k2-seam .k2-grip").focus();
      await page.keyboard.press("End");
      await settled(page);
      await page.setViewportSize({ width: 1320, height: 800 });
      await settled(page);
      const mainBox = await boxOf(page, mainOf("form"));
      const sideBox = await boxOf(page, side);
      expect([sideBox?.y, (sideBox?.x ?? 0) >= (mainBox?.x ?? 0) + (mainBox?.width ?? 0)]).toEqual([mainBox?.y, true]);
    });
  }, 30_000);

  test("a list, its reader and an info column stay as every split: beside each other, no rule of its own", async () => {
    for (const width of [1024, 1440])
      await withPage(width, "three", true, async (page) => {
        const where = `three ${width} px`;
        expect([where, await page.locator(".k2-split[data-context]").count(), await page.locator("style[data-k2-rule]").count()]).toEqual([
          where,
          0,
          0,
        ]);
        const reader = await boxOf(page, 'section[aria-label="Haupt"]');
        const info = await boxOf(page, side);
        expect([where, info?.y, (info?.x ?? 0) >= (reader?.x ?? 0) + (reader?.width ?? 0)]).toEqual([where, reader?.y, true]);
      });
  }, 30_000);
});
