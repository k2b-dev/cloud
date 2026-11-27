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
// end, the colours of its part run along it, and in forced colours the range stays visible.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss = "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-range-bar.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (options: { width: number; forced?: boolean }, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width: options.width, height: 800 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    if (options.forced) await page.emulateMedia({ forcedColors: "active" });
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
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

/** Each bar: its track and range in px, the range's background, and its words. */
const read = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-k2-part="RangeBar"]')].map((track) => {
      const range = track.querySelector("i")!;
      const outer = track.getBoundingClientRect();
      const inner = range.getBoundingClientRect();
      return {
        label: track.getAttribute("aria-label"),
        role: track.getAttribute("role"),
        track: { width: outer.width, height: outer.height },
        start: inner.left - outer.left,
        end: outer.right - inner.right,
        width: inner.width,
        background: getComputedStyle(range).backgroundImage,
        color: getComputedStyle(range).backgroundColor,
        outline: getComputedStyle(track).outlineStyle,
      };
    }),
  );

for (const width of [1440, 390])
  test(`each day stands on the week's one scale at ${width} px`, async () => {
    await withPage({ width }, async (page) => {
      const bars = await read(page);
      expect(bars.map((bar) => [bar.role, bar.label])).toEqual([
        ["img", "2.9° bis 9.1°"],
        ["img", "-3.4° bis 4.6°"],
        ["img", "5° bis 5°"],
        ["img", "-1.2° bis 14°"],
        ["img", "neutral"],
      ]);
      const [today, saturday, single, past, neutral] = bars;
      // on the phone the table shows two lines per row and no bar: only the neutral bar under it stays
      if (width === 390) {
        expect(neutral!.track.height).toBe(6);
        return;
      }
      for (const bar of bars) expect(bar.track.height).toBe(6);
      // -4…10: 2.9 lies at 6.9/14 of the track, 9.1 at 13.1/14
      const at = (share: number) => Math.round(share * today!.track.width);
      expect(Math.round(today!.start)).toBe(at(6.9 / 14));
      expect(Math.round(today!.end)).toBe(at(0.9 / 14));
      expect(Math.round(saturday!.start)).toBe(at(0.6 / 14));
      // a single value still shows as a short bar
      expect(single!.width).toBe(4);
      // a value past the scale stops at its end
      expect(Math.round(past!.end)).toBe(0);
      // the colours of its part run along the bar; without stops the bar is neutral
      expect(today!.background).toContain("linear-gradient");
      expect(neutral!.background).toBe("none");
      expect(neutral!.color).not.toBe("rgba(0, 0, 0, 0)");
      expect((await measureV2Layout(page)).problems).toEqual([]);
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
