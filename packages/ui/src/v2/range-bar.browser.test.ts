import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-range-bar.client";
import { measureV2Layout } from "./testing";

// RangeBar (test/v2-range-bar.client.tsx, a week of weather): each day from its low to its high on the week's one
// scale. The range stands where the scale puts it, a single value still shows, a value past the scale stops at its
// end and a range at the very end keeps its stub inside the track, the colours of its part run along it in the writing
// direction and keep 3:1 on the surface in light and dark, and in forced colours the range stays visible. A data
// colour on an icon arrives as its colour.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-range-bar.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (options: { width: number; dark?: boolean; forced?: boolean }, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width: options.width, height: 800 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    if (options.forced) await page.emulateMedia({ forcedColors: "active" });
    if (options.dark) await page.emulateMedia({ colorScheme: "dark" });
    await page.setContent(
      `<!doctype html><html lang="de"${options.dark ? ' style="color-scheme: dark"' : ""}><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"${options.dark ? ' data-theme="dark"' : ""}><div id="root"></div></body></html>`,
    );
    await page.addScriptTag({ content: client });
    await page.waitForFunction(() => window.__k2Mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

/** Each bar: its track and range in px, the range's background and the colours in it, and its words. */
const read = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-k2-part="RangeBar"]')]
      .filter((track) => track.getClientRects().length > 0)
      .map((track) => {
        const range = track.querySelector("i")!;
        const outer = track.getBoundingClientRect();
        const inner = range.getBoundingClientRect();
        const background = getComputedStyle(range).backgroundImage;
        return {
          label: track.getAttribute("aria-label"),
          role: track.getAttribute("role"),
          track: { width: outer.width, height: outer.height },
          start: inner.left - outer.left,
          end: outer.right - inner.right,
          width: inner.width,
          background,
          colors: (background.match(/rgba?\([^)]*\)/g) ?? []).map((color) =>
            color
              .match(/[\d.]+/g)!
              .slice(0, 3)
              .map(Number),
          ),
          color: getComputedStyle(range).backgroundColor,
          outline: getComputedStyle(track).outlineStyle,
          surface: getComputedStyle(document.body).getPropertyValue("--k2-surface").trim(),
        };
      }),
  );

const luminance = ([r, g, b]: number[]) => {
  const [lr, lg, lb] = [r!, g!, b!].map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr! + 0.7152 * lg! + 0.0722 * lb!;
};
const hex = (value: string) => [1, 3, 5].map((start) => Number.parseInt(value.slice(start, start + 2), 16));
const contrast = (a: number[], b: number[]) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
};

test("each day stands on the week's one scale at 1440 px, in its colours, a stub at the very end inside the track", async () => {
  await withPage({ width: 1440 }, async (page) => {
    const bars = await read(page);
    expect(bars.map((bar) => [bar.role, bar.label])).toEqual([
      ["img", "2.9° bis 9.1°"],
      ["img", "-3.4° bis 4.6°"],
      ["img", "5° bis 5°"],
      ["img", "-1.2° bis 14°"],
      ["img", "-2° bis 8°"],
      ["img", "10° bis 10°"],
      ["img", "rtl"],
      ["img", "neutral"],
    ]);
    const [today, saturday, single, past, loose, end, rtl, neutral] = bars;
    for (const bar of bars) expect(bar.track.height).toBe(6);
    // -4…10: 2.9 lies at 6.9/14 of the track, 9.1 at 13.1/14
    const at = (share: number) => Math.round(share * today!.track.width);
    expect(Math.round(today!.start)).toBe(at(6.9 / 14));
    expect(Math.round(today!.end)).toBe(at(0.9 / 14));
    expect(Math.round(saturday!.start)).toBe(at(0.6 / 14));
    // a single value still shows as a short bar; a value past the scale stops at its end
    expect(single!.width).toBe(4);
    expect(Math.round(past!.end)).toBe(0);
    // at the scale's very end the 4 px stub stays inside the track
    expect(end!.width).toBe(4);
    expect(Math.round(end!.end)).toBe(0);
    expect(end!.start).toBeGreaterThanOrEqual(0);
    // the exact colours of its part: -2…8 runs from the blue at -4 (-20 %) over the teal at 4 (60 %) to the green at 10
    expect(loose!.background).toBe("linear-gradient(to right, rgb(29, 78, 216) -20%, rgb(15, 118, 110) 60%, rgb(21, 128, 61) 120%)");
    // right to left the range stands from the right, and its colours run from the right
    expect(Math.round(rtl!.end)).toBe(Math.round(loose!.start));
    expect(rtl!.background.startsWith("linear-gradient(to left,")).toBe(true);
    // without stops the bar is neutral
    expect(neutral!.background).toBe("none");
    expect(neutral!.color).not.toBe("rgba(0, 0, 0, 0)");
    // a data colour on an icon arrives as its colour
    expect(await page.locator('[data-k2-part="Icon"][data-name="sun"]').evaluate((icon) => getComputedStyle(icon).color)).toBe(
      "rgb(180, 83, 9)",
    );
    expect((await measureV2Layout(page)).problems).toEqual([]);
  });
}, 30_000);

test("on the phone a coloured bar keeps its colours, and the table rows give their place to words", async () => {
  await withPage({ width: 390 }, async (page) => {
    const bars = await read(page);
    // the table's bars stand only in its wide rows; the loose ones remain
    expect(bars.map((bar) => bar.label)).toEqual(["-2° bis 8°", "10° bis 10°", "rtl", "neutral"]);
    expect(bars[0]!.background).toContain("linear-gradient(to right, rgb(29, 78, 216)");
    expect(bars[0]!.width).toBeGreaterThan(100);
  });
}, 30_000);

test("in the dark the colours of the range keep 3:1 on the surface", async () => {
  await withPage({ width: 1440, dark: true }, async (page) => {
    const [loose] = (await read(page)).filter((bar) => bar.label === "-2° bis 8°");
    expect(loose!.colors.length).toBe(3);
    for (const color of loose!.colors) expect(contrast(color, hex(loose!.surface))).toBeGreaterThanOrEqual(3);
  });
}, 30_000);

test("in forced colours the range draws in the text colour on an outlined track", async () => {
  await withPage({ width: 1440, forced: true }, async (page) => {
    const bars = await read(page);
    for (const bar of bars) {
      expect(bar.background).toBe("none");
      expect(bar.color).not.toBe("rgba(0, 0, 0, 0)");
      expect(bar.outline).toBe("solid");
    }
  });
}, 30_000);
