import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page, Route } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle, serverMarkup } from "../../test/v2-behavior/harness";
import { measureV2Layout } from "./testing";

// Cover (test/v2-cover.demo.tsx): a picture across its place. The server's markup alone holds its room before any
// script runs and before the picture comes; when the picture arrives, or fails, nothing moves; a quiet tint fills the
// room meanwhile, in light and dark; a cover without a picture leaves no band. Runs in Chromium and in WebKit
// (TEST_BROWSER=webkit).

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss = "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; }";
const picture = (fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="240"><rect width="1200" height="240" fill="${fill}"/></svg>`;

let browser: Browser;
let bundle: string;
let markup: string;
beforeAll(async () => {
  [bundle, markup, browser] = await Promise.all([demoBundle("../v2-cover"), serverMarkup("../v2-cover"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

/**
 * A page with the server's markup. `pictures`: `hold` keeps every picture on its way, `serve` sends them (the one named
 * kaputt fails). `mount` runs the island over the markup, as a Cloud page does.
 */
const withPage = async (
  options: { width: number; dark?: boolean; pictures: "hold" | "serve"; mount: boolean },
  run: (page: Page) => Promise<void>,
) => {
  const page = await browser.newPage({ viewport: { width: options.width, height: 900 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  const held: Route[] = [];
  await page.route("https://cover.example/**", (route) => {
    if (options.pictures === "hold") held.push(route);
    else if (route.request().url().endsWith("/kaputt.svg")) route.abort();
    else route.fulfill({ status: 200, contentType: "image/svg+xml", body: picture("#0f766e") });
  });
  try {
    if (options.dark) await page.emulateMedia({ colorScheme: "dark" });
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"${options.dark ? ' data-theme="dark"' : ""}><div id="root">${markup}</div></body></html>`,
      { waitUntil: "domcontentloaded" },
    );
    if (options.mount) {
      await page.addScriptTag({ content: bundle });
      await page.waitForFunction(() => window.__mounted === true);
      await settled(page);
    }
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.close();
  }
};

/** Each cover: its size, its tint, what became of its picture, and its words. */
const covers = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-k2-part="Cover"]')].map((cover) => {
      const box = cover.getBoundingClientRect();
      // the room inside the pane, without a scroll bar
      const pane = cover.closest<HTMLElement>('[data-k2-part="Pane"]')!.clientWidth;
      return {
        width: box.width,
        paneWidth: pane,
        height: box.height,
        tint: getComputedStyle(cover).backgroundColor,
        image: cover.getAttribute("data-image"),
        pictures: cover.querySelectorAll("img").length,
        role: cover.getAttribute("role"),
        label: cover.getAttribute("aria-label"),
        hidden: cover.getAttribute("aria-hidden"),
      };
    }),
  );

for (const [width, wide, slim] of [
  [1440, 180, 88],
  [390, 130, 72],
] as const) {
  test(`at ${width} px the server's markup holds the room before the picture comes, and nothing moves when it does`, async () => {
    let before: Awaited<ReturnType<typeof covers>> = [];
    await withPage({ width, pictures: "hold", mount: false }, async (page) => {
      before = await covers(page);
      // three covers: the one without a picture leaves no band
      expect(before.map((cover) => Math.round(cover.height))).toEqual([wide, slim, wide]);
      // from edge to edge of its pane, a quiet tint in the room while the picture is on its way
      for (const cover of before) {
        expect(Math.round(cover.width)).toBe(cover.paneWidth);
        expect(cover.tint).not.toBe("rgba(0, 0, 0, 0)");
        expect(cover.pictures).toBe(1);
      }
    });
    await withPage({ width, pictures: "serve", mount: true }, async (page) => {
      await page.waitForFunction(() =>
        [...document.querySelectorAll('[data-k2-part="Cover"]')].every((cover) => cover.getAttribute("data-image") !== ""),
      );
      const after = await covers(page);
      // the same room with the picture as without it
      expect(after.map((cover) => cover.height)).toEqual(before.map((cover) => cover.height));
      expect(after.map((cover) => [cover.image, cover.pictures])).toEqual([
        ["shown", 1],
        ["shown", 1],
        // a picture that fails leaves its room to the tint
        ["failed", 0],
      ]);
      expect(after[2]!.tint).not.toBe("rgba(0, 0, 0, 0)");
      // the picture fills its room, cut to it
      const fit = await page
        .locator('[data-k2-part="Cover"] img')
        .first()
        .evaluate((image) => {
          const style = getComputedStyle(image);
          const box = image.getBoundingClientRect();
          const room = image.parentElement!.getBoundingClientRect();
          return { fit: style.objectFit, same: box.width === room.width && box.height === room.height };
        });
      expect(fit).toEqual({ fit: "cover", same: true });
      // decoration says nothing and has no role; a cover with words is one picture with them
      expect(after.map((cover) => [cover.role, cover.label, cover.hidden])).toEqual([
        [null, null, "true"],
        ["img", "Der Hof der Werkstatt von oben", null],
        [null, null, "true"],
      ]);
      expect((await measureV2Layout(page)).problems).toEqual([]);
    });
  }, 30_000);
}

test("in the dark the room keeps its quiet tint, a darker one than in the light, and the layout stays clean", async () => {
  let light = "";
  await withPage({ width: 1440, pictures: "hold", mount: true }, async (page) => {
    light = (await covers(page))[0]!.tint;
  });
  await withPage({ width: 1440, dark: true, pictures: "hold", mount: true }, async (page) => {
    const [first] = await covers(page);
    expect(first!.tint).not.toBe("rgba(0, 0, 0, 0)");
    expect(first!.tint).not.toBe(light);
    expect((await measureV2Layout(page)).problems).toEqual([]);
  });
}, 30_000);
