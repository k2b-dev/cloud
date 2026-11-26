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
    await tab.locator('[data-k2-part="Row"]').filter({ hasText: "broken.heic" }).filter({ hasText: "could not be read" }).waitFor();
    await tab.waitForFunction(() => document.querySelectorAll('[data-k2-part="List"] [data-k2-part="Row"]').length === 3);
    const texts = await rows.allTextContents();
    expect(texts[0]).toContain("first.heic");
    expect(texts[1]).toContain("second.png");
    if (browserName === "chromium")
      await tab.waitForFunction(() => document.querySelector('[data-k2-part="Row"]')?.textContent?.includes("HEIC"));
    const failure = tab.locator('[data-k2-part="Row"]').filter({ hasText: "broken.heic" });
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
        // each failed file is its own row: the reason whole, the recovery on its line (whole under the pointer), its removal
        const rows = await tab.evaluate(() =>
          Array.from(document.querySelectorAll('[data-k2-part="Row"]')).map((row) => ({
            sideways: row.scrollWidth - row.clientWidth,
            words: (row.textContent ?? "").length > 40,
            remove:
              row.querySelector('button[aria-label^="Remove"], button[aria-label^="Entfernen"], button[aria-label$="entfernen"]') !== null,
          })),
        );
        expect(rows).toHaveLength(4);
        for (const row of rows) expect({ lang, width, ...row }).toEqual({ lang, width, sideways: 0, words: true, remove: true });
        expect(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      } finally {
        await tab.context().close();
      }
    }
  }
}, 60_000);

test("a setting that is not valid says what is wrong at its field and holds the export", async () => {
  const tab = await open("en", 1280);
  try {
    const chooser = tab.waitForEvent("filechooser");
    await tab.getByRole("button", { name: "Add images" }).first().click();
    await (await chooser).setFiles([{ name: "logo.png", mimeType: "image/png", buffer: png }]);
    await tab.evaluate(() => window.releaseDecodes());
    await tab.getByRole("spinbutton", { name: /Quality/ }).waitFor();
    const exportButton = tab.getByRole("button", { name: /^Export all/ }).last();
    const quality = tab.getByRole("spinbutton", { name: /Quality/ });
    await quality.fill("5");
    await tab.getByText("Enter a quality from 10 to 100.").waitFor();
    expect(await exportButton.isDisabled()).toBe(true);
    await quality.fill("85");
    await tab.getByText("Enter a quality from 10 to 100.").waitFor({ state: "detached" });
    await tab.getByRole("radio", { name: "JPEG" }).check();
    const background = tab.getByRole("textbox", { name: /Transparency background/ });
    // a short hex colour is a colour too
    await background.fill("#fff");
    expect(await tab.getByText("Enter a colour like #ffffff.").count()).toBe(0);
    await background.fill("white-ish");
    await tab.getByText("Enter a colour like #ffffff.").waitFor();
    await background.fill("#ffffff");
    const width = tab.getByRole("spinbutton", { name: /Max width/ });
    await width.fill("0");
    await tab.getByText("Enter a whole number from 1, or leave it empty.").waitFor();
    expect(await exportButton.isDisabled()).toBe(true);
    await width.fill("");
    expect(await exportButton.isDisabled()).toBe(false);
  } finally {
    await tab.context().close();
  }
}, 30_000);

test("1,000 images keep only the rows in view in the page", async () => {
  const tab = await open("en", 1280, "?many");
  try {
    await tab.getByText("1000 images").first().waitFor();
    const rows = await tab.locator('[data-k2-part="Row"]').count();
    expect(rows).toBeGreaterThan(5);
    expect(rows).toBeLessThanOrEqual(80);
    expect(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await tab.context().close();
  }
}, 30_000);
