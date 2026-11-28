import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser } from "playwright";
import { launchBrowser, launchHookMs } from "../packages/ui/test/browser";
import { renderCloudShell } from "./fixtures/cloud-shell";

// Pictures of an app's screens stand in the shell of `renderCloudShell`. Without Core there is no /branding/logo, and
// every picture showed a broken logo in the rail (lanes Y and W5, 26.11.).

let browser: Browser;
let shell: Awaited<ReturnType<typeof renderCloudShell>>;
beforeAll(async () => {
  [shell, browser] = await Promise.all([renderCloudShell({ id: "beispiel", name: "Beispiel", icon: "box" }), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  shell?.restore();
  await browser?.close();
});

test("the shell of a picture shows its logo: every image of the shell loads", async () => {
  const html = await shell.page("/app/beispiel", [{ title: "Start", href: "/" }, { title: "Beispiel" }]);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.setContent(html);
    await page.waitForFunction(() => [...document.images].every((image) => image.complete));
    const images = await page.evaluate(() =>
      [...document.images].map((image) => ({ alt: image.alt, width: image.naturalWidth, rail: !!image.closest(".layout-rail-logo") })),
    );
    expect(images.some((image) => image.rail)).toBe(true);
    for (const image of images) expect({ ...image, loaded: image.width > 0 }).toMatchObject({ loaded: true });
  } finally {
    await page.close();
  }
});
