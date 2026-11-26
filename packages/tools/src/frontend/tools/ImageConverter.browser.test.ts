import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { appHostCss } from "../../../../ui/test/app-host-fixture";
import { browserName, launchBrowser } from "../../../../ui/test/browser";
import type {} from "./ImageConverter.browser-harness";
import { buildHarness } from "./image-intake/browser-harness";

const harness = await buildHarness(new URL("./ImageConverter.browser-harness.tsx", import.meta.url));
const fixture = Buffer.from(await Bun.file(new URL("./image-intake/fixtures/sample-48x32.heic", import.meta.url)).arrayBuffer());
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQaPgPAAIzAZDtHsO2AAAAAElFTkSuQmCC", "base64");
let css = "";
let browser: Awaited<ReturnType<typeof launchBrowser>>;
beforeAll(async () => {
  css = await appHostCss(resolve(import.meta.dir, "../../styles/app.css"));
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (lang: "en" | "de", width: number, search = "") => {
  const tab = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  await tab.route("http://image-converter.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    if (path === "/app.css") return route.fulfill({ contentType: "text/css", body: css });
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="${lang}" class="light"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body class="k2b-ui" style="margin:0;height:100vh"><div id="root" class="k2-ui" style="height:100vh;display:flex"></div><script src="/harness.js"></script></body></html>`,
      });
    return route.fulfill({ status: 404 });
  });
  await tab.goto(`http://image-converter.test/${search}`);
  await tab.locator('[data-k2-part="Workspace"]').waitFor();
  return tab;
};

test("mixed image intake keeps every outcome in drop order without moving the first row", async () => {
  const tab = await open("en", 1280);
  try {
    const chooser = tab.waitForEvent("filechooser");
    await tab.getByRole("button", { name: "Add images" }).first().click();
    await (await chooser).setFiles([
      { name: "first.heic", mimeType: "image/heic", buffer: fixture },
      { name: "second.png", mimeType: "image/png", buffer: png },
      { name: "broken.heic", mimeType: "image/heic", buffer: fixture.subarray(0, 64) },
    ]);
    const rows = tab.locator('[data-k2-part="List"] [data-k2-part="Row"]');
    await tab.waitForFunction(() => document.querySelectorAll('[data-k2-part="List"] [data-k2-part="Row"]').length >= 2);
    const before = await rows.first().boundingBox();
    expect(before).not.toBeNull();
    // Safari can finish the native path before this point. Order and geometry still hold.
    await tab.evaluate(() => window.releaseDecodes());
    await tab.locator('[data-k2-part="Notice"]').filter({ hasText: "broken.heic" }).waitFor();
    await tab.waitForFunction(() => document.querySelectorAll('[data-k2-part="List"] [data-k2-part="Row"]').length === 2);
    const texts = await rows.allTextContents();
    expect(texts[0]).toContain("first.heic");
    expect(texts[1]).toContain("second.png");
    if (browserName === "chromium")
      await tab.waitForFunction(() => document.querySelector('[data-k2-part="Row"]')?.textContent?.includes("HEIC"));
    const failure = tab.locator('[data-k2-part="Notice"]').filter({ hasText: "broken.heic" });
    expect(await failure.textContent()).toContain("This image could not be read.");
    expect(await failure.textContent()).toContain("Export it again from the source app");
    expect(await failure.getByRole("button", { name: "Remove broken.heic" }).count()).toBe(1);
    expect(await rows.first().boundingBox()).toEqual(before);
  } finally {
    await tab.context().close();
  }
}, 30_000);

test("a file that cannot be added keeps its whole reason and recovery hint, from a phone up", async () => {
  for (const lang of ["en", "de"] as const) {
    for (const width of [320, 390, 1280]) {
      const tab = await open(lang, width, "?failures");
      try {
        const notices = await tab.evaluate(() =>
          Array.from(document.querySelectorAll('[data-k2-part="Notice"]')).map((notice) => ({
            overflow: notice.scrollHeight - notice.clientHeight,
            sideways: notice.scrollWidth - notice.clientWidth,
            words: (notice.textContent ?? "").length > 40,
          })),
        );
        expect(notices).toHaveLength(4);
        for (const notice of notices) expect({ lang, width, ...notice }).toEqual({ lang, width, overflow: 0, sideways: 0, words: true });
        expect(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      } finally {
        await tab.context().close();
      }
    }
  }
}, 60_000);
