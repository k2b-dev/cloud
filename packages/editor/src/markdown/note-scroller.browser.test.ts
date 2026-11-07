import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";
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

const open = async (search = "") => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(server.url.href + search);
  await page.waitForFunction(() => "harness" in window);
  await page.evaluate(() => (window as unknown as { harness: NoteScrollerHarness }).harness.settle());
  return page;
};

test("a widget parsing an SVG while CodeMirror renders the lines it scrolled to does not move the page scroller", async () => {
  const page = await open();
  try {
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

test("a note shortened above the view keeps a focused editor at the bottom", async () => {
  const page = await open();
  try {
    const { before, after } = await page.evaluate(() =>
      (window as unknown as { harness: NoteScrollerHarness }).harness.deleteAboveAtBottom(2000),
    );
    expect(before).toBeLessThanOrEqual(1);
    expect(after).toBeLessThanOrEqual(1);
  } finally {
    await page.close();
  }
});

// A sidebar or panel drag changes the column width on every frame and rewraps lines above the page's top edge. The
// text being read stays where it is in every painted frame, also while the drag holds focus away from the editor.
for (const focused of [false, true])
  test(`a column resized frame by frame keeps the text at the top edge in place (${focused ? "focused" : "not focused"})`, async () => {
    const page = await open("?prose");
    try {
      const widths = [
        ...Array.from({ length: 40 }, (_, index) => 1180 - index * 9),
        ...Array.from({ length: 40 }, (_, index) => 829 + index * 9),
      ];
      const moved = await page.evaluate(
        ({ widths, focused }) =>
          (window as unknown as { harness: NoteScrollerHarness }).harness.resizeColumn("Paragraph 40 ", widths, focused),
        { widths, focused },
      );
      expect(moved.filter((distance) => Math.abs(distance) > 1)).toEqual([]);
    } finally {
      await page.close();
    }
  });

// The place to hold is where the reader is now: after another person's edit above moved the text, and after the
// column changed inside the same scroller and the reader scrolled on.
for (const before of ["edit", "column"] as const)
  test(`a resize after ${before === "edit" ? "an edit above the view" : "a column change and scrolling"} keeps the text the reader sees`, async () => {
    const page = await open("?prose");
    try {
      const widths = Array.from({ length: 30 }, (_, index) => 1180 - index * 9);
      const moved = await page.evaluate(
        ({ widths, before }) =>
          (window as unknown as { harness: NoteScrollerHarness }).harness.resizeColumn("Paragraph 50 ", widths, false, before),
        { widths, before },
      );
      expect(moved.filter((distance) => Math.abs(distance) > 1)).toEqual([]);
    } finally {
      await page.close();
    }
  });
