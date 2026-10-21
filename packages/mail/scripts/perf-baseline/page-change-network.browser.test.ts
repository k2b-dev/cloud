import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser } from "playwright";
import { browserName, launchBrowser } from "../../../ui/test/browser";
import { recordPageChangeNetwork } from "./page-change-network";

let scriptAccepted: (() => void) | undefined;
let releaseScript: (() => void) | undefined;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/slow.js") {
      await new Promise<void>((resolve) => {
        releaseScript = resolve;
        scriptAccepted?.();
      });
      return new Response("window.slowLoaded = true", { headers: { "content-type": "text/javascript" } });
    }
    if (path === "/cached.js")
      return new Response("window.cachedLoaded = true", {
        headers: { "content-type": "text/javascript", "cache-control": "public,max-age=3600" },
      });
    if (path === "/broken.css") return new Response("unavailable", { status: 503 });
    if (path === "/bad")
      return new Response("<html><body>matching markup</body></html>", {
        status: 500,
        headers: { "content-type": "text/html" },
      });
    const extra = path === "/target" || path === "/prime" ? '<script src="/cached.js"></script>' : "";
    return new Response(`<html><head>${extra}</head><body>ready</body></html>`, { headers: { "content-type": "text/html" } });
  },
});
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  releaseScript?.();
  await browser?.close();
  server.stop(true);
});

const setup = async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = browserName === "chromium" ? await context.newCDPSession(page) : undefined;
  await cdp?.send("Network.enable");
  await page.goto(new URL("/prime", server.url).href);
  return { context, page, cdp };
};

test("page-change recorder waits for a slow required script after the observed end", async () => {
  const { context, page, cdp } = await setup();
  const recorder = recordPageChangeNetwork(page, "/target", cdp);
  try {
    await page.goto(new URL("/target", server.url).href);
    const accepted = new Promise<void>((resolve) => {
      scriptAccepted = resolve;
    });
    const requested = page.waitForRequest("**/slow.js");
    await page.evaluate(() => {
      const script = document.createElement("script");
      script.src = "/slow.js";
      document.head.append(script);
    });
    await requested;
    await accepted;
    // The start event is captured, but the server has not completed the response yet.
    let finished = false;
    const result = recorder.finish(1000).then((sizes) => {
      finished = true;
      return sizes;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(releaseScript).toBeFunction();
    releaseScript?.();
    releaseScript = undefined;
    const sizes = await result;
    expect(sizes.htmlBytes).toBeGreaterThan(0);
    expect(sizes.jsBytes).toBeGreaterThan(0);
  } finally {
    releaseScript?.();
    releaseScript = undefined;
    scriptAccepted = undefined;
    recorder.stop();
    await context.close();
  }
}, 20_000);

test("cached JavaScript has zero Chromium encoded transfer on a real document change", async () => {
  const { context, page, cdp } = await setup();
  const recorder = recordPageChangeNetwork(page, "/target", cdp);
  try {
    await page.goto(new URL("/target", server.url).href);
    const sizes = await recorder.finish(1000);
    expect(sizes.htmlBytes).toBeGreaterThan(0);
    if (cdp) expect(sizes.jsBytes).toBe(0);
    else expect(sizes.jsBytes).toBeGreaterThanOrEqual(0);
  } finally {
    recorder.stop();
    await context.close();
  }
});

test("a failed stylesheet rejects the page change even when destination content exists", async () => {
  const { context, page, cdp } = await setup();
  const recorder = recordPageChangeNetwork(page, "/target", cdp);
  try {
    await page.goto(new URL("/target", server.url).href);
    const response = page.waitForResponse("**/broken.css");
    await page.evaluate(() => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "/broken.css";
      document.head.append(link);
    });
    expect((await response).status()).toBe(503);
    // Chromium may classify an HTTP error stylesheet as a failed resource; both must reject.
    await expect(recorder.finish(1000)).rejects.toThrow(/Page-change resource (returned 503|failed)/);
  } finally {
    recorder.stop();
    await context.close();
  }
});

test("an error document containing matching markup is never a successful destination", async () => {
  const { context, page, cdp } = await setup();
  const recorder = recordPageChangeNetwork(page, "/bad", cdp);
  try {
    await page.goto(new URL("/bad", server.url).href);
    await expect(recorder.finish(1000)).rejects.toThrow("returned 500");
  } finally {
    recorder.stop();
    await context.close();
  }
});
