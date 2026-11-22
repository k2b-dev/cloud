import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

// Cloud flach K2 (audit class 1): the flat scrollers draw an overlay thumb instead of a track. With classic scrollbars
// in Chromium and WebKit, the content keeps the scroller's whole width whether it overflows or not: rows reach the
// column edge, and nothing moves when the content starts to scroll. Before, `scrollbar-gutter: stable` cost every line
// 8 px in Chromium, and WebKit, where our styled scrollbar is not reserved, moved the content by 8 px.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "overlay-scrollbar.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { AppWorkspace, DetailPanel, ScrollArea } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const count = window.overlayRows === "many" ? 60 : 3;
const rows = (prefix) => Array.from({ length: count }, (_, i) => {
  const row = document.createElement("div");
  row.className = "row " + prefix;
  row.textContent = prefix + " " + (i + 1);
  return row;
});
render(() => createComponent(AppWorkspace, { resizable: false, get children() { return [
  createComponent(AppWorkspace.Sidebar, { id: "navigation", label: "Navigation", get children() {
    return createComponent(AppWorkspace.SidebarDesktop, { get children() {
      return createComponent(AppWorkspace.SidebarBody, { sidebarMode: "expanded", get children() { return rows("side"); } });
    } });
  } }),
  createComponent(AppWorkspace.Content, { get children() { return createComponent(AppWorkspace.Main, { get children() { return rows("main"); } }); } }),
]; } }), document.getElementById("workspace"));
render(() => createComponent(DetailPanel, { get children() {
  return createComponent(DetailPanel.Body, { get children() {
    return rows("detail").map((row) => { row.setAttribute("data-k2b-band", ""); return row; });
  } });
} }), document.getElementById("detail"));
render(() => createComponent(ScrollArea, { scrollbar: "overlay", get children() { return rows("area"); } }), document.getElementById("area"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the overlay scrollbar fixture");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  // Headless Chromium hides scrollbars by default; this file needs the classic ones a desktop draws.
  browser = await launchBrowser({ ignoreDefaultArgs: ["--hide-scrollbars"] });
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (rows: "few" | "many"): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  await page.setContent(
    `<!doctype html><html><head><style>${css}</style><style>` +
      ".row{height:40px;box-shadow:inset 0 -1px 0 #e4e4e7;line-height:20px;padding:10px 0}" +
      "#workspace{height:400px;display:flex}#detail{width:380px;height:300px;display:flex;flex-direction:column}#area .k2b-scroll-area{height:200px;width:400px}" +
      `</style></head><body class="k2b-ui" style="margin:0"><div id="workspace"></div><div id="detail"></div><div id="area"></div></body></html>`,
  );
  await page.addScriptTag({ content: `window.overlayRows = ${JSON.stringify(rows)};` });
  await page.addScriptTag({ content: script });
  await page.locator(".row.area").first().waitFor();
  await settled(page);
  return page;
};

const scrollers = {
  sidebar: ".k2b-app-workspace__sidebar-body",
  main: ".k2b-app-workspace__main",
  detail: ".k2b-detail-panel__body",
  area: "#area .k2b-scroll-area",
} as const;
const rowOf = { sidebar: ".row.side", main: ".row.main", detail: ".row.detail", area: ".row.area" } as const;
/** Where a row ends before the scroller's inner edge: the sidebar's rows are inset items, 8 px from both edges. */
const rowGap = { sidebar: 8, main: 0, detail: 0, area: 0 } as const;

/** For each scroller: whether it overflows, its width without a track, and where its first row ends. */
const measure = (page: Page) =>
  page.evaluate(
    ({ scrollers, rowOf }) =>
      Object.fromEntries(
        Object.entries(scrollers).map(([name, selector]) => {
          const scroller = document.querySelector(selector) as HTMLElement;
          const row = document.querySelector(rowOf[name as keyof typeof rowOf]) as HTMLElement;
          const box = scroller.getBoundingClientRect();
          const style = getComputedStyle(scroller);
          const inner = box.right - Number.parseFloat(style.borderRightWidth) - Number.parseFloat(style.paddingRight);
          return [
            name,
            {
              overflows: scroller.scrollHeight > scroller.clientHeight + 1,
              track:
                scroller.offsetWidth -
                scroller.clientWidth -
                Number.parseFloat(style.borderLeftWidth) -
                Number.parseFloat(style.borderRightWidth),
              sideways: scroller.scrollWidth > scroller.clientWidth,
              rowRight: row.getBoundingClientRect().right,
              rowGap: Math.round((inner - row.getBoundingClientRect().right) * 100) / 100,
              thumb: scroller.querySelector(":scope > .k2b-overlay-scrollbar")?.getAttribute("data-overflow") === "true",
            },
          ];
        }),
      ),
    { scrollers, rowOf },
  );

describe("overlay scrollbar of the flat scrollers", () => {
  test("content keeps the whole width with and without overflow, and nothing moves when it starts to scroll", async () => {
    const few = await load("few");
    const many = await load("many");
    try {
      const before = await measure(few);
      const after = await measure(many);
      for (const name of Object.keys(scrollers) as (keyof typeof scrollers)[]) {
        expect({ name, overflows: before[name]!.overflows }).toEqual({ name, overflows: false });
        expect({ name, overflows: after[name]!.overflows }).toEqual({ name, overflows: true });
        // No track takes room, so a row reaches the scroller's inner edge in both states and stays where it was.
        expect({ name, track: after[name]!.track, sideways: after[name]!.sideways }).toEqual({ name, track: 0, sideways: false });
        expect({ name, gap: before[name]!.rowGap }).toEqual({ name, gap: rowGap[name] });
        expect({ name, gap: after[name]!.rowGap }).toEqual({ name, gap: rowGap[name] });
        expect({ name, right: after[name]!.rowRight }).toEqual({ name, right: before[name]!.rowRight });
        // The thumb is there only when there is something to scroll.
        expect({ name, thumbs: [before[name]!.thumb, after[name]!.thumb] }).toEqual({ name, thumbs: [false, true] });
      }
    } finally {
      await few.close();
      await many.close();
    }
  });

  test("dragging the thumb scrolls its column", async () => {
    const page = await load("many");
    try {
      const detail = page.locator(scrollers.detail);
      await detail.hover();
      await settled(page);
      const thumb = page.locator(`${scrollers.detail} > .k2b-overlay-scrollbar > .k2b-overlay-scrollbar__thumb`);
      const box = (await thumb.boundingBox())!;
      const scroller = (await detail.boundingBox())!;
      // The thumb stands at the top of the column and at its end edge.
      expect(Math.round(box.y)).toBe(Math.round(scroller.y));
      expect(Math.round(box.x + box.width)).toBe(Math.round(scroller.x + scroller.width));
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 60, { steps: 4 });
      await page.mouse.up();
      expect(await detail.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  });
});
