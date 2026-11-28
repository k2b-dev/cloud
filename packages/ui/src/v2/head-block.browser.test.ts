import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-head-block.client";
import type { Kind } from "../../test/v2-head-block.fixture";
import { measureV2Layout } from "./testing";

// Look rules 30 and 31 (Valentin 27.11.): a pane's head and its status row are one block, with one line under it and no
// line between its rows; where the pane is wide (1200 px and more), or the head holds actions only, they stand in one
// row. The head's search is its symbol on every width and opens in place when pressed. And a row of one line keeps its
// height when it carries a deed beside its time. All of it is decided while the parts are made: the server's page and
// the live one show the same. The window is set like Cloud's shell, 66 px beside the workspace.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0 0 0 66px; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
let server: (kind: Kind) => { html: string; script: string };
const temp = mkdtempSync(resolve(tmpdir(), "k2-v2-head-block-"));
beforeAll(async () => {
  const serverFile = resolve(temp, "server.js");
  await Bun.write(serverFile, await bundleV2Entry("v2-head-block.server.tsx", "ssr"));
  ({ render: server } = (await import(serverFile)) as { render: typeof server });
  [client, browser] = await Promise.all([bundleV2Entry("v2-head-block.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
  rmSync(temp, { recursive: true, force: true });
});

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
      await page.addScriptTag({ content: `window.__k2HeadKind = ${JSON.stringify(kind)};` });
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

type Box = { x: number; y: number; width: number; height: number };
const boxOf = (page: Page, selector: string): Promise<Box | null> =>
  page.evaluate((selector) => {
    const found = document.querySelector(selector)?.getBoundingClientRect();
    return found
      ? { x: Math.round(found.x), y: Math.round(found.y), width: Math.round(found.width), height: Math.round(found.height) }
      : null;
  }, selector);
const middle = (box: Box | null) => (box ? box.y + box.height / 2 : Number.NaN);

/** Lines across the head block (a control's frame is no line): the head's, the status row's, the block's own. */
const linesOf = (page: Page) =>
  page.evaluate(() => {
    const block = document.querySelector<HTMLElement>('.k2-pane > [data-slot="head"]');
    if (!block) throw new Error("no head");
    const pane = block.parentElement!.getBoundingClientRect();
    return [block, ...block.querySelectorAll<HTMLElement>("*")].filter((element) => {
      const style = getComputedStyle(element);
      const drawn = style.display !== "contents" && parseFloat(style.borderBottomWidth) > 0 && style.borderBottomStyle !== "none";
      return drawn && element.getBoundingClientRect().width >= pane.width * 0.8;
    }).length;
  });

const path = '.k2-pane > [data-slot="head"] [data-k2-part="Path"]';
const filter = '.k2-pane > [data-slot="head"] [data-slot="status"] .k2-status-lead';
const search = '.k2-pane > [data-slot="head"] .k2-input[data-search]';

describe("a pane's head and its status row are one block", () => {
  // the fixture has no sidebar: its pane is the window less the shell's 66 px, wide from a window of 1266 px
  for (const live of [false, true])
    for (const [width, oneRow] of [
      [390, false],
      [1024, false],
      [1440, true],
      [1920, true],
    ] as const)
      test(`with a path at ${width}px ${oneRow ? "in one row" : "in two rows"} (${live ? "hydrated" : "server"})`, async () => {
        await withPage(width, "path", live, async (page) => {
          const gap = middle(await boxOf(page, filter)) - middle(await boxOf(page, path));
          if (oneRow) expect(Math.abs(gap)).toBeLessThan(4);
          // two rows: the status row under the head; from 768 px close together (a head of 48 px over a row of 44)
          else expect(gap).toBeGreaterThan(30);
          if (!oneRow && width >= 768) expect(gap).toBeLessThan(52);
          expect(await linesOf(page)).toBe(1);
          if (width > 390) expect((await measureV2Layout(page, { root: "#root" })).problems).toEqual([]);
        });
      });

  for (const width of [390, 1440])
    test(`a head of actions only shares the status row's row at ${width}px`, async () => {
      await withPage(width, "actions", true, async (page) => {
        expect(Math.abs(middle(await boxOf(page, search)) - middle(await boxOf(page, filter)))).toBeLessThan(8);
        expect(await linesOf(page)).toBe(1);
      });
    });
});

describe("a line of state under a head is no toolbar", () => {
  for (const width of [1440, 1920])
    test(`a plain bar under the head keeps its own row and line at ${width}px`, async () => {
      await withPage(width, "state", true, async (page) => {
        expect(await page.locator('.k2-pane > [data-slot="head"]').getAttribute("data-block")).toBeNull();
        const head = await boxOf(page, '.k2-pane > [data-slot="head"] > .k2-bar');
        const state = await boxOf(page, '.k2-pane > [data-slot="status"] > .k2-bar');
        expect(state!.y).toBeGreaterThanOrEqual(head!.y + head!.height);
      });
    });
});

describe("the head's bar stays one box with the toolbar in it", () => {
  for (const width of [1440, 1920])
    test(`with room, nothing folds into "…" at ${width}px`, async () => {
      await withPage(width, "path", true, async (page) => {
        for (const name of ["Teilen", "Laden"])
          expect(await page.locator('.k2-pane > [data-slot="head"] .k2-bar-end').getByRole("button", { name }).isVisible()).toBe(true);
        expect(await page.locator('.k2-pane > [data-slot="head"] .k2-bar-fold').count()).toBe(0);
      });
    });

  test("the Tab key goes as the eye does: path, toolbar, then the head's actions", async () => {
    await withPage(1920, "path", true, async (page) => {
      await page.locator('.k2-pane > [data-slot="head"] [data-k2-part="Path"] a').first().focus();
      const lefts: number[] = [];
      for (let step = 0; step < 6; step++) {
        lefts.push(await page.evaluate(() => Math.round(document.activeElement!.getBoundingClientRect().left)));
        await page.keyboard.press("Tab");
      }
      expect(lefts).toEqual([...lefts].sort((a, b) => a - b));
      expect(new Set(lefts).size).toBe(lefts.length);
    });
  });
});

describe("the head's search is its symbol on every width", () => {
  test("it opens over its place when pressed, keeps its words, and folds back when empty", async () => {
    await withPage(1440, "path", true, async (page) => {
      const field = page.locator(`${search} > input`);
      expect((await boxOf(page, search))?.width).toBe(36);
      expect(await field.getAttribute("title")).toBe("Suchen");
      // nothing beside it moves or folds while it opens: it grows to the left over its place
      const neighbours = () =>
        Promise.all([
          boxOf(page, '.k2-pane > [data-slot="head"] .k2-bar-end > .k2-btn:nth-of-type(1)'),
          boxOf(page, '.k2-pane > [data-slot="head"] .k2-bar-end > .k2-btn:nth-of-type(3)'),
          boxOf(page, filter),
        ]);
      const before = await neighbours();
      await field.click();
      expect((await boxOf(page, search))?.width).toBeGreaterThan(100);
      expect(await neighbours()).toEqual(before);
      await field.fill("Angebot");
      await page.keyboard.press("Tab");
      // its words keep it open
      expect((await boxOf(page, search))?.width).toBeGreaterThan(100);
      await field.fill("");
      await page.keyboard.press("Tab");
      expect((await boxOf(page, search))?.width).toBe(36);
    });
  });

  test('"/" opens it where nobody types', async () => {
    await withPage(1440, "path", true, async (page) => {
      await page.locator("body").click({ position: { x: 600, y: 500 } });
      await page.keyboard.press("/");
      expect(await page.evaluate(() => document.activeElement?.closest(".k2-input[data-search]") !== null)).toBe(true);
      expect((await boxOf(page, search))?.width).toBeGreaterThan(100);
    });
  });

  for (const live of [false, true])
    test(`words from the address keep it open on the server's page alone and after it (${live ? "hydrated" : "server"})`, async () => {
      await withPage(1440, "filled", live, async (page) => {
        expect((await boxOf(page, search))?.width).toBeGreaterThan(100);
        expect(await page.locator(`${search} > input`).inputValue()).toBe("Angebot");
        if (!live) return;
        // a caller that empties the field itself: it folds once the focus leaves
        await page.locator(`${search} > input`).focus();
        await page.evaluate(() => {
          (document.querySelector(".k2-input[data-search] > input") as HTMLInputElement).value = "";
        });
        await page.keyboard.press("Tab");
        expect((await boxOf(page, search))?.width).toBe(36);
      });
    });

  test("a search with more at its end (a filter, as Mail's) keeps its field from 768 px", async () => {
    await withPage(1440, "withEnd", true, async (page) => {
      expect((await boxOf(page, search))?.width).toBe(184);
      expect(await page.getByRole("button", { name: "Filter der Suche" }).isVisible()).toBe(true);
    });
  });
});

// The case DR's #4470 moves into the pane's first row: shared here so both pull requests check the same page.
describe("a workspace head of actions only above a pane's toolbar", () => {
  for (const width of [390, 1024, 1440])
    test(`keeps the page whole at ${width}px`, async () => {
      await withPage(width, "workspace", true, async (page) => {
        expect(await page.locator(".k2-status-lead").isVisible()).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (width > 390) expect((await measureV2Layout(page, { root: "#root" })).problems).toEqual([]);
      });
    });
});

describe("a row of one line keeps its height beside its deed", () => {
  test("on the desktop the time stands before the deed, in the same line as every row's", async () => {
    await withPage(1440, "rows", true, async (page) => {
      const rows = await page.locator(".k2-list > .k2-row").evaluateAll((elements) =>
        elements.map((row) => {
          const box = (selector: string) => row.querySelector(selector)?.getBoundingClientRect() ?? null;
          const time = box(".k2-row-time");
          const deed = box(".k2-row-end");
          return { height: Math.round(row.getBoundingClientRect().height), time, deed };
        }),
      );
      // every row as tall as a row with its time alone (the third: a time, no deed)
      expect(rows.map((row) => row.height)).toEqual(rows.map(() => rows[2]!.height));
      const both = rows[0]!;
      expect(both.time!.right).toBeLessThanOrEqual(both.deed!.left);
      expect(Math.abs(both.time!.top + both.time!.height / 2 - (both.deed!.top + both.deed!.height / 2))).toBeLessThan(4);
      expect((await measureV2Layout(page, { root: "#root" })).problems).toEqual([]);
    });
  });
  test("on the phone the deed takes the row under the text, never over the time", async () => {
    await withPage(390, "rows", true, async (page) => {
      const row = page.locator(".k2-list > .k2-row").first();
      const time = (await row.locator(".k2-row-time").boundingBox())!;
      const deed = (await row.locator(".k2-row-end").boundingBox())!;
      expect(deed.y).toBeGreaterThanOrEqual(time.y + time.height - 1);
    });
  });
});
