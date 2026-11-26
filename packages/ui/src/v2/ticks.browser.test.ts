import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-ticks.client";
import { measureV2Layout } from "./testing";

// Ticks (test/v2-ticks.client.tsx, the sources of a monitoring app): one tick per time slot, ok in the soft colour of
// the app, a failure red and taller, an empty slot nothing. 140 × 20 px in a table cell, the width of its place with
// `stretch`; a failure keeps 3:1 against the page in light and dark, and stays apart in forced colors.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-ticks.client.tsx", "dom"), launchBrowser()]);
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
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"${options.dark ? ' data-theme="dark"' : ""}><div id="root"></div></body></html>`,
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

/** The ticks of the first table row and of the detail: their box, and the height and colour of each slot by state. */
const read = (page: Page) =>
  page.evaluate(() => {
    const rgb = (color: string) =>
      color
        .match(/[\d.]+/g)!
        .slice(0, 4)
        .map(Number);
    const luminance = (color: string) => {
      const [r, g, b] = rgb(color).map((channel) => {
        const c = channel / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const contrast = (a: string, b: string) => {
      const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (light! + 0.05) / (dark! + 0.05);
    };
    const page = getComputedStyle(document.querySelector(".k2-pane")!).backgroundColor;
    const of = (ticks: Element) => {
      const box = ticks.getBoundingClientRect();
      const slot = (state: string) => {
        const tick = ticks.querySelector(`[data-s="${state}"]`);
        if (!tick) return undefined;
        const style = getComputedStyle(tick);
        const alpha = rgb(style.backgroundColor)[3];
        return {
          height: tick.getBoundingClientRect().height,
          color: style.backgroundColor,
          drawn: style.backgroundColor !== "rgba(0, 0, 0, 0)" && alpha !== 0,
          contrast: Math.round(contrast(style.backgroundColor, page) * 10) / 10,
        };
      };
      return {
        width: Math.round(box.width),
        height: Math.round(box.height),
        role: ticks.getAttribute("role"),
        label: ticks.getAttribute("aria-label"),
        slots: ticks.children.length,
        ok: slot("ok"),
        bad: slot("bad"),
        none: slot("none"),
      };
    };
    const [row, , , , detail] = [...document.querySelectorAll(".k2-ticks")];
    const failing = document.querySelectorAll(".k2-ticks")[1]!;
    return { row: of(row!), failing: of(failing), detail: of(detail!), band: Math.round(detail!.parentElement!.clientWidth) };
  });

for (const dark of [false, true])
  test(`${dark ? "dark" : "light"}: a tick per slot, ok soft in the app colour, a failure red, taller and 3:1 against the page`, async () => {
    await withPage({ width: 1440, dark }, async (page) => {
      const { row, failing } = await read(page);
      expect({ width: row.width, height: row.height, role: row.role, slots: row.slots }).toEqual({
        width: 140,
        height: 20,
        role: "img",
        slots: 30,
      });
      expect(row.label).toBe("prometheus-nord: 30 Abrufe, alle erfolgreich");
      expect(failing.ok!.drawn).toBe(true);
      expect(failing.bad!.drawn).toBe(true);
      expect(failing.bad!.color).not.toBe(failing.ok!.color);
      expect(failing.bad!.height).toBeGreaterThan(failing.ok!.height);
      expect(failing.bad!.contrast).toBeGreaterThanOrEqual(3);
      expect((await measureV2Layout(page)).problems).toEqual([]);
    });
  });

test("an empty slot draws nothing and keeps its place; a new source starts with empty slots", async () => {
  await withPage({ width: 1440 }, async (page) => {
    const found = await page.evaluate(() => {
      const ticks = document.querySelectorAll(".k2-ticks")[2]!;
      const slots = [...ticks.children].map((tick) => ({
        state: tick.getAttribute("data-s"),
        width: tick.getBoundingClientRect().width,
        color: getComputedStyle(tick).backgroundColor,
      }));
      return {
        states: slots.map((slot) => slot.state).join(""),
        widths: new Set(slots.map((slot) => Math.round(slot.width * 10))).size,
        empty: slots[0]!.color,
      };
    });
    expect(found.states.startsWith("none".repeat(18))).toBe(true);
    expect(found.widths).toBe(1);
    expect(found.empty).toBe("rgba(0, 0, 0, 0)");
  });
});

/** The stretched ticks of the detail: where their slots start and end against the text edges, their widths and gaps. */
const strip = (page: Page) =>
  page.evaluate(() => {
    const ticks = document.querySelectorAll(".k2-ticks")[4]!;
    // the text edges: where the words of the band's text start and end, inside its padding
    const words = ticks.parentElement!.querySelector(".k2-text")!;
    const box = words.getBoundingClientRect();
    const style = getComputedStyle(words);
    const [start, end] = [box.left + Number.parseFloat(style.paddingLeft), box.right - Number.parseFloat(style.paddingRight)];
    const slots = [...ticks.children].map((tick) => tick.getBoundingClientRect());
    return {
      start: Math.round(slots[0]!.left - start),
      room: Math.round(end - slots[slots.length - 1]!.right),
      widths: [...new Set(slots.map((slot) => Math.round(slot.width * 10) / 10))],
      gaps: [...new Set(slots.slice(1).map((slot, index) => Math.round((slot.left - slots[index]!.right) * 10) / 10))],
    };
  });

test("with stretch at 1440 the slots reach their cap of 12 px, 2 px apart, and the strip stays at the start", async () => {
  await withPage({ width: 1440 }, async (page) => {
    const { detail, failing } = await read(page);
    const found = await strip(page);
    expect({ start: found.start, widths: found.widths, gaps: found.gaps }).toEqual({ start: 0, widths: [12], gaps: [2] });
    // 30 slots of 12 px and 29 gaps of 2 px: 418 px, the rest of the room stays free after the strip
    expect(found.room).toBeGreaterThan(400);
    expect(detail.height).toBe(20);
    expect(detail.bad!.height).toBeGreaterThan(detail.ok!.height);
    expect(detail.ok!.color).not.toBe(failing.ok!.color);
  });
});

test("with stretch at 390 the slots give way below their cap and fill the room between the text edges", async () => {
  await withPage({ width: 390 }, async (page) => {
    const found = await strip(page);
    expect({ start: found.start, room: found.room, gaps: found.gaps }).toEqual({ start: 0, room: 0, gaps: [2] });
    expect(found.widths.every((width) => width > 4 && width < 12)).toBe(true);
  });
});

test("forced colors: the ticks stay drawn and a failure stays apart from ok", async () => {
  await withPage({ width: 1440, forced: true }, async (page) => {
    const { failing } = await read(page);
    expect(failing.ok!.drawn).toBe(true);
    expect(failing.bad!.drawn).toBe(true);
    expect(failing.bad!.color).not.toBe(failing.ok!.color);
    expect(failing.bad!.height).toBeGreaterThan(failing.ok!.height);
  });
});

test("at 390 the phone form of the table and the detail keep their ticks within the column", async () => {
  await withPage({ width: 390 }, async (page) => {
    const { detail, band } = await read(page);
    expect(detail.width).toBeLessThanOrEqual(band);
    expect((await measureV2Layout(page)).problems).toEqual([]);
  });
});
