import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContext, BrowserContextOptions, CDPSession, Page } from "playwright";
import { browserName, launchBrowser } from "../../test/browser";

// Whether a finger scrolls the list or swipes a row, whether a long press survives the release, and whether anything
// moves are decided by a real engine's touch handling and layout. Rows sit in a scrolling list; the conversation
// fixture wraps MessageRow in VirtualFeed, as the documentation recommends for a chat.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "gesture-menu.fixture.ts");
const conversationEntry = resolve(import.meta.dir, "gesture-menu-conversation.fixture.ts");
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
            createComponent(GestureMenu, { label: "Message " + index, items, children: row(index) }),
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
const conversationSource = `
import { createComponent, render } from "solid-js/web";
import { GestureMenu, LocaleProvider, MessageRow, VirtualFeed } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

window.calls = { reply: 0, react: 0, copy: 0, toolbar: 0 };
const people = { nora: { name: "Nora Brandt" }, me: { name: "Robin Example" } };
const messages = Array.from({ length: 12 }, (_, index) => ({
  id: "m" + index,
  author: index % 3 === 2 ? "me" : "nora",
  text: "Message " + index + " with enough words to fill most of a line on a phone",
}));
const actions = [
  { id: "reply", label: "Reply", icon: "ti ti-arrow-back-up", onSelect: () => window.calls.toolbar++ },
  { id: "react", label: "React", icon: "ti ti-mood-smile", onSelect: () => window.calls.toolbar++ },
];
const items = [
  { label: "Reply", icon: "ti ti-arrow-back-up", action: () => window.calls.reply++, gesture: "swipe-right" },
  { label: "React with thumbs up", icon: "ti ti-thumb-up", action: () => window.calls.react++, gesture: "double-tap" },
  { label: "Copy text", icon: "ti ti-copy", action: () => window.calls.copy++ },
];
render(
  () =>
    createComponent(LocaleProvider, {
      locale: "en",
      get children() {
        return createComponent(VirtualFeed, {
          items: messages,
          getKey: (message) => message.id,
          estimateSize: () => 72,
          label: "Conversation",
          itemLabel: (message) => people[message.author].name,
          children: (message) =>
            createComponent(GestureMenu, {
              label: "Message from " + people[message.author].name,
              items,
              get children() {
                return createComponent(MessageRow, {
                  author: people[message.author],
                  text: message.text,
                  time: "10:42",
                  own: message.author === "me",
                  groupStart: true,
                  actions,
                });
              },
            }),
        });
      },
    }),
  document.getElementById("app"),
);
`;
const bundle = async (path: string, source: string) => {
  const build = await Bun.build({
    entrypoints: [path],
    files: { [path]: source },
    target: "browser",
    conditions: ["browser"],
    format: "iife",
  });
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle a GestureMenu fixture for the browser.");
  return build.outputs[0]!.text();
};
const script = await bundle(entry, fixtureSource);
const conversationScript = await bundle(conversationEntry, conversationSource);

type Fixture = { calls: { reply: number; react: number; copy: number }; swipes: number; shift: number };
type Conversation = { calls: { reply: number; react: number; copy: number; toolbar: number } };

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
  options: { pausedClock?: boolean; conversation?: boolean } = {},
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
#app.conversation { display: flex; height: 100vh; }
</style></head><body class="k2b-ui" style="background:var(--k2b-surface)"><div id="app"${options.conversation ? ' class="conversation"' : ""}></div></body></html>`,
  );
  await page.addScriptTag({ content: options.conversation ? conversationScript : script });
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

/**
 * A finger that moves through every point, then lifts, through Chromium's input protocol. Chromium flings a scroll at
 * the speed it reads from the events' timestamps; without them, it stamps each event when its call arrives, so a busy
 * machine that delivers several moves at once flings the list far further. The calls go out back to back, but their
 * timestamps are one 60 Hz frame apart and the lift is stamped 100 ms after the last move. Chromium treats a finger
 * that rests 80 ms or longer before it lifts as stopped, so the list stops without a fling, about as far as the finger
 * moved.
 */
const touch = async (cdp: CDPSession, points: { x: number; y: number }[]) => {
  const [first, ...rest] = points;
  const start = Date.now() / 1000;
  const at = (frame: number) => start + frame / 60;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [first!], timestamp: at(0) });
  for (const [index, point] of rest.entries())
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point], timestamp: at(index + 1) });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [], timestamp: at(points.length + 5) });
};

const hold = async (page: Page, context: BrowserContext, point: { x: number; y: number }, ms = 700) => {
  if (browserName === "chromium") {
    const cdp = await context.newCDPSession(page);
    try {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
      await page.locator(".k2b-context-menu[role='menu'], dialog[open] .k2b-gesture-menu__sheet-menu").waitFor();
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } finally {
      await cdp.detach();
    }
  } else {
    // Playwright drives WebKit touch only as a whole tap; synthetic events exercise the held pointer's lifecycle.
    await page.evaluate(
      async ({ point, ms }) => {
        const target = document.elementFromPoint(point.x, point.y)!;
        const init: PointerEventInit = {
          pointerType: "touch",
          isPrimary: true,
          pointerId: 1,
          bubbles: true,
          cancelable: true,
          clientX: point.x,
          clientY: point.y,
        };
        target.dispatchEvent(new PointerEvent("pointerdown", init));
        await new Promise((resolve) => setTimeout(resolve, ms));
        target.dispatchEvent(new PointerEvent("pointerup", init));
        target.dispatchEvent(new Event("touchend", { bubbles: true, cancelable: true }));
      },
      { point, ms },
    );
  }
};

/**
 * Waits until the page has handled the input sent so far and reached the state `ready` reports. Chromium hands touch
 * moves to the page at its next frame, after the protocol call returned, so reading the page right away can miss them.
 */
const until = (page: Page, ready: string) => page.waitForFunction(ready, undefined, { timeout: 10_000 });

/** Waits until the list has stopped scrolling: its position stays the same for ten frames. */
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
        // The finger lands on row 8, which the scroll left in view.
        expect(
          await page.evaluate(
            ({ x, y }) =>
              document.elementFromPoint(x, y)?.closest(".k2b-gesture-menu") === document.querySelectorAll(".k2b-gesture-menu")[8],
            cdpPoints[0]!,
          ),
        ).toBe(true);
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
        // A connected keyboard reaches the items from the sheet, which holds focus after the long press.
        expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("DIALOG");
        await page.keyboard.press("ArrowDown");
        expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Reply");
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

  const conversation = (page: Page) =>
    page.evaluate(() => ({ calls: { ...(window as unknown as Conversation).calls } }) satisfies Conversation);
  const toolbar = (page: Page, key: string) =>
    page.locator(`[data-key="${key}"] .k2b-message-row__actions`).evaluate((actions) => getComputedStyle(actions).opacity);

  test("in a conversation a tap leaves the message's toolbar hidden, so a double tap where it sits reacts", async () => {
    const { page, context } = await open(phone, { pausedClock: true, conversation: true });
    try {
      const reply = page.locator('[data-key="m7"] .k2b-message-row__actions').getByRole("button", { name: "Reply" });
      const box = (await reply.boundingBox())!;
      const point = [box.x + box.width / 2, box.y + box.height / 2] as const;
      await page.touchscreen.tap(...point);
      expect(await toolbar(page, "m7")).toBe("0");
      await page.touchscreen.tap(...point);
      await until(page, "window.calls.react === 1");
      expect(await conversation(page)).toEqual({ calls: { reply: 0, react: 1, copy: 0, toolbar: 0 } });
      expect(await toolbar(page, "m7")).toBe("0");
    } finally {
      await context.close();
    }
  }, 30_000);

  test("in a conversation the keyboard shows the toolbar, and Tab then Shift+F10 open the message's menu", async () => {
    const { page, context } = await open({ viewport: { width: 1024, height: 768 } }, { conversation: true });
    try {
      await page.mouse.move(1023, 767);
      await page.locator('[data-key="m6"]').focus();
      await page.keyboard.press("ArrowDown");
      expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.key)).toBe("m7");
      expect(await toolbar(page, "m7")).toBe("1");
      expect(await toolbar(page, "m6")).toBe("0");

      await page.keyboard.press("Tab");
      const group = await page.evaluate(() => ({
        role: document.activeElement?.getAttribute("role"),
        popup: document.activeElement?.getAttribute("aria-haspopup"),
        row: (document.activeElement?.closest("[data-key]") as HTMLElement | null)?.dataset.key,
      }));
      expect(group).toEqual({ role: "group", popup: "menu", row: "m7" });
      expect(await toolbar(page, "m7")).toBe("1");

      await page.keyboard.press("Shift+F10");
      const menu = page.locator(".k2b-context-menu[role='menu']");
      await menu.waitFor();
      expect(await menu.locator("[role='menuitem']").allTextContents()).toEqual(["Reply", "React with thumbs up", "Copy text"]);
      await until(page, `document.activeElement?.textContent === "Reply"`);
      await page.keyboard.press("Escape");
      expect(await menu.count()).toBe(0);
      expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("group");
    } finally {
      await context.close();
    }
  }, 30_000);

  test.skipIf(browserName === "webkit")("with reduced motion the swipe's icon shows above the message that stays in place", async () => {
    const { page, context } = await open({ ...phone, reducedMotion: "reduce" }, { conversation: true });
    try {
      const cdp = await context.newCDPSession(page);
      const from = await center(page, '[data-key="m7"] .k2b-message-row__text');
      const points = Array.from({ length: 8 }, (_, step) => ({ x: from.x - 60 + step * 14, y: from.y }));
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [points[0]!] });
      for (const point of points.slice(1)) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point] });
      await until(page, `document.querySelector('[data-key="m7"] .k2b-gesture-menu')?.hasAttribute("data-armed")`);
      // Hit testing follows paint order; the icon takes no pointer events of its own.
      const top = await page.evaluate(() => {
        const icon = document.querySelector<HTMLElement>('[data-key="m7"] .k2b-gesture-menu__swipe')!;
        icon.style.pointerEvents = "auto";
        const box = icon.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        icon.style.pointerEvents = "";
        return hit?.closest(".k2b-gesture-menu__swipe") === icon;
      });
      expect(top).toBe(true);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await until(page, "window.calls.reply === 1");
    } finally {
      await context.close();
    }
  });
});

describe(`GestureMenu on tablets in ${browserName}`, () => {
  const portrait: BrowserContextOptions = {
    viewport: { width: 834, height: 1194 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  };
  const landscape: BrowserContextOptions = { ...portrait, viewport: { width: 1194, height: 834 } };
  const labels = ["Reply", "React with thumbs up", "Copy text"];

  for (const [name, options] of [
    ["portrait", portrait],
    ["landscape", landscape],
  ] as const) {
    test(`a ${name} hold opens the menu at the finger and keeps it open after the lift`, async () => {
      const { page, context } = await open(options);
      try {
        const point = await center(page, ".k2b-gesture-menu >> nth=2 >> .text");
        await hold(page, context, point);
        const menu = page.locator(".k2b-context-menu[role='menu']");
        await menu.waitFor();
        const box = (await menu.boundingBox())!;
        expect(Math.abs(box.x - point.x)).toBeLessThanOrEqual(24);
        expect(Math.abs(box.y - point.y)).toBeLessThanOrEqual(24);
        expect(await menu.locator("[role='menuitem']").allTextContents()).toEqual(labels);
        // The finger covers the row, so the menu names it.
        expect(await menu.locator(".k2b-context-menu__title").textContent()).toBe("Message 2");
        expect(await page.locator("dialog[open]").count()).toBe(0);
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        await page.waitForTimeout(300);
        expect(await menu.isVisible()).toBe(true);
        expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Reply");
        expect(await page.evaluate(() => getSelection()?.toString() ?? "")).toBe("");
        expect((await fixture(page)).calls).toEqual({ reply: 0, react: 0, copy: 0 });
        await page.keyboard.press("Escape");
        expect(await menu.count()).toBe(0);
        expect(await page.getByRole("group", { name: "Message 2", exact: true }).evaluate((host) => host === document.activeElement)).toBe(
          true,
        );
      } finally {
        await context.close();
      }
    }, 30_000);
  }

  test("a hold near the list's bottom-right corner clamps the menu inside the viewport", async () => {
    const { page, context } = await open(landscape);
    try {
      const viewport = page.viewportSize()!;
      const list = (await page.locator(".list").boundingBox())!;
      const point = { x: viewport.width - 20, y: Math.min(list.y + list.height, viewport.height) - 10 };
      expect(
        await page.evaluate(({ x, y }) => {
          const target = document.elementFromPoint(x, y);
          return !!target?.closest(".k2b-gesture-menu") && !target.closest("a, pre, [data-gesture-ignore]");
        }, point),
      ).toBe(true);
      await hold(page, context, point);
      const menu = page.locator(".k2b-context-menu[role='menu']");
      await menu.waitFor();
      const box = (await menu.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(8);
      expect(box.y).toBeGreaterThanOrEqual(8);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 8);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - 8);
    } finally {
      await context.close();
    }
  }, 30_000);

  // Everything outside a modal dialog is inert, also a menu on the body, so the hold keeps the sheet there.
  test("inside a modal dialog a hold still opens the sheet", async () => {
    const { page, context } = await open(landscape);
    try {
      await page.evaluate(() => {
        const dialog = document.createElement("dialog");
        dialog.className = "host";
        document.getElementById("app")!.append(dialog);
        dialog.append(document.querySelector(".list")!);
        dialog.showModal();
      });
      await hold(page, context, await center(page, ".k2b-gesture-menu >> nth=2 >> .text"));
      const sheet = page.locator("dialog[open] .k2b-gesture-menu__sheet-menu");
      await sheet.waitFor();
      expect(await page.locator(".k2b-context-menu").count()).toBe(0);
      await page.keyboard.press("ArrowDown");
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Reply");
    } finally {
      await context.close();
    }
  }, 30_000);

  test("a 390px phone still opens the bottom sheet", async () => {
    const { page, context } = await open(phone);
    try {
      await hold(page, context, await center(page, ".k2b-gesture-menu >> nth=2 >> .text"));
      const sheet = page.locator("dialog[open] .k2b-gesture-menu__sheet-menu");
      await sheet.waitFor();
      expect(await sheet.isVisible()).toBe(true);
      expect(await page.locator(".k2b-context-menu").count()).toBe(0);
    } finally {
      await context.close();
    }
  }, 30_000);

  // Only Chromium's CDP input can exercise real scrolling; Playwright drives WebKit touch only as a whole tap.
  test.skipIf(browserName === "webkit")(
    "moving before the hold scrolls the list and opens nothing",
    async () => {
      const { page, context } = await open(portrait);
      try {
        const cdp = await context.newCDPSession(page);
        const point = await center(page, ".k2b-gesture-menu >> nth=6 >> .text");
        await touch(cdp, [point, ...Array.from({ length: 8 }, (_, step) => ({ x: point.x, y: point.y - 12 - step * 16 }))]);
        await still(page);
        expect(await page.evaluate(() => document.querySelector(".list")!.scrollTop)).toBeGreaterThan(0);
        await page.waitForTimeout(700);
        expect(await page.locator(".k2b-context-menu, dialog[open]").count()).toBe(0);
        expect((await fixture(page)).calls).toEqual({ reply: 0, react: 0, copy: 0 });
      } finally {
        await context.close();
      }
    },
    30_000,
  );

  test.skipIf(browserName === "webkit")(
    "moving after the hold does not scroll or close the popover",
    async () => {
      const { page, context } = await open(portrait);
      try {
        const cdp = await context.newCDPSession(page);
        const point = await center(page, ".k2b-gesture-menu >> nth=6 >> .text");
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
        const menu = page.locator(".k2b-context-menu[role='menu']");
        await menu.waitFor();
        const before = await page.evaluate(() => document.querySelector(".list")!.scrollTop);
        const start = Date.now() / 1000;
        for (let step = 1; step <= 5; step++)
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x: point.x, y: point.y - step * 16 }],
            timestamp: start + step / 60,
          });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [], timestamp: start + 11 / 60 });
        await still(page);
        expect(await page.evaluate(() => document.querySelector(".list")!.scrollTop)).toBe(before);
        expect(await menu.isVisible()).toBe(true);
        expect((await fixture(page)).calls).toEqual({ reply: 0, react: 0, copy: 0 });
      } finally {
        await context.close();
      }
    },
    30_000,
  );

  // WebKit has no held-touch protocol in Playwright; synthetic pointer movement checks cancellation before the timer.
  test.skipIf(browserName !== "webkit")(
    "moving a synthetic finger before the hold opens nothing",
    async () => {
      const { page, context } = await open(portrait);
      try {
        const point = await center(page, ".k2b-gesture-menu >> nth=2 >> .text");
        await page.evaluate(async ({ x, y }) => {
          const target = document.elementFromPoint(x, y)!;
          const init: PointerEventInit = {
            pointerType: "touch",
            isPrimary: true,
            pointerId: 1,
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
          };
          target.dispatchEvent(new PointerEvent("pointerdown", init));
          await new Promise((resolve) => setTimeout(resolve, 80));
          target.dispatchEvent(new PointerEvent("pointermove", { ...init, clientY: y + 20 }));
          await new Promise((resolve) => setTimeout(resolve, 700));
          target.dispatchEvent(new PointerEvent("pointerup", { ...init, clientY: y + 20 }));
          target.dispatchEvent(new Event("touchend", { bubbles: true, cancelable: true }));
        }, point);
        expect(await page.locator(".k2b-context-menu, dialog[open]").count()).toBe(0);
        expect((await fixture(page)).calls).toEqual({ reply: 0, react: 0, copy: 0 });
      } finally {
        await context.close();
      }
    },
    30_000,
  );

  test("right-click still opens at the pointer and Escape returns focus to the group", async () => {
    const { page, context } = await open(landscape);
    try {
      const point = await center(page, ".k2b-gesture-menu >> nth=2 >> .text");
      await page.mouse.click(point.x, point.y, { button: "right" });
      const menu = page.locator(".k2b-context-menu[role='menu']");
      await menu.waitFor();
      const box = (await menu.boundingBox())!;
      expect(Math.abs(box.x - point.x)).toBeLessThanOrEqual(24);
      expect(Math.abs(box.y - point.y)).toBeLessThanOrEqual(24);
      expect(await menu.locator("[role='menuitem']").allTextContents()).toEqual(labels);
      await until(page, `document.activeElement?.textContent === "Reply"`);
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Reply");
      await page.keyboard.press("Escape");
      expect(await menu.count()).toBe(0);
      expect(await page.getByRole("group", { name: "Message 2", exact: true }).evaluate((host) => host === document.activeElement)).toBe(
        true,
      );
    } finally {
      await context.close();
    }
  }, 30_000);

  // Swipes need Chromium's held-touch protocol too.
  test.skipIf(browserName === "webkit")(
    "a horizontal swipe on a tablet still replies once",
    async () => {
      const { page, context } = await open(portrait);
      try {
        const cdp = await context.newCDPSession(page);
        const from = await center(page, ".k2b-gesture-menu >> nth=8 >> .text");
        const points = Array.from({ length: 10 }, (_, step) => ({ x: 60 + step * 14, y: from.y + step }));
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [points[0]!] });
        for (const point of points.slice(1)) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point] });
        await until(page, `document.querySelectorAll(".k2b-gesture-menu")[8].hasAttribute("data-armed")`);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await until(page, `window.calls.reply === 1 && !document.querySelector(".k2b-gesture-menu[data-swipe]")`);
        expect(await fixture(page)).toMatchObject({ calls: { reply: 1, react: 0, copy: 0 }, swipes: 1 });
        expect(await page.locator(".k2b-context-menu, dialog[open]").count()).toBe(0);
        expect(await page.evaluate(() => document.querySelector(".list")!.scrollTop)).toBe(0);
      } finally {
        await context.close();
      }
    },
    30_000,
  );
});
