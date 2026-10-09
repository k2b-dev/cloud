import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContext, BrowserContextOptions, CDPSession, Page } from "playwright";
import { browserName, launchBrowser } from "../../test/browser";

// Whether a finger scrolls the list or swipes a row, whether a long press survives the release, and whether anything
// moves are decided by a real engine's touch handling and layout. Rows sit in a scrolling list, as in a conversation.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "gesture-menu.fixture.ts");
const fixtureSource = `
import { createComponent, insert, render } from "solid-js/web";
import { GestureMenu, LocaleProvider } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

window.calls = { reply: 0, react: 0, copy: 0 };
window.swipes = 0;
const items = [
  { label: "Reply", icon: "ti ti-arrow-back-up", action: () => window.calls.reply++, gesture: "swipe-right" },
  { label: "React with thumbs up", icon: "ti ti-thumb-up", action: () => window.calls.react++, gesture: "double-tap" },
  { label: "Copy text", icon: "ti ti-copy", action: () => window.calls.copy++ },
];
const row = (index) => {
  const content = document.createElement("div");
  content.className = "row";
  const text = document.createElement("p");
  text.className = "text";
  text.textContent = "Message " + index + " with enough words to take a whole line";
  content.append(text);
  if (index === 0) {
    const link = document.createElement("a");
    link.href = "#anchor";
    link.className = "link";
    link.textContent = "a link";
    const code = document.createElement("pre");
    code.className = "code";
    code.textContent = "const value = " + "1 + ".repeat(80) + "1;";
    content.append(link, code);
  }
  return content;
};
render(
  () =>
    createComponent(LocaleProvider, {
      locale: "en",
      get children() {
        const list = document.createElement("div");
        list.className = "list";
        insert(
          list,
          Array.from({ length: 30 }, (_, index) =>
            createComponent(GestureMenu, { label: "Message " + index, items, tabIndex: -1, children: row(index) }),
          ),
        );
        return list;
      },
    }),
  document.getElementById("app"),
);
new MutationObserver((records) => {
  for (const record of records)
    if (record.attributeName === "data-swipe" && record.target.hasAttribute("data-swipe") && record.oldValue === null) window.swipes++;
}).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-swipe"], attributeOldValue: true });
window.shift = 0;
if (PerformanceObserver.supportedEntryTypes.includes("layout-shift"))
  new PerformanceObserver((list) => {
    for (const shift of list.getEntries()) window.shift += shift.value;
  }).observe({ type: "layout-shift", buffered: true });
`;
const build = await Bun.build({
  entrypoints: [entry],
  files: { [entry]: fixtureSource },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the GestureMenu fixture for the browser.");
const script = await build.outputs[0]!.text();

type Fixture = { calls: { reply: number; react: number; copy: number }; swipes: number; shift: number };

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

const open = async (
  context: BrowserContextOptions,
  options: { pausedClock?: boolean } = {},
): Promise<{ page: Page; context: BrowserContext }> => {
  const browserContext = await browser.newContext(context);
  const page = await browserContext.newPage();
  // A paused clock makes two taps a double tap however long the machine takes between them.
  if (options.pausedClock) await page.clock.install();
  await page.setContent(
    `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<style>${css}</style><style>
html, body { margin: 0; }
.list { height: 600px; overflow-y: auto; }
.row { padding: 8px 16px; font: 16px/24px sans-serif; }
.text { margin: 0; }
.code { margin: 0; overflow-x: auto; }
</style></head><body class="k2b-ui" style="background:var(--k2b-surface)"><div id="app"></div></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await page.locator(".k2b-gesture-menu").first().waitFor();
  if (options.pausedClock) await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);
  return { page, context: browserContext };
};

const fixture = (page: Page) =>
  page.evaluate(() => {
    const state = window as unknown as Fixture;
    return { calls: { ...state.calls }, swipes: state.swipes, shift: state.shift };
  });

const center = async (page: Page, selector: string) => {
  const box = (await page.locator(selector).first().boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

/** A finger that moves through every point, then lifts, through Chromium's input protocol. */
const touch = async (cdp: CDPSession, points: { x: number; y: number }[]) => {
  const [first, ...rest] = points;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [first!] });
  for (const point of rest) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
};

/**
 * Waits until the page has handled the input sent so far and reached the state `ready` reports. Chromium hands touch
 * moves to the page at its next frame, after the protocol call returned, so reading the page right away can miss them.
 */
const until = (page: Page, ready: string) => page.waitForFunction(ready, undefined, { timeout: 10_000 });

/** Waits until the list's fling has ended: its position stays the same for ten frames. */
const still = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((done) => {
        const list = document.querySelector(".list")!;
        let last = list.scrollTop;
        let quiet = 0;
        const tick = () => {
          quiet = list.scrollTop === last ? quiet + 1 : 0;
          last = list.scrollTop;
          if (quiet >= 10) done();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );

describe(`GestureMenu in ${browserName}`, () => {
  // A finger that moves or stays down needs Chromium's input protocol: Playwright drives WebKit's touch input only as
  // a whole tap.
  test.skipIf(browserName === "webkit")(
    "a vertical drag scrolls the list and never swipes; a horizontal drag swipes without moving the layout",
    async () => {
      const { page, context } = await open(phone);
      try {
        const cdp = await context.newCDPSession(page);
        const start = await center(page, ".k2b-gesture-menu >> nth=6");
        // Up the screen with a slight sideways drift, as a thumb scrolls.
        await touch(
          cdp,
          Array.from({ length: 12 }, (_, step) => ({ x: start.x + step * 2, y: start.y - step * 20 })),
        );
        await still(page);
        expect(await page.evaluate(() => document.querySelector(".list")!.scrollTop)).toBeGreaterThan(100);
        expect(await fixture(page)).toMatchObject({ calls: { reply: 0, react: 0, copy: 0 }, swipes: 0 });

        const scrolled = await page.evaluate(() => document.querySelector(".list")!.scrollTop);
        const target = page.locator(".k2b-gesture-menu >> nth=8");
        const before = await target.boundingBox();
        const from = await center(page, ".k2b-gesture-menu >> nth=8 >> .text");
        const cdpPoints = Array.from({ length: 10 }, (_, step) => ({ x: 60 + step * 14, y: from.y + step }));
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [cdpPoints[0]!] });
        for (const point of cdpPoints.slice(1)) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point] });
        await until(
          page,
          `document.querySelectorAll(".k2b-gesture-menu")[8].style.getPropertyValue("--k2b-gesture-menu-offset") === "79.5px"`,
        );
        // While the finger is down, the content follows it by a transform; the row itself stays where it was.
        const during = await target.evaluate((surface) => ({
          swipe: surface.getAttribute("data-swipe"),
          armed: surface.hasAttribute("data-armed"),
          transform: getComputedStyle(surface.querySelector(".k2b-gesture-menu__content")!).transform,
          top: surface.getBoundingClientRect().top,
        }));
        expect(during.swipe).toBe("right");
        expect(during.armed).toBe(true);
        expect(during.transform).toBe("matrix(1, 0, 0, 1, 79.5, 0)");
        expect(during.top).toBeCloseTo(before!.y, 0);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await until(page, `window.calls.reply === 1 && !document.querySelector(".k2b-gesture-menu[data-swipe]")`);
        expect(await fixture(page)).toEqual({ calls: { reply: 1, react: 0, copy: 0 }, swipes: 1, shift: 0 });
        expect(await page.evaluate(() => document.querySelector(".list")!.scrollTop)).toBe(scrolled);
        expect(await target.boundingBox()).toEqual(before);
        expect(await target.evaluate((surface) => surface.hasAttribute("data-swipe"))).toBe(false);
      } finally {
        await context.close();
      }
    },
    30_000,
  );

  test.skipIf(browserName === "webkit")("a code block in a row still scrolls sideways under the finger", async () => {
    const { page, context } = await open(phone);
    try {
      const cdp = await context.newCDPSession(page);
      const from = await center(page, ".code");
      await touch(
        cdp,
        Array.from({ length: 10 }, (_, step) => ({ x: from.x + 100 - step * 20, y: from.y })),
      );
      await until(page, `document.querySelector(".code").scrollLeft > 50`);
      expect(await fixture(page)).toMatchObject({ calls: { reply: 0, react: 0, copy: 0 }, swipes: 0 });
    } finally {
      await context.close();
    }
  });

  test.skipIf(browserName === "webkit")(
    "a long press opens the menu as a bottom sheet that stays open after the finger lifts",
    async () => {
      const { page, context } = await open(phone);
      try {
        const cdp = await context.newCDPSession(page);
        const point = await center(page, ".k2b-gesture-menu >> nth=2 >> .text");
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
        const sheet = page.locator("dialog[open] .k2b-gesture-menu__sheet-menu");
        await sheet.waitFor();
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        // The release and anything it would cause, such as a click on the backdrop, are handled by now.
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        await page.waitForTimeout(300);
        await expect(sheet.isVisible()).resolves.toBe(true);
        expect(await page.locator("dialog[open]").getAttribute("aria-label")).toBe("Message 2");
        expect(await page.evaluate(() => getSelection()?.toString() ?? "")).toBe("");
        // Every item has a 44 px touch target at least.
        const heights = await sheet
          .locator("[role='menuitem']")
          .evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height));
        expect(heights).toHaveLength(3);
        for (const height of heights) expect(height).toBeGreaterThanOrEqual(44);
        await page.touchscreen.tap(...(Object.values(await center(page, "dialog[open] [role='menuitem'] >> nth=2")) as [number, number]));
        await until(page, `window.calls.copy === 1 && !document.querySelector("dialog[open]")`);
        expect(await fixture(page)).toMatchObject({ calls: { reply: 0, react: 0, copy: 1 }, shift: 0 });
      } finally {
        await context.close();
      }
    },
    30_000,
  );

  test("a double tap on the text reacts once; on a link it does not", async () => {
    const { page, context } = await open(phone, { pausedClock: true });
    try {
      const point = await center(page, ".k2b-gesture-menu >> nth=3 >> .text");
      await page.touchscreen.tap(point.x, point.y);
      await page.touchscreen.tap(point.x, point.y);
      await until(page, "window.calls.react === 1");
      // The page did not zoom.
      expect(await page.evaluate(() => visualViewport?.scale ?? 1)).toBe(1);

      // Input is handled in order: once the double tap after them reacted, the taps on the link were handled too.
      const link = await center(page, ".link");
      await page.touchscreen.tap(link.x, link.y);
      await page.touchscreen.tap(link.x, link.y);
      await page.touchscreen.tap(point.x, point.y);
      await page.touchscreen.tap(point.x, point.y);
      await until(page, "window.calls.react === 2");
      expect((await fixture(page)).calls).toEqual({ reply: 0, react: 2, copy: 0 });
    } finally {
      await context.close();
    }
  });

  test("with a mouse, a double-click reacts without selecting a word and a right-click opens the menu", async () => {
    const { page, context } = await open({ viewport: { width: 1024, height: 768 } });
    try {
      const point = await center(page, ".k2b-gesture-menu >> nth=1 >> .text");
      await page.mouse.dblclick(point.x, point.y);
      await until(page, "window.calls.react === 1");
      expect(await page.evaluate(() => getSelection()?.toString() ?? "")).toBe("");
      // Dragging still selects text.
      const text = (await page.locator(".k2b-gesture-menu >> nth=1 >> .text").boundingBox())!;
      await page.mouse.move(text.x + 2, point.y);
      await page.mouse.down();
      await page.mouse.move(text.x + 160, point.y, { steps: 5 });
      await page.mouse.up();
      expect((await page.evaluate(() => getSelection()?.toString() ?? "")).length).toBeGreaterThan(3);
      expect(await page.locator(".k2b-gesture-menu[data-swipe]").count()).toBe(0);

      await page.mouse.click(point.x, point.y, { button: "right" });
      const menu = page.locator(".k2b-context-menu[role='menu']");
      await expect(menu.isVisible()).resolves.toBe(true);
      expect(await menu.locator("[role='menuitem']").allTextContents()).toEqual(["Reply", "React with thumbs up", "Copy text"]);
      expect(await page.locator("dialog[open]").count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});
