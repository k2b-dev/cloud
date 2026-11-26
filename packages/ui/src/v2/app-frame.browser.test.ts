import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import type {} from "../../test/v2-app-frame.demo";
import { demoBundle, serverMarkup } from "../../test/v2-behavior/harness";

// The parts of an installed app's frame: the tab bar of the phone with "More", the attention count in the sidebar and
// on a tab, the brand's logo, and notices that float over the page and keep their room free at the end of the panes.

/** A phone with a notch and a home indicator; a desktop engine has no insets, so the sheet takes them as sizes. */
const insets = { top: 47, right: 0, bottom: 34, left: 0 };
const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8").replace(
  /env\(\s*safe-area-inset-(top|right|bottom|left)\s*\)/g,
  (_, side: keyof typeof insets) => `${insets[side]}px`,
);
const testCss =
  "html, body { margin: 0; height: 100%; } .demo-frame { position: fixed; inset: 0; display: flex; flex-direction: column; } .demo-frame > .k2-ws { flex: 1; min-height: 0; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let bundle: string;
let markup: string;
beforeAll(async () => {
  [bundle, markup, browser] = await Promise.all([demoBundle("../v2-app-frame"), serverMarkup("../v2-app-frame"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (width: number, run: (page: Page) => Promise<void>) => {
  const phone = width < 768;
  const page = await browser.newPage({
    viewport: { width, height: phone ? 844 : 900 },
    ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
  });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root">${markup}</div></body></html>`,
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

const box = (page: Page, selector: string) =>
  page.evaluate((query) => {
    const element = document.querySelector(query);
    if (!element || element.getClientRects().length === 0) return undefined;
    const { top, bottom, left, right, height, width } = element.getBoundingClientRect();
    return { top, bottom, left, right, height, width };
  }, selector);

for (const width of [1440, 390])
  test(`a notice of one line has its line in the middle of its band, beside its sign (${width} px)`, async () => {
    await withPage(width, async (page) => {
      const sign = (await box(page, "#one-line .k2-notice > .k2-icon"))!;
      const text = (await box(page, "#one-line .k2-notice-text"))!;
      const band = (await box(page, "#one-line .k2-notice"))!;
      expect(Math.abs(sign.top + sign.height / 2 - (text.top + text.height / 2))).toBeLessThanOrEqual(1);
      // on the phone its deed stands under the text, in a row of its own; beside it the line is the band's middle
      if (width >= 768) expect(Math.abs(band.top + band.height / 2 - (text.top + text.height / 2))).toBeLessThanOrEqual(1);
    });
  }, 30_000);

test("server markup: four tabs and More, the open one marked, counts as figures and in words; the sidebar's logo", () => {
  const tabs = [...markup.matchAll(/data-k2-part="TabBar\.(?:Tab|More)"/g)];
  expect(tabs).toHaveLength(5);
  expect(markup).toMatch(/aria-current="page"[^>]*>(?:(?!<\/a>).)*Start/);
  expect(markup).toContain(">99+<");
  expect(markup).toContain("Mehr als 99 ungelesen");
  expect(markup).toContain("3 ungelesen");
  // More counts the places it holds: Notizbücher 2 and Spaces 5
  expect(markup).toMatch(/data-k2-part="TabBar\.More"(?:(?!<\/button>).)*>7<(?:(?!<\/button>).)*7 ungelesen/);
  expect(markup).toMatch(/class="k2-nav-title"><img class="k2-nav-logo" src="data:image\/svg\+xml/);
  // a quiet count stays quiet; an attention count of 0 shows nothing
  expect(markup).toMatch(/Spaces<\/span>(?:<!--[^>]*-->)*<span class="k2-ni-count">5<\/span>/);
  expect(markup).not.toMatch(/class="k2-ni-name">Mail<\/span>(?:(?!<\/a>).)*k2-unread/);
});

test("on the phone the tab bar holds the home indicator and More opens a sheet with the other places and counts", async () => {
  await withPage(390, async (page) => {
    const bar = (await box(page, ".k2-tabbar"))!;
    expect(Math.round(bar.bottom)).toBe(844);
    expect(bar.height).toBe(1 + 56 + insets.bottom);
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--k2-tabbar-h"))).toBe(`${bar.height}px`);
    // a count stands clear of its symbol with a ring of the bar's surface
    expect(await page.evaluate(() => getComputedStyle(document.querySelector(".k2-tab > .k2-unread")!).boxShadow)).toContain("2px");
    await page.getByRole("button", { name: /Mehr/ }).click();
    const sheet = page.getByRole("dialog", { name: "Mehr" });
    await sheet.waitFor();
    expect(await sheet.locator(".k2-row").allTextContents()).toEqual([
      expect.stringContaining("Notizbücher"),
      expect.stringContaining("Spaces"),
    ]);
    expect(await sheet.textContent()).toContain("5 ungelesen");
  });
});

test("from 768 px the tab bar leaves; the sidebar shows the logo and the attention count beside the quiet one", async () => {
  await withPage(1440, async (page) => {
    expect(await box(page, ".k2-tabbar")).toBeUndefined();
    const logo = (await box(page, ".k2-nav-logo"))!;
    expect(logo.height).toBe(20);
    const chat = page.locator(".k2-ni", { hasText: "Chat" });
    expect(await chat.locator(".k2-unread").textContent()).toBe("3");
    expect(await chat.getAttribute("aria-current")).toBeNull();
  });
});

for (const width of [390, 1440])
  test(`floating notices stand above the tab bar and the panes keep their room free (${width} px)`, async () => {
    await withPage(width, async (page) => {
      const stack = (await box(page, ".k2-notice-stack"))!;
      const room = await page.evaluate(() => document.documentElement.style.getPropertyValue("--k2-notice-stack"));
      // on the phone the panes end at the tab bar, 12 px below the stack; beside it near the window's end
      expect(room).toBe(`${Math.ceil(width < 768 ? stack.height + 12 : 900 - stack.top)}px`);
      const padding = await page.evaluate(() => getComputedStyle(document.querySelector(".k2-pane > .k2-scroll")!).paddingBottom);
      expect(padding).toBe(room);
      if (width < 768) {
        const bar = (await box(page, ".k2-tabbar"))!;
        expect(Math.round(stack.bottom)).toBe(Math.round(bar.top - 12));
        // the deed stays in the end column and is a button of at least 44 px
        const deed = (await box(page, ".k2-notice-stack .k2-notice-end > .k2-btn"))!;
        const text = (await box(page, ".k2-notice-stack .k2-notice-text"))!;
        expect(deed.left).toBeGreaterThan(text.right - 0.5);
        expect(deed.height).toBeGreaterThanOrEqual(44);
      } else expect(Math.round(stack.bottom)).toBe(900 - insets.bottom - 24);
      // scrolled to its end, the last row of the pane stands above the stack
      await page.evaluate(() => {
        const scroll = document.querySelector(".k2-pane > .k2-scroll")!;
        scroll.scrollTop = scroll.scrollHeight;
      });
      await settled(page);
      const last = (await box(page, ".k2-pane .k2-scroll > .k2-text"))!;
      expect(last.bottom).toBeLessThanOrEqual(stack.top);
      await page.evaluate(() => window.__hideNotices?.());
      await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--k2-notice-stack") === "0px");
    });
  });
