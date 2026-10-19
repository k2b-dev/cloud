import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

declare const window: Window & { hostWidth: { values: boolean[]; stop: () => void } };
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
setDefaultTimeout(30_000);
beforeAll(async () => {
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "app-host-width.ts")], target: "browser" });
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the app host watcher.");
  const bundle = await build.outputs[0]!.text();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/watch.js") return new Response(bundle, { headers: { "content-type": "application/javascript" } });
      return new Response(
        `<!doctype html><html><head><style>
        html { container: k2b-app-area / inline-size; font-size: 16px; }
        body { margin: 0; }
        #host { container: other k2b-app-area / inline-size; width: 1023.75px; }
        #probe { --wide: no; }
        @container k2b-app-area (min-width: 64rem) { #probe { --wide: yes; } }
      </style></head><body><div id="host"><div class="k2b-app-workspace"><div id="probe"></div></div></div>
      <script type="module">
        import { watchAppHostWidth } from "/watch.js";
        ${url.searchParams.has("fallback") ? "window.ResizeObserver = undefined;" : ""}
        const values = [];
        const stop = watchAppHostWidth(document.querySelector("#probe"), 64, value => values.push(value));
        window.hostWidth = { values, stop };
      </script></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

const open = async (fallback = false) => {
  const page = await browser.newPage({ viewport: { width: 1680, height: 900 } });
  try {
    await page.goto(`${server.url}${fallback ? "?fallback" : ""}`);
    await page.waitForFunction(() => Boolean(window.hostWidth));
    return page;
  } catch (error) {
    await page.close();
    throw error;
  }
};
const values = (page: Page) => page.evaluate(() => window.hostWidth.values);
const settle = (page: Page) =>
  page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const resizeHost = (page: Page, width: number) =>
  page.locator("#host").evaluate((element, width) => {
    element.style.width = `${width}px`;
  }, width);

test("fractional content widths match CSS at 64 rem in a wide window", async () => {
  const page = await open();
  try {
    expect(await values(page)).toEqual([false]);
    expect(await page.locator("#probe").evaluate((element) => getComputedStyle(element).getPropertyValue("--wide").trim())).toBe("no");
    await resizeHost(page, 1024);
    await page.waitForFunction(() => window.hostWidth.values.at(-1) === true);
    expect(await page.locator("#probe").evaluate((element) => getComputedStyle(element).getPropertyValue("--wide").trim())).toBe("yes");
    expect(await page.evaluate(() => innerWidth)).toBe(1680);
  } finally {
    await page.close();
  }
});

test("host-only resizes update exactly once per change", async () => {
  const page = await open();
  try {
    for (const width of [952, 1024, 1192, 1023.75]) {
      await resizeHost(page, width);
      await page.waitForFunction((wide) => window.hostWidth.values.at(-1) === wide, width >= 1024);
      await settle(page);
    }
    expect(await values(page)).toEqual([false, true, false]);
    expect(await page.evaluate(() => innerWidth)).toBe(1680);
  } finally {
    await page.close();
  }
});

test("a host losing and regaining its container name with its width, as Cloud's panel column does, reselects the host", async () => {
  const page = await open();
  try {
    // Closing the panel: the app area loses the name and takes the window's width.
    await page.locator("#host").evaluate((element) => {
      element.style.containerName = "other";
      element.style.width = "auto";
    });
    await page.waitForFunction(() => window.hostWidth.values.at(-1) === true);
    expect(await page.locator("#probe").evaluate((element) => getComputedStyle(element).getPropertyValue("--wide").trim())).toBe("yes");
    // Opening it again at 26 rem in a 1440 px window.
    await page.locator("#host").evaluate((element) => {
      element.style.containerName = "other k2b-app-area";
      element.style.width = "952px";
    });
    await page.waitForFunction(() => window.hostWidth.values.at(-1) === false);
    await resizeHost(page, 1024);
    await page.waitForFunction(() => window.hostWidth.values.at(-1) === true);
    expect(await values(page)).toEqual([false, true, false, true]);
  } finally {
    await page.close();
  }
});

test("stop disconnects every update", async () => {
  const page = await open();
  try {
    await page.evaluate(() => window.hostWidth.stop());
    await resizeHost(page, 1024);
    await page.locator("#host").evaluate((element) => {
      element.style.containerName = "none";
    });
    await page.setViewportSize({ width: 1192, height: 900 });
    await settle(page);
    expect(await values(page)).toEqual([false]);
  } finally {
    await page.close();
  }
});

test("without ResizeObserver the initial check and window resize still work until stopped", async () => {
  const page = await open(true);
  try {
    expect(await values(page)).toEqual([false]);
    await resizeHost(page, 1024);
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await page.waitForFunction(() => window.hostWidth.values.at(-1) === true);
    await page.evaluate(() => window.hostWidth.stop());
    await resizeHost(page, 952);
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await settle(page);
    expect(await values(page)).toEqual([false, true]);
  } finally {
    await page.close();
  }
});
