import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-row-action.client";

// A row's deed was named by its words alone ("Ansehen"), so a list of ten rows read "Ansehen" ten times. Row names the
// deed by its words and then the row's title (WCAG 2.5.3: the visible words come first); the app names nothing itself.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-row-action.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (width: number, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
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

for (const width of [1440, 390])
  test(`each row's deed is named by its words and then its row's title at ${width} px`, async () => {
    await withPage(width, async (page) => {
      // the visible words first, then what the deed is about; a title of JSX is read as its words
      await page.getByRole("button", { name: "Ansehen Angebot Küche Lindqvist", exact: true }).waitFor();
      await page.getByRole("button", { name: "Ansehen Angebot Esstisch Brandner", exact: true }).waitFor();
      // the words a person sees stay the words on the button
      const words = await page.locator(".k2-row .k2-btn .k2-btn-label").allTextContents();
      expect(words.map((word) => word.trim())).toEqual(["Ansehen", "Ansehen"]);
    });
  });

// PS (PWA review): on the phone a row's deed with words ("Abmelden") stood 28 px tall, under the 44 px a finger needs.
// It keeps its look and its place; a finger hits 44 px of it.
test("on the phone a row's deed takes a finger's 44 px without moving", async () => {
  await withPage(390, async (page) => {
    const hits = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>(".k2-row[data-action] > .k2-row-end > .k2-btn:first-child")).map((button) => {
        const box = button.getBoundingClientRect();
        const x = box.left + box.width / 2;
        const middle = box.top + box.height / 2;
        // what a finger 22 px above and below the middle of the deed lands on
        const at = (y: number) => document.elementFromPoint(x, y)?.closest(".k2-btn") === button;
        return { height: Math.round(box.height), above: at(middle - 21), below: at(middle + 21) };
      }),
    );
    expect(hits.length).toBe(2);
    for (const hit of hits) {
      expect(hit.height).toBeLessThan(44);
      expect(hit).toEqual(expect.objectContaining({ above: true, below: true }));
    }
  });
});
