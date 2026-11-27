import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import { textEdge } from "./tokens";

// The widths a column keeps (W4, Grids): a column with `width` gives up its minimum on the phone, a search that is
// the head of a column fills it, and a main column that needs more than 400 px says so with `min`, so the sidebar
// becomes a drawer where both columns do not fit beside it. The fixture is test/v2-pane-fit.fixture.tsx.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; } .case { position: relative; height: 640px; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
let server: { html: string; script: string };
const temp = mkdtempSync(resolve(tmpdir(), "k2-v2-pane-fit-"));
beforeAll(async () => {
  const serverFile = resolve(temp, "server.js");
  await Bun.write(serverFile, await bundleV2Entry("v2-pane-fit.server.tsx", "ssr"));
  const { render }: { render: () => { html: string; script: string } } = await import(serverFile);
  server = render();
  [client, browser] = await Promise.all([bundleV2Entry("v2-pane-fit.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
  rmSync(temp, { recursive: true, force: true });
});

/** The page as the server sent it; with `live` hydrated, which fails on any node the client would make differently. */
const withPage = async (width: number, live: boolean, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${server.script}<style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root">${server.html}</div></body></html>`,
    );
    if (live) {
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

const box = (page: Page, selector: string) =>
  page.evaluate((selector) => {
    const found = document.querySelector(selector)?.getBoundingClientRect();
    return found ? { left: Math.round(found.left), right: Math.round(found.right), width: Math.round(found.width) } : null;
  }, selector);
const shown = (page: Page, selector: string) =>
  page.evaluate((selector) => {
    const found = document.querySelector(selector);
    return !!found && found.getClientRects().length > 0;
  }, selector);

for (const live of [false, true]) {
  const when = live ? "after the page came alive" : "as the server sent it";

  test(`the phone, 390 px, ${when}: a column with a minimum of 480 px is as wide as the window and shows its table as rows`, async () => {
    await withPage(390, live, async (page) => {
      expect(await box(page, 'section[aria-label="Tabellen"]')).toEqual({ left: 0, right: 390, width: 390 });
      expect(await shown(page, 'section[aria-label="Tabellen"] .k2-table-phone')).toBe(true);
      expect(await shown(page, 'section[aria-label="Tabellen"] .k2-table-scroll')).toBe(false);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    });
  });

  test(`1440 px, ${when}: a search that is the head of a column fills it from edge to edge`, async () => {
    await withPage(1440, live, async (page) => {
      for (const name of ["Abfragen", "Tabellen"]) {
        const pane = await box(page, `section[aria-label="${name}"]`);
        const search = await box(page, `section[aria-label="${name}"] > [data-slot="head"] .k2-input[data-search]`);
        expect([name, search?.left, search?.right]).toEqual([name, pane!.left + textEdge.wide, pane!.right - textEdge.wide]);
      }
    });
  });

  // 248 + 1 + 320 + 1 + 640 = 1210 px; with the 400 px of a column without `min` it would be 970 px
  for (const [width, column] of [
    [1024, false],
    [1200, false],
    [1280, true],
  ] as const)
    test(`${width} px, ${when}: beside a main column that keeps 640 px the sidebar is ${column ? "a column" : "a drawer"}`, async () => {
      await withPage(width, live, async (page) => {
        expect(await shown(page, '[data-case="queries"] .k2-ws-side')).toBe(column);
        expect(await shown(page, '[data-case="queries"] .k2-ws-toggle')).toBe(!column);
        expect((await box(page, 'section[aria-label="Abfrage"]'))!.width).toBeGreaterThanOrEqual(640);
      });
    });
}

test("nothing moves when the page comes alive", async () => {
  const places = (page: Page) =>
    page.evaluate(() =>
      [".k2-ws-side", ".k2-ws-toggle", 'section[aria-label="Abfragen"]', 'section[aria-label="Abfrage"]', ".k2-input[data-search]"].map(
        (selector) => {
          const found = document.querySelector(`[data-case="queries"] ${selector}`)?.getBoundingClientRect();
          return found && found.width > 0 ? [Math.round(found.x), Math.round(found.width)] : null;
        },
      ),
    );
  for (const width of [390, 1024, 1440]) {
    let before: Awaited<ReturnType<typeof places>> = [];
    await withPage(width, false, async (page) => {
      before = await places(page);
    });
    await withPage(width, true, async (page) => {
      expect([width, await places(page)]).toEqual([width, before]);
    });
  }
});
