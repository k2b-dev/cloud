import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser } from "playwright";
import { launchBrowser } from "./browser";

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(() => browser?.close());

test("a test that hangs with an open page", async () => {
  const page = await browser.newPage();
  await page.setContent("<p>waiting</p>");
  await new Promise(() => {});
}, 1_000);

for (let n = 1; n <= 3; n++) {
  test(`a later test ${n} still opens a page`, async () => {
    const page = await browser.newPage();
    try {
      await page.setContent("<p>ready</p>");
      expect(await page.locator("p").textContent()).toBe("ready");
    } finally {
      await page.close();
    }
  });
}
