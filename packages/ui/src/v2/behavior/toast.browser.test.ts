// Contract test for v2 toasts on @ui-sdk/core's toaster and toast region through our Solid 1 adapter: one toaster per
// owner (two Workspaces on one page), timers that pause while hovered, maxVisible, Escape, the close and action
// buttons, F6 into the region, and a swipe (Chromium only, through CDP touch). Runs in Chromium and in WebKit.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { browserName, hoverInPlace, launchBrowser, launchHookMs, pageErrors } from "../../../test/browser";
import { contractCss, demoBundle, heard, openDemo, serverMarkup } from "../../../test/v2-behavior/harness";

const webkit = browserName === "webkit";
let browser: Browser;
let bundle: string;
let css: string;
let markup: string;
beforeAll(async () => {
  [bundle, css, markup] = await Promise.all([demoBundle("toast"), contractCss(), serverMarkup("toast")]);
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (run: (page: Page) => Promise<void>, touch = false) => {
  const page = await openDemo(browser, bundle, css, { markup, touch });
  const errors = pageErrors(page);
  try {
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};
const toasts = (page: Page, region: "a" | "b") =>
  page.$$eval(`[data-testid="${region}-region"] [data-slot="toast"]`, (items) => items.map((item) => (item as HTMLElement).dataset.toast));
const until = (page: Page, condition: string) =>
  page.waitForFunction(condition, undefined, { timeout: 4000 }).then(
    () => true,
    () => false,
  );

test("server markup: an empty region is no landmark and names nothing", () => {
  expect(markup).toContain('data-slot="toast-region"');
  expect(markup).not.toContain('role="region"');
  expect(markup).not.toContain("Benachrichtigungen");
});

// Guard for module state (#4058 round 2): every Workspace has its own toaster, so a toast never shows in another.
test("each Workspace has its own toasts; the region is a named landmark while it holds one", async () => {
  await withPage(async (page) => {
    await page.getByTestId("a-save").click();
    expect(await until(page, `document.querySelectorAll('[data-testid="a-region"] [data-slot="toast"]').length === 1`)).toBe(true);
    expect(await toasts(page, "a")).toEqual(["Gespeichert 1"]);
    expect(await toasts(page, "b")).toEqual([]);
    const region = page.getByTestId("a-region");
    expect(await region.getAttribute("role")).toBe("region");
    expect(await region.getAttribute("aria-label")).toBe("Benachrichtigungen");
    expect(await page.getByTestId("b-region").getAttribute("role")).toBeNull();
    expect(await heard(page, "Gespeichert 1")).toBe(true);
  });
});

test("maxVisible: the newest three show, the others wait and move up when one closes", async () => {
  await withPage(async (page) => {
    for (let step = 0; step < 4; step++) await page.getByTestId("a-save").click();
    await page.getByTestId("a-undo").click();
    expect(await until(page, `document.querySelector('[data-testid="a-region"] [data-toast="Verschoben"]')`)).toBe(true);
    expect(await toasts(page, "a")).toEqual(["Verschoben", "Gespeichert 4", "Gespeichert 3"]);
    await page.locator('[data-toast="Verschoben"] [data-slot="toast-close"]').click();
    expect(
      await until(
        page,
        `document.querySelectorAll('[data-testid="a-region"] [data-slot="toast"]').length === 3 && !document.querySelector('[data-toast="Verschoben"]')`,
      ),
    ).toBe(true);
    expect(await toasts(page, "a")).toEqual(["Gespeichert 4", "Gespeichert 3", "Gespeichert 2"]);
  });
});

test("a toast closes after its time, but not while the pointer rests on it", async () => {
  await withPage(async (page) => {
    // playwright clock: the toast's timer is the subject; the page's time runs only when the test says.
    await page.clock.install();
    await page.getByTestId("a-brief").click();
    const toast = page.locator('[data-toast="Kurz"]');
    await toast.waitFor();
    // hover: no geometry is read after the hover.
    await hoverInPlace(toast);
    // playwright clock: longer than the toast's 1.5 s, while the pointer holds it.
    await page.clock.runFor(2000);
    expect(await toast.count()).toBe(1);
    await page.mouse.move(5, 5);
    // playwright clock: past its 1.5 s once nothing holds it.
    await page.clock.runFor(2000);
    expect(await toast.count()).toBe(0);
  });
});

test("the action runs and closes its toast; Escape closes the focused toast; F6 jumps into the region", async () => {
  await withPage(async (page) => {
    await page.getByTestId("a-undo").click();
    await page.locator('[data-toast="Verschoben"] [data-slot="toast-action"]').click();
    expect(
      await until(
        page,
        `document.querySelector('[data-toast="Rückgängig gemacht"]') && !document.querySelector('[data-toast="Verschoben"]')`,
      ),
    ).toBe(true);
    await page.getByTestId("a-save").focus();
    await page.keyboard.press("F6");
    expect(await until(page, `document.activeElement?.closest('[data-testid="a-region"]') !== null`)).toBe(true);
    const name = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.toast);
    await page.keyboard.press("Escape");
    expect(await until(page, `!document.querySelector('[data-toast="${name}"]')`)).toBe(true);
  });
});

// WEBKIT_TOUCH: touch input exists only through Chromium's CDP here.
test.skipIf(webkit)("a swipe dismisses a toast [skipped in WebKit: WEBKIT_TOUCH]", async () => {
  await withPage(async (page) => {
    await page.getByTestId("a-save").click();
    const toast = page.locator('[data-toast="Gespeichert 1"]');
    await toast.waitFor();
    const box = await toast.boundingBox();
    if (!box) throw new Error("no toast box");
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", x: number, y: number) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
    const y = box.y + box.height / 2;
    await touch("touchStart", box.x + 20, y);
    for (let step = 1; step <= 10; step++) await touch("touchMove", box.x + 20 + step * 30, y);
    await touch("touchEnd", box.x + 320, y);
    expect(await until(page, `!document.querySelector('[data-toast="Gespeichert 1"]')`)).toBe(true);
  }, true);
});
