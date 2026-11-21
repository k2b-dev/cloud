import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser } from "../../test/browser";
import { layoutProblems } from "../../test/head-overlap";

// Error class: a box that overlaps its sibling, spills, or cuts its text without a sign at one width only (K15).
// This fixture is the guard of the self-check itself: a clean page passes at every width, and a page with one defect
// of each kind is caught at every width. Apps call `layoutProblems` the same way on their own pages.
const clean = `
  <header data-probe="head" style="display:flex;align-items:center;gap:8px;height:56px;padding:0 20px;border-bottom:1px solid #e4e4e7">
    <h1 style="flex:1;min-width:0;margin:0;font-size:14px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">
      Quarterly report for the north warehouse and its three outlets, with the open returns
    </h1>
    <button style="flex:none;height:36px">Share</button>
  </header>
  <nav style="display:flex;gap:4px;overflow-x:auto;padding:0 20px">
    ${Array.from({ length: 14 }, (_, index) => `<a style="flex:none;padding:8px">View ${index + 1}</a>`).join("")}
  </nav>
  <div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;padding:0 20px">
    <span style="overflow:hidden;white-space:nowrap;mask-image:linear-gradient(to left,transparent,#000 24px)">
      A long description that fades out at the end of its cell instead of being cut
    </span>
    <span style="white-space:nowrap">12.04.2026</span>
  </div>
  <div class="k2b-avatar-stack" style="display:flex;padding:0 20px">
    <span style="width:24px;height:24px;border-radius:50%;background:#71717a"></span>
    <span style="width:24px;height:24px;border-radius:50%;background:#2563eb;margin-left:-4px"></span>
  </div>`;

const defects = `
  <div style="display:flex;width:240px">
    <span data-probe="first" style="flex:none;width:120px">First</span>
    <span data-probe="second" style="flex:none;width:120px;margin-left:-60px">Second</span>
  </div>
  <div data-probe="spilling" style="width:120px"><div style="width:200px">A box wider than its parent</div></div>
  <div data-probe="cut" style="width:120px;overflow:hidden;white-space:nowrap">A title that is cut without a sign</div>
  <div data-probe="wide" style="position:absolute;top:0;left:0;width:2400px;height:1px"></div>`;

const widths = [390, 768, 1440, 1920];
let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await launchBrowser();
  page = await browser.newPage();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const check = async (width: number, body: string) => {
  await page.setViewportSize({ width, height: 800 });
  await page.setContent(`<!doctype html><html><body style="margin:0;font:13px sans-serif"><main id="app">${body}</main></body></html>`);
  return page.evaluate(layoutProblems, { root: "#app" });
};

describe(`layout self-check in ${browserName}`, () => {
  for (const width of widths) {
    test(`${width} px: a clean page passes`, async () => {
      expect((await check(width, clean)).problems).toEqual([]);
    });

    test(`${width} px: each kind of defect is found`, async () => {
      const result = await check(width, defects);
      // The line height of the font decides the overlap's height; its width and the pair are the finding.
      expect(result.overlap.map((line) => line.replace(/x\d+$/, ""))).toEqual([
        '[data-probe="second"] overlaps [data-probe="first"] by 60',
      ]);
      expect(result.spill).toEqual(['[data-probe="spilling"] spills 80 px out of its box']);
      expect(result.cut.map((line) => line.split(" is cut")[0])).toEqual(['[data-probe="cut"]']);
      expect(result.sideways).toBe(true);
      expect(result.problems.at(-1)).toBe("the page scrolls sideways (2400 px)");
    });
  }
});
