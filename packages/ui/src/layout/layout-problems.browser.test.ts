import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { browserName, launchWithScrollbars, settled } from "../../test/browser";
import { layoutProblems } from "../../test/head-overlap";
import { layoutWidths, scrollbarWidth } from "../layout-check";

// Error class: a box that overlaps its sibling, spills, or cuts its text without a sign at one width only (K15), and a
// line drawn twice because both neighbours draw it (K2, "one line, one owner").
// This fixture is the guard of the self-check itself: a clean page passes at every width, and a page with one defect
// of each kind is caught at every width. Apps call `layoutProblems` the same way on their own pages.
// The shipped stylesheet, so `k2b-divided` is the real mechanism.
const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");
const clean = `
  <section data-probe="divided-frame" style="border-block:1px solid #e4e4e7">
    <ul class="k2b-divided" style="list-style:none;margin:0;padding:0">
      <li hidden>Hidden first row</li>
      <li style="padding:8px 20px">Palette 14</li>
      <li style="padding:8px 20px">Palette 15</li>
      <li style="padding:8px 20px">Palette 16</li>
    </ul>
  </section>
  <div class="k2b-divided-inline" style="display:flex;padding:0 20px">
    <span style="padding:0 8px">Open</span>
    <span style="padding:0 8px">Done</span>
  </div>
  <header data-probe="head" style="display:flex;align-items:center;gap:8px;height:56px;padding:0 20px;border-bottom:1px solid #e4e4e7">
    <h1 style="flex:1;min-width:0;margin:0;font-size:14px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">
      Quarterly report for the north warehouse and its three outlets, with the open returns
    </h1>
    <button style="flex:none;height:36px">Share</button>
  </header>
  <nav data-layout-check="scroll-x" style="display:flex;gap:4px;overflow-x:auto;padding:0 20px">
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
  <div data-probe="row-a" style="width:200px;border-bottom:1px solid #e4e4e7">Row A</div>
  <div data-probe="row-b" style="width:200px;border-top:1px solid #e4e4e7">Row B</div>
  <section data-probe="frame" style="width:200px;margin-top:16px;border-top:1px solid #d4d4d8">
    <div data-probe="inner" style="border-top:1px solid #d4d4d8;outline:2px solid #2563eb">Inner band</div>
  </section>
  <div style="display:flex;width:240px">
    <span data-probe="first" style="flex:none;width:120px">First</span>
    <span data-probe="second" style="flex:none;width:120px;margin-left:-60px">Second</span>
  </div>
  <div data-probe="spilling" style="width:120px"><div style="width:200px">A box wider than its parent</div></div>
  <div data-probe="cut" style="width:120px;overflow:hidden;white-space:nowrap">A title that is cut without a sign</div>
  <div data-probe="cut-in-scroller" style="width:120px;height:40px;overflow-x:hidden;overflow-y:auto;white-space:nowrap">A row that scrolls down but is cut sideways</div>
  <div data-probe="panel-body" style="width:300px;height:80px;overflow-y:auto"><div style="width:340px">A detail body that scrolls sideways by 40 px</div></div>
  <div data-probe="wide" style="position:absolute;top:0;left:0;width:2400px;height:1px"></div>`;

// The shared widths (with the docked detail column at 1100 px) and a very wide screen.
const widths = [...layoutWidths, 1920];
let browser: Browser;
let page: Page;
beforeAll(async () => {
  // Classic scrollbars, as on most desktops: only then does a scrollbar take its width.
  browser = await launchWithScrollbars();
  page = await browser.newPage();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const check = async (width: number, body: string) => {
  await page.setViewportSize({ width, height: 800 });
  await page.setContent(
    `<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui" style="margin:0;font:13px sans-serif"><main id="app">${body}</main></body></html>`,
  );
  await settled(page);
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
      expect(result.cut.map((line) => line.split(" is cut")[0])).toEqual(['[data-probe="cut"]', '[data-probe="cut-in-scroller"]']);
      // A scroll area with only `overflow-y: auto` scrolls sideways too when its content is too wide.
      expect(result.scroll.map((line) => line.split(" by ")[0])).toEqual(['[data-probe="panel-body"] scrolls sideways']);
      // Both neighbours draw the line, and a child repeats its parent's edge; the outline of a focus ring is no border.
      expect(result.double.map((line) => line.replace(/ at .*$/, ""))).toEqual([
        'double line: [data-probe="row-a"] bottom and [data-probe="row-b"] top',
        'double line: [data-probe="frame"] top and [data-probe="inner"] top',
      ]);
      expect(result.sideways).toBe(true);
      expect(result.problems.at(-1)).toBe("the page scrolls sideways (2400 px)");
    });
  }
});

// Scroll containers: a scroller that says it scrolls on purpose passes, a toolbar scrolls only on a phone (K15), and a
// column that a classic scrollbar makes too narrow for its content is caught.
const toolbar = `<div data-probe="toolbar" role="toolbar" aria-label="Format" style="display:flex;gap:4px;width:200px;overflow-x:auto">
  ${Array.from({ length: 12 }, (_, index) => `<button type="button" style="flex:none;width:36px">${index + 1}</button>`).join("")}
</div>`;
describe(`scroll containers in ${browserName}`, () => {
  // A classic run is only worth its name when a scrollbar takes room. With phone emulation Chromium draws overlay
  // scrollbars that take none, even with classic scrollbars: such a run belongs to a desktop window without touch.
  test.if(browserName === "chromium")("classic scrollbars take room on a desktop page, and none with touch emulation", async () => {
    await check(1100, "<p>Room</p>");
    expect(await page.evaluate(scrollbarWidth)).toBeGreaterThan(0);
    const phone = await browser.newPage({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true });
    try {
      await phone.setContent("<!doctype html><html><body><p>Room</p></body></html>");
      expect(await phone.evaluate(scrollbarWidth)).toBe(0);
    } finally {
      await phone.close();
    }
  });

  test("390 px: a scroller that opts in, a code block, and a toolbar on a phone pass", async () => {
    const result = await check(
      390,
      `<div data-layout-check="scroll-x" style="width:200px;overflow-x:auto"><div style="width:400px">Chips in a row</div></div>${toolbar}<pre style="width:200px;overflow-x:auto;margin:0">claude mcp add --transport http cloud https://cloud.example.test/mcp</pre>`,
    );
    expect(result.problems).toEqual([]);
  });

  test("1440 px: a toolbar does not scroll sideways on a wide screen", async () => {
    const result = await check(1440, toolbar);
    expect(result.scroll.map((line) => line.split(" scrolls")[0])).toEqual(['[data-probe="toolbar"]']);
  });

  test.if(browserName === "chromium")("1440 px: a classic scrollbar that makes a column too narrow is caught", async () => {
    const result = await check(
      1440,
      `<div data-probe="list" style="width:300px;height:120px;overflow-y:auto"><div style="width:300px;height:400px">A list as wide as its column</div></div>`,
    );
    // The vertical scrollbar takes its width, so the 300 px content no longer fits beside it.
    expect(
      await page.locator('[data-probe="list"]').evaluate((list) => list.getBoundingClientRect().width - list.clientWidth),
    ).toBeGreaterThan(7);
    expect(result.scroll.map((line) => line.split(" by ")[0])).toEqual(['[data-probe="list"] scrolls sideways']);
  });
});

// Touch: small controls reach 44 px with an empty, invisible pseudo-element (the hit area). That is no spill. A drawn
// pseudo-element that reaches out, or real content next to a hit area, still is.
const hitAreaStyle = `<style>
  .app-hit { position: relative; display: inline-block; width: 20px; height: 20px; }
  .app-hit::after { content: ""; position: absolute; inset: -12px; }
  .app-badge { position: relative; display: inline-block; width: 20px; height: 20px; }
  .app-badge::after { content: "3"; position: absolute; top: -6px; right: -18px; padding: 0 4px; background: #dc2626; color: #fff; }
</style>`;
const touchClean = `${hitAreaStyle}
  <div data-probe="toolbar" style="display:flex;gap:4px;padding:0 20px">
    <button type="button" class="k2b-button k2b-icon-button" data-variant="ghost" data-size="sm" aria-label="More">…</button>
    <span data-probe="app-hit" class="app-hit"></span>
  </div>`;
const touchDefects = `${hitAreaStyle}
  <div data-probe="badge-box" style="width:24px"><span class="app-badge"></span></div>
  <div data-probe="hit-and-content" style="width:120px"><span class="app-hit"></span><div style="width:200px">Wider than its box</div></div>`;

describe(`layout self-check with touch in ${browserName}`, () => {
  let touch: Page;
  beforeAll(async () => {
    touch = await browser.newPage({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
  });
  const checkTouch = async (body: string) => {
    await touch.setContent(
      `<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui" style="margin:0;font:13px sans-serif"><main id="app">${body}</main></body></html>`,
    );
    await settled(touch);
    return touch.evaluate(layoutProblems, { root: "#app" });
  };

  test("390 px: hit areas of small controls are no spill", async () => {
    // The hit area is real: the icon button is smaller than 44 px and its pseudo-element reaches past it.
    const result = await checkTouch(touchClean);
    expect(await touch.evaluate(() => matchMedia("(any-pointer: coarse)").matches)).toBe(true);
    expect(await touch.locator(".k2b-icon-button").evaluate((button) => getComputedStyle(button, "::after").position)).toBe("absolute");
    // Without the hit-area rule this box would spill: its pseudo-element reaches 12 px past it.
    expect(await touch.locator('[data-probe="app-hit"]').evaluate((box) => box.scrollWidth - box.clientWidth)).toBeGreaterThan(7);
    expect(result.problems).toEqual([]);
  });

  test("390 px: a drawn pseudo-element or real content beside a hit area still spills", async () => {
    const result = await checkTouch(touchDefects);
    expect(result.spill.map((line) => line.split(" spills")[0])).toEqual([
      '[data-probe="badge-box"]',
      "span.app-badge",
      '[data-probe="hit-and-content"]',
    ]);
  });
});
