import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Locator, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-long-menu.demo";

// A menu never grows past the room of the screen (Spaces break-ui v4: the people menu with many entries was cut off
// at the bottom at 1024 px and wider). It keeps inside on the side it opens to, or opens to the other side when
// there is more room there, and scrolls inside; the keys bring the entry they reach into view. 60 people, in
// test/v2-long-menu.demo.tsx, in Chromium and WebKit.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; padding: 8px; } .ti { display: inline-block; width: 1em; height: 1em; }";
const height = 700;
// the room the behaviour layer keeps to the edge of the screen (`collisionPadding`)
const padding = 8;

let browser: Browser;
let bundle: string;
beforeAll(async () => {
  [bundle, browser] = await Promise.all([demoBundle("../v2-long-menu"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (width: number, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width, height } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
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

/** The open menu: its box, whether it scrolls inside, and its entries that the screen shows whole. */
const look = (page: Page) =>
  page.evaluate(() => {
    const menu = document.querySelector<HTMLElement>(".k2-menu")!;
    const box = menu.getBoundingClientRect();
    const shown = (element: Element) => {
      const entry = element.getBoundingClientRect();
      return entry.top >= box.top - 0.5 && entry.bottom <= box.bottom + 0.5 && entry.bottom <= window.innerHeight;
    };
    const active = document.activeElement;
    return {
      top: box.top,
      bottom: box.bottom,
      scrolls: menu.scrollHeight > menu.clientHeight,
      entries: menu.querySelectorAll('[role="menuitem"]').length,
      active: active?.textContent?.trim() ?? "",
      activeShown: active ? shown(active) : false,
    };
  });

/** Opens the menu, then walks it with the keys: every entry the keys reach is in view, the last one too. */
const walk = async (page: Page, trigger: Locator) => {
  await trigger.click();
  await page.locator(".k2-menu").waitFor();
  await settled(page);
  const opened = await look(page);
  // the menu stays on the screen, with the room to its edge, and scrolls inside
  expect(opened.top).toBeGreaterThanOrEqual(padding - 0.5);
  expect(opened.bottom).toBeLessThanOrEqual(height - padding + 0.5);
  expect([opened.entries, opened.scrolls]).toEqual([60, true]);
  // the keys: down through the list, the end, back to the start; each entry they reach shows whole
  for (let step = 0; step < 30; step += 1) await page.keyboard.press("ArrowDown");
  await settled(page);
  const down = await look(page);
  expect([down.active.startsWith("Person"), down.activeShown]).toEqual([true, true]);
  await page.keyboard.press("End");
  await settled(page);
  expect(await look(page)).toMatchObject({ active: "Person 60", activeShown: true });
  await page.keyboard.press("Home");
  await settled(page);
  expect(await look(page)).toMatchObject({ active: "Person 01", activeShown: true });
  await page.keyboard.press("Escape");
  await page.locator(".k2-menu").waitFor({ state: "detached" });
  return opened;
};

for (const width of [1024, 1440])
  test(`${width}×${height}: a menu of 60 people in the head stays inside the screen under its button and scrolls`, async () => {
    await withPage(width, async (page) => {
      const trigger = page.getByRole("button", { name: "Personen" });
      const opened = await walk(page, trigger);
      // it opens down, under its button
      expect(opened.top).toBeGreaterThanOrEqual((await trigger.boundingBox())!.y);
    });
  });

for (const width of [1024, 1440])
  test(`${width}×${height}: the same menu behind the "…" of the lowest row opens up and stays inside the screen`, async () => {
    await withPage(width, async (page) => {
      // the lowest row whose "…" the screen shows whole
      const name = await page.evaluate(() => {
        const buttons = [...document.querySelectorAll<HTMLElement>('.k2-row button[aria-label^="Zuweisen"]')].filter(
          (button) => button.getBoundingClientRect().bottom <= window.innerHeight,
        );
        return buttons.at(-1)!.getAttribute("aria-label")!;
      });
      const trigger = page.getByRole("button", { name, exact: true });
      const at = (await trigger.boundingBox())!;
      expect(at.y).toBeGreaterThan(height / 2);
      const opened = await walk(page, trigger);
      expect(opened.bottom).toBeLessThanOrEqual(at.y + 0.5);
    });
  });
