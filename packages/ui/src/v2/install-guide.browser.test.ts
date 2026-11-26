import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle, serverMarkup } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-install-guide.demo";

// The install guide of v2 and `Only`: each platform's guidance from the server's page on, the browser's own dialog in
// the place the steps hold (nothing moves when it arrives), and content for one kind of device picked by the stylesheet.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } #root > .k2-ws { flex: 1; min-height: 0; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let bundle: string;
let markup: string;
beforeAll(async () => {
  [bundle, markup, browser] = await Promise.all([demoBundle("../v2-install-guide"), serverMarkup("../v2-install-guide"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (width: number, touch: boolean, run: (page: Page) => Promise<void>, live = true) => {
  const page = await browser.newPage({ viewport: { width, height: 844 }, ...(touch ? { isMobile: true, hasTouch: true } : {}) });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root">${markup}</div></body></html>`,
    );
    if (live) {
      await page.addScriptTag({ content: bundle });
      await page.waitForFunction(() => window.__mounted === true);
    }
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

/** The words a person sees in a part of the page (hidden variants and other kinds of device left out). */
const seen = (page: Page, selector: string) =>
  page.evaluate((query) => {
    const words: string[] = [];
    const walk = document.createTreeWalker(document.querySelector(query)!, NodeFilter.SHOW_TEXT);
    for (let node = walk.nextNode(); node; node = walk.nextNode()) {
      const parent = node.parentElement!;
      const text = node.textContent?.trim();
      if (!text || parent.closest(".k2-hidden-text")) continue;
      if (parent.getClientRects().length === 0 || getComputedStyle(parent).visibility === "hidden") continue;
      words.push(text);
    }
    return words;
  }, selector);

test("server markup: Safari's three steps as a list, a browser in another app gets the link to copy, Samsung gets Chrome", () => {
  const order = ["android", "apple", "in-app", "mac", "samsung", "only"];
  const part = (id: string) => {
    const next = order[order.indexOf(id) + 1];
    return markup.slice(markup.indexOf(`id="${id}"`), next ? markup.indexOf(`id="${next}"`) : undefined);
  };
  expect([...part("apple").matchAll(/<li[\s>]/g)]).toHaveLength(3);
  expect(part("apple")).toContain("Teilen öffnen");
  expect(part("apple")).toContain("Danach koppelst du das Gerät.");
  expect(part("in-app")).toContain("Link kopieren");
  expect(part("in-app")).toContain('data-tone="warn"');
  expect(part("samsung")).toContain("intent://cloud.example.org/pwa/#Intent;scheme=https;package=com.android.chrome");
  // Chrome on Android: the steps and the dialog's button are both in the server's page, in one place
  expect(part("android")).toMatch(/data-shows="steps"/);
  expect(part("android")).toContain('data-variant="prompt"');
});

for (const touch of [false, true])
  test(`a Mac's guide shows the ${touch ? "iPad's touch" : "Mac's"} steps from the server's page on, as a list`, async () => {
    await withPage(
      touch ? 820 : 1440,
      touch,
      async (page) => {
        const words = await seen(page, "#mac .k2-install");
        expect(words).toContain(touch ? "Teilen öffnen" : "Zum Dock hinzufügen");
        expect(words).not.toContain(touch ? "Zum Dock hinzufügen" : "Teilen öffnen");
        expect(await page.locator("#mac ol").first().getAttribute("role")).toBe("list");
      },
      false,
    );
  });

test("when the browser offers its own dialog, its button takes the steps' place and nothing below moves", async () => {
  await withPage(390, true, async (page) => {
    const below = () => page.evaluate(() => document.querySelector("#android > .k2-text")!.getBoundingClientRect().top);
    const before = await below();
    const button = page.getByRole("button", { name: "App installieren" });
    expect(await seen(page, "#android .k2-install")).toContain("Browser-Menü öffnen");
    expect(await button.isVisible()).toBe(false);
    await page.evaluate(() => window.__offer!());
    await settled(page);
    expect(await below()).toBe(before);
    expect(await seen(page, "#android .k2-install")).not.toContain("Browser-Menü öffnen");
    expect(await button.isVisible()).toBe(true);
    await button.click();
    expect(await page.evaluate(() => window.__installs)).toBe(1);
  });
});

for (const [touch, shown, gone] of [
  [false, "Mit der Maus", "Mit dem Finger"],
  [true, "Mit dem Finger", "Mit der Maus"],
] as const)
  test(`Only picks the ${touch ? "finger's" : "mouse's"} content and the browser's from the server's page on`, async () => {
    await withPage(
      touch ? 390 : 1440,
      touch,
      async (page) => {
        const words = await seen(page, "#only");
        expect(words).toEqual(["Im Browser", shown]);
        expect(words).not.toContain(gone);
        expect(words).not.toContain("Installiert");
      },
      false,
    );
  });
