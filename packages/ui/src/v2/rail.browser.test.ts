import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle, serverMarkup } from "../../test/v2-behavior/harness";

// The rail of an app from 768 px: every place a link in the tab order with its name, the name as a hint beside it,
// the foot always in view while 20 places scroll, and the tab bar in its place on the phone. Its measures against
// Cloud's app bar are pinned in packages/cloud (rail.browser.test.ts).

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } .demo-frame { position: fixed; inset: 0; display: flex; } .demo-rail { display: flex; padding-block: 8px; } .demo-frame > .k2-ws { flex: 1; min-height: 0; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let bundle: string;
let markup: string;
beforeAll(async () => {
  [bundle, markup, browser] = await Promise.all([demoBundle("../v2-rail"), serverMarkup("../v2-rail"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (width: number, height: number, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width, height } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root">${markup}</div></body></html>`,
    );
    await page.addScriptTag({ content: bundle });
    await page.waitForFunction(() => window.__mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

test("server markup: every place a link named by its words, the open one current, the count in figures and words", () => {
  const rail = markup.slice(markup.indexOf('data-k2-part="Rail"'), markup.indexOf('data-k2-part="Workspace"'));
  expect([...rail.matchAll(/data-k2-part="Rail\.Item"/g)]).toHaveLength(21);
  expect(markup).toMatch(/<nav class="k2-rail" data-k2-part="Rail" aria-label="Lindenhof Cloud">/);
  expect(rail).toMatch(/href="#chat"(?:(?!<\/a>).)*<span class="k2-hidden-text">Chat<\/span>(?:(?!<\/a>).)*>3<(?:(?!<\/a>).)*3 ungelesen/);
  expect(rail).toMatch(/aria-current="page"[^>]*href="#spaces"/);
});

test("the tab order walks the places from the top to the foot; each shows its name beside it", async () => {
  await withPage(1440, 900, async (page) => {
    await page.focus('.k2-rail a[href="#start"]');
    const order: string[] = [];
    for (let step = 0; step < 21; step++) {
      order.push(await page.evaluate(() => document.activeElement?.getAttribute("href") ?? ""));
      await page.keyboard.press("Tab");
    }
    expect(order[0]).toBe("#start");
    expect(order[2]).toBe("#spaces");
    expect(order.at(-1)).toBe("#einstellungen");
    // keyboard focus shows the hint to the right of the place, with its name
    await page.focus('.k2-rail a[href="#chat"]');
    const tip = page.locator(".k2-tip:visible");
    await tip.waitFor();
    expect(await tip.textContent()).toBe("Chat");
    const [place, hint] = await Promise.all([page.locator('.k2-rail a[href="#chat"]').boundingBox(), tip.boundingBox()]);
    expect(hint!.x).toBeGreaterThanOrEqual(place!.x + place!.width);
  });
});

test("with 20 places on a short window the places scroll and the foot stays in view; focus brings each into view", async () => {
  await withPage(1024, 600, async (page) => {
    const view = await page.evaluate(() => {
      const scroll = document.querySelector<HTMLElement>(".k2-rail-scroll")!;
      const foot = document.querySelector(".k2-rail-foot .k2-rail-item")!.getBoundingClientRect();
      return { scrolls: scroll.scrollHeight > scroll.clientHeight, footBottom: foot.bottom, height: window.innerHeight };
    });
    expect(view.scrolls).toBe(true);
    expect(view.footBottom).toBeLessThanOrEqual(view.height);
    await page.focus('.k2-rail a[href="#lager-17"]');
    await settled(page);
    const last = await page.evaluate(() => {
      const scroll = document.querySelector(".k2-rail-scroll")!.getBoundingClientRect();
      const item = document.querySelector('.k2-rail a[href="#lager-17"]')!.getBoundingClientRect();
      return item.top >= scroll.top - 0.5 && item.bottom <= scroll.bottom + 0.5;
    });
    expect(last).toBe(true);
  });
});

test("below 768 px the rail leaves and the tab bar takes its place", async () => {
  await withPage(390, 844, async (page) => {
    expect(await page.evaluate(() => document.querySelector(".k2-rail")!.getClientRects().length)).toBe(0);
    expect(await page.evaluate(() => document.querySelector(".k2-tabbar")!.getClientRects().length)).toBe(1);
  });
});
