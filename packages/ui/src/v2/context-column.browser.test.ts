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
  expect([where, sideBox.y >= mainBox.y + mainBox.height]).toEqual([where, true]);
  // nothing is hidden: the column scrolls in one piece, and at its end the context column is in view
  await page.locator(side).scrollIntoViewIfNeeded();
  const after = await boxOf(page, side);
  expect([where, after !== null && after.y < 800 && after.y + Math.min(after.height, 100) <= 800]).toEqual([where, true]);
  // no grip on a line that moves nothing
  expect([where, await page.locator(".k2-split[data-context] > .k2-seam .k2-grip").locator("visible=true").count()]).toEqual([where, 0]);
};

const cases: { kind: Kind; width: number; beside: boolean }[] = [
  { kind: "form", width: 1024, beside: false },
  { kind: "form", width: 1440, beside: true },
  { kind: "form", width: 1920, beside: true },
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
});
