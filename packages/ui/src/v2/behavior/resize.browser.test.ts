// Contract test for the v2 column grip (behaviour only): keys, pointer, and the push at the minimum from the concept.
// Columns: 240 (min 160) | 360 (min 280) | the rest (min 400) in a 1406 px wide container.
// Runs in Chromium and in WebKit (TEST_BROWSER=webkit). WEBKIT_HELD: Playwright's WebKit renders no frame while a
// mouse button is held, and core's bindDrag reports moves once per frame, so the live widths during a drag are checked
// in Chromium only; the release applies the last position in both.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser, launchHookMs, pageErrors, settled } from "../../../test/browser";
import { contractCss, demoBundle, openDemo, serverMarkup } from "../../../test/v2-behavior/harness";
import { cascade } from "./resize";

const webkit = browserName === "webkit";
let browser: Browser;
let bundle: string;
let css: string;
let markup: string;
beforeAll(async () => {
  [bundle, css, markup] = await Promise.all([demoBundle("resize"), contractCss(), serverMarkup("resize")]);
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (run: (page: Page) => Promise<void>) => {
  const page = await openDemo(browser, bundle, css, { markup });
  const errors = pageErrors(page);
  try {
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};
/** Rendered widths of the two fixed columns and the rest. */
const widths = async (page: Page) => {
  await settled(page);
  return page.$$eval("[data-column]", (columns) => columns.map((column) => Math.round(column.getBoundingClientRect().width)));
};
const until = (page: Page, expected: number[]) =>
  page
    .waitForFunction(
      (want) =>
        JSON.stringify(
          [...document.querySelectorAll("[data-column]")].map((column) => Math.round(column.getBoundingClientRect().width)),
        ) === want,
      JSON.stringify(expected),
    )
    .then(
      () => true,
      () => false,
    );

test("cascade: the losing side gives way nearest first, each column down to its minimum", () => {
  const mins = [160, 280, 400];
  expect(cascade([240, 360, 806], mins, 0, 100)).toEqual([340, 280, 786]);
  expect(cascade([240, 360, 806], mins, 0, 1000)).toEqual([726, 280, 400]);
  expect(cascade([240, 360, 806], mins, 1, -200)).toEqual([160, 280, 966]);
  expect(cascade([240, 360, 806], mins, 0, -1000)).toEqual([160, 440, 806]);
});

test("server markup: each grip is a focusable vertical separator with its width", () => {
  expect((markup.match(/role="separator"/g) ?? []).length).toBe(2);
  expect(markup).toContain('aria-orientation="vertical"');
  expect(markup).toContain('aria-valuenow="240"');
  expect(markup).toContain('aria-valuenow="360"');
  expect(markup).toContain('aria-label="Breite: Ordner"');
});

test("keys: arrows 8 px, Shift 64 px, Home and End to the limits, Enter back to the default", async () => {
  await withPage(async (page) => {
    expect(await widths(page)).toEqual([240, 360, 806]);
    const grip = page.locator('[data-grip="0"]');
    await grip.focus();
    await page.keyboard.press("ArrowRight");
    expect(await until(page, [248, 352, 806])).toBe(true);
    await page.keyboard.press("Shift+ArrowRight");
    expect(await until(page, [312, 288, 806])).toBe(true);
    expect(await grip.getAttribute("aria-valuenow")).toBe("312");
    // End pushes past the minimum of the next column into the rest: both stop at their minimum.
    await page.keyboard.press("End");
    expect(await until(page, [726, 280, 400])).toBe(true);
    // Back in the same run: the rest grows again first, then the middle column (reverse order).
    await page.keyboard.press("Shift+ArrowLeft");
    expect(await until(page, [662, 280, 464])).toBe(true);
    await page.keyboard.press("Home");
    expect(await until(page, [160, 440, 806])).toBe(true);
    await page.keyboard.press("Enter");
    expect(await until(page, [240, 360, 806])).toBe(true);
  });
});

test("keys: at its minimum the column left of the grip pushes the one before it", async () => {
  await withPage(async (page) => {
    await page.locator('[data-grip="1"]').focus();
    for (let step = 0; step < 4; step++) await page.keyboard.press("Shift+ArrowLeft");
    expect(await until(page, [160, 280, 966])).toBe(true);
    expect(await page.locator('[data-grip="0"]').getAttribute("aria-valuenow")).toBe("160");
  });
});

const drag = async (page: Page, moves: number[]) => {
  const box = await page.locator('[data-grip="0"]').boundingBox();
  if (!box) throw new Error("no grip");
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (const dx of moves) await page.mouse.move(start.x + dx, start.y, { steps: 4 });
};

test("pointer: a drag past the minimum pushes on, the way back unwinds in reverse, the release keeps the last width", async () => {
  await withPage(async (page) => {
    await drag(page, [500, 100]);
    await page.mouse.up();
    expect(await until(page, [340, 280, 786])).toBe(true);
    expect(await page.locator("[data-dragging]").count()).toBe(0);
  });
});

// WEBKIT_HELD: widths follow the pointer only on rendered frames, and Playwright's WebKit renders none while held.
test.skipIf(webkit)("pointer: widths follow live and Escape puts every column back [skipped in WebKit: WEBKIT_HELD]", async () => {
  await withPage(async (page) => {
    await drag(page, [500]);
    expect(await until(page, [726, 280, 400])).toBe(true);
    expect(await page.locator('[data-grip="0"][data-dragging]').count()).toBe(1);
    await page.keyboard.press("Escape");
    expect(await until(page, [240, 360, 806])).toBe(true);
    await page.mouse.up();
    expect(await until(page, [240, 360, 806])).toBe(true);
  });
});
