import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../test/browser";

const ui = resolve(import.meta.dir, "..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "input-mode.fixture.ts");
const build = await Bun.build({
  entrypoints: [entry],
  files: {
    [entry]: `
import { createComponent, render } from "solid-js/web";
import { installInputModeController, Kbd } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
render(() => createComponent(Kbd, { keys: "mod+k", class: "k2b-kbd-hint" }), document.getElementById("hint"));
installInputModeController();
`,
  },
  target: "browser",
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the input mode fixture.");
const script = await build.outputs[0]!.text();
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (page: Page) => {
  await page.setContent(`<!doctype html><html lang="en"><head><style>${css}</style>
    <style>*,*::before,*::after{transition:none!important;animation:none!important}</style></head>
    <body class="k2b-ui" tabindex="-1" style="margin:0;padding:2rem">
      <label>Text <input id="text" /></label>
      <label>Toggle <input id="checkbox" type="checkbox" /></label>
      <div class="k2b-progressive-row" style="display:flex;align-items:center;gap:1rem;width:20rem;margin-top:2rem">
        <span>Example row</span><button class="k2b-progressive-action">Action</button>
      </div>
      <div style="display:flex;align-items:center;gap:1rem;margin-top:2rem"><span>Search</span><span id="hint"></span></div>
    </body></html>`);
  await page.addScriptTag({ content: script });
  await page.locator(".k2b-kbd-hint").waitFor({ state: "attached" });
};
const attribute = (page: Page, name: string) => page.locator("html").getAttribute(name);
const geometry = (page: Page) =>
  page.evaluate(() =>
    [".k2b-progressive-row", ".k2b-progressive-action", ".k2b-kbd-hint"].map((selector) => {
      const { x, y, width, height } = document.querySelector(selector)!.getBoundingClientRect();
      return { x, y, width, height };
    }),
  );

// Pages and contexts belong to each test so a timeout cannot poison later tests.
describe("input mode in a browser", () => {
  test("starts without attributes and reserves the hidden hint's box", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await load(page);
      expect(await attribute(page, "data-k2b-input")).toBeNull();
      expect(await attribute(page, "data-k2b-kbd")).toBeNull();
      const hint = page.locator(".k2b-kbd-hint");
      expect(await hint.evaluate((element) => getComputedStyle(element).visibility)).toBe("hidden");
      const box = await hint.boundingBox();
      expect(box!.width).toBeGreaterThan(0);
      expect(box!.height).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  }, 30_000);

  test("a real tap selects touch and a subsequent mouse move selects trackpad", async () => {
    const context = await browser.newContext({ hasTouch: true, viewport: { width: 900, height: 700 } });
    try {
      const page = await context.newPage();
      await load(page);
      await page.touchscreen.tap(650, 550);
      expect(await attribute(page, "data-k2b-input")).toBe("touch");
      await page.mouse.move(750, 600);
      expect(await attribute(page, "data-k2b-input")).toBe("trackpad");
    } finally {
      await context.close();
    }
  }, 30_000);

  test("typing and Shift leave hints hidden; a key on the body enables them for the document", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await load(page);
      await page.locator("#text").focus();
      await page.keyboard.type("hello");
      expect(await attribute(page, "data-k2b-kbd")).toBeNull();
      await page.locator("body").focus();
      await page.keyboard.press("Shift");
      expect(await attribute(page, "data-k2b-kbd")).toBeNull();
      await page.keyboard.press("a");
      expect(await attribute(page, "data-k2b-kbd")).toBe("on");
      expect(await page.locator(".k2b-kbd-hint").evaluate((element) => getComputedStyle(element).visibility)).toBe("visible");
      await page.mouse.move(750, 600);
      expect(await attribute(page, "data-k2b-kbd")).toBe("on");
    } finally {
      await context.close();
    }
  }, 30_000);

  test("mode and hint changes preserve geometry while actions reveal on hover", async () => {
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    try {
      const page = await context.newPage();
      await load(page);
      const rest = await geometry(page);
      const action = page.locator(".k2b-progressive-action");
      const opacity = () => action.evaluate((element) => getComputedStyle(element).opacity);
      for (const mode of ["touch", "trackpad"] as const) {
        await page.evaluate((mode) => document.documentElement.setAttribute("data-k2b-input", mode), mode);
        expect(await geometry(page)).toEqual(rest);
        expect(await opacity()).toBe(mode === "touch" ? "1" : "0");
      }
      await page.locator("body").focus();
      await page.keyboard.press("a");
      expect(await attribute(page, "data-k2b-kbd")).toBe("on");
      expect(await geometry(page)).toEqual(rest);
      await page.locator(".k2b-progressive-row").hover();
      expect(await opacity()).toBe("1");
      expect(await geometry(page)).toEqual(rest);
    } finally {
      await context.close();
    }
  }, 30_000);
});
