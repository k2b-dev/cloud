import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Browser, chromium, type Page } from "playwright";

// Scrolling depends on real layout, so this runs the note editor's arrangement in Chromium.
type Cursor = { clearBelow: number; clearAbove: number; bottomFade: number; topFade: number; scrollTop: number; maxScrollTop: number };
type Harness = {
  cursor: () => Cursor;
  placeAtVisibleBottom: () => void;
  placeAtEnd: () => void;
  paste: (text: string) => void;
  settle: () => Promise<void>;
};

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [new URL("./fade-scroll-margins.browser-harness.ts", import.meta.url).pathname],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
  });
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the editor harness.");
  const bundle = await build.outputs[0]!.text();
  const css = Bun.file(new URL("../../../../../ui/dist/styles.css", import.meta.url));
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/harness.js") return new Response(bundle, { headers: { "content-type": "application/javascript" } });
      if (path === "/ui.css") return new Response(css, { headers: { "content-type": "text/css" } });
      return new Response(
        `<!doctype html><html><head><link rel="stylesheet" href="/ui.css"></head>` +
          `<body class="k2b-ui" style="margin:0"><div id="root"></div><script src="/harness.js"></script></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

const open = async (query = "") => {
  const page = await browser.newPage({ viewport: { width: 480, height: 480 } });
  await page.goto(`${server.url}${query}`);
  await page.waitForFunction(() => "harness" in window && document.querySelector("[data-scroll-fade]") !== null);
  return page;
};

const cursor = (page: Page) =>
  page.evaluate(async () => {
    const harness = (window as unknown as { harness: Harness }).harness;
    await harness.settle();
    return harness.cursor();
  });

/** The cursor line is never under a fade that is drawn after the editor scrolled. */
const expectClearOfFades = (at: Cursor) => {
  expect(at.clearBelow).toBeGreaterThanOrEqual(at.bottomFade);
  expect(at.clearAbove).toBeGreaterThanOrEqual(at.topFade);
};

describe("note editor scroll margins", () => {
  test("Enter, typing, and paste at the bottom keep the cursor line above the bottom fade", async () => {
    const page = await open();
    try {
      await page.evaluate(() => (window as unknown as { harness: Harness }).harness.placeAtVisibleBottom());
      const start = await cursor(page);
      expect(start.bottomFade).toBe(48);
      expectClearOfFades(start);

      for (let index = 0; index < 6; index++) {
        await page.keyboard.press("Enter");
        expectClearOfFades(await cursor(page));
        await page.keyboard.type("more text");
        expectClearOfFades(await cursor(page));
      }

      await page.evaluate(() => (window as unknown as { harness: Harness }).harness.paste("first\nsecond\nthird\nfourth"));
      const pasted = await cursor(page);
      expect(pasted.bottomFade).toBe(48);
      expectClearOfFades(pasted);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("Enter on the last line scrolls to the end, where no fade is drawn", async () => {
    const page = await open();
    try {
      await page.evaluate(() => (window as unknown as { harness: Harness }).harness.placeAtEnd());
      for (let index = 0; index < 4; index++) {
        await page.keyboard.press("Enter");
        const at = await cursor(page);
        expectClearOfFades(at);
        expect(at.clearBelow).toBeGreaterThan(0);
      }
    } finally {
      await page.close();
    }
  }, 30_000);

  test("without the margins the cursor line ends under the fade", async () => {
    const page = await open("?margins=off");
    try {
      await page.evaluate(() => (window as unknown as { harness: Harness }).harness.placeAtVisibleBottom());
      for (let index = 0; index < 3; index++) await page.keyboard.press("Enter");
      const at = await cursor(page);
      expect(at.bottomFade).toBe(48);
      expect(at.clearBelow).toBeLessThan(at.bottomFade);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("pointer scrolling still reaches both ends", async () => {
    const page = await open();
    try {
      await page.mouse.move(200, 160);
      await page.mouse.wheel(0, 10_000);
      await page.waitForFunction(() => {
        const at = (window as unknown as { harness: Harness }).harness.cursor();
        return at.maxScrollTop > 0 && at.scrollTop === at.maxScrollTop;
      });
      await page.mouse.wheel(0, -10_000);
      await page.waitForFunction(() => (window as unknown as { harness: Harness }).harness.cursor().scrollTop === 0);
    } finally {
      await page.close();
    }
  }, 30_000);
});
