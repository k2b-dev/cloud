import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser } from "playwright";
import { launchBrowser } from "../../../../../ui/test/browser";
import type { NoteScrollerHarness } from "./note-scroller.browser-harness";

// The page scroller only clamps in a real browser layout; WebKit is the engine that showed it.
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [new URL("./note-scroller.browser-harness.ts", import.meta.url).pathname],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
  });
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the note scroller harness.");
  const bundle = await build.outputs[0]!.text();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/harness.js")
        return new Response(bundle, { headers: { "content-type": "application/javascript" } });
      // `@k2b/ui` makes the root the app area's size container; the jump needs one.
      return new Response(
        `<!doctype html><html style="container-type:inline-size"><head><meta charset="utf-8"></head>` +
          `<body style="margin:0"><div id="port" style="height:800px;overflow:auto"></div><script src="/harness.js"></script></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  browser = await launchBrowser();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

test("a widget parsing an SVG while CodeMirror renders the lines it scrolled to does not move the page scroller", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.goto(server.url.href);
    await page.waitForFunction(() => "harness" in window);
    await page.evaluate(() => (window as unknown as { harness: NoteScrollerHarness }).harness.settle());
    // The last jump lands near the end, where the note without its new lines is shorter than the scroll position.
    for (const anchor of ["Anchor 2", "Anchor 4", "Anchor 6"]) {
      const { written, scrollTop } = await page.evaluate(
        (text) => (window as unknown as { harness: NoteScrollerHarness }).harness.scrollTo(text),
        anchor,
      );
      expect({ anchor, scrollTop }).toEqual({ anchor, scrollTop: written });
    }
  } finally {
    await page.close();
  }
});
