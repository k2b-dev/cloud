import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

// Exercise the shipped CSS: DOM emulation cannot prove geometry or the first paint.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "bottom-sheet-adaptive.fixture.ts");
const fixture = `
import { createComponent } from "solid-js/web";
import { BottomSheet, Button, bottomSheetOptions, bottomSheetAdaptiveOptions, dialogCore } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
window.openSheet = ({ input = false, history = false, adaptive = true } = {}) => {
  void dialogCore.open((close, context) => createComponent(BottomSheet, {
    onDismiss: context.requestDismiss,
    get children() { return [
      createComponent(BottomSheet.Header, { title: "Confirm change" }),
      createComponent(BottomSheet.Body, { get children() {
        const content = document.createElement(input ? "input" : "p");
        content.dataset.content = "";
        if (input) content.setAttribute("aria-label", "Name");
        else content.textContent = "Apply this change to the workspace?";
        return content;
      } }),
      createComponent(BottomSheet.Footer, { get children() { return [
        createComponent(Button, { children: "Cancel", onClick: () => close() }),
        createComponent(Button, { children: "Apply", onClick: () => close() }),
      ]; } }),
    ]; },
  }), { ...(adaptive ? bottomSheetAdaptiveOptions : bottomSheetOptions), history });
  return new Promise(resolve => requestAnimationFrame(() => {
    const dialog = document.querySelector("dialog[open]");
    resolve(dialog.getBoundingClientRect().toJSON());
  }));
};
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the adaptive sheet fixture.");
const script = await build.outputs[0]!.text();

type SheetOptions = { input?: boolean; history?: boolean; adaptive?: boolean };
declare global {
  interface Window {
    openSheet: (options?: SheetOptions) => Promise<DOMRectJSON>;
  }
}
type DOMRectJSON = { x: number; y: number; width: number; height: number; top: number; right: number; bottom: number; left: number };
const views = [
  { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  { viewport: { width: 1194, height: 834 } },
  { viewport: { width: 834, height: 1194 } },
];
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

async function withPage(options: BrowserContextOptions, run: (page: Page) => Promise<void>) {
  const context = await browser.newContext(options);
  try {
    const page = await context.newPage();
    await page.route("https://sheet.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>${css}</style></head><body class="k2b-ui"></body></html>`,
      }),
    );
    await page.goto("https://sheet.test/");
    await page.addScriptTag({ content: script });
    await run(page);
  } finally {
    await context.close();
  }
}
const settled = (page: Page) =>
  page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
const rect = (page: Page) =>
  page.locator("dialog[open]").evaluate((el) => {
    const { x, y, width, height, top, right, bottom, left } = el.getBoundingClientRect();
    return { x, y, width, height, top, right, bottom, left };
  });
const open = async (page: Page, options: SheetOptions = {}) => {
  const first = await page.evaluate((options) => window.openSheet(options), options);
  await settled(page);
  return first;
};
const centered = (box: DOMRectJSON, width: number, height: number) => {
  expect(Math.abs(box.left + box.width / 2 - width / 2)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.top + box.height / 2 - height / 2)).toBeLessThanOrEqual(1);
  expect(box.width).toBe(512);
  expect(box.bottom).toBeLessThan(height - 100);
};

describe("adaptive bottom sheet", () => {
  for (const view of views) {
    const phone = view.viewport.width < 768;
    const label = `${view.viewport.width}x${view.viewport.height}`;
    test(`geometry, handle tab order, corners and closing footer at ${label}`, () =>
      withPage(view, async (page) => {
        await open(page);
        const dialog = page.locator("dialog[open]");
        const box = await rect(page);
        expect(await dialog.getAttribute("class")).toContain("is-adaptive");
        expect(await dialog.locator(".k2b-bottom-sheet__handle").isVisible()).toBe(phone);
        const padding = await dialog
          .locator(".k2b-panel-dialog__footer:last-child")
          .evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
        if (phone) {
          expect(box.bottom).toBe(view.viewport.height);
          expect(padding).toBeGreaterThanOrEqual(16);
        } else {
          centered(box, view.viewport.width, view.viewport.height);
          expect(padding).toBe(20);
          const corners = await dialog.evaluate((el) => {
            const style = getComputedStyle(el);
            return [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius].map(
              parseFloat,
            );
          });
          expect(corners.every((radius) => radius > 0)).toBe(true);
          expect(await dialog.evaluate((el) => getComputedStyle(el).animationName)).toBe("k2b-sheet-dialog-enter");
          // The handle precedes these actions in the DOM; Tab must skip it.
          for (const name of ["Cancel", "Apply"]) {
            await page.keyboard.press("Tab");
            expect(await page.evaluate(() => document.activeElement?.textContent)).toBe(name);
          }
        }
      }));

    test(`reduced motion has its settled geometry in the first frame at ${label}`, () =>
      withPage({ ...view, reducedMotion: "reduce" }, async (page) => {
        const first = await open(page);
        expect(first).toEqual(await rect(page));
        expect(await page.locator("dialog[open]").evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
      }));

    for (const input of [false, true]) {
      test(`initial focus ${input ? "on input" : "on ring-less dialog"} at ${label}`, () =>
        withPage(view, async (page) => {
          await open(page, { input });
          const target = page.locator(input ? 'input[aria-label="Name"]' : "dialog[open]");
          expect(await target.evaluate((el) => el === document.activeElement)).toBe(true);
          if (!input) expect(await target.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("none");
        }));
    }

    test(`Escape dismisses at ${label}`, () =>
      withPage(view, async (page) => {
        await open(page);
        await page.keyboard.press("Escape");
        await page.locator("dialog[open]").waitFor({ state: "detached" });
      }));
    test(`Back dismisses without changing the URL at ${label}`, () =>
      withPage(view, async (page) => {
        const url = page.url();
        await open(page, { history: true });
        expect(page.url()).toBe(url);
        await page.goBack();
        await page.locator("dialog[open]").waitFor({ state: "detached" });
        expect(page.url()).toBe(url);
      }));
  }

  test("ordinary menus stay on the bottom edge at tablet width", () =>
    withPage(views[1]!, async (page) => {
      await open(page, { adaptive: false });
      expect((await rect(page)).bottom).toBe(834);
      expect(await page.locator(".k2b-bottom-sheet__handle").isVisible()).toBe(true);
    }));

  test("rotation switches in place and keeps the typed value", () =>
    withPage(views[0]!, async (page) => {
      await open(page, { input: true });
      await page.getByRole("textbox", { name: "Name" }).fill("Unfinished draft");
      await page.evaluate(() => {
        Reflect.set(document.querySelector("dialog")!, "sheetMarker", "same dialog");
        Reflect.set(document.querySelector("[data-content]")!, "sheetMarker", "same content");
      });
      await page.setViewportSize(views[1]!.viewport);
      await settled(page);
      centered(await rect(page), 1194, 834);
      expect(await page.locator(".k2b-bottom-sheet__handle").isVisible()).toBe(false);
      expect(await page.locator("dialog").evaluate((el) => Reflect.get(el, "sheetMarker"))).toBe("same dialog");
      expect(await page.locator("[data-content]").evaluate((el) => Reflect.get(el, "sheetMarker"))).toBe("same content");
      expect(await page.getByRole("textbox", { name: "Name" }).inputValue()).toBe("Unfinished draft");
    }));
});
