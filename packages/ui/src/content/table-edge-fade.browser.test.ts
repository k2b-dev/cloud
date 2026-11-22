import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

// #3933: a table that scrolls sideways fades at the edge where it continues, driven by a scroll timeline; a table that
// fits has no mask. The fade moves nothing. Chromium runs with the classic scrollbars a desktop draws.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "table-edge-fade.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { DataTable } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const wide = Array.from({ length: 9 }, (_, i) => ({ id: "c" + i, header: "Column " + (i + 1), value: "v", nowrap: true }));
const rows = Array.from({ length: 4 }, (_, i) => ({ v: "A long value " + (i + 1) }));
render(() => createComponent(DataTable, { columns: wide, rows, surface: "plain", ariaLabel: "Wide" }), document.getElementById("wide"));
render(() => createComponent(DataTable, { columns: wide.slice(0, 2), rows, surface: "plain", ariaLabel: "Fits" }), document.getElementById("fits"));
render(() => createComponent(DataTable, { columns: wide, rows, surface: "plain", ariaLabel: "Wide rtl" }), document.getElementById("rtl"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the table edge fade fixture");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser({ ignoreDefaultArgs: ["--hide-scrollbars"] });
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await page.setContent(
    `<!doctype html><html><head><style>${css}</style><style>.host{width:400px;margin-bottom:16px}</style></head>` +
      `<body class="k2b-ui" style="margin:0;padding:16px"><div id="wide" class="host"></div><div id="fits" class="host"></div>` +
      `<div id="rtl" class="host" dir="rtl"></div></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await page.locator("#rtl tbody tr").first().waitFor();
  await settled(page);
  return page;
};

const read = (page: Page, root: string, to?: "middle" | "end") =>
  page.locator(`${root} .k2b-table-wrap`).evaluate(async (wrap, to) => {
    const max = wrap.scrollWidth - wrap.clientWidth;
    const rtl = getComputedStyle(wrap).direction === "rtl";
    if (to) wrap.scrollLeft = (rtl ? -1 : 1) * (to === "middle" ? max / 2 : max);
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const heads = Array.from(wrap.querySelectorAll("thead th")).map((th) => Math.round(th.getBoundingClientRect().width));
    return { mask: getComputedStyle(wrap).maskImage, overflows: max > 1, heads };
  }, to);

describe("a table that scrolls sideways", () => {
  test("fades only where it continues, moves nothing, and a table that fits has no mask", async () => {
    const page = await load();
    try {
      const timelines = await page.evaluate(() => CSS.supports("animation-timeline: scroll()"));
      const fits = await read(page, "#fits");
      expect(fits.overflows).toBe(false);
      expect(fits.mask).toBe("none");
      const start = await read(page, "#wide");
      expect(start.overflows).toBe(true);
      if (!timelines) {
        // Without scroll timelines the edge stays as it was.
        expect(start.mask).toBe("none");
        return;
      }
      const middle = await read(page, "#wide", "middle");
      const end = await read(page, "#wide", "end");
      // Start: only the trailing edge fades; middle: both; end: only the leading edge.
      // Engines serialize the direction as an angle: 90deg runs left to right, 270deg right to left.
      expect(start.mask).toMatch(/^linear-gradient\((to right|90deg), rgb\(0, 0, 0\)/);
      expect(middle.mask).not.toBe(start.mask);
      expect(end.mask).not.toBe(start.mask);
      expect(end.mask).not.toBe(middle.mask);
      expect(end.mask).toMatch(/rgb\(0, 0, 0\) 24px\)$/);
      // A mask moves nothing: every head cell keeps its width.
      expect(middle.heads).toEqual(start.heads);
      // Right to left, the table starts on the right and fades towards the left.
      const rtl = await read(page, "#rtl");
      expect(rtl.mask).toMatch(/^linear-gradient\((to left|270deg), rgb\(0, 0, 0\)/);
    } finally {
      await page.close();
    }
  });
});
