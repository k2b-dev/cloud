import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { browserName, launchBrowser } from "../../test/browser";

const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "reaction-bar.fixture.ts");
const fixtureSource = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { ReactionBar, reactionPeople } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const options = window.fixtureOptions;
const [reactions, setReactions] = createSignal(Array.from({ length: 20 }, (_, index) => ({
  key: String(index), emoji: index === 0 ? "👍" : "🎉", count: 5, own: index === 0,
  label: reactionPeople({ names: ["Nora Brandt", "Tobias", "Lea", "Jonas"], own: true, count: 5 }),
})));
const listeners = [];
for (const target of [document, window]) {
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  const captureOf = (options) => typeof options === "boolean" ? options : Boolean(options?.capture);
  target.addEventListener = (type, listener, options) => {
    const capture = captureOf(options);
    if (!listeners.some((item) => item.target === target && item.type === type && item.listener === listener && item.capture === capture)) {
      listeners.push({ target, type, listener, capture });
    }
    add(type, listener, options);
  };
  target.removeEventListener = (type, listener, options) => {
    const index = listeners.findIndex((item) => item.target === target && item.type === type && item.listener === listener && item.capture === captureOf(options));
    if (index >= 0) listeners.splice(index, 1);
    remove(type, listener, options);
  };
}
window.toggled = [];
window.fixture = {
  // Solid delegates click once per document and intentionally keeps that shared listener.
  listeners: () => listeners.filter((item) => item.type !== "click").length,
  replace: () => setReactions((items) => items.map((item) => ({ ...item, count: item.count + 1 }))),
  relabel: (label) => setReactions((items) => items.map((item) => (item.key === "0" ? { ...item, label } : item))),
  remove: () => setReactions((items) => items.filter((item) => item.key !== "0")),
  unmount: render(() => createComponent(ReactionBar, {
    get reactions() { return reactions(); },
    onToggle: options.readOnly ? undefined : (key) => window.toggled.push(key),
    onAdd: options.progressive ? () => {} : undefined,
    add: options.progressive ? "progressive" : "always",
    density: options.density,
    overflow: options.overflow,
    max: options.max,
  }), document.getElementById("app")),
};
`;
const build = await Bun.build({
  entrypoints: [entry],
  files: { [entry]: fixtureSource },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the ReactionBar fixture.");
const script = await build.outputs[0]!.text();

declare const fixture: {
  listeners: () => number;
  replace: () => void;
  relabel: (label: string) => void;
  remove: () => void;
  unmount: () => void;
};
declare const toggled: string[];
let browser: Browser;
let context: BrowserContext | undefined;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterEach(async () => {
  await context?.close();
  context = undefined;
}, 30_000);
afterAll(async () => {
  await browser?.close();
});
const open = async (
  options: {
    density?: "compact" | "default";
    overflow?: "scroll" | "wrap";
    max?: number;
    progressive?: boolean;
    readOnly?: boolean;
    touch?: boolean;
  } = {},
): Promise<Page> => {
  context = await browser.newContext({ viewport: { width: 500, height: 600 }, hasTouch: options.touch ?? false });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html data-k2b-input="${options.touch ? "touch" : "trackpad"}"><head><style>${css}</style>
<style>*,*::before,*::after{transition:none!important}body{margin:0;min-height:1800px}#app{width:280px;margin:100px 20px 40px}</style></head>
<body class="k2b-ui"><div id="app" class="k2b-progressive-row"></div><button id="outside">Outside</button></body></html>`);
  await page.addScriptTag({ content: `window.fixtureOptions = ${JSON.stringify(options)};` });
  await page.addScriptTag({ content: script });
  return page;
};
const chip = (page: Page) => page.locator('[data-reaction-key="0"]');
const hint = (page: Page) => page.locator(".k2b-reaction-bar__hint");
const isOpen = (page: Page) => hint(page).evaluate((element) => element.matches(":popover-open"));
const point = async (page: Page) => {
  const box = await chip(page).boundingBox();
  if (!box) throw new Error("Chip has no box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
const touch = async (page: Page) => {
  const session = await page.context().newCDPSession(page);
  const send = async (type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel", position?: { x: number; y: number }) => {
    await session.send("Input.dispatchTouchEvent", { type, touchPoints: position ? [{ ...position, id: 1 }] : [] });
  };
  return { send, close: () => session.detach() };
};

// Touch injection uses Chromium's real pointer -> touch -> compatibility click pipeline.
// The suite is authored here; its execution belongs to the owner's browser lock.
describe("ReactionBar in the browser", () => {
  for (const [density, height] of [
    ["compact", 24],
    ["default", 26],
  ] as const) {
    test(`${density} chips are ${height}px high and keep keyed elements on replacement`, async () => {
      const page = await open({ density });
      expect(await chip(page).evaluate((element) => element.getBoundingClientRect().height)).toBe(height);
      await chip(page).focus();
      const before = await chip(page).elementHandle();
      await page.evaluate(() => fixture.replace());
      expect(await before!.evaluate((element) => element === document.activeElement && element.isConnected)).toBe(true);
    }, 30_000);
  }
  test("hover, moving between chips, and visible keyboard focus use one names hint", async () => {
    const page = await open();
    await chip(page).hover();
    await page.waitForTimeout(350);
    expect(await isOpen(page)).toBe(true);
    expect(await hint(page).textContent()).toBe("👍 You, Nora Brandt and 3 more");
    await page.locator('[data-reaction-key="1"]').hover();
    expect(await isOpen(page)).toBe(true);
    expect(await hint(page).textContent()).toBe("🎉 You, Nora Brandt and 3 more");
    await page.mouse.move(450, 30);
    expect(await isOpen(page)).toBe(false);
    await page.keyboard.press("Tab");
    expect(await chip(page).evaluate((element) => element.matches(":focus-visible"))).toBe(true);
    await page.waitForTimeout(350);
    expect(await isOpen(page)).toBe(true);
    await page.keyboard.press("Escape");
    expect(await isOpen(page)).toBe(false);
  }, 30_000);

  test("an open names hint follows its reaction and closes when the reaction goes", async () => {
    const page = await open();
    await chip(page).hover();
    await page.waitForTimeout(350);
    expect(await isOpen(page)).toBe(true);
    await page.evaluate(() => fixture.relabel("You and Nora Brandt"));
    expect(await hint(page).textContent()).toBe("👍 You and Nora Brandt");
    expect(await isOpen(page)).toBe(true);
    await page.evaluate(() => fixture.remove());
    expect(await isOpen(page)).toBe(false);
  }, 30_000);

  const chromiumTest = browserName === "chromium" ? test : test.skip;
  chromiumTest(
    "a touch hold never toggles and the next short tap toggles exactly once",
    async () => {
      const page = await open({ touch: true });
      const input = await touch(page);
      try {
        const position = await point(page);
        await input.send("touchStart", position);
        await page.waitForTimeout(650);
        expect(await isOpen(page)).toBe(true);
        expect(await hint(page).getAttribute("data-touch")).toBe("");
        await input.send("touchEnd");
        await page.waitForTimeout(100);
        expect(await page.evaluate(() => toggled)).toEqual([]);
        await page.touchscreen.tap(position.x, position.y);
        expect(await page.evaluate(() => toggled)).toEqual(["0"]);
        expect(await isOpen(page)).toBe(false);
        // A second hold without any compatibility click must not leave a flag that eats the next tap either.
        await input.send("touchStart", position);
        await page.waitForTimeout(650);
        await input.send("touchEnd");
        await page.touchscreen.tap(position.x, position.y);
        expect(await page.evaluate(() => toggled)).toEqual(["0", "0"]);
      } finally {
        await input.close();
      }
    },
    30_000,
  );
  chromiumTest(
    "movement over 8px and pointer cancellation abandon the hold without blocking scrolling",
    async () => {
      const page = await open({ touch: true });
      const input = await touch(page);
      try {
        const position = await point(page);
        await input.send("touchStart", position);
        await input.send("touchMove", { x: position.x + 30, y: position.y });
        await page.waitForTimeout(650);
        await input.send("touchEnd");
        expect(await isOpen(page)).toBe(false);
        expect(await page.evaluate(() => toggled)).toEqual([]);
        await input.send("touchStart", position);
        await input.send("touchCancel");
        await page.waitForTimeout(650);
        expect(await isOpen(page)).toBe(false);
        expect(await page.evaluate(() => toggled)).toEqual([]);
      } finally {
        await input.close();
      }
    },
    30_000,
  );
  chromiumTest(
    "read-only short taps show names until an outside tap, scrolling, or Escape",
    async () => {
      const page = await open({ touch: true, readOnly: true });
      const position = await point(page);
      const tap = () => page.touchscreen.tap(position.x, position.y);
      await tap();
      expect(await isOpen(page)).toBe(true);
      expect(await hint(page).getAttribute("data-touch")).toBe("");
      await page.locator("#outside").tap();
      expect(await isOpen(page)).toBe(false);
      await tap();
      await page.locator(".k2b-reaction-bar__scroll").evaluate((element) => {
        element.scrollLeft = 40;
      });
      await page.waitForTimeout(50);
      expect(await isOpen(page)).toBe(false);
      await page.locator(".k2b-reaction-bar__scroll").evaluate((element) => {
        element.scrollLeft = 0;
      });
      await page.waitForTimeout(50);
      await tap();
      await page.keyboard.press("Escape");
      expect(await isOpen(page)).toBe(false);
      expect(await page.evaluate(() => toggled)).toEqual([]);
    },
    30_000,
  );
  chromiumTest(
    "a short writable tap toggles without a hint; pen holds suppress their click",
    async () => {
      const page = await open({ touch: true });
      const position = await point(page);
      await page.touchscreen.tap(position.x, position.y);
      expect(await page.evaluate(() => toggled)).toEqual(["0"]);
      expect(await isOpen(page)).toBe(false);
      await chip(page).dispatchEvent("pointerdown", { pointerType: "pen", pointerId: 9, clientX: position.x, clientY: position.y });
      await page.waitForTimeout(650);
      expect(await isOpen(page)).toBe(true);
      await chip(page).dispatchEvent("pointerup", { pointerType: "pen", pointerId: 9 });
      await chip(page).dispatchEvent("click");
      expect(await page.evaluate(() => toggled)).toEqual(["0"]);
    },
    30_000,
  );
  test("progressive add keeps all boxes on hover and remains visible while expanded", async () => {
    const page = await open({ density: "compact", max: 3, progressive: true });
    const add = page.locator(".k2b-reaction-bar__add");
    const boxes = () =>
      page.locator(".k2b-reaction-bar__chip, .k2b-reaction-bar__add-button").evaluateAll((elements) =>
        elements.map((element) => {
          const box = element.getBoundingClientRect();
          return [box.x, box.y, box.width, box.height];
        }),
      );
    expect(await add.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
    const before = await boxes();
    await chip(page).hover();
    expect(await add.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
    expect(await boxes()).toEqual(before);
    await page.locator(".k2b-reaction-bar__add-button").evaluate((element) => element.setAttribute("aria-expanded", "true"));
    await page.mouse.move(450, 30);
    expect(await add.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
    expect(await boxes()).toEqual(before);
    await page.locator("html").evaluate((element) => element.setAttribute("data-k2b-input", "touch"));
    // Touch hides it by paint only; its place stays reserved.
    expect(await add.evaluate((element) => getComputedStyle(element).visibility)).toBe("hidden");
    expect(await boxes()).toEqual(before);
  }, 30_000);
  test("unmount removes the open hint, timers and document/window listeners", async () => {
    const page = await open();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const before = await page.evaluate(() => fixture.listeners());
    await chip(page).hover();
    await page.waitForTimeout(350);
    expect(await isOpen(page)).toBe(true);
    expect(await page.evaluate(() => fixture.listeners())).toBeGreaterThan(before);
    await page.evaluate(() => fixture.unmount());
    expect(await page.locator(":popover-open").count()).toBe(0);
    expect(await page.evaluate(() => fixture.listeners())).toBe(0);
    await page.locator("#outside").click();
    await page.evaluate(() => window.scrollTo(0, 100));
    await page.waitForTimeout(600);
    expect(errors).toEqual([]);
  }, 30_000);
});
