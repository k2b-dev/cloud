import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser } from "playwright";
import { panelEndState } from "../../../../scripts/perf-baseline/panel-probe";
import { browserName, launchBrowser } from "../../../ui/test/browser";
import { recordPageChangeNetwork } from "./page-change-network";
import { installPageChangeProbe, pageChangeKey } from "./page-change-probe";

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

test("a delayed request event from before the measurement contributes no bytes", async () => {
  const { context, page, cdp } = await setup();
  let recorder: ReturnType<typeof recordPageChangeNetwork> | undefined;
  try {
    const accepted = new Promise<void>((resolve) => {
      scriptAccepted = resolve;
    });
    const requested = page.waitForRequest("**/slow.js");
    await page.evaluate(() => {
      const script = document.createElement("script");
      script.src = "/slow.js";
      document.head.append(script);
    });
    const old = await requested;
    await accepted;
    // Browser timestamps are the subject. A frame puts this start before the recorder's host boundary.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    recorder = recordPageChangeNetwork(page, "/isolated", cdp);
    // Model a delayed Playwright-channel delivery after CDP already reported this start.
    // Its startTime is populated only when the response arrives, not at this event.
    const emit: unknown = Reflect.get(page, "emit");
    if (typeof emit !== "function") throw new Error("Playwright no longer supports replaying a request event");
    emit.call(page, "request", old);
    releaseScript?.();
    releaseScript = undefined;
    const response = await old.response();
    if (!response) throw new Error("Missing delayed script response");
    await response.finished();
    await page.goto(new URL("/isolated", server.url).href);
    const sizes = await recorder.finish(1000);
    expect(sizes.htmlBytes).toBeGreaterThan(0);
    expect(sizes.jsBytes).toBe(0);
  } finally {
    releaseScript?.();
    releaseScript = undefined;
    scriptAccepted = undefined;
    recorder?.stop();
    await context.close();
  }
}, 20_000);

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
    const failure: unknown = await recorder.finish(1000).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : "").toMatch(/Page-change resource (returned 503|failed)/);
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
    const failure: unknown = await recorder.finish(1000).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : "").toContain("returned 500");
  } finally {
    recorder.stop();
    await context.close();
  }
});

const errorSetup = async () => {
  const state = await setup();
  await state.page.addInitScript({
    content: `(${installPageChangeProbe.toString()})({key:${JSON.stringify(pageChangeKey)},panel:${panelEndState.toString()}})`,
  });
  await state.page.goto(new URL("/isolated", server.url).href);
  return state;
};

test("page-change errors include native exceptions and rejections in the host and same-origin frames", async () => {
  const { context, page } = await errorSetup();
  try {
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error("host crash");
      }, 0);
      setTimeout(() => {
        void Promise.reject(new Error("host rejection"));
      }, 0);
    });
    await page.waitForFunction(() => window.__mailPageChange.errors().some((error) => error.includes("host rejection")), undefined, {
      timeout: 1000,
    });
    expect(await page.evaluate(() => window.__mailPageChange.errors().some((error) => error.includes("host crash")))).toBe(true);
    const frameLoaded = page.waitForEvent(
      "framenavigated",
      (frame) => frame !== page.mainFrame() && new URL(frame.url()).pathname === "/child",
    );
    await page.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.src = "/child";
      document.body.append(frame);
    });
    const frame = await frameLoaded;
    await frame.evaluate(() => {
      setTimeout(() => {
        throw new Error("frame crash");
      }, 0);
      setTimeout(() => {
        void Promise.reject(new Error("frame rejection"));
      }, 0);
    });
    await page.waitForFunction(() => window.__mailPageChange.errors().some((error) => error.includes("frame rejection")), undefined, {
      timeout: 1000,
    });
    const errors = await page.evaluate(() => window.__mailPageChange.errors());
    for (const message of ["host crash", "host rejection", "frame crash", "frame rejection"])
      expect(errors.some((error) => error.includes(message))).toBe(true);
  } finally {
    await context.close();
  }
});

test("a handled fetch denial is not an uncaught page-change error", async () => {
  const { context, page } = await errorSetup();
  try {
    // WebKit reports this handled rejection as a JavaScript console error. Playwright
    // promotes it to pageerror even though neither native error event fires.
    const reported =
      browserName === "webkit"
        ? page.waitForEvent("pageerror", { timeout: 1000 }).then(
            (error) => error,
            (error: unknown) => error,
          )
        : undefined;
    const denied = new URL("/catalog", server.url);
    denied.hostname = "localhost"; // Different origin; this server sends no CORS permission.
    const handled = await page.evaluate(async (url) => {
      try {
        await fetch(url);
        return false;
      } catch {
        return true;
      }
    }, denied.href);
    expect(handled).toBe(true);
    if (reported) {
      const error = await reported;
      expect(error instanceof Error ? error.name : "").toContain("Fetch API cannot load");
    }
    expect(await page.evaluate(() => window.__mailPageChange.errors())).toEqual([]);
  } finally {
    await context.close();
  }
});
