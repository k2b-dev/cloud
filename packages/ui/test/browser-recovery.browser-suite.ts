import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser } from "playwright";
import { launchBrowser } from "./browser";

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(() => browser?.close());

test("a test that hangs waiting on its page", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.setContent("<p>waiting</p>");
    await page.locator("#never").waitFor();
  } finally {
    await page.context().close();
  }
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
