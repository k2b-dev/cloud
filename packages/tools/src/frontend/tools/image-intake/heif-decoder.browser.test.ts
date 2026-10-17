import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browserName, launchBrowser } from "../../../../../ui/test/browser";
import { buildHarness } from "./browser-harness";
import type {} from "./heif-decoder.browser-harness";

const harness = await buildHarness(new URL("./heif-decoder.browser-harness.ts", import.meta.url));
const fixture = [...new Uint8Array(await Bun.file(new URL("./fixtures/sample-48x32.heic", import.meta.url)).arrayBuffer())];
let browser: Awaited<ReturnType<typeof launchBrowser>>;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

describe("HEIF intake in a browser", () => {
  test("uses native decoding or a worker PNG, classifies failures and enforces the pixel budget", async () => {
    const tab = await browser.newPage();
    try {
      await tab.route("http://image-intake.test/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><html><body></body></html>",
        }),
      );
      await tab.goto("http://image-intake.test/");
      await tab.addScriptTag({ content: harness });
      const ready = await tab.evaluate((bytes) => window.runIntake("photo.heic", "image/heic", bytes), fixture);
      expect(ready.status).toBe("ready");
      expect([ready.width, ready.height]).toEqual([48, 32]);
      if (browserName === "chromium") {
        expect(ready.type).toBe("image/png");
        expect(ready.workers).toBeGreaterThan(0);
      }
      expect(ready.mainThreadDecoder).toBe(false);
      const truncated = await tab.evaluate((bytes) => window.runIntake("broken.heic", "image/heic", bytes.slice(0, 64)), fixture);
      expect(truncated.status).toBe("decode-failed");
      const large = await tab.evaluate((bytes) => window.runIntake("photo.heic", "image/heic", bytes, 48 * 32 - 1), fixture);
      expect(large.status).toBe("too-large");
      expect(large.workers).toBeGreaterThan(0);
      expect(large.mainThreadDecoder).toBe(false);
      const brokenPng = await tab.evaluate(() => window.runIntake("x.png", "image/png", [116, 101, 120, 116]));
      expect(brokenPng.status).toBe("decode-failed");
      const text = await tab.evaluate(() => window.runIntake("x.txt", "text/plain", [116, 101, 120, 116]));
      expect(text.status).toBe("unsupported");
    } finally {
      await tab.context().close();
    }
  }, 30_000);
});
