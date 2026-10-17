import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { browserName, launchBrowser } from "../../test/browser";

const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "drag-and-drop.fixture.ts");
const source = `
import { createSignal } from "solid-js";
import { createComponent, insert, render } from "solid-js/web";
import { DragSource, DropTarget, GestureMenu, LocaleProvider, useKeyboardDrag, activeDrag } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
window.drops = []; window.clicks = 0; window.announcements = []; window.shift = 0;
// WebKit decides at touchstart whether a touch can be kept from scrolling, so record which touchmove listeners exist.
window.touchListeners = [];
const addListener = EventTarget.prototype.addEventListener;
EventTarget.prototype.addEventListener = function (type, listener, options) {
  if (type === "touchmove") window.touchListeners.push({ target: this, passive: typeof options === "object" ? options.passive : undefined });
  return addListener.call(this, type, listener, options);
};
window.addEventListener("pointerdown", event => window.lastPointer = event.pointerId, true);
const [removed, setRemoved] = createSignal(false);
const [disabled, setDisabled] = createSignal(false);
window.removeFirst = () => setRemoved(true);
window.disableArchive = () => setDisabled(true);
render(() => createComponent(LocaleProvider, { locale: new URLSearchParams(location.search).get("locale") || "en", get children() {
  const pickUp = useKeyboardDrag();
  const list = document.createElement("div"); list.className = "list";
  insert(list, Array.from({ length: 30 }, (_, i) => {
    const payload = { type: "demo.row", value: "row-" + i, label: "Row " + i, icon: "ti ti-mail" };
    const content = document.createElement("div"); content.className = "row"; content.textContent = payload.label;
    content.addEventListener("click", () => window.clicks++);
    const menu = () => createComponent(GestureMenu, { label: payload.label, items: [
      { label: "Reply", action: () => {} },
      { label: "Move…", action: () => pickUp(payload, content) },
    ], get children() { return i === 1 ? createComponent(DragSource, { payload, children: content }) : content; } });
    // Exercise both nestings. Removing through Solid runs the source's cleanup.
    if (i === 1) return menu();
    const host = document.createElement("div");
    insert(host, () => i === 0 && removed() ? null : createComponent(DragSource, { payload, get children() { return menu(); } }));
    return host;
  }));
  const rail = document.createElement("div"); rail.className = "rail";
  const target = (label, accept) => createComponent(DropTarget, { label, accept, class: label.toLowerCase(),
    get disabled() { return label === "Archive" && disabled(); },
    onDrop: (payload) => window.drops.push({ target: label, value: payload.value }), children: label });
  insert(rail, [target("Archive", ["demo.row"]), target("Calendar", ["demo.task"])]);
  const extra = document.createElement("div"); extra.className = "extra";
  // Opt in per test, so the normal keyboard path has exactly one accepting destination.
  insert(extra, () => activeDrag() && window.extraTarget ? target("Later", ["demo.row"]) : null);
  return [list, rail, extra];
} }), document.getElementById("app"));
// A source without a GestureMenu, and one inside editable content that drags only from its handle.
window.mountBare = () => {
  const host = document.createElement("div"); document.querySelector(".rail").append(host);
  const row = document.createElement("div"); row.className = "row bare-row"; row.textContent = "Bare";
  render(() => createComponent(LocaleProvider, { locale: "en", get children() {
    return createComponent(DragSource, { class: "bare-source", payload: { type: "demo.row", value: "bare", label: "Bare" }, children: row });
  } }), host);
};
window.mountEditable = () => {
  const editor = document.createElement("div"); editor.contentEditable = "true"; document.querySelector(".rail").append(editor);
  const paragraph = document.createElement("p"); paragraph.className = "row paragraph"; paragraph.textContent = "Paragraph text";
  const handle = document.createElement("span"); handle.className = "handle"; handle.contentEditable = "false"; handle.textContent = "::";
  render(() => createComponent(LocaleProvider, { locale: "en", get children() {
    return createComponent(DragSource, { class: "paragraph-source", payload: { type: "demo.row", value: "paragraph", label: "Paragraph" }, children: [handle, paragraph] });
  } }), editor);
};
// A modal dialog nested inside the Archive target, with its own source.
window.openNested = () => {
  const dialog = document.createElement("dialog"); dialog.className = "nested"; dialog.style.padding = "40px";
  document.querySelector(".archive").append(dialog);
  render(() => createComponent(LocaleProvider, { locale: "en", get children() {
    const row = document.createElement("div"); row.className = "inner-row"; row.textContent = "Inner row";
    const pickUp = useKeyboardDrag();
    window.pickUpInner = () => pickUp({ type: "demo.row", value: "inner", label: "Inner" }, row);
    return [
      createComponent(DragSource, { payload: { type: "demo.row", value: "inner", label: "Inner" }, children: row }),
      createComponent(DropTarget, { label: "Inbox", accept: ["demo.row"], class: "inbox",
        onDrop: (payload) => window.drops.push({ target: "Inbox", value: payload.value }), children: "Inbox" }),
    ];
  } }), dialog);
  dialog.showModal();
};
new MutationObserver(() => {
  const text = document.querySelector('.k2b-drag-announcer')?.textContent;
  if (text && window.announcements.at(-1) !== text) window.announcements.push(text);
}).observe(document.body, { subtree: true, childList: true, characterData: true });
if (PerformanceObserver.supportedEntryTypes.includes("layout-shift"))
  new PerformanceObserver(list => { for (const shift of list.getEntries()) window.shift += shift.value; }).observe({ type: "layout-shift", buffered: true });
`;
const build = await Bun.build({
  entrypoints: [entry],
  files: { [entry]: source },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the drag and drop fixture.");
const script = await build.outputs[0]!.text();
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (options: BrowserContextOptions = {}) => {
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, ...options });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>
    body { margin: 0; } #app { display: flex; gap: 24px; padding: 20px; align-items: start; }
    .list { height: 300px; width: 400px; overflow: auto; flex: none; } .row { height: 48px; padding: 12px; box-sizing: border-box; }
    .rail { display: grid; gap: 20px; } .k2b-drop-target { width: 160px; padding: 20px; box-sizing: border-box; }
    .extra { position: fixed; bottom: 20px; right: 20px; }
    </style></head><body class="k2b-ui"><div id="app"></div></body></html>`);
  await page.addScriptTag({ content: script });
  await page.locator(".row").first().waitFor();
  return { page, context };
};
const until = (page: Page, expression: string) => page.waitForFunction(expression, undefined, { timeout: 10_000 });
const center = async (page: Page, selector: string) => {
  const box = (await page.locator(selector).first().boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
const startMouse = async (page: Page, index = 2) => {
  const point = await center(page, `.row >> nth=${index}`);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 15, point.y);
  await page.locator(".k2b-drag-preview").waitFor();
  return point;
};
const moveTo = async (page: Page, selector: string) => {
  const point = await center(page, selector);
  await page.mouse.move(point.x, point.y);
  return point;
};
const clean = async (page: Page) => {
  await until(page, `!document.querySelector('.k2b-drag-preview, [data-drop], [data-dragging], [data-held]')`);
};
const drops = (page: Page) => page.evaluate("window.drops");

describe(`drag and drop in ${browserName}`, () => {
  test("mouse slop, preview, accepting drop, and stable source geometry", async () => {
    const { page, context } = await open();
    try {
      const row = page.locator(".k2b-drag-source").nth(2);
      const before = await row.boundingBox();
      const point = await center(page, ".row >> nth=2");
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      await page.mouse.move(point.x + 5, point.y);
      await page.mouse.up();
      expect(await page.locator(".k2b-drag-preview").count()).toBe(0);
      await startMouse(page);
      expect(await row.boundingBox()).toEqual(before);
      const target = await moveTo(page, ".archive");
      await until(page, `document.querySelector('.archive')?.dataset.drop === 'over'`);
      expect(await page.locator(".calendar").getAttribute("data-drop")).toBeNull();
      // The preview sits at the pointer; WebKit reports mouse coordinates in whole pixels.
      const [x, y] = await page
        .locator(".k2b-drag-preview")
        .evaluate((el) => (/translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(el.style.transform) ?? []).slice(1).map(Number));
      expect(Math.abs(x! - target.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(y! - target.y)).toBeLessThanOrEqual(1);
      // In the top layer, so a transformed or modal dialog neither offsets nor covers it.
      expect(await page.locator(".k2b-drag-preview").evaluate((el) => el.matches(":popover-open"))).toBe(true);
      await until(page, "window.announcements.some(text => text.startsWith('Row 2 picked up.'))");
      // Captured, so a release over an iframe still ends the drag.
      expect(await row.evaluate((el) => el.hasPointerCapture((window as unknown as { lastPointer: number }).lastPointer))).toBe(true);
      await page.mouse.up();
      await clean(page);
      expect(await drops(page)).toEqual([{ target: "Archive", value: "row-2" }]);
      await until(page, `document.querySelector('.k2b-drag-announcer')?.textContent?.endsWith('Row 2 dropped on Archive.')`);
      expect(await row.boundingBox()).toEqual(before);
      if (browserName === "chromium") expect(await page.evaluate<number>("window.shift")).toBe(0);
    } finally {
      await context.close();
    }
  });

  test("the preview keeps a scoped dark theme", async () => {
    const { page, context } = await open();
    try {
      await page.evaluate(() => {
        document.body.dataset.theme = "dark";
      });
      await startMouse(page);
      // --k2b-surface-elevated of the dark theme, #181d24.
      expect(await page.locator(".k2b-drag-preview").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(24, 29, 36)");
      await page.keyboard.press("Escape");
      await page.mouse.up();
      await clean(page);
    } finally {
      await context.close();
    }
  });

  test("an incompatible target refuses and does not drop", async () => {
    const { page, context } = await open();
    try {
      await startMouse(page);
      await moveTo(page, ".calendar");
      await until(page, `document.querySelector('.calendar')?.dataset.drop === 'refused'`);
      await until(page, `document.querySelector('.k2b-drag-announcer')?.textContent?.endsWith('Calendar does not take Row 2.')`);
      await page.mouse.up();
      await clean(page);
      expect(await drops(page)).toEqual([]);
      await until(page, `document.querySelector('.k2b-drag-announcer')?.textContent?.endsWith('Row 2 not moved.')`);
    } finally {
      await context.close();
    }
  });

  for (const index of [1, 2])
    test(`held touch hands the menu to the drag, nesting ${index}`, async () => {
      const { page, context } = await open({ viewport: { width: 834, height: 1194 }, hasTouch: true, isMobile: true });
      try {
        const point = await center(page, `.row >> nth=${index}`);
        const target = await center(page, ".archive");
        if (browserName === "chromium") {
          const cdp = await context.newCDPSession(page);
          try {
            await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
            await page.locator(".k2b-context-menu").waitFor();
            await page.locator("[data-held]").waitFor();
            await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: point.x + 20, y: point.y }] });
            await page.locator(".k2b-drag-preview").waitFor();
            await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [target] });
            await until(page, `document.querySelector('.archive')?.dataset.drop === 'over'`);
            await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          } finally {
            await cdp.detach();
          }
        } else {
          // Playwright drives WebKit touch only as a whole tap; synthetic PointerEvents exercise the held pointer lifecycle.
          await page.evaluate(
            ({ point, index }) => {
              const row = document.querySelectorAll(".row")[index]!;
              row.dispatchEvent(
                new PointerEvent("pointerdown", {
                  pointerId: 7,
                  pointerType: "touch",
                  isPrimary: true,
                  button: 0,
                  bubbles: true,
                  cancelable: true,
                  clientX: point.x,
                  clientY: point.y,
                }),
              );
            },
            { point, index },
          );
          await page.locator(".k2b-context-menu").waitFor();
          await page.locator("[data-held]").waitFor();
          await page.evaluate(
            ({ point, target, index }) => {
              const row = document.querySelectorAll(".row")[index]!;
              const send = (type: string, x: number, y: number) =>
                row.dispatchEvent(
                  new PointerEvent(type, {
                    pointerId: 7,
                    pointerType: "touch",
                    isPrimary: true,
                    button: 0,
                    bubbles: true,
                    cancelable: true,
                    clientX: x,
                    clientY: y,
                  }),
                );
              send("pointermove", point.x + 20, point.y);
              send("pointermove", target.x, target.y);
            },
            { point, target, index },
          );
          await until(page, `document.querySelector('.archive')?.dataset.drop === 'over'`);
          await page.evaluate(
            ({ target, index }) => {
              const row = document.querySelectorAll(".row")[index]!;
              row.dispatchEvent(
                new PointerEvent("pointerup", { pointerId: 7, pointerType: "touch", bubbles: true, clientX: target.x, clientY: target.y }),
              );
              const end = new Event("touchend", { bubbles: true, cancelable: true });
              row.dispatchEvent(end);
              if (!end.defaultPrevented) row.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
            },
            { target, index },
          );
        }
        await clean(page);
        expect(await page.locator(".k2b-context-menu").count()).toBe(0);
        expect(await drops(page)).toEqual([{ target: "Archive", value: `row-${index}` }]);
        expect(await page.evaluate<number>("window.clicks")).toBe(0);
        // The menu had focus; closed by the drag, it returns focus to its group instead of dropping it on the body.
        expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("group");
      } finally {
        await context.close();
      }
    });

  // A finger that stays down while a modal sheet opens needs Chromium's input protocol.
  test.skipIf(browserName === "webkit")("below 48rem a held touch closes the sheet and drags", async () => {
    const { page, context } = await open({ viewport: { width: 760, height: 900 }, hasTouch: true, isMobile: true });
    try {
      const point = await center(page, ".row >> nth=2");
      const target = await center(page, ".archive");
      const cdp = await context.newCDPSession(page);
      try {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
        await page.locator("dialog[open] .k2b-gesture-menu__sheet-menu").waitFor();
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: point.x + 20, y: point.y }] });
        await page.locator(".k2b-drag-preview").waitFor();
        await until(page, `!document.querySelector("dialog[open]")`);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [target] });
        await until(page, `document.querySelector('.archive')?.dataset.drop === 'over'`);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } finally {
        await cdp.detach();
      }
      await clean(page);
      expect(await drops(page)).toEqual([{ target: "Archive", value: "row-2" }]);
      expect(await page.evaluate<number>("window.clicks")).toBe(0);
    } finally {
      await context.close();
    }
  });

  test("a source without a GestureMenu keeps a held touch from scrolling", async () => {
    const { page, context } = await open({ viewport: { width: 834, height: 1194 }, hasTouch: true, isMobile: true });
    try {
      await page.evaluate("window.mountBare()");
      // Present before any press, so WebKit lets the hold cancel the moves of a touch that started on the source.
      expect(
        await page.evaluate(() =>
          (window as unknown as { touchListeners: { target: EventTarget; passive?: boolean }[] }).touchListeners.some(
            (entry) => entry.target === document.querySelector(".bare-source") && entry.passive === false,
          ),
        ),
      ).toBe(true);
      // Chromium's input protocol drives the real touch; WebKit's has no held touch in Playwright.
      if (browserName === "chromium") {
        const point = await center(page, ".bare-row");
        const target = await center(page, ".archive");
        const cdp = await context.newCDPSession(page);
        try {
          await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
          await page.locator("[data-held]").waitFor();
          await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: point.x, y: point.y + 20 }] });
          await page.locator(".k2b-drag-preview").waitFor();
          await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [target] });
          await until(page, `document.querySelector('.archive')?.dataset.drop === 'over'`);
          await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        } finally {
          await cdp.detach();
        }
        await clean(page);
        expect(await drops(page)).toEqual([{ target: "Archive", value: "bare" }]);
        expect(await page.evaluate(() => [window.scrollX, window.scrollY])).toEqual([0, 0]);
      }
    } finally {
      await context.close();
    }
  });

  test("a platform long press before the hold time counts as the hold", async () => {
    const { page, context } = await open({ viewport: { width: 834, height: 1194 }, hasTouch: true, isMobile: true });
    try {
      const point = await center(page, ".row >> nth=2");
      const target = await center(page, ".archive");
      // Android sends contextmenu for a long press at about 400 ms, before the 500 ms timer; all of this runs well before it.
      const seen = await page.evaluate(
        async ({ point }) => {
          const row = document.querySelectorAll(".row")[2]!;
          const pointer = (type: string, x: number, y: number) =>
            row.dispatchEvent(
              new PointerEvent(type, {
                pointerId: 7,
                pointerType: "touch",
                isPrimary: true,
                button: 0,
                bubbles: true,
                cancelable: true,
                clientX: x,
                clientY: y,
              }),
            );
          pointer("pointerdown", point.x, point.y);
          row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y }));
          await new Promise((resolve) => setTimeout(resolve, 50));
          const menu = document.querySelector(".k2b-context-menu") !== null;
          pointer("pointermove", point.x + 20, point.y);
          return { menu, preview: document.querySelector(".k2b-drag-preview") !== null };
        },
        { point },
      );
      expect(seen).toEqual({ menu: true, preview: true });
      await page.evaluate(
        ({ target }) => {
          const row = document.querySelectorAll(".row")[2]!;
          for (const type of ["pointermove", "pointerup"])
            row.dispatchEvent(
              new PointerEvent(type, {
                pointerId: 7,
                pointerType: "touch",
                isPrimary: true,
                bubbles: true,
                clientX: target.x,
                clientY: target.y,
              }),
            );
        },
        { target },
      );
      await clean(page);
      expect(await page.locator(".k2b-context-menu").count()).toBe(0);
      expect(await drops(page)).toEqual([{ target: "Archive", value: "row-2" }]);
    } finally {
      await context.close();
    }
  });

  test("a source inside editable content keeps its text and drags from a handle", async () => {
    const { page, context } = await open();
    try {
      await page.evaluate("window.mountEditable()");
      // The touch-only rule that turns off text selection skips editable sources through this selector.
      expect(await page.locator(".paragraph-source").evaluate((el) => el.matches(":read-write"))).toBe(true);
      const text = await center(page, ".paragraph");
      await page.mouse.move(text.x, text.y);
      await page.mouse.down();
      await page.mouse.move(text.x + 30, text.y);
      // Checked with the button still down, as a drag would end with the release.
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect(await page.locator(".k2b-drag-preview, [data-dragging]").count()).toBe(0);
      await page.mouse.up();
      const handle = await center(page, ".handle");
      await page.mouse.move(handle.x, handle.y);
      await page.mouse.down();
      await page.mouse.move(handle.x + 15, handle.y);
      await page.locator(".k2b-drag-preview").waitFor();
      await page.keyboard.press("Escape");
      await page.mouse.up();
      await clean(page);
      expect(await drops(page)).toEqual([]);
    } finally {
      await context.close();
    }
  });

  // Playwright cannot drive a WebKit touch scroll; synthetic PointerEvents cannot scroll the browser.
  test.skipIf(browserName === "webkit")("touch movement before the hold scrolls instead of dragging", async () => {
    const { page, context } = await open({ hasTouch: true, isMobile: true });
    try {
      const cdp = await context.newCDPSession(page);
      try {
        const point = await center(page, ".row >> nth=4");
        const now = Date.now() / 1000;
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point], timestamp: now });
        for (let i = 1; i <= 8; i++)
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x: point.x, y: point.y - i * 15 }],
            timestamp: now + i / 60,
          });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [], timestamp: now + 13 / 60 });
        await until(page, `document.querySelector('.list').scrollTop > 0`);
        await clean(page);
        expect(await drops(page)).toEqual([]);
        expect(await page.locator(".k2b-context-menu").count()).toBe(0);
      } finally {
        await cdp.detach();
      }
    } finally {
      await context.close();
    }
  });

  test("autoscroll continues at rest and stops outside the edge zone", async () => {
    const { page, context } = await open();
    try {
      await startMouse(page);
      const box = (await page.locator(".list").boundingBox())!;
      await page.mouse.move(box.x + 100, box.y + box.height - 4);
      await until(page, `document.querySelector('.list').scrollTop >= 36`);
      await page.mouse.move(box.x + 100, box.y + 150);
      const samples = await page.evaluate(async () => {
        const list = document.querySelector(".list")!;
        await new Promise(requestAnimationFrame);
        const before = list.scrollTop;
        for (let i = 0; i < 5; i++) await new Promise(requestAnimationFrame);
        return [before, list.scrollTop];
      });
      expect(samples[1]).toBe(samples[0]);
      await page.keyboard.press("Escape");
      await page.mouse.up();
      await clean(page);
    } finally {
      await context.close();
    }
  });

  for (const method of ["Escape", "pointercancel", "blur", "second pointer"])
    test(`${method} cancels with complete cleanup`, async () => {
      const { page, context } = await open();
      try {
        await startMouse(page);
        await moveTo(page, ".archive");
        await until(page, `document.querySelector('.archive')?.dataset.drop === 'over'`);
        if (method === "Escape") await page.keyboard.press("Escape");
        else
          await page.evaluate(
            ({ method, pointerId }) => {
              if (method === "blur") window.dispatchEvent(new Event("blur"));
              else
                window.dispatchEvent(
                  new PointerEvent(method === "pointercancel" ? "pointercancel" : "pointerdown", {
                    pointerId: method === "pointercancel" ? pointerId : pointerId + 1,
                    bubbles: true,
                  }),
                );
            },
            { method, pointerId: await page.evaluate<number>("window.lastPointer") },
          );
        await clean(page);
        await page.mouse.up();
        expect(await drops(page)).toEqual([]);
        await until(page, `document.querySelector('.k2b-drag-announcer')?.textContent?.endsWith('Row 2 not moved.')`);
        expect(await page.evaluate(() => document.documentElement.style.userSelect)).toBe("");
      } finally {
        await context.close();
      }
    });

  test("keyboard pickup from the row menu drops and returns focus", async () => {
    const { page, context } = await open();
    try {
      const row = page.getByRole("group", { name: "Row 2", exact: true });
      await row.focus();
      await page.keyboard.press("Shift+F10");
      await until(page, `document.activeElement?.textContent === 'Reply'`);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await until(page, `document.querySelector('.archive')?.dataset.drop === 'over'`);
      // Instructions and the first choice come as one announcement; texts from before the region was ready precede it.
      await until(
        page,
        `document.querySelector('.k2b-drag-announcer')?.textContent?.endsWith('Row 2 picked up. 1 place takes it. Arrow keys choose a place, Enter drops, Escape cancels. Archive, 1 of 1.')`,
      );
      await page.keyboard.press("ArrowDown");
      await until(page, `document.querySelector('.k2b-drag-announcer')?.textContent === 'Archive, 1 of 1.'`);
      await page.keyboard.press("Enter");
      await clean(page);
      expect(await drops(page)).toEqual([{ target: "Archive", value: "row-2" }]);
      await until(page, `document.querySelector('.k2b-drag-announcer')?.textContent?.endsWith('Row 2 dropped on Archive.')`);
      expect(await row.evaluate((el) => el === document.activeElement)).toBe(true);
    } finally {
      await context.close();
    }
  });

  test("Escape with the button still down keeps the release from clicking the row", async () => {
    const { page, context } = await open();
    try {
      const point = await startMouse(page);
      await page.keyboard.press("Escape");
      await clean(page);
      await page.mouse.move(point.x, point.y);
      await page.mouse.up();
      await page.evaluate(() => new Promise((done) => setTimeout(done, 50)));
      expect(await page.evaluate<number>("window.clicks")).toBe(0);
      // The next press clicks as usual.
      await page.mouse.click(point.x, point.y);
      await until(page, "window.clicks === 1");
    } finally {
      await context.close();
    }
  });

  test("keyboard pickup waits for destinations shown only while dragging", async () => {
    const { page, context } = await open();
    try {
      await page.evaluate("window.extraTarget = true; window.disableArchive()");
      const row = page.getByRole("group", { name: "Row 2", exact: true });
      await row.focus();
      await page.keyboard.press("Shift+F10");
      await until(page, `document.activeElement?.textContent === 'Reply'`);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await until(page, `document.querySelector('.later')?.dataset.drop === 'over'`);
      await until(page, `document.querySelector(".k2b-drag-announcer")?.textContent?.endsWith("Later, 1 of 1.")`);
      await page.keyboard.press("Enter");
      await clean(page);
      expect(await drops(page)).toEqual([{ target: "Later", value: "row-2" }]);
    } finally {
      await context.close();
    }
  });

  test("keyboard choices follow destinations that hide during the pickup", async () => {
    const { page, context } = await open();
    try {
      await page.evaluate("window.extraTarget = true");
      const row = page.getByRole("group", { name: "Row 2", exact: true });
      await row.focus();
      await page.keyboard.press("Shift+F10");
      await until(page, `document.activeElement?.textContent === 'Reply'`);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await until(page, `document.querySelector('.k2b-drag-announcer')?.textContent?.endsWith('Archive, 1 of 2.')`);
      await page.locator(".later").evaluate((el) => {
        (el as HTMLElement).style.visibility = "hidden";
      });
      await page.keyboard.press("ArrowDown");
      await until(page, `document.querySelector('.k2b-drag-announcer')?.textContent === 'Archive, 1 of 1.'`);
      await page.keyboard.press("Enter");
      await clean(page);
      expect(await drops(page)).toEqual([{ target: "Archive", value: "row-2" }]);
    } finally {
      await context.close();
    }
  });

  test("a modal dialog that opens during a keyboard pickup ends it without a drop", async () => {
    const { page, context } = await open();
    try {
      const row = page.getByRole("group", { name: "Row 2", exact: true });
      await row.focus();
      await page.keyboard.press("Shift+F10");
      await until(page, `document.activeElement?.textContent === 'Reply'`);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await until(page, `document.querySelector('.archive')?.dataset.drop === 'over'`);
      await page.evaluate(() => {
        const dialog = document.createElement("dialog");
        dialog.innerHTML = "<button>OK</button>";
        document.body.append(dialog);
        dialog.showModal();
      });
      await page.keyboard.press("Enter");
      await clean(page);
      expect(await drops(page)).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("a second modal that opens over a keyboard pickup inside a modal ends it", async () => {
    const { page, context } = await open();
    try {
      await page.evaluate("window.openNested()");
      await page.evaluate(() => {
        const row = document.querySelector<HTMLElement>(".inner-row")!;
        row.tabIndex = 0;
        row.focus();
      });
      await page.evaluate("window.pickUpInner()");
      // Only the destination inside the same modal takes part.
      await until(page, `document.querySelector('.inbox')?.dataset.drop === 'over'`);
      await page.evaluate(() => {
        const dialog = document.createElement("dialog");
        dialog.innerHTML = "<button>OK</button>";
        document.body.append(dialog);
        dialog.showModal();
      });
      await page.keyboard.press("Enter");
      await clean(page);
      expect(await drops(page)).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("a keyboard pickup ends when a shared dialog stack hides the origin's level", async () => {
    const { page, context } = await open();
    try {
      await page.evaluate("window.openNested()");
      await page.evaluate("window.pickUpInner()");
      await until(page, `document.querySelector('.inbox')?.dataset.drop === 'over'`);
      // The next level of a dialogCore stack hides the level below with display: none.
      const prevented = await page.evaluate(() => {
        (document.querySelector(".inner-row")!.parentElement as HTMLElement).style.display = "none";
        const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
        document.querySelector("dialog.nested")!.dispatchEvent(event);
        return event.defaultPrevented;
      });
      expect(prevented).toBe(false);
      await clean(page);
      expect(await drops(page)).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("text inside an editable region of a source keeps its native drag", async () => {
    const { page, context } = await open();
    try {
      const prevented = await page.evaluate(() => {
        const source = document.querySelectorAll(".k2b-drag-source")[3]!;
        const editor = document.createElement("div");
        editor.contentEditable = "true";
        editor.textContent = "Editable";
        source.append(editor);
        const editable = new DragEvent("dragstart", { bubbles: true, cancelable: true });
        editor.dispatchEvent(editable);
        const row = new DragEvent("dragstart", { bubbles: true, cancelable: true });
        source.querySelector(".row")!.dispatchEvent(row);
        return { editable: editable.defaultPrevented, row: row.defaultPrevented };
      });
      expect(prevented).toEqual({ editable: false, row: true });
    } finally {
      await context.close();
    }
  });

  test("keyboard pickup skips a hidden destination", async () => {
    const { page, context } = await open();
    try {
      // Still laid out, but invisible: a pointer cannot aim at it, so the keyboard must not either.
      await page.locator(".archive").evaluate((el) => {
        (el as HTMLElement).style.visibility = "hidden";
      });
      const row = page.getByRole("group", { name: "Row 2", exact: true });
      await row.focus();
      await page.keyboard.press("Shift+F10");
      await until(page, `document.activeElement?.textContent === 'Reply'`);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await until(page, `document.querySelector('.k2b-drag-announcer')?.textContent?.endsWith('No place here takes Row 2.')`);
      await clean(page);
      expect(await row.evaluate((el) => el === document.activeElement)).toBe(true);
      await page.keyboard.press("Enter");
      expect(await drops(page)).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("a drag inside a modal dialog never reaches a target around the dialog", async () => {
    const { page, context } = await open();
    try {
      await page.evaluate("document.body.style.height = '3000px'; window.openNested()");
      const row = (await page.locator(".inner-row").boundingBox())!;
      const dialog = (await page.locator("dialog.nested").boundingBox())!;
      await page.mouse.move(row.x + 10, row.y + row.height / 2);
      await page.mouse.down();
      await page.mouse.move(row.x + 30, row.y + row.height / 2);
      await page.locator(".k2b-drag-preview").waitFor();
      await page.mouse.move(dialog.x + 8, dialog.y + 8);
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      expect(await page.locator(".archive").getAttribute("data-drop")).not.toBe("over");
      // Resting at the viewport's edge over the backdrop never scrolls the page behind the modal.
      await page.mouse.move(dialog.x + 8, page.viewportSize()!.height - 4);
      await page.evaluate(() => new Promise((done) => setTimeout(done, 200)));
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      await page.mouse.up();
      await clean(page);
      expect(await drops(page)).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("unmounting a source cancels the drag", async () => {
    const { page, context } = await open();
    try {
      await startMouse(page, 0);
      await moveTo(page, ".archive");
      await page.evaluate("window.removeFirst()");
      await clean(page);
      await page.mouse.up();
      expect(await drops(page)).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("targets mounted during a drag register immediately; a disabled target refuses", async () => {
    const { page, context } = await open();
    try {
      await page.evaluate("window.extraTarget = true");
      await startMouse(page);
      await until(page, `document.querySelector('.later')?.dataset.drop === 'ok'`);
      await page.evaluate("window.disableArchive()");
      await moveTo(page, ".archive");
      await until(page, `document.querySelector('.archive')?.dataset.drop === 'refused'`);
      await page.mouse.up();
      await clean(page);
      expect(await drops(page)).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
