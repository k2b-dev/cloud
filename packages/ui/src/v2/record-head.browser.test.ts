import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-record-head.client";

// A record's head on the phone (W8, Weather at 390 px with a long place name): avatar, name and the head's actions
// stand in one row, the name cut with "…"; only kinds that find no room beside the name take a second row. Before,
// avatar, name and "…" took a row each (about 140 px). The fixture is test/v2-record-head.client.tsx.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss = "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-record-head.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (kinds: boolean, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
    );
    await page.addScriptTag({ content: `window.__k2Kinds = ${kinds};` });
    await page.addScriptTag({ content: client });
    await page.waitForFunction(() => window.__k2Mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

const shape = (page: Page) =>
  page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>('.k2-ws-main > [data-slot="head"] > .k2-bar')!;
    const middle = (element: Element) => {
      const box = element.getBoundingClientRect();
      return Math.round(box.top + box.height / 2);
    };
    const name = bar.querySelector<HTMLElement>(".k2-record-name")!;
    const avatar = bar.querySelector(".k2-av")!;
    const style = getComputedStyle(bar);
    return {
      // one row of the head: the avatar with the space above and below it and the head's line (57 px, as the mockup)
      row: Math.round(
        avatar.getBoundingClientRect().height +
          Number.parseFloat(style.paddingTop) +
          Number.parseFloat(style.paddingBottom) +
          Number.parseFloat(style.borderBottomWidth),
      ),
      height: Math.round(bar.getBoundingClientRect().height),
      name: middle(name),
      avatar: middle(avatar),
      actions: [...bar.querySelectorAll(":scope > .k2-bar-end .k2-btn")].map(middle),
      cut: name.scrollWidth > name.clientWidth + 0.5,
      inside: bar.getBoundingClientRect().right <= innerWidth + 0.5,
    };
  });

test("390 px, a very long name with its kinds: two rows at most, the actions on the name's row, the name cut with '…'", async () => {
  await withPage(true, async (page) => {
    const found = await shape(page);
    // the head's row, then a row of kinds (a chip of 24 px and the 4 px above it)
    expect(found.height).toBeLessThanOrEqual(found.row + 4 + 24);
    expect([found.avatar, ...found.actions]).toEqual([found.name, ...found.actions.map(() => found.name)]);
    expect([found.cut, found.inside]).toEqual([true, true]);
  });
});

test("390 px, a very long name without kinds: one row", async () => {
  await withPage(false, async (page) => {
    const found = await shape(page);
    expect(found.height).toBe(found.row);
    expect([found.avatar, ...found.actions]).toEqual([found.name, ...found.actions.map(() => found.name)]);
    expect([found.cut, found.inside]).toEqual([true, true]);
  });
});
