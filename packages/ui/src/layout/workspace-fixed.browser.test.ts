import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser } from "../../test/browser";

const css = readFileSync(resolve(import.meta.dir, "../styles/layout-parity.css"), "utf8");
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
});

test("the document app container keeps fixed descendants attached to the viewport", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.setContent(`<!doctype html><style>${css}</style>
      <body style="margin:0;height:3000px"><div id="fixed" style="position:fixed;top:0;height:20px">Fixed</div></body>`);
    expect(await page.locator("html").evaluate((root) => getComputedStyle(root).containerName)).toBe("k2b-app-area");
    await page.evaluate(() => window.scrollTo(0, 600));
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    expect((await page.locator("#fixed").boundingBox())?.y).toBe(0);
  } finally {
    await page.close();
  }
});
