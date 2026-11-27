import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-nested-split.client";
import { measureV2Layout } from "./testing";

// A split inside a column (Files, pairing; a record's detail with its info column): nothing runs past the window, and
// every grip stands centred on a line of 1 px, at the widths of a tablet and a desktop (W1b, #4229: the detail ended at
// 1027 px in a window of 1024). The column asks the workspace for what the panes of its split need beside each other;
// a detail counts through the workspace's declared `detail`, so the sidebar does not jump when it opens; a split in a
// dialog asks for nothing. The fixture is test/v2-nested-split.client.tsx.

type Kind = "files" | "inner" | "dialog" | "record";

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0 0 0 66px; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-nested-split.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (kind: Kind, width: number, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
    );
    await page.addScriptTag({ content: `window.__k2Case = ${JSON.stringify(kind)};` });
    await page.addScriptTag({ content: client });
    await page.waitForFunction(() => window.__k2Mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

/** Whether the sidebar stands as a column (not a drawer). */
const sidebar = (page: Page) => page.evaluate(() => (document.querySelector(".k2-ws-side")?.getClientRects().length ?? 0) > 0);
const past = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-k2-workspace] *")]
      .filter((element) => element.getClientRects().length > 0 && element.getBoundingClientRect().right > innerWidth + 0.5)
      .map(
        (element) => `${element.tagName.toLowerCase()}.${element.className} ends at ${Math.round(element.getBoundingClientRect().right)}`,
      )
      .slice(0, 5),
  );

for (const [kind, widths] of [
  ["files", [1024, 1100, 1280, 1440]],
  ["inner", [1024, 1100, 1280, 1440]],
  ["record", [1024, 1440, 1680, 1920]],
] as const)
  for (const width of widths)
    test(`${kind} at ${width} px: nothing runs past the window, and every grip stands centred on its line`, async () => {
      await withPage(kind, width, async (page) => {
        expect([kind, width, await past(page)]).toEqual([kind, width, []]);
        const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
        expect([kind, width, layout.problems.filter((problem) => problem.startsWith("grip"))]).toEqual([kind, width, []]);
      });
    }, 30_000);

test("a split inside a column without a detail: the column asks for what its panes need, so the sidebar gives way at 1024 px", async () => {
  // 248 + 1 + (320 + 1 + 400) = 970 px beside the sidebar; the workspace has 958 px at a window of 1024
  for (const [width, column] of [
    [1024, false],
    [1100, true],
  ] as const)
    await withPage("inner", width, async (page) => {
      expect([width, await sidebar(page)]).toEqual([width, column]);
    });
});

test("a detail in a split inside a column opens and closes without moving the sidebar", async () => {
  for (const width of [800, 1024, 1036, 1100, 1440])
    await withPage("files", width, async (page) => {
      const open = await sidebar(page);
      await page.evaluate(() => window.__k2Detail?.(false));
      await page.waitForFunction(() => !document.querySelector('section[aria-label="Ansicht"]'));
      await settled(page);
      const closed = await sidebar(page);
      await page.evaluate(() => window.__k2Detail?.(true));
      await page.waitForFunction(() => document.querySelector('section[aria-label="Ansicht"]') !== null);
      await settled(page);
      expect([width, closed, await sidebar(page)]).toEqual([width, open, open]);
    });
});

test("a split in an open dialog asks the workspace behind it for no room", async () => {
  // the column behind needs 400 px: 248 + 1 + 400 fits in the 958 px of a window of 1024, with the dialog open too
  await withPage("dialog", 1024, async (page) => {
    await page.locator(".k2-dialog").waitFor();
    expect(await sidebar(page)).toBe(true);
  });
});
