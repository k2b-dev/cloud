import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { hoverInPlace, launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-grips.client";

// The column grips of a table head stand still until they are wanted (study B shows none at rest; Pulse, Files and the
// Notebooks admin showed "⋮" between every column title). A hover or a focus in the head shows them, a grip in reach of
// the keys stays in the tab order, and their room never changes, so nothing moves. While a touch is on the head, a grip
// takes a 44 px target. Fixture: test/v2-grips.client.tsx (a table with two column grips), in Chromium and WebKit.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss = "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-grips.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (run: (page: Page) => Promise<void>, touch = false) => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 }, hasTouch: touch });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
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

/** Each column grip of the head: whether its dots and its pill show, and where it and its head stand. */
const look = (page: Page) =>
  page.evaluate(() => {
    const probe = document.createElement("i");
    document.body.append(probe);
    const transparent = (value: string) => {
      probe.style.color = value;
      const colour = getComputedStyle(probe).color;
      return colour === "rgba(0, 0, 0, 0)" || colour === "transparent";
    };
    const found = [...document.querySelectorAll<HTMLElement>(".k2-table thead .k2-cgrip")].map((grip) => {
      const style = getComputedStyle(grip);
      const box = grip.getBoundingClientRect();
      const head = grip.closest("th")!.getBoundingClientRect();
      return {
        shows: !transparent(style.getPropertyValue("--k2-dot")) || !transparent(style.getPropertyValue("--k2-pill")),
        at: [box.left, box.top, box.width, box.height, head.left, head.width].map(Math.round).join(" "),
        tabindex: grip.getAttribute("tabindex"),
      };
    });
    probe.remove();
    return found;
  });

test("at rest no grip shows; a hover on the head shows them all in their place, and nothing moves", async () => {
  await withPage(async (page) => {
    const rest = await look(page);
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.map((grip) => [grip.shows, grip.tabindex])).toEqual(rest.map(() => [false, "0"]));
    // the pointer on a column title, not on a grip
    await hoverInPlace(page.locator(".k2-table thead th").first(), { x: 40, y: 18 });
    await settled(page);
    const hovered = await look(page);
    expect(hovered.map((grip) => grip.shows)).toEqual(rest.map(() => true));
    expect(hovered.map((grip) => grip.at)).toEqual(rest.map((grip) => grip.at));
    // the pointer leaves the head: they rest again
    await page.mouse.move(700, 600);
    await settled(page);
    expect((await look(page)).map((grip) => grip.shows)).toEqual(rest.map(() => false));
  });
});

test("a grip the keys reach shows, and so do the others of its head; it keeps its name and its value", async () => {
  await withPage(async (page) => {
    const grip = page.locator('.k2-cgrip[aria-label="Betreff"]');
    await grip.focus();
    await page.keyboard.press("ArrowRight");
    await settled(page);
    expect((await look(page)).every((each) => each.shows)).toBe(true);
    expect(await grip.getAttribute("aria-valuenow")).toBe("208");
  });
});

test("touch: a touch on the head shows the grips, each with a 44 px target; before it, the edge is the title's", async () => {
  await withPage(async (page) => {
    const box = (await page.locator('.k2-cgrip[aria-label="Betreff"]').boundingBox())!;
    const head = (await page.locator(".k2-table thead th").first().boundingBox())!;
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2, top: head.y };
    // what a point beside the grip hits: 20 px to either side of its line, and from the top of the head 44 px down
    // (the table's scroller ends at the top of the head, so the target starts there)
    const hits = () =>
      page.evaluate(
        ({ x, y, top }) =>
          [
            [x - 20, y],
            [x + 20, y],
            [x, top + 2],
            [x, top + 42],
          ].map(([px, py]) => document.elementFromPoint(px!, py!)?.matches(".k2-cgrip") ?? false),
        centre,
      );
    expect(await hits()).toEqual([false, false, false, false]);
    await page.touchscreen.tap(box.x - 60, centre.y);
    await settled(page);
    expect((await look(page)).every((each) => each.shows)).toBe(true);
    expect(await hits()).toEqual([true, true, true, true]);
    // a touch elsewhere lets them rest again, with their own small target
    await page.touchscreen.tap(700, 600);
    await settled(page);
    expect((await look(page)).some((each) => each.shows)).toBe(false);
    expect(await hits()).toEqual([false, false, false, false]);
  }, true);
});
