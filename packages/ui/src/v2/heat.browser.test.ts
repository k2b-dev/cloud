import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-heat.client";
import { measureV2Layout } from "./testing";

// Heat (test/v2-heat.client.tsx, the reading column of a mail app while no mail is open): the mails of the last 53
// weeks as the hero of the empty detail. It fits its place by layout alone and never cuts the newest weeks, a day is
// at most 12 px, the strongest tone stands 3:1 apart from the page in light and dark, the arrows walk the days and
// each day says its count and date; in a page written right to left the newest week is on the left; forced colors
// keep quiet and busy days apart.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-heat.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

type Options = { width: number; dark?: boolean; forced?: boolean; rtl?: boolean; data?: "usual" | "none" | "huge" };

const withPage = async (options: Options, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width: options.width, height: 900 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    if (options.forced) await page.emulateMedia({ forcedColors: "active" });
    await page.setContent(
      `<!doctype html><html lang="de"${options.rtl ? ' dir="rtl"' : ""}><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"${options.dark ? ' data-theme="dark"' : ""}><div id="root"></div></body></html>`,
    );
    if (options.data) await page.evaluate((data) => Object.assign(window, { __k2Heat: data }), options.data);
    await page.addScriptTag({ content: client });
    await page.waitForFunction(() => window.__k2Mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

/** The picture's box against its place, the size of a day, and the newest week's place. */
const fit = (page: Page) =>
  page.evaluate(() => {
    const heat = document.querySelector(".k2-heat")!;
    const pane = heat.closest(".k2-pane")!.getBoundingClientRect();
    const cells = [...heat.querySelectorAll<HTMLElement>("[data-heat-day]")];
    const boxes = cells.map((cell) => cell.getBoundingClientRect());
    const today = heat.querySelector<HTMLElement>('[aria-current="date"]')!.getBoundingClientRect();
    return {
      cells: cells.length,
      size: Math.round(boxes[0]!.width * 10) / 10,
      square: boxes.every((box) => Math.abs(box.width - box.height) < 0.5),
      inside: boxes.every((box) => box.left >= pane.left - 0.5 && box.right <= pane.right + 0.5),
      overflow: heat.scrollWidth > heat.clientWidth + 1,
      todayLeft: Math.round(today.left),
      lefts: [Math.round(Math.min(...boxes.map((box) => box.left))), Math.round(Math.max(...boxes.map((box) => box.right)))],
    };
  });

for (const width of [1024, 1440, 1920])
  test(`at ${width} px every one of the 53 weeks shows, square and inside the reading column`, async () => {
    await withPage({ width }, async (page) => {
      const found = await fit(page);
      expect({ cells: found.cells, square: found.square, inside: found.inside, overflow: found.overflow }).toEqual({
        cells: 369,
        square: true,
        inside: true,
        overflow: false,
      });
      // a day grows up to 12 px and gives way below that, never to nothing
      expect(found.size).toBeLessThanOrEqual(12);
      expect(found.size).toBeGreaterThanOrEqual(3);
      if (width === 1920) expect(found.size).toBe(12);
      // the newest week stands at the end, today in it
      expect(found.todayLeft).toBeGreaterThan(found.lefts[1]! - 13);
      expect((await measureV2Layout(page)).problems).toEqual([]);
    });
  });

test("in a page written right to left the newest week stands on the left", async () => {
  await withPage({ width: 1440, rtl: true }, async (page) => {
    const found = await fit(page);
    expect(found.inside).toBe(true);
    expect(found.todayLeft).toBeLessThan(found.lefts[0]! + 13);
  });
});

/** The colour of the quiet tone, the strongest tone and the page, and the contrast of the strongest to the page. */
const tones = (page: Page) =>
  page.evaluate(() => {
    const rgb = (color: string) => {
      const values = color.match(/[\d.]+/g)!.map(Number);
      return color.startsWith("color(srgb") ? values.slice(0, 3).map((value) => value * 255) : values.slice(0, 3);
    };
    const luminance = (color: string) => {
      const [r, g, b] = rgb(color).map((channel) => {
        const c = channel / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const contrast = (a: string, b: string) => {
      const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return Math.round(((light! + 0.05) / (dark! + 0.05)) * 10) / 10;
    };
    const page = getComputedStyle(document.querySelector(".k2-pane")!).backgroundColor;
    const tone = (value: number) => {
      const cell = document.querySelector<HTMLElement>(`[data-heat-day][data-tone="${value}"]`)!;
      const style = getComputedStyle(cell);
      return { color: style.backgroundColor, opacity: style.opacity, contrast: contrast(style.backgroundColor, page) };
    };
    return { quiet: tone(0), soft: tone(1), strong: tone(4), legend: document.querySelectorAll(".k2-heat-scale > i").length };
  });

for (const dark of [false, true])
  test(`${dark ? "dark" : "light"}: four tones of one colour from soft to strong, the strongest 3:1 to the page`, async () => {
    await withPage({ width: 1440, dark }, async (page) => {
      const found = await tones(page);
      expect(found.strong.contrast).toBeGreaterThanOrEqual(3);
      expect(found.soft.color).not.toBe(found.quiet.color);
      expect(found.soft.contrast).toBeLessThan(found.strong.contrast);
      expect(found.legend).toBe(5);
    });
  });

test("forced colors: a quiet day is an edge, a busy day the text colour", async () => {
  await withPage({ width: 1440, forced: true }, async (page) => {
    const found = await tones(page);
    expect(found.strong.color).not.toBe(found.quiet.color);
    expect(Number(found.soft.opacity)).toBeLessThan(1);
    expect(Number(found.strong.opacity)).toBe(1);
  });
});

test("one Tab stop on today; the arrows walk the days and the line below says count and date", async () => {
  await withPage({ width: 1440 }, async (page) => {
    const grid = page.getByRole("grid", { name: "Mails pro Tag" });
    expect(await grid.getByRole("gridcell").count()).toBe(369);
    expect(await grid.locator('[tabindex="0"]').count()).toBe(1);
    await grid.locator('[aria-current="date"]').focus();
    const focused = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    const said = await focused();
    expect(said).toMatch(/^\d+ Mails am Fr\., 27\. Nov\.$/);
    expect(await page.locator(".k2-heat-read").textContent()).toBe(said!);
    await page.keyboard.press("ArrowLeft");
    expect(await focused()).toMatch(/ Mails am Fr\., 20\. Nov\.$/);
    await page.keyboard.press("ArrowUp");
    expect(await focused()).toMatch(/ Mails am Do\., 19\. Nov\.$/);
    // a day after today is not there: down from today stays on today
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
    expect(await focused()).toBe(said);
    await page.keyboard.press("ArrowDown");
    expect(await focused()).toBe(said);
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowDown");
    expect(await focused()).toMatch(/ Mails am Sa\., 21\. Nov\.$/);
    await page.keyboard.press("Home");
    expect(await focused()).toMatch(/ Mails am Sa\., 29\. Nov\.$/);
    expect(await grid.locator('[tabindex="0"]').count()).toBe(1);
    // each weekday names itself in full, every other one shows its short name
    expect(await grid.getByRole("rowheader").first().getAttribute("aria-label")).toBe("Montag");
  });
});

test("a new mailbox without mail: every day quiet, nothing cut; a huge one: the scale keeps its quarters", async () => {
  await withPage({ width: 1440, data: "none" }, async (page) => {
    expect(await page.locator("[data-heat-day]:not([data-tone='0'])").count()).toBe(0);
    expect((await fit(page)).cells).toBe(369);
  });
  await withPage({ width: 1440, data: "huge" }, async (page) => {
    const counts = await page.evaluate(() =>
      [1, 2, 3, 4].map((tone) => document.querySelectorAll(`[data-heat-day][data-tone="${tone}"]`).length),
    );
    expect(counts.every((count) => count > 20)).toBe(true);
    expect(await page.locator('[aria-current="date"]').getAttribute("aria-label")).toMatch(/^\d{1,3}\.\d{3} Mails am Fr\., 27\. Nov\.$/);
  });
});
