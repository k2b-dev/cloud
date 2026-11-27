import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-section-actions.demo";

// The buttons of a section head keep their words or fold into "⋯"; they are never cut (Files, DP: "Verwalten" was cut
// at 800 px). test/v2-section-actions.demo.tsx at 800 and 1440 px, in Chromium and WebKit.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let bundle: string;
beforeAll(async () => {
  [bundle, browser] = await Promise.all([demoBundle("../v2-section-actions"), launchBrowser()]);
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
    await page.addScriptTag({ content: bundle });
    await page.waitForFunction(() => window.__mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

/** Each section head: its title, the buttons that show (by name), and whether any of them is cut or outside it. */
const heads = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".k2-sec > .k2-sh")].map((head) => {
      const room = head.getBoundingClientRect();
      const buttons = [...head.querySelectorAll<HTMLElement>(".k2-btn")].filter((button) => {
        const style = getComputedStyle(button);
        return style.visibility !== "hidden" && button.getBoundingClientRect().width > 0;
      });
      const label = (button: HTMLElement) => button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "";
      const title = head.querySelector("h3")!;
      return {
        title: title.textContent,
        buttons: buttons.map(label),
        whole: buttons.every((button) => {
          const box = button.getBoundingClientRect();
          const words = button.querySelector<HTMLElement>(".k2-btn-label");
          return box.right <= room.right + 8.5 && box.left >= room.left && (!words || words.scrollWidth <= words.clientWidth + 1);
        }),
        titleInside: title.getBoundingClientRect().right <= (buttons[0]?.getBoundingClientRect().left ?? room.right) + 0.5,
      };
    }),
  );

test("800 px: a head without room folds its buttons into '⋯'; one with room keeps the words; nothing is cut", async () => {
  await withPage(800, async (page) => {
    const found = await heads(page);
    for (const head of found) expect([head.title, head.whole, head.titleInside]).toEqual([head.title, true, true]);
    expect(found.map((head) => head.buttons)).toEqual([["Weitere Aktionen"], ["Verwalten"], ["Weitere Aktionen"]]);
  });
});

test("1440 px: every head has room and keeps its buttons with their words", async () => {
  await withPage(1440, async (page) => {
    const found = await heads(page);
    for (const head of found) expect([head.title, head.whole, head.titleInside]).toEqual([head.title, true, true]);
    expect(found.slice(0, 2).map((head) => head.buttons)).toEqual([["Hinzufügen", "Verwalten"], ["Verwalten"]]);
  });
});

test("the '⋯' of a head holds its buttons as entries that do the same; with room again the buttons come back", async () => {
  await withPage(800, async (page) => {
    const section = page.getByRole("region", { name: "Freigaben für Mitarbeitende" });
    await section.getByRole("button", { name: "Weitere Aktionen" }).click();
    await page.locator(".k2-menu").waitFor();
    await settled(page);
    expect(await page.getByRole("menuitem").allTextContents()).toEqual(["Hinzufügen", "Verwalten"]);
    expect(await page.getByRole("menuitem", { name: "Verwalten" }).getAttribute("href")).toBe("#verwalten");
    await page.getByRole("menuitem", { name: "Hinzufügen" }).click();
    await page.locator(".k2-menu").waitFor({ state: "detached" });
    expect(await page.evaluate(() => window.__sectionDeeds ?? [])).toEqual(["add"]);
    await page.setViewportSize({ width: 1440, height: 800 });
    await settled(page);
    expect((await heads(page))[0]?.buttons).toEqual(["Hinzufügen", "Verwalten"]);
  });
});
