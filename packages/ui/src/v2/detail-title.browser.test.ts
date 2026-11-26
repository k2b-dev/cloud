import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-detail-title.client";
import { heights } from "./tokens";

// The title of an open entry in its detail's head (test/v2-detail-title.client.tsx, the worst case of Spaces): a long
// one takes two lines at most and ends in "…", its full words in the tooltip; a short one keeps the head's height.

const longTitle = "Lieferantenrechnungen aus dem Oktober prüfen, mit dem Lager abgleichen und an die Buchhaltung geben";

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-detail-title.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (width: number, run: (page: Page) => Promise<void>, short = false) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
    );
    if (short) await page.evaluate(() => Reflect.set(window, "__k2ShortTitle", true));
    await page.addScriptTag({ content: client });
    await page.waitForFunction(() => window.__k2Mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

/** The title in the detail's head: its lines, whether words are cut off, its tooltip, and the head around it. */
const head = (page: Page) =>
  page.evaluate(() => {
    const bar = document.querySelector('.k2-pane[data-detail] > [data-slot="head"] > .k2-bar')!;
    const title = bar.querySelector<HTMLElement>(".k2-bar-start > .k2-text")!;
    const box = title.getBoundingClientRect();
    const end = bar.querySelector(".k2-bar-end")!.getBoundingClientRect();
    return {
      lines: Math.round(box.height / Number.parseFloat(getComputedStyle(title).lineHeight)),
      cut: title.scrollHeight > title.clientHeight + 1 || title.scrollWidth > title.clientWidth + 1,
      tooltip: title.getAttribute("title"),
      beforeEnd: box.right <= end.left + 0.5,
      inside: box.bottom <= bar.getBoundingClientRect().bottom + 0.5,
      height: Math.round(bar.getBoundingClientRect().height),
    };
  });

for (const width of [1440, 390])
  test(`at ${width}: a long title in a detail's head takes two lines at most, the full words in its tooltip`, async () => {
    await withPage(width, async (page) => {
      const found = await head(page);
      expect(found.lines).toBe(2);
      expect(found.tooltip).toBe(longTitle);
      // the actions keep their place beside it, and the head grows around the two lines
      expect(found.beforeEnd).toBe(true);
      expect(found.inside).toBe(true);
      // on the phone the words run on beyond the second line: they end in "…"
      if (width === 390) expect(found.cut).toBe(true);
    });
  });

test("at 1440: a short title stays one line, and the head beside the list keeps the 52 px of the status row", async () => {
  await withPage(
    1440,
    async (page) => {
      const found = await head(page);
      expect(found.lines).toBe(1);
      expect(found.cut).toBe(false);
      expect(found.height).toBe(heights.status);
    },
    true,
  );
});
