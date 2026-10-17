import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { launchBrowser } from "../../../../ui/test/browser";
import { buildHarness, uiRoot } from "./image-intake/browser-harness";

type Browser = Awaited<ReturnType<typeof launchBrowser>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;

const harness = await buildHarness(new URL("./SpeedTest.browser-harness.tsx", import.meta.url));
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
const assets: Record<string, [string, string]> = {
  "/harness.js": ["text/javascript; charset=utf-8", harness],
  "/app.css": ["text/css", css],
  "/styles.css": ["text/css", readFileSync(`${uiRoot}dist/styles.css`, "utf8")],
};
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (page: Page, lang: "de" | "en") => {
  await page.route("http://speed-test.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/styles.css"></head><body class="k2b-ui"><div id="root"></div><script src="/harness.js"></script></body></html>`,
      });
    const asset = assets[path];
    return asset ? route.fulfill({ contentType: asset[0], body: asset[1] }) : route.fulfill({ status: 404 });
  });
  await page.goto("http://speed-test.test/");
  await page.locator('[data-chart-kind="sparkline"] [data-chart-datum]').first().waitFor({ state: "attached" });
};

const tooltipText = async (page: Page, chart: string) => {
  const selector = `${chart} [role="tooltip"]:popover-open`;
  await page.waitForFunction((selector) => !!document.querySelector(selector)?.textContent, selector);
  const text = (await page.locator(selector).textContent()) ?? "";
  expect(text).not.toMatch(/Value|Wert|X:|Y:/);
  return text;
};

test("speed test sparklines name the metric and show each sample with its unit", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 600 } });
  try {
    await open(page, "de");
    const download = '#download [data-chart-kind="sparkline"]';
    const ping = '#ping [data-chart-kind="sparkline"]';
    const before = await page.locator("main").boundingBox();
    await page.locator(download).focus();
    await page.keyboard.press("Home");
    expect(await tooltipText(page, download)).toBe("Download: 94 Mbps");
    // The tooltip floats over the card; the readings keep their place.
    expect(await page.locator("main").boundingBox()).toEqual(before);
    await page.keyboard.press("Escape");

    await page.locator(ping).hover({ position: { x: 1, y: 10 } });
    expect(await tooltipText(page, ping)).toBe("Ping: 8,3 ms");
  } finally {
    await page.close();
  }
}, 30_000);

test("a tap on a phone shows the sample in the reader's locale", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 600 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
  try {
    await open(page, "en");
    const ping = '#ping [data-chart-kind="sparkline"]';
    await page.locator(ping).tap({ position: { x: 1, y: 10 } });
    expect(await tooltipText(page, ping)).toBe("Ping: 8.3 ms");
  } finally {
    await page.close();
  }
}, 30_000);
