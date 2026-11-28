import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import type {} from "../../test/v2-accent.client";
import { bundleV2Entry } from "../../test/v2-bundle";
import { measureV2Layout } from "./testing";

// A page with an accent of its own (test/v2-accent.client.tsx, a place's visitor page): `Workspace accent` puts the
// colour on the primary action with readable words, on the bars of its week (today's the strongest, the others in a
// quiet tone) and on the hero's state in a band of its tint, in light and in dark. Focus rings and the colours of states
// stay; in forced colours the bars keep the text colour. A value that is no colour leaves the app's colour.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-accent.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (
  options: { accent: string; dark?: boolean; forced?: boolean; width?: number },
  run: (page: Page) => Promise<void>,
) => {
  const page = await browser.newPage({ viewport: { width: options.width ?? 1440, height: 900 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    if (options.forced) await page.emulateMedia({ forcedColors: "active" });
    await page.setContent(
      `<!doctype html><html lang="de"${options.dark ? ' style="color-scheme: dark"' : ""}><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"${options.dark ? ' data-theme="dark"' : ""}><div id="root"></div></body></html>`,
    );
    await page.addScriptTag({ content: `window.__k2Accent = ${JSON.stringify(options.accent)};` });
    await page.addScriptTag({ content: client });
    await page.waitForFunction(() => window.__k2Mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

/** The painted colours that carry the accent, as sRGB channels, and the grounds they stand on. */
const read = (page: Page) =>
  page.evaluate(() => {
    // a computed colour (`rgb(…)`, or `color(srgb 0–1 …)` from a color-mix()) or a token as written (`#rrggbb`)
    const channels = (color: string): number[] => {
      if (color.startsWith("#")) return [1, 3, 5].map((start) => Number.parseInt(color.slice(start, start + 2), 16));
      const values = (color.match(/[\d.]+/g) ?? []).map(Number);
      return color.startsWith("color(srgb") ? values.slice(0, 3).map((value) => value * 255) : values.slice(0, 3);
    };
    const style = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`accent: ${selector} is missing`);
      return getComputedStyle(element);
    };
    const button = style('[data-k2-part="Button"][data-variant="primary"]');
    const bars = [...document.querySelectorAll<HTMLElement>('[data-k2-part="RangeBar"] > i')].map((bar) => ({
      current: bar.closest("tr")?.hasAttribute("aria-current") ?? false,
      fill: channels(getComputedStyle(bar).backgroundColor),
    }));
    return {
      fill: channels(button.backgroundColor),
      words: channels(button.color),
      state: channels(style('.k2-band[data-tone="app"] .k2-text[data-tone="app"]').color),
      band: channels(style('.k2-band[data-tone="app"]').backgroundColor),
      today: channels(style(".k2-table tbody tr[aria-current] > td").backgroundColor),
      surface: channels(style(".k2-ws").getPropertyValue("--k2-surface").trim()),
      bars,
      ring: style(".k2-ws").getPropertyValue("--k2-blue-ring").trim(),
      bad: style(".k2-ws").getPropertyValue("--k2-bad").trim(),
    };
  });

const luminance = ([r, g, b]: readonly number[]) => {
  const [lr, lg, lb] = [r!, g!, b!].map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr! + 0.7152 * lg! + 0.0722 * lb!;
};
const contrast = (a: readonly number[], b: readonly number[]) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
};
const hex = (value: string) => [1, 3, 5].map((start) => Number.parseInt(value.slice(start, start + 2), 16));

// warm orange, yellow, navy, pure red, green, light grey
const accents = ["#c2410c", "#facc15", "#1e3a8a", "#ff0000", "#15803d", "#d4d4d8"];

for (const dark of [false, true])
  test(`${dark ? "dark" : "light"}: the primary, the week's bars and the hero's state take the accent, readable`, async () => {
    for (const accent of accents)
      await withPage({ accent, dark }, async (page) => {
        const look = await read(page);
        // the primary is the accent (or a darker step of it) with words at 4.5:1
        expect(contrast(look.fill, look.words)).toBeGreaterThanOrEqual(4.5);
        if (contrast(hex(accent), [255, 255, 255]) >= 4.5 || contrast(hex(accent), [9, 9, 11]) >= 4.5)
          expect(look.fill).toEqual(hex(accent));
        // the state reads at 4.5:1 on its band's tint and on the surface; the band and today's row carry the tint
        expect(contrast(look.state, look.band)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(look.state, look.surface)).toBeGreaterThanOrEqual(4.5);
        expect(look.band).not.toEqual(look.surface);
        expect(look.today).toEqual(look.band);
        // six days have a bar; today's is the strongest, in the ink, and every bar keeps 3:1 on the surface
        expect(look.bars.length).toBe(6);
        const today = look.bars.filter((bar) => bar.current);
        expect(today.length).toBe(1);
        expect(today[0]!.fill).toEqual(look.state);
        for (const bar of look.bars.filter((other) => !other.current)) {
          expect(contrast(bar.fill, look.surface)).toBeGreaterThanOrEqual(3);
          expect(bar.fill).not.toEqual(today[0]!.fill);
        }
        // focus rings and states keep the system's colours
        expect(look.ring).toBe(dark ? "rgb(96 165 250 / 0.35)" : "rgb(37 99 235 / 0.18)");
        expect(look.bad).not.toBe("");
      });
  }, 60_000);

test("the page measures clean with an accent, on a wide screen and on the phone", async () => {
  for (const width of [1440, 390])
    await withPage({ accent: "#c2410c", width }, async (page) => {
      expect((await measureV2Layout(page)).problems).toEqual([]);
    });
}, 30_000);

test("a value that is no colour leaves the app's colour: the primary stays blue and the bars neutral", async () => {
  await withPage({ accent: "#c2410c;position:fixed" }, async (page) => {
    expect(await page.locator("[data-k2-accent]").count()).toBe(0);
    const look = await read(page);
    expect(look.fill).toEqual(hex("#2563eb"));
    for (const bar of look.bars) expect(bar.fill).toEqual(look.bars[0]!.fill);
  });
}, 30_000);

test("in forced colours the bars keep the text colour, today's too, and the primary keeps the system's look", async () => {
  await withPage({ accent: "#c2410c", forced: true }, async (page) => {
    const look = await read(page);
    for (const bar of look.bars) expect(bar.fill).toEqual(look.bars[0]!.fill);
    expect(look.bars[0]!.fill).not.toEqual(hex("#d57d58"));
    // only Chromium's emulation repaints a control's fill with the system's colours; WebKit only matches the query
    if (browserName === "chromium") expect(look.fill).not.toEqual(hex("#c2410c"));
  });
}, 30_000);
