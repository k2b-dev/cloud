import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser } from "../../../ui/test/browser";
import { startErrorPageServer } from "./server";

let server: Awaited<ReturnType<typeof startErrorPageServer>>;
let browser: Browser;

beforeAll(async () => {
  server = await startErrorPageServer();
  browser = await launchBrowser();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  server?.stop();
});

const viewports = [
  { name: "desktop", width: 1440, height: 900, touch: false },
  { name: "phone", width: 390, height: 844, touch: true },
] as const;

/** Where the way home, the road's room and the whole block sit. */
const places = (page: Page) =>
  page.evaluate(() => {
    const box = (selector: string) => {
      const rect = document.querySelector(selector)!.getBoundingClientRect();
      return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
    };
    return {
      home: box(".cloud-error-page__actions a"),
      road: box(".cloud-error-page__road"),
      page: box(".cloud-error-page"),
      scroll: document.documentElement.scrollWidth <= window.innerWidth,
    };
  });

const open = async (viewport: (typeof viewports)[number], path: string, javaScriptEnabled = true) => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    locale: "en-US",
    isMobile: viewport.touch,
    hasTouch: viewport.touch,
    javaScriptEnabled,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url + path);
  return { page, errors };
};

describe(`generic error page in ${browserName}`, () => {
  for (const viewport of viewports)
    for (const path of ["missing", "missing?as=lea", "broken"])
      test(`${path} on ${viewport.name}: the first paint already holds the scene's place`, async () => {
        const plain = await open(viewport, path, false);
        const before = await places(plain.page);
        await plain.page.context().close();

        const { page, errors } = await open(viewport, path);
        try {
          // The game draws into the reserved place once its code has arrived.
          await page.locator("[data-waiting-game] .lauf canvas").waitFor({ state: "attached" });
          await page.waitForFunction(() => document.documentElement.dataset.lauf === "wait");
          expect(await places(page)).toEqual(before);
          expect(before.scroll).toBe(true);
          expect(errors).toEqual([]);
        } finally {
          await page.context().close();
        }
      }, 30_000);

  test("the way home comes before the game in the focus order, and the symbol starts a round in place", async () => {
    const { page, errors } = await open(viewports[0], "missing");
    try {
      await page.locator("[data-waiting-game] .lauf canvas").waitFor({ state: "attached" });
      await page.locator("h1").click();
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Go to home page");
      expect(await page.locator("[data-waiting-game-start]").getAttribute("tabindex")).toBe("-1");

      const height = (await places(page)).page.height;
      await page.locator("[data-waiting-game-start]").click();
      await page.waitForFunction(() => document.documentElement.dataset.lauf === "run");
      // The symbol and the sentence fold away inside the block; the page around it keeps its size.
      await page.waitForFunction(() => document.querySelector("h1")!.getBoundingClientRect().top < 120);
      expect((await places(page)).page.height).toBe(height);
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.documentElement.dataset.lauf === "wait");
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);
});
