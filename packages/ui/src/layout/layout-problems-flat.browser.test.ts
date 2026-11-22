import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser, settled } from "../../test/browser";
import { type FlatProblemKind, layoutProblems } from "../layout-check";

// Error class: flat lines and fills stop short of their area, two lines run a few px apart, a grip sits off its edge,
// and text leaves the type roles (Cloud flach K2, K11, K13). A person saw these in screenshots; this file is the guard
// of the four flat kinds of the self-check: each finds its defect (probe) and passes the clean form (counter-probe).
// The shipped stylesheet, so `--k2b-type-roles` is the real token.
const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");
// Classic 15 px scrollbars, as on a desktop; Chromium keeps a stable gutter for them, WebKit on Linux overlays them.
const classic = `
  .k2b-ui .scroll { scrollbar-width: auto !important; }
  .k2b-ui .scroll::-webkit-scrollbar { width: 15px !important; }
  .k2b-ui .scroll::-webkit-scrollbar-thumb { background: #a1a1aa; }
  [data-layout-area] { width: 400px; margin-bottom: 24px; background: #fff; }
  .line { height: 40px; border-bottom: 1px solid #e4e4e7; }
  /* Lines drawn by pseudo-elements, as the flat columns and rows draw them. */
  .drawn-row { position: relative; height: 40px; }
  .drawn-row::after { content: ""; position: absolute; right: 20px; bottom: 0; left: 20px; height: 1px; background: #e4e4e7; }
  .column-line { position: relative; }
  .column-line::after { content: ""; position: absolute; top: 0; right: 0; bottom: 0; width: 1px; background: #e4e4e7; }
  .sep { position: relative; width: 0; }
  .sep.own-line::before { content: ""; position: absolute; top: 0; bottom: 0; left: 50%; width: 1px; background: #e4e4e7; transform: translateX(-50%); }
  .sep.line-on-top::before { z-index: 1; }
`;

let browser: Browser;
let page: Page;
beforeAll(async () => {
  // Headless Chromium hides scrollbars by default; the gutter probe needs the classic ones a desktop draws.
  browser = await launchBrowser({ ignoreDefaultArgs: ["--hide-scrollbars"] });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const check = async (body: string, flat: FlatProblemKind[]) => {
  await page.setContent(
    `<!doctype html><html><head><style>${css}</style><style>${classic}</style></head><body class="k2b-ui" style="margin:0;padding:16px;font:13px/20px sans-serif"><main id="app">${body}</main></body></html>`,
  );
  await settled(page);
  return page.evaluate(layoutProblems, { root: "#app", flat });
};

describe(`flat kinds of the layout self-check in ${browserName}`, () => {
  test("the flat kinds are off by default and leave the old kinds alone", async () => {
    await check('<section data-layout-area><div class="line" style="margin:0 20px">Inset row</div></section>', []);
    const result = await page.evaluate(layoutProblems, { root: "#app" });
    expect(result.shortEdge).toEqual([]);
    expect(result.problems).toEqual([]);
  });

  test("short-edge: a line, a fill, a selected table row, and a line before a scrollbar gutter stop short", async () => {
    const result = await check(
      `<section data-layout-area data-probe="area">
        <div class="line" data-probe="inset-line" style="margin:0 20px">Inset line</div>
        <div class="drawn-row" data-probe="drawn-row">A row whose line is a pseudo-element with an inset</div>
        <div data-probe="notice" style="margin:8px 16px;height:48px;background:#fef3c7">A notice that keeps a margin</div>
        <table data-probe="table" style="width:360px;border-collapse:collapse">
          <tbody><tr><td data-probe="selected" style="height:40px;background:#dbeafe">Selected</td><td style="background:#dbeafe">row</td></tr></tbody>
        </table>
      </section>
      <section data-layout-area data-probe="gutter-area" class="scroll" style="height:120px;overflow-y:auto;scrollbar-gutter:stable">
        ${Array.from({ length: 6 }, (_, index) => `<div class="line" data-probe="gutter-row-${index + 1}">Row ${index + 1}</div>`).join("")}
      </section>`,
      ["short-edge"],
    );
    const inGutterArea = result.shortEdge.filter((line) => line.includes("gutter-area"));
    expect(result.shortEdge.filter((line) => !line.includes("gutter-area"))).toEqual([
      'short-edge: the line of [data-probe="inset-line"] stops 20 px short of the left edge of [data-probe="area"]',
      'short-edge: the line of [data-probe="inset-line"] stops 20 px short of the right edge of [data-probe="area"]',
      'short-edge: the line of [data-probe="drawn-row"] stops 20 px short of the left edge of [data-probe="area"]',
      'short-edge: the line of [data-probe="drawn-row"] stops 20 px short of the right edge of [data-probe="area"]',
      'short-edge: the fill of [data-probe="notice"] stops 16 px short of the left edge of [data-probe="area"]',
      'short-edge: the fill of [data-probe="notice"] stops 16 px short of the right edge of [data-probe="area"]',
      'short-edge: the fill of td "row" stops 40 px short of the right edge of [data-probe="area"]',
    ]);
    // The gutter is no excuse: every line before it stops by the gutter's width. WebKit on Linux keeps no gutter.
    const gutter = await page.locator('[data-probe="gutter-area"]').evaluate((area: HTMLElement) => area.offsetWidth - area.clientWidth);
    if (browserName === "chromium") expect(gutter).toBe(15);
    expect(inGutterArea).toEqual(
      gutter > 0
        ? Array.from(
            { length: 6 },
            (_, index) =>
              `short-edge: the line of [data-probe="gutter-row-${index + 1}"] stops ${gutter} px short of the right edge of [data-probe="gutter-area"]`,
          )
        : [],
    );
  });

  test("short-edge: lines and fills from edge to edge pass; text keeps its inset, and chips and narrow cells are no rows", async () => {
    const result = await check(
      `<section data-layout-area>
        <div class="line" style="padding:0 20px">A row whose text keeps the 20 px inset</div>
        <div style="height:48px;padding:0 16px;background:#fef3c7">A notice cell from edge to edge</div>
        <div style="height:40px;box-shadow:inset 0 -1px 0 #e4e4e7">A row with a shadow line</div>
        <table style="width:100%;border-collapse:collapse">
          <tbody><tr><td style="height:40px;background:#dbeafe">Selected</td><td style="background:#dbeafe">row</td></tr>
          <tr><td style="height:40px;border-bottom:1px solid #e4e4e7">A</td><td style="border-bottom:1px solid #e4e4e7">B</td></tr></tbody>
        </table>
        <div style="height:40px;padding:0 20px;display:flex;align-items:center;gap:8px">
          <span style="display:block;padding:0 8px;border-radius:999px;background:#e4e4e7">Chip</span>
          <span style="display:block;width:120px;height:20px;background:#fee2e2">A cell of a third</span>
        </div>
        <div style="height:40px;padding:0 20px"><input style="width:100%;box-sizing:border-box;border:0;border-bottom:1px solid #a1a1aa;background:#f4f4f5"></div>
      </section>`,
      ["short-edge"],
    );
    expect(result.shortEdge).toEqual([]);
  });

  test("near-double: lines up to 8 px apart over half of the shorter one are found, also from a shadow or a pseudo-element", async () => {
    const result = await check(
      `<header data-probe="head" style="height:40px;border-bottom:1px solid #e4e4e7">Head</header>
      <section data-probe="section" style="margin-top:4px;border-top:1px solid #e4e4e7">Section 4 px below the head line</section>
      <div style="display:flex;height:80px;margin-top:24px">
        <div data-probe="column" style="width:200px;border-right:1px solid #e4e4e7"></div>
        <div data-probe="inner-column" style="width:200px;margin-left:5px;box-shadow:-1px 0 0 #d4d4d8"></div>
      </div>
      <div data-probe="row" style="height:40px;margin-top:24px;border-bottom:1px solid #e4e4e7"></div>
      <div data-probe="band" style="margin-top:8px;height:40px;border-top:1px solid #d4d4d8"></div>
      <div style="display:flex;height:80px;margin-top:24px">
        <div class="column-line" data-probe="column-line" style="width:200px"></div>
        <div data-probe="card" style="width:200px;border:1px solid #d4d4d8;border-radius:8px">A card on the column line</div>
      </div>`,
      ["near-double"],
    );
    expect(result.nearDouble).toEqual([
      'near-double: [data-probe="head"] bottom and [data-probe="section"] top lie 4 px apart over 1248 px',
      'near-double: [data-probe="row"] bottom and [data-probe="band"] top lie 8 px apart over 1248 px',
      'near-double: [data-probe="column"] right and [data-probe="inner-column"] left shadow lie 4 px apart over 80 px',
      'near-double: [data-probe="column-line"]::after and [data-probe="card"] left lie 0 px apart over 80 px',
    ]);
  });

  test("near-double: lines 9 px apart, lines side by side for less than half, touching lines, and frames pass", async () => {
    const result = await check(
      `<header style="height:40px;border-bottom:1px solid #e4e4e7">Head</header>
      <section style="margin-top:9px;border-top:1px solid #e4e4e7">Section 9 px below the head line</section>
      <div style="height:40px;margin-top:24px;border-bottom:1px solid #e4e4e7;width:200px"></div>
      <div style="margin:4px 0 0 120px;width:400px;border-top:1px solid #e4e4e7">Overlaps the line above by 80 of its 200 px</div>
      <div style="display:flex;gap:8px;margin-top:24px">
        <button style="border:1px solid #d4d4d8;border-radius:8px;height:36px">One</button>
        <button style="border:1px solid #d4d4d8;border-radius:8px;height:36px">Two</button>
      </div>
      <div style="height:40px;margin-top:24px;border-bottom:1px solid #e4e4e7"></div>
      <div style="margin-top:4px;height:40px;border:1px solid #d4d4d8;border-radius:8px">A card 4 px below a line: its edge is a frame</div>
      <div data-probe="a" style="height:40px;margin-top:24px;border-bottom:1px solid #e4e4e7"></div>
      <div data-probe="b" style="border-top:1px solid #e4e4e7">Touches the line above: a double line</div>`,
      ["near-double"],
    );
    expect(result.nearDouble).toEqual([]);
    // Two touching lines stay the old kind's finding.
    expect(result.double.map((line) => line.replace(/ at .*$/, ""))).toEqual([
      'double line: [data-probe="a"] bottom and [data-probe="b"] top',
    ]);
  });

  // A column boundary with a grip in the source between its two columns, as in K13: 5 x 32 px, on the line. The line
  // is the left column's border, or the separator's own pseudo-element (`own-line`), as a standalone separator draws it.
  const columns = ({ grip = "", separator = "own-line", left = "", after = "" }) => `
    <div style="display:flex;height:200px">
      <div data-probe="left" style="width:200px;${left}"></div>
      <div role="separator" tabindex="0" aria-orientation="vertical" aria-label="Width of the list" data-probe="sep" class="sep ${separator}">
        <span style="position:absolute;top:50%;left:50%;width:5px;height:32px;border-radius:999px;background:#8a8a94;transform:translate(-50%,-50%);${grip}"></span>
      </div>
      <div data-probe="right" style="flex:1">${after}</div>
    </div>`;
  const border = "border-right:1px solid #e4e4e7";

  test("grip-off-center: half a pixel beside its line, low on its line, under its line, under a column, or without a line", async () => {
    const result = await check(
      [
        // The flat sidebar's defect: the line is the column's last pixel, the grip is centred on the column's edge.
        columns({ separator: "", left: border }),
        columns({ grip: "transform:translate(-50%,calc(-50% + 40px))" }),
        columns({ separator: "own-line line-on-top" }),
        columns({
          after: '<div data-probe="cover" style="position:relative;z-index:1;margin-left:-8px;height:100%;background:#fff"></div>',
        }),
        columns({ separator: "" }),
      ].join(""),
      ["grip-off-center"],
    );
    expect(result.gripOffCenter).toEqual([
      'grip-off-center: the grip of "Width of the list" sits 0.5 px off the middle of [data-probe="left"] right',
      'grip-off-center: the grip of "Width of the list" sits 40 px off the middle of its 200 px line',
      'grip-off-center: the grip of "Width of the list" lies behind [data-probe="sep"]::before',
      'grip-off-center: the grip of "Width of the list" lies behind [data-probe="cover"]',
      'grip-off-center: the grip of "Width of the list" has no line under it',
    ]);
  });

  test("grip-off-center: a grip on the middle of its line and in front of it passes, also when it lets the pointer through", async () => {
    const result = await check(
      [
        columns({}),
        columns({ grip: "pointer-events:none" }),
        columns({ separator: "", left: border, grip: "transform:translate(calc(-50% - 0.5px),-50%)" }),
      ].join(""),
      ["grip-off-center"],
    );
    expect(result.gripOffCenter).toEqual([]);
  });

  test("type-role: sizes, line heights, and weights outside the roles are found in a flat area", async () => {
    const result = await check(
      `<section data-layout-area data-probe="area">
        <span data-probe="fifteen" style="display:block;font-size:15px;line-height:20px">Fifteen</span>
        <b data-probe="bold" style="display:block;font:700 13px/20px sans-serif">Seven hundred</b>
        <span data-probe="normal" style="display:block;font-size:13px;line-height:normal">Normal line height</span>
        <span data-probe="lead-light" style="display:block;font:400 18px/24px sans-serif">A lead in 400</span>
      </section>`,
      ["type-role"],
    );
    expect(result.typeRole.map((line) => line.replace(/ is .*$/, ""))).toEqual([
      'type-role: [data-probe="fifteen"] in [data-probe="area"]',
      'type-role: [data-probe="bold"] in [data-probe="area"]',
      'type-role: [data-probe="normal"] in [data-probe="area"]',
      'type-role: [data-probe="lead-light"] in [data-probe="area"]',
    ]);
    expect(result.typeRole[0]).toBe('type-role: [data-probe="fifteen"] in [data-probe="area"] is 15px/20px/400, no type role');
  });

  test("type-role: every role passes; text outside a flat area, initials, and reading text are left out", async () => {
    const result = await check(
      `<section data-layout-area>
        ${[
          ["12px/16px", 400],
          ["12px/20px", 600],
          ["13px/20px", 400],
          ["13px/20px", 500],
          ["14px/20px", 600],
          ["14px/22px", 400],
          ["18px/24px", 600],
          ["18px/20px", 600],
        ]
          .map(([size, weight]) => `<span style="display:block;font:${weight} ${size} sans-serif">Role ${size} ${weight}</span>`)
          .join("")}
        <span class="k2b-avatar" style="display:inline-block;font:600 10px/20px sans-serif">MS</span>
        <div contenteditable="true" style="font:600 16px/24px sans-serif">A heading in a note</div>
      </section>
      <p style="font-size:15px">Outside every flat area</p>`,
      ["type-role"],
    );
    expect(result.typeRole).toEqual([]);
  });

  test("type-role: an area without the token says so once", async () => {
    const result = await check(
      '<section data-layout-area data-probe="bare" style="--k2b-type-roles: initial"><span>One</span><span>Two</span></section>',
      ["type-role"],
    );
    expect(result.typeRole).toEqual(['type-role: [data-probe="bare"] has no type roles (--k2b-type-roles is not set)']);
  });
});
