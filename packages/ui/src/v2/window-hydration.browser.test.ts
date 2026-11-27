import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-window-hydration.client";
import type { Kind } from "../../test/v2-window-hydration.fixture";

// A list or table with a window is rendered on the server and hydrated in the browser (review of #4211): the server
// sends the first 40 entries, group heads counted, and the browser's first render must be the same nodes, or the
// development build of Solid throws. Nothing the server sent moves when the page comes alive.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
let server: (kind: Kind) => { html: string; script: string };
const temp = mkdtempSync(resolve(tmpdir(), "k2-v2-window-hydration-"));
beforeAll(async () => {
  const serverFile = resolve(temp, "server.js");
  await Bun.write(serverFile, await bundleV2Entry("v2-window-hydration.server.tsx", "ssr"));
  ({ render: server } = (await import(serverFile)) as { render: typeof server });
  [client, browser] = await Promise.all([bundleV2Entry("v2-window-hydration.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
  rmSync(temp, { recursive: true, force: true });
});

/** The boxes of the first entries in the page (rows, table rows, sidebar entries), rounded. */
const boxes = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-k2-part="Row"], .k2-table tbody tr, .k2-ni'))
      .filter((element) => element.getBoundingClientRect().height > 0)
      .slice(0, 15)
      .map((element) => {
        const box = element.getBoundingClientRect();
        return `${element.textContent?.trim().slice(0, 16)} ${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}`;
      }),
  );

const hydrated = async (kind: Kind, width: number, run: (page: Page, before: string[]) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(3000);
  const errors = pageErrors(page);
  const { html, script } = server(kind);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8">${script}<style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root">${html}</div></body></html>`,
    );
    const before = await boxes(page);
    await page.addScriptTag({ content: `window.__k2Kind = ${JSON.stringify(kind)};` });
    await page.addScriptTag({ content: client }).catch(() => undefined);
    // a node the client makes differently throws in hydration: the page never says it is done
    await page.waitForFunction(() => window.__k2Hydrated === true).catch(() => undefined);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => window.__k2Hydrated === true)).toBe(true);
    await settled(page);
    await run(page, before);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

const kinds: { kind: Kind; width: number; what: string }[] = [
  { kind: "groups", width: 1440, what: "a list of 60 entries under group heads" },
  { kind: "forty", width: 1440, what: "a list of 40 entries (no window)" },
  { kind: "fortyone", width: 1440, what: "a list of 41 entries (a window)" },
  { kind: "table", width: 1440, what: "a grouped table whose first page holds 37 of its 38 rows" },
  { kind: "phone", width: 390, what: "a grouped table in its phone form" },
];

for (const { kind, width, what } of kinds)
  test(`${what} hydrates without a mismatch, and nothing the server sent moves`, async () => {
    await hydrated(kind, width, async (page, before) => {
      expect(before.length).toBeGreaterThan(0);
      expect(await boxes(page)).toEqual(before);
    });
  });

test("a sidebar of 1,000 entries whose current one is far down hydrates without a mismatch and shows it", async () => {
  await hydrated("nav", 1440, async (page) => {
    const current = page.locator('.k2-ni[aria-current="page"]');
    expect(await current.textContent()).toContain("Tabelle 700");
    // on load the sidebar brings its current page into view
    const seen = await current.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return box.top >= 0 && box.bottom <= window.innerHeight;
    });
    expect(seen).toBe(true);
  });
});
