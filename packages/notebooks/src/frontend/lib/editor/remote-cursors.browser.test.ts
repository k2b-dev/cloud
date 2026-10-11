import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../../../../ui/test/browser";
import { REMOTE_CARET_IDLE_CLASS, REMOTE_CARET_LABEL_IDLE_MS } from "./remote-cursors";

// Fading, hover, and reduced motion are computed styles, so this runs the editor theme in a real browser.
import type {} from "./remote-cursors.browser-harness";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [new URL("./remote-cursors.browser-harness.ts", import.meta.url).pathname],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
  });
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the editor harness.");
  const bundle = await build.outputs[0]!.text();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/harness.js") {
        return new Response(bundle, { headers: { "content-type": "application/javascript" } });
      }
      return new Response(
        `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="root"></div><script src="/harness.js"></script></body></html>`,
        {
          headers: { "content-type": "text/html" },
        },
      );
    },
  });
  browser = await launchBrowser();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

const open = async (reducedMotion: "reduce" | "no-preference" = "no-preference") => {
  const page = await browser.newPage({ viewport: { width: 480, height: 240 }, reducedMotion });
  await page.goto(server.url.href);
  await page.waitForSelector(".cm-remoteCaret");
  return page;
};

const label = (page: Page) =>
  page.$eval(".cm-remoteCaret", (caret) => {
    const info = caret.querySelector(".cm-remoteCaretLabel")!;
    const style = getComputedStyle(info);
    const box = caret.getBoundingClientRect();
    return { opacity: style.opacity, transitionDuration: style.transitionDuration, caret: [box.left, box.top, box.width, box.height] };
  });

const waitForIdle = (page: Page) =>
  page.waitForSelector(`.cm-remoteCaret.${REMOTE_CARET_IDLE_CLASS}`, { timeout: REMOTE_CARET_LABEL_IDLE_MS + 2_000 });

describe("remote caret labels", () => {
  test("an idle name fades without moving the caret, and shows at once on hover and on movement", async () => {
    const page = await open();
    try {
      // Start the activity window now rather than at page load, so a slow launch cannot make the caret idle first.
      await page.evaluate(() => window.remoteCursorHarness.moveTo(31));
      const active = await label(page);
      expect(active.opacity).toBe("1");
      expect(active.transitionDuration).toBe("0s");

      await waitForIdle(page);
      await page.waitForFunction(() => getComputedStyle(document.querySelector(".cm-remoteCaretLabel")!).opacity === "0");
      const idle = await label(page);
      expect(idle.transitionDuration).toBe("0.3s");
      expect(idle.caret).toEqual(active.caret);

      // Point at the dot like a person does. WebKit can hit-test the dot's center to the caret around it,
      // which Playwright's hover() rejects, while :hover on that caret is what shows the name.
      const dot = (await page.locator(".cm-remoteCaretDot").boundingBox())!;
      await page.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2);
      expect((await label(page)).opacity).toBe("1");
      await page.mouse.move(400, 200);

      await page.evaluate(() => window.remoteCursorHarness.moveTo(12));
      expect(await page.$eval(".cm-remoteCaret", (caret, idleClass) => caret.classList.contains(idleClass), REMOTE_CARET_IDLE_CLASS)).toBe(
        false,
      );
      expect((await label(page)).opacity).toBe("1");
    } finally {
      await page.close();
    }
  }, 30_000);

  test("with reduced motion an idle name hides without a fade", async () => {
    const page = await open("reduce");
    try {
      await waitForIdle(page);
      const idle = await label(page);
      expect(idle.opacity).toBe("0");
      expect(idle.transitionDuration).toBe("0s");
    } finally {
      await page.close();
    }
  }, 30_000);
});
