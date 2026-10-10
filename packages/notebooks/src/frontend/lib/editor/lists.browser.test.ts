import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Browser, type BrowserContextOptions, type Page, devices as playwrightDevices } from "playwright";
import { browserName, launchBrowser } from "../../../../../ui/test/browser";

// Where a click leaves the note depends on real focus, selection, and scrolling, so this runs in a real browser.
type Measure = { scrollTop: number; windowScroll: number; lineTop: number; text: string; head: number };
type Harness = {
  scrollToMiddle: (task: string) => void;
  measure: (task: string) => Measure;
  placeCursor: (task: string) => void;
  settle: () => Promise<void>;
};

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [new URL("./lists.browser-harness.ts", import.meta.url).pathname],
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
      if (path === "/harness.js") return new Response(bundle, { headers: { "content-type": "application/javascript; charset=utf-8" } });
      if (path === "/ui.css") return new Response(css, { headers: { "content-type": "text/css" } });
      return new Response(
        `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/ui.css"></head>` +
          `<body class="k2b-ui" style="margin:0"><div id="root"></div><script src="/harness.js"></script></body></html>`,
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

// A real phone of the engine, user agent included, so CodeMirror takes its iOS or Android paths for touch and focus.
const { defaultBrowserType: _, ...phone } = playwrightDevices[browserName === "webkit" ? "iPhone 15" : "Pixel 7"];

const devices: Record<string, BrowserContextOptions> = {
  desktop: { viewport: { width: 1280, height: 800 } },
  phone,
};

const open = async (device: BrowserContextOptions) => {
  const context = await browser.newContext(device);
  const page = await context.newPage();
  await page.goto(server.url.href);
  await page.waitForFunction(() => "harness" in window && document.querySelector(".custom-list-task-marker") !== null);
  return page;
};

const measure = (page: Page, task: string) =>
  page.evaluate(async (task) => {
    const harness = (window as unknown as { harness: Harness }).harness;
    await harness.settle();
    return harness.measure(task);
  }, task);

/** Runs a harness step and waits until the browser has finished reacting to it, such as revealing a focused caret. */
const call = <K extends "scrollToMiddle" | "placeCursor">(page: Page, name: K, task: string) =>
  page.evaluate(
    async ([name, task]) => {
      const harness = (window as unknown as { harness: Harness }).harness;
      harness[name](task);
      await harness.settle();
    },
    [name, task] as const,
  );

const checkbox = (page: Page, task: string) => page.locator(".cm-line", { hasText: task }).locator(".custom-list-task-marker");

/** The press left the note where it was: same scroll position, same line on screen, no page scroll. */
const expectStill = (before: Measure, after: Measure) => {
  expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.lineTop - before.lineTop)).toBeLessThanOrEqual(1);
  expect(after.windowScroll).toBe(before.windowScroll);
};

describe.each(Object.entries(devices))("ticking a checklist box in the note editor (%s)", (name, device) => {
  // Presses where the box is on screen; a locator's tap or click would first scroll it to where Playwright wants it.
  const press = async (page: Page, task: string) => {
    const box = await checkbox(page, task).boundingBox();
    if (!box) throw new Error(`The box of "${task}" is not on screen.`);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await (name === "phone" ? page.touchscreen.tap(x, y) : page.mouse.click(x, y));
  };

  test("toggles the box and keeps the note and the caret still", async () => {
    const page = await open(device);
    try {
      await call(page, "scrollToMiddle", "Task 20");
      const before = await measure(page, "Task 20");
      expect(before.scrollTop).toBeGreaterThan(0);
      expect(before.lineTop).toBeGreaterThan(0);
      expect(before.lineTop).toBeLessThan(device.viewport!.height);

      await press(page, "Task 20");
      const ticked = await measure(page, "Task 20");
      expect(ticked.text).toBe("- [x] Task 20");
      expect(ticked.head).toBe(before.head);
      expectStill(before, ticked);

      await press(page, "Task 20");
      const unticked = await measure(page, "Task 20");
      expect(unticked.text).toBe("- [ ] Task 20");
      expectStill(before, unticked);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("keeps the caret on its line far above, and typing then scrolls back to it", async () => {
    const page = await open(device);
    try {
      await call(page, "placeCursor", "Task 2");
      await call(page, "scrollToMiddle", "Done 20");
      const before = await measure(page, "Done 20");
      expect(before.lineTop).toBeGreaterThan(0);
      expect(before.lineTop).toBeLessThan(device.viewport!.height);

      await press(page, "Done 20");
      const after = await measure(page, "Done 20");
      expect(after.text).toBe("- [ ] Done 20");
      expect(after.head).toBe(before.head);
      expectStill(before, after);

      // Normal typing still brings the caret into view.
      await page.keyboard.type("!");
      const typed = await measure(page, "Task 2!");
      expect(typed.lineTop).toBeGreaterThanOrEqual(0);
      expect(typed.lineTop).toBeLessThan(device.viewport!.height);
    } finally {
      await page.context().close();
    }
  }, 30_000);
});
