import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { browserName, launchBrowser } from "../../../../ui/test/browser";
import type {} from "./ImageConverter.browser-harness";
import { buildHarness, uiRoot } from "./image-intake/browser-harness";

const harness = await buildHarness(new URL("./ImageConverter.browser-harness.tsx", import.meta.url));
const fixture = Buffer.from(await Bun.file(new URL("./image-intake/fixtures/sample-48x32.heic", import.meta.url)).arrayBuffer());
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQaPgPAAIzAZDtHsO2AAAAAElFTkSuQmCC", "base64");
const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", new URL("../../../../cloud/", import.meta.url).pathname))).default;
const css = (
  await Promise.all(
    ["../../../../../styles.css", "../../styles/app.css"].map(async (path) => {
      const build = await Bun.build({ entrypoints: [new URL(path, import.meta.url).pathname], plugins: [tailwind] });
      if (!build.success) throw new AggregateError(build.logs, "Tools CSS build failed");
      return build.outputs[0]!.text();
    }),
  )
).join("\n");
const assets: Record<string, [string, string | Buffer]> = {
  "/harness.js": ["text/javascript", harness],
  "/app.css": ["text/css", css],
  "/styles.css": ["text/css", readFileSync(`${uiRoot}dist/styles.css`, "utf8")],
};
let browser: Awaited<ReturnType<typeof launchBrowser>>;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

test("mixed image intake keeps every outcome in drop order in the main area without moving the first card", async () => {
  const tab = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  try {
    await tab.route("http://image-converter.test/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/")
        return route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><html lang="en"><head><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/styles.css"></head><body class="k2b-ui"><div id="root" style="height:100vh;display:flex"></div><script src="/harness.js"></script></body></html>',
        });
      const asset = assets[path];
      return asset ? route.fulfill({ contentType: asset[0], body: asset[1] }) : route.fulfill({ status: 404 });
    });
    await tab.goto("http://image-converter.test/");
    await tab.locator('.tools-image-converter input[type="file"]').setInputFiles([
      { name: "first.heic", mimeType: "image/heic", buffer: fixture },
      { name: "second.png", mimeType: "image/png", buffer: png },
      { name: "broken.heic", mimeType: "image/heic", buffer: fixture.subarray(0, 64) },
    ]);
    const cards = tab.locator('.tools-image-converter [role="listitem"]');
    await tab.waitForFunction(() => document.querySelectorAll('.tools-image-converter [role="listitem"]').length === 3);
    const firstNode = await cards.first().elementHandle();
    const before = await cards.first().boundingBox();
    expect(before).not.toBeNull();
    if (browserName === "chromium") expect(await cards.first().getAttribute("data-status")).toBe("loading");
    // Safari can finish the native path before this point. Order and geometry still hold.
    await tab.evaluate(() => window.releaseDecodes());
    await tab.waitForFunction(
      () =>
        document.querySelectorAll('.tools-image-converter [data-status="ready"]').length === 2 &&
        document.querySelectorAll('.tools-image-converter [data-status="failed"]').length === 1,
    );
    expect(await cards.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-status")))).toEqual(["ready", "ready", "failed"]);
    expect(await cards.evaluateAll((nodes) => nodes.map((node) => node.querySelector("p[title]")?.getAttribute("title")))).toEqual([
      "first.heic",
      "second.png",
      "broken.heic",
    ]);
    expect(await cards.first().textContent()).toContain("HEIC");
    expect(await cards.last().textContent()).toContain("This image could not be read.");
    expect(await cards.last().textContent()).toContain("Export it again from the source app");
    expect(await cards.last().getByRole("button", { name: "Remove broken.heic" }).count()).toBe(1);
    expect(await cards.first().boundingBox()).toEqual(before);
    expect(await firstNode?.evaluate((node) => node === document.querySelector('.tools-image-converter [role="listitem"]'))).toBe(true);
  } finally {
    await tab.context().close();
  }
}, 30_000);
