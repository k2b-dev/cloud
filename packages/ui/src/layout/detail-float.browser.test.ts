import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { browserName, launchBrowser } from "../../test/browser";

const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "detail-float.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { AppWorkspace, DetailPanel, DataTable, PageTrailProvider } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const params = new URLSearchParams(document.body.dataset.params);
const [open, setOpen] = createSignal(params.has("initial"));
let selected = 0;
const close = () => { document.body.dataset.closes = String(Number(document.body.dataset.closes || 0) + 1); setOpen(false); };
const button = (index) => {
  const element = document.createElement("button");
  element.id = "row-" + index;
  element.textContent = "Row " + index;
  // Cards carry their own width, as a board's columns do: WebKit sizes a max-content row from its items' widths, not their flex bases.
  element.style.cssText = params.has("trail") ? "flex:none;width:260px;height:160px" : "display:block;width:100%;height:42px;text-align:left";
  element.addEventListener("click", () => { selected = index; setOpen(true); });
  return element;
};
const mainContent = () => {
  const toolbar = document.createElement("div");
  toolbar.id = "toolbar";
  toolbar.textContent = "Fixed toolbar";
  toolbar.style.cssText = "height:40px;flex-shrink:0";
  if (params.has("table")) {
    return [toolbar, createComponent(DataTable, {
      class:"fixture-table", surface:"paper", fillHeight:true, scrollClass:"k2b-detail-trail",
      rows:Array.from({length:2}, (_, index) => ({index, date:new Date("2026-11-14T12:00:00Z"), amount:"12400,00 EUR"})),
      onRowClick:() => setOpen(true),
      columns:params.has("values") ? [
        {id:"0",header:"Record",value:"index"},
        {id:"date",header:"Date",value:"date",class:"fixture-date"},
        {id:"amount",header:"Amount",value:"amount",nowrap:true},
        ...Array.from({length:5}, (_, index) => ({id:String(index + 3),header:"Description " + index,value:() => "Free text that can wrap"})),
      ] : Array.from({length:8}, (_, index) => ({id:String(index), header:"Field " + index, value:row => "Cell " + row.index + "." + index})),
      // The default wrapper truncates every value; a plain wrapper shows what the column's nowrap decides.
      cellContentClass:params.has("values") ? "fixture-cell" : undefined,
      renderCell:({row,col,value}) => col.id === "0" ? button(row.index) : col.id === "date" ? row.date.toISOString().slice(0,10) : value,
    })];
  }
  if (!params.has("trail")) return [toolbar, ...Array.from({length:40}, (_, index) => button(index))];
  const trail = document.createElement("div");
  trail.id = "board";
  trail.className = "k2b-detail-trail fixture-board";
  trail.style.cssText = "min-height:0;flex:1;overflow:auto";
  const cards = document.createElement("div");
  cards.style.cssText = "display:flex;width:max-content;gap:16px";
  cards.append(...Array.from({length:8}, (_, index) => button(index)));
  trail.append(cards);
  return [toolbar, trail];
};
// A documentation-style frame that contains layout, inside a longer page.
if (params.has("frame")) document.getElementById("app").style.cssText = "height:480px;margin-top:100px;contain:layout";
render(() => createComponent(PageTrailProvider, { trail:{title:"Devices",ancestors:[{title:"Inventory",href:"/inventory"}]}, get children() { return createComponent(AppWorkspace, {
  layoutState: () => ({version:2, sidebarWidth: Number(params.get("sidebar")) || 208, detailWidths: params.has("persisted") ? {record:Number(params.get("persisted"))} : undefined}),
  get children() { return [
    createComponent(AppWorkspace.Sidebar, { id:"navigation", maxSize:960, get children() { return createComponent(AppWorkspace.SidebarDesktop, {get children() {return createComponent(AppWorkspace.SidebarItem, {href:"/devices", active:true, children:"Devices"});}}); } }),
    createComponent(AppWorkspace.Content, { get children() { return [
      createComponent(AppWorkspace.Main, { class:"fixture-main", scroll:!params.has("trail") && !params.has("table"), get children() { return mainContent(); } }),
      createComponent(AppWorkspace.Detail, {
        id:"record", phone:params.has("phone-page") ? "page" : "sheet", width:params.get("width") || "md", get open() { return open(); }, onClose:params.has("fixed") ? undefined : close, onStep:direction => {
          document.body.dataset.steps = String(Number(document.body.dataset.steps || 0) + direction);
          const count = document.querySelectorAll('[id^="row-"]').length;
          selected = Math.max(0, Math.min(count - 1, selected + direction));
          return document.getElementById("row-" + selected);
        },
        get children() { return createComponent(DetailPanel, { get children() { return [
          createComponent(DetailPanel.Header, { title:"Selected record", get actions() { const element = document.createElement("button"); element.id="close"; element.textContent="Close"; element.addEventListener("click", close); return element; } }),
          createComponent(DetailPanel.Body, { get children() { const text = document.createElement("p"); text.id="detail-text"; text.textContent="Text in the selected record"; return text; } }),
        ]; } }); },
      }),
    ]; } }),
    createComponent(AppWorkspace.BottomDrawer, { id:"events", get open() { return params.has("drawer"); }, height:"sm", children:"Recent events" }),
  ]; },
}); } }), document.getElementById("app"));
const workspace = document.querySelector("[data-k2b-app-workspace]");
const aside = document.querySelector(".k2b-app-workspace__detail");
document.body.dataset.initialMotion = String(workspace.hasAttribute("data-workspace-motion"));
document.body.dataset.initialTransition = getComputedStyle(aside).transitionDuration;
document.body.dataset.initialWidth = String(aside.getBoundingClientRect().width);
requestAnimationFrame(() => {
  document.body.dataset.firstMotion = String(workspace.hasAttribute("data-workspace-motion"));
  requestAnimationFrame(() => { document.body.dataset.secondMotion = String(workspace.hasAttribute("data-workspace-motion")); });
});
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the floating detail fixture.");
const script = await build.outputs[0]!.text();
// Each test opens its own page and waits on real frames; like the other browser suites, a test gets 30 s.
setDefaultTimeout(30_000);
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});
// Geometry and interaction tests run without motion: each transition costs frames, and a loaded host makes
// frames slow. The motion test asks for motion itself.
const load = async (width: number, height: number, params = "", options: BrowserContextOptions = {}) => {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce", ...options });
  await page.setContent(
    // Flush by default, as Cloud's shell is up to 1535 px; `card` frames the workspace as Cloud does from 1536 px.
    `<!doctype html><html lang="en"><head><style>${css}</style><style>${
      new URLSearchParams(params).has("card")
        ? "#app{box-sizing:border-box;padding:0.5rem}"
        : ".k2b-ui .k2b-app-workspace{border:0;--k2b-workspace-radius:0px}"
    }.fixture-main{padding:var(--k2b-workspace-detail-inset)}.fixture-date{width:1px}${
      new URLSearchParams(params).has("wide") ? ".fixture-table td,.fixture-table th{min-width:240px}" : ""
    }</style></head><body class="k2b-ui" style="margin:0"><div id="app" style="height:100vh"></div></body></html>`,
  );
  await page.evaluate((params) => {
    document.body.dataset.params = params;
  }, params);
  await page.addScriptTag({ content: script });
  await page.locator("#row-0").waitFor();
  await page.bringToFront();
  return page;
};
const geometry = (page: Page) =>
  page.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector)!;
      const rect = element.getBoundingClientRect();
      return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height };
    };
    const main = document.querySelector<HTMLElement>(".k2b-app-workspace__main")!;
    const aside = document.querySelector<HTMLElement>(".k2b-app-workspace__detail")!;
    const board = document.querySelector<HTMLElement>("#board");
    return {
      root: box(".k2b-app-workspace"),
      // The inset is measured inside the workspace's border, which a framed workspace has.
      border: document.querySelector<HTMLElement>(".k2b-app-workspace")!.clientTop,
      content: box(".k2b-app-workspace__content"),
      main: box(".k2b-app-workspace__main"),
      detail: box(".k2b-app-workspace__detail"),
      maxHeight: getComputedStyle(main).maxHeight,
      full: aside.dataset.workspaceDetailSheet ?? null,
      pressed: aside.querySelector("button")?.getAttribute("aria-pressed"),
      board: board
        ? {
            width: board.clientWidth,
            scrollWidth: board.scrollWidth,
            left: board.scrollLeft,
          }
        : null,
      toolbarPadding: Number.parseFloat(getComputedStyle(document.getElementById("toolbar")!).paddingInlineEnd),
    };
  });
const settlePanel = (page: Page) =>
  page.waitForFunction(() => document.querySelector(".k2b-app-workspace__detail")!.getAnimations().length === 0);
const openRow = async (page: Page, id = "row-0") => {
  await page.locator(`#${id}`).click();
  await settlePanel(page);
};
const expectInset = (shape: Awaited<ReturnType<typeof geometry>>) => {
  expect(shape.detail.top - shape.root.top - shape.border).toBeCloseTo(8, 1);
  expect(shape.root.right - shape.border - shape.detail.right).toBeCloseTo(8, 1);
  expect(shape.root.bottom - shape.border - shape.detail.bottom).toBeCloseTo(8, 1);
};

describe("floating workspace detail", () => {
  for (const [width, height] of [
    [1366, 900],
    [1920, 1080],
  ]) {
    for (const [params, wanted] of [
      ["", 416],
      ["persisted=520", 520],
      ["width=sm", 320],
      ["width=lg", 480],
      ["width=xl", 544],
    ] as const) {
      test(`${width}×${height}: floats at the preset or persisted width (${params || "md"})`, async () => {
        const page = await load(width!, height!, params);
        try {
          await openRow(page);
          const shape = await geometry(page);
          expectInset(shape);
          expect(shape.detail.width).toBeCloseTo(wanted, 1);
          expect(shape.detail.left - shape.main.right).toBeCloseTo(0, 1);
          expect(shape.main.width).toBeGreaterThanOrEqual(320);
        } finally {
          await page.close();
        }
      });
    }
  }
  for (const [width, height] of [
    [1366, 900],
    [1920, 1080],
  ] as const) {
    for (const frame of ["", "&card=1"]) {
      for (const surface of ["trail", "table"]) {
        test(`${width}×${height} ${surface}${frame}: the scroll viewport rounds the cut edge one inset before Detail`, async () => {
          const page = await load(width, height, `${surface}=1&initial=1${frame}`);
          try {
            await settlePanel(page);
            const shape = await page.locator(".k2b-detail-trail").evaluate((viewport) => {
              const token = (name: string) => {
                const probe = document.createElement("div");
                probe.style.width = `var(${name})`;
                viewport.append(probe);
                const pixels = probe.getBoundingClientRect().width;
                probe.remove();
                return pixels;
              };
              const inset = token("--k2b-workspace-detail-inset");
              const radius = token("--k2b-radius-surface");
              viewport.scrollLeft = 130;
              const rect = viewport.getBoundingClientRect();
              // A table's viewport sits inside its Paper frame's border; the frame is the surface's outer edge.
              const paper = viewport.closest(".k2b-paper");
              const frame = (paper ?? viewport).getBoundingClientRect();
              // Inside a Paper the viewport's corner follows the frame's inner curve, one border smaller.
              const border = paper ? Number.parseFloat(getComputedStyle(paper).borderRightWidth) : 0;
              const style = getComputedStyle(viewport);
              const candidates = viewport.querySelectorAll("tbody tr:first-child td, #board button");
              const cut = [...candidates].find((cell) => {
                const box = cell.getBoundingClientRect();
                return box.left < rect.right && box.right > rect.right;
              });
              return {
                inset,
                radius: radius - border,
                right: rect.right,
                frameRight: frame.right,
                panelLeft: document.querySelector(".k2b-app-workspace__detail")!.getBoundingClientRect().left,
                radii: [
                  style.borderTopLeftRadius,
                  style.borderTopRightRadius,
                  style.borderBottomLeftRadius,
                  style.borderBottomRightRadius,
                ].map(Number.parseFloat),
                cutRight: cut?.getBoundingClientRect().right ?? 0,
                scrollWidth: viewport.scrollWidth,
                clientWidth: viewport.clientWidth,
                overflow: style.overflowX,
              };
            });
            expect(shape.scrollWidth).toBeGreaterThan(shape.clientWidth);
            expect(shape.overflow).toBe("auto");
            expect(shape.frameRight).toBeCloseTo(shape.panelLeft - shape.inset, 1);
            for (const radius of shape.radii) expect(radius).toBeCloseTo(shape.radius, 1);
            expect(shape.cutRight).toBeGreaterThan(shape.right);
          } finally {
            await page.close();
          }
        });
      }
    }
  }

  test("a narrow date column and amount keep their whole value on one line beside Detail", async () => {
    const page = await load(1366, 900, "table=1&values=1&initial=1");
    try {
      await settlePanel(page);
      for (const column of [2, 3]) {
        const value = await page.locator(`tbody tr:first-child td:nth-child(${column})`).evaluate((cell) => {
          const content = cell.querySelector<HTMLElement>(".fixture-cell")!;
          const text = content.firstChild!;
          const range = document.createRange();
          range.selectNodeContents(text);
          const bounds = range.getBoundingClientRect();
          const box = content.getBoundingClientRect();
          return {
            lines: range.getClientRects().length,
            left: bounds.left,
            right: bounds.right,
            contentLeft: box.left,
            contentRight: box.right,
            scroll: content.scrollWidth,
            client: content.clientWidth,
          };
        });
        expect(value.lines).toBe(1);
        expect(value.scroll).toBeLessThanOrEqual(value.client);
        expect(value.left).toBeGreaterThanOrEqual(value.contentLeft - 0.5);
        expect(value.right).toBeLessThanOrEqual(value.contentRight + 0.5);
      }
    } finally {
      await page.close();
    }
  });

  test("fits a preferred width while keeping Main at 320 px", async () => {
    const page = await load(1024, 900, "sidebar=208&persisted=640");
    try {
      await openRow(page);
      const shape = await geometry(page);
      expectInset(shape);
      expect(shape.main.width).toBeCloseTo(320, 1);
      expect(shape.detail.width).toBeCloseTo(shape.root.width - 208 - 328, 1);
      expect(shape.detail.left - shape.main.right).toBeCloseTo(0, 1);
    } finally {
      await page.close();
    }
  });
  test("a narrow content area keeps Main and Detail at their minimum, overlapping", async () => {
    const page = await load(1024, 900, "sidebar=500&persisted=640");
    try {
      await openRow(page);
      const shape = await geometry(page);
      expectInset(shape);
      expect(shape.main.width).toBeCloseTo(320, 1);
      expect(shape.detail.width).toBeCloseTo(320, 1);
      expect(shape.detail.left).toBeLessThan(shape.main.right);
    } finally {
      await page.close();
    }
  });
  test("a board reveals its card beside the panel without extra scroll content", async () => {
    const page = await load(1366, 900, "trail=1");
    try {
      const before = await geometry(page);
      await page.locator("#board").evaluate((element) => {
        element.scrollLeft = 600;
      });
      await openRow(page, "row-5");
      await page.waitForFunction(
        () =>
          document.getElementById("row-5")!.getBoundingClientRect().right <=
          document.querySelector(".k2b-app-workspace__detail")!.getBoundingClientRect().left,
      );
      const opened = await geometry(page);
      expect(opened.board!.scrollWidth).toBe(before.board!.scrollWidth);
      expect(opened.main.right).toBeCloseTo(opened.detail.left, 1);
      await page.locator("#close").click();
      await settlePanel(page);
      expect((await geometry(page)).board!.scrollWidth).toBe(before.board!.scrollWidth);
    } finally {
      await page.close();
    }
  });
  for (const [width, height, params] of [
    [1180, 820, "table=1"],
    [1366, 900, "table=1"],
    [1920, 1080, "table=1&card=1"],
    [2560, 1440, "table=1&card=1"],
  ] as const) {
    test(`${width}×${height}: full-height detail, rounded table, unclipped shadow and stable columns`, async () => {
      const page = await load(width, height, params);
      try {
        const table = () =>
          page.locator(".fixture-table").evaluate((shell) => {
            const wrap = shell.querySelector<HTMLElement>(".k2b-table-wrap")!;
            const table = wrap.querySelector("table")!;
            const style = getComputedStyle(shell);
            return {
              right: shell.getBoundingClientRect().right,
              width: table.getBoundingClientRect().width,
              columns: [...table.querySelectorAll("th")].map((cell) => cell.getBoundingClientRect().width),
              client: wrap.clientWidth,
              scroll: wrap.scrollWidth,
              radii: [style.borderTopRightRadius, style.borderBottomRightRadius].map(Number.parseFloat),
            };
          });
        const before = await table();
        await openRow(page);
        const shape = await geometry(page);
        expectInset(shape);
        const head = await page.locator(".k2b-app-workspace__head").boundingBox();
        expect(head!.height).toBeLessThanOrEqual(1);
        expect(head!.width).toBeLessThanOrEqual(1);
        expect(shape.main.top).toBeCloseTo(shape.root.top + shape.border, 1);
        const opened = await table();
        expect(opened.right).toBeCloseTo(shape.detail.left - 8, 1);
        for (const radius of opened.radii) expect(radius).toBeGreaterThan(0);
        expect(opened.width).toBeCloseTo(before.width, 0);
        opened.columns.forEach((column, index) => expect(column).toBeCloseTo(before.columns[index]!, 0));
        expect(opened.scroll).toBeGreaterThan(opened.client);
        const clipping = await page.locator(".k2b-app-workspace__detail").evaluate((panel) => {
          if (!(panel instanceof HTMLElement)) throw new Error("Expected an HTML detail panel.");
          const rect = panel.getBoundingClientRect();
          const failures: string[] = [];
          // Only the containing block and its ancestors can clip an absolutely positioned panel.
          if (!panel.offsetParent?.matches(".k2b-app-workspace")) failures.push("the workspace is not the containing block");
          for (let ancestor = panel.offsetParent; ancestor; ancestor = ancestor.parentElement) {
            const style = getComputedStyle(ancestor),
              box = ancestor.getBoundingClientRect();
            const viewport =
              Math.abs(box.left) <= 1 &&
              Math.abs(box.top) <= 1 &&
              Math.abs(box.width - innerWidth) <= 1 &&
              Math.abs(box.height - innerHeight) <= 1;
            if (style.clipPath !== "none" || /\bpaint\b/.test(style.contain)) failures.push(ancestor.className + ": clip/paint");
            if (
              !viewport &&
              (style.overflowX !== "visible" || style.overflowY !== "visible") &&
              (box.left > rect.left - 64 || box.top > rect.top - 64 || box.right < rect.right + 64 || box.bottom < rect.bottom + 64)
            )
              failures.push(ancestor.className + ": overflow");
          }
          return failures;
        });
        expect(clipping).toEqual([]);
        await page.locator("#close").click();
        const closed = await table();
        expect(closed.right).toBeCloseTo(shape.root.right - shape.border - 8, 1);
        expect(closed.width).toBeCloseTo(closed.client, 0);
        expect(
          await page
            .locator(".k2b-app-workspace")
            .evaluate((root) =>
              [root, ...root.querySelectorAll<HTMLElement>("*")].some(
                (element) => getComputedStyle(element).getPropertyValue("--k2b-detail-trail-hold") !== "",
              ),
            ),
        ).toBe(false);
        expect(css).not.toContain("--k2b-detail-trail-hold");
      } finally {
        await page.close();
      }
    });
  }
  for (const [width, height, params] of [
    [1366, 900, "table=1&wide=1"],
    [1920, 1080, "table=1&wide=1&card=1"],
  ] as const) {
    test(`${width}×${height}: reveals the last visible table cell beside the detail panel`, async () => {
      const page = await load(width, height, params);
      try {
        const column = await page.locator(".k2b-table-wrap").evaluate((wrap) => {
          const bounds = wrap.getBoundingClientRect();
          const cells = [...wrap.querySelectorAll("tbody tr:first-child td")];
          return cells.findLastIndex((cell) => {
            const rect = cell.getBoundingClientRect();
            return rect.left >= bounds.left && rect.right <= bounds.right;
          });
        });
        expect(column).toBeGreaterThan(0);
        const selector = `.k2b-table-wrap tbody tr:first-child td:nth-child(${column + 1})`;
        await page.locator(selector).click();
        await settlePanel(page);
        await page.waitForFunction((selector) => {
          const cell = document.querySelector(selector)!.getBoundingClientRect();
          const wrap = document.querySelector(".k2b-table-wrap")!.getBoundingClientRect();
          return cell.left >= wrap.left - 0.5 && cell.right <= wrap.right + 0.5;
        }, selector);
        const shape = await page.locator(selector).evaluate((cell) => {
          const rect = cell.getBoundingClientRect();
          const wrap = cell.closest(".k2b-table-wrap")!.getBoundingClientRect();
          const detail = document.querySelector(".k2b-app-workspace__detail")!.getBoundingClientRect();
          return { left: rect.left, right: rect.right, wrapLeft: wrap.left, wrapRight: wrap.right, detailLeft: detail.left };
        });
        expect(shape.left).toBeGreaterThanOrEqual(shape.wrapLeft - 0.5);
        expect(shape.right).toBeLessThanOrEqual(shape.wrapRight + 0.5);
        expect(shape.right).toBeLessThanOrEqual(shape.detailLeft);
      } finally {
        await page.close();
      }
    });
  }
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    test(`${reducedMotion}: opening reserves the track first; closing releases it after the slide`, async () => {
      const page = await load(1366, 900, "table=1", { reducedMotion });
      try {
        await page.waitForSelector("[data-workspace-motion]");
        const sample = (action: "open" | "close") =>
          page.evaluate(
            (action) =>
              new Promise<{ time: number; width: number; x: number; display: string; translate: number }[]>((resolve) => {
                const panel = document.querySelector<HTMLElement>(".k2b-app-workspace__detail")!;
                const wrap = document.querySelector<HTMLElement>(".k2b-table-wrap")!;
                const samples: { time: number; width: number; x: number; display: string; translate: number }[] = [];
                let start: number;
                const frame = () => {
                  const width = wrap.clientWidth;
                  const x = panel.getBoundingClientRect().x;
                  const style = getComputedStyle(panel);
                  samples.push({
                    time: performance.now() - start,
                    width,
                    x,
                    display: style.display,
                    translate: style.transform === "none" ? 0 : new DOMMatrix(style.transform).m41,
                  });
                  // An ease-out slide comes close to its end long before it reaches it; the open sample stops only there.
                  if ((action === "close" && style.display === "none") || (action === "open" && samples.at(-1)!.translate === 0))
                    resolve(samples);
                  else if (performance.now() - start > 300) resolve(samples);
                  else requestAnimationFrame(frame);
                };
                requestAnimationFrame(() => {
                  // Start the action in a rendering frame so the sample measures
                  // the transition rather than waiting for the browser to wake up.
                  getComputedStyle(panel).transform;
                  start = performance.now();
                  document.getElementById(action === "open" ? "row-0" : "close")!.click();
                  frame();
                });
              }),
            action,
          );
        const wide = await page.locator(".k2b-table-wrap").evaluate((wrap) => wrap.clientWidth);
        const opening = await sample("open");
        const narrow = opening[0]!.width;
        expect(narrow).toBeLessThan(wide);
        if (reducedMotion === "no-preference") expect(opening[0]!.translate).toBeGreaterThan(0);
        else {
          expect(opening).toHaveLength(1);
          expect(opening[0]!.translate).toBe(0);
        }
        expect(opening.at(-1)!.translate).toBeCloseTo(0, 1);
        await settlePanel(page);
        const closing = await sample("close");
        let previousX = closing[0]!.x;
        for (const frame of closing) {
          if (frame.display !== "none") {
            expect(frame.width).toBe(narrow);
            expect(frame.x).toBeGreaterThanOrEqual(previousX - 0.5);
            previousX = frame.x;
          }
          if (frame.width > narrow) expect(frame.display).toBe("none");
        }
        expect(closing.at(-1)!.display).toBe("none");
        expect(closing.at(-1)!.width).toBe(wide);
        expect(closing.at(-1)!.time).toBeLessThanOrEqual(300);
        if (reducedMotion === "reduce") expect(closing).toHaveLength(1);
      } finally {
        await page.close();
      }
    });
  }
  test("1920×1080 framed: the workspace clips its end edge only while the panel slides", async () => {
    const page = await load(1920, 1080, "table=1&card=1", { reducedMotion: "no-preference" });
    try {
      await page.waitForSelector("[data-workspace-motion]");
      const clipAfter = (id: string) =>
        page.evaluate(async (id) => {
          const root = document.querySelector<HTMLElement>(".k2b-app-workspace")!;
          document.getElementById(id)!.click();
          // The controller marks the slide as soon as the panel's visibility changes, before any frame.
          await Promise.resolve();
          return getComputedStyle(root).clipPath;
        }, id);
      const rest = () =>
        page.locator(".k2b-app-workspace").evaluate((root) => ({
          sliding: root.hasAttribute("data-workspace-detail-sliding"),
          clip: getComputedStyle(root).clipPath,
        }));
      expect(await clipAfter("row-0")).toContain("inset");
      await settlePanel(page);
      await page.waitForFunction(() => !document.querySelector("[data-workspace-detail-sliding]"));
      expect(await rest()).toEqual({ sliding: false, clip: "none" });
      expect(await clipAfter("close")).toContain("inset");
      await page.waitForFunction(() => getComputedStyle(document.querySelector(".k2b-app-workspace__detail")!).display === "none");
      await page.waitForFunction(() => !document.querySelector("[data-workspace-detail-sliding]"));
      expect(await rest()).toEqual({ sliding: false, clip: "none" });
    } finally {
      await page.close();
    }
  });
  for (const fixed of [false, true]) {
    test(`820×1180 touch tablet ${fixed ? "reflows a permanent panel" : "overlays a closable drawer"}`, async () => {
      const page = await load(820, 1180, fixed ? "fixed=1" : "", { hasTouch: true });
      try {
        await openRow(page);
        const shape = await geometry(page);
        expectInset(shape);
        expect(shape.main.width).toBeCloseTo(fixed ? shape.root.width - shape.detail.width - 8 : shape.content.width, 1);
      } finally {
        await page.close();
      }
    });
  }
  for (const params of ["trail=1", "table=1&wide=1"]) {
    test(`820×1180 touch tablet: the last ${params.startsWith("trail") ? "card" : "column"} scrolls out from under the drawer`, async () => {
      const page = await load(820, 1180, params, { hasTouch: true });
      try {
        await openRow(page);
        const scroller = params.startsWith("trail") ? "#board" : ".k2b-table-wrap";
        const shape = await page.locator(scroller).evaluate((element, board) => {
          element.scrollLeft = element.scrollWidth;
          const last = board ? document.getElementById("row-7")! : [...element.querySelectorAll("thead th")].at(-1)!;
          return {
            last: last.getBoundingClientRect().right,
            drawer: document.querySelector(".k2b-app-workspace__detail")!.getBoundingClientRect().left,
            scroller: element.getBoundingClientRect().right,
          };
        }, params.startsWith("trail"));
        // The drawer overlays the scroller, and the scroller's end space brings its last column beside it.
        expect(shape.drawer).toBeLessThan(shape.scroller);
        expect(shape.last).toBeLessThanOrEqual(shape.drawer);
      } finally {
        await page.close();
      }
    });
  }
  test("390×844: a phone page fills the viewport without sheet space or gestures and Escape closes it", async () => {
    const page = await load(390, 844, "phone-page=1", { hasTouch: true });
    try {
      const mainState = () =>
        page.locator(".k2b-app-workspace__main").evaluate((main) => ({
          height: main.clientHeight,
          scrollHeight: main.scrollHeight,
          scrollTop: main.scrollTop,
          padding: getComputedStyle(main).scrollPaddingBottom,
          after: getComputedStyle(main, "::after").content,
        }));
      await page.locator("#row-30").scrollIntoViewIfNeeded();
      const before = await mainState();
      await page.locator("#row-30").click();
      await settlePanel(page);
      const shape = await geometry(page);
      expect(shape.detail).toMatchObject({ top: 0, left: 0, width: 390, height: 844, bottom: 844 });
      expect(shape.full).toBeNull();
      expect(await page.locator(".k2b-app-workspace__detail-grabber").isVisible()).toBe(false);
      expect(await mainState()).toEqual(before);
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Selected record");
      const header = page.locator(".k2b-detail-panel__header");
      expect(await header.evaluate((element) => getComputedStyle(element).touchAction)).not.toBe("none");
      const box = await header.boundingBox();
      const x = box!.x + 30,
        y = box!.y + box!.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y + 140, { steps: 8 });
      expect((await geometry(page)).detail).toEqual(shape.detail);
      await page.mouse.up();
      await settlePanel(page);
      expect((await geometry(page)).detail).toEqual(shape.detail);
      expect(await page.locator("body").getAttribute("data-closes")).toBeNull();
      if (browserName !== "webkit") {
        for (const type of ["touchstart", "touchmove", "touchend"]) {
          await header.evaluate((element, type) => {
            const sample = new Touch({ identifier: 1, target: element, clientX: 100, clientY: type === "touchstart" ? 20 : 180 });
            element.dispatchEvent(
              new TouchEvent(type, {
                bubbles: true,
                cancelable: true,
                touches: type === "touchend" ? [] : [sample],
                changedTouches: [sample],
              }),
            );
          }, type);
        }
        await settlePanel(page);
        expect((await geometry(page)).detail).toEqual(shape.detail);
        expect(await page.locator("body").getAttribute("data-closes")).toBeNull();
      }
      await page.keyboard.press("Escape");
      await settlePanel(page);
      expect(await page.locator("body").getAttribute("data-closes")).toBe("1");
      expect(await page.locator(".k2b-app-workspace__detail").isVisible()).toBe(false);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("row-30");
    } finally {
      await page.close();
    }
  });
  test("1440px: phone page detail keeps the normal floating desktop geometry", async () => {
    const sheet = await load(1440, 900);
    const page = await load(1440, 900, "phone-page=1");
    try {
      await openRow(sheet);
      await openRow(page);
      expect((await geometry(page)).detail).toEqual((await geometry(sheet)).detail);
      expect((await geometry(page)).main).toEqual((await geometry(sheet)).main);
      expect((await geometry(page)).detail.top).toBe(8);
      expect(await page.locator(".k2b-app-workspace__detail-grabber").isVisible()).toBe(false);
      await page.keyboard.press("Escape");
      await settlePanel(page);
      expect(await page.locator("body").getAttribute("data-closes")).toBe("1");
    } finally {
      await sheet.close();
      await page.close();
    }
  });
  test("390×844: the half sheet sits on the window's bottom edge, Main's last row scrolls above it, and the grabber toggles detents", async () => {
    const page = await load(390, 844);
    try {
      await openRow(page, "row-30");
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Selected record");
      const half = await geometry(page);
      expect(half.detail.bottom).toBeCloseTo(844, 1);
      expect(half.detail.height).toBeCloseTo(844 * 0.55, 1);
      expect(half).toMatchObject({ full: null, pressed: "false" });
      // Opening reveals the tapped row above the sheet.
      await page.waitForFunction(
        () =>
          document.getElementById("row-30")!.getBoundingClientRect().bottom <=
          document.querySelector(".k2b-app-workspace__detail")!.getBoundingClientRect().top,
      );
      const last = await page.evaluate(() => {
        const main = document.querySelector(".k2b-app-workspace__main")!;
        main.scrollTop = main.scrollHeight;
        return document.getElementById("row-39")!.getBoundingClientRect().bottom;
      });
      expect(last).toBeLessThanOrEqual(half.detail.top);
      const grabber = page.locator(".k2b-app-workspace__detail-grabber");
      await grabber.click();
      await settlePanel(page);
      const full = await geometry(page);
      // At full height Main keeps its size under the sheet.
      expect(full).toMatchObject({ full: "full", pressed: "true" });
      expect(full.main.height).toBeCloseTo(half.main.height, 1);
      expect(full.detail.height).toBeCloseTo(844 - 8, 1);
      await grabber.click();
      await settlePanel(page);
      expect((await geometry(page)).detail.height).toBeCloseTo(844 * 0.55, 1);
      const box = await grabber.boundingBox();
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.mouse.down();
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2 + 100, { steps: 8 });
      expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
      await page.mouse.up();
      await settlePanel(page);
      expect(await page.locator("body").getAttribute("data-closes")).toBe("1");
      expect(await page.locator(".k2b-app-workspace__detail").getAttribute("hidden")).not.toBeNull();
    } finally {
      await page.close();
    }
  });
  test("390×844: a frame that contains layout keeps the sheet inside itself", async () => {
    const page = await load(390, 844, "frame=1&initial=1");
    try {
      const frame = await page.locator("#app").evaluate((element) => element.getBoundingClientRect().toJSON() as DOMRect);
      const sheet = (await geometry(page)).detail;
      expect(sheet.bottom).toBeCloseTo(frame.bottom, 1);
      expect(sheet.height).toBeCloseTo(480 * 0.55, 1);
      await page.locator(".k2b-app-workspace__detail-grabber").click();
      await settlePanel(page);
      expect((await geometry(page)).detail.height).toBeCloseTo(480 - 8, 1);
    } finally {
      await page.close();
    }
  });
  test("390×844: Main above an open bottom drawer in a small frame keeps its reserved height beside the sheet", async () => {
    const page = await load(390, 844, "frame=1&trail=1&drawer=1&initial=1");
    try {
      const board = await page.locator("#board").evaluate((element) => element.getBoundingClientRect().height);
      expect(board).toBeGreaterThan(100);
    } finally {
      await page.close();
    }
  });
  test("Escape closes and restores the clicked row; Enter focuses the panel title", async () => {
    const page = await load(1366, 900);
    try {
      await openRow(page, "row-2");
      await page.keyboard.press("Escape");
      await settlePanel(page);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("row-2");
      await page.keyboard.press("Enter");
      await settlePanel(page);
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Selected record");
      await page.keyboard.press("Escape");
      await settlePanel(page);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("row-2");
    } finally {
      await page.close();
    }
  });
  test("1280×800: J focuses and reveals the next row below Main's fold beside the panel", async () => {
    const page = await load(1280, 800);
    try {
      // The first row that ends below Main's fold; the row before it is the last one fully in view.
      const fold = await page.evaluate(() => {
        const bottom = document.querySelector(".k2b-app-workspace__main")!.getBoundingClientRect().bottom;
        return Array.from(document.querySelectorAll('[id^="row-"]')).findIndex((row) => row.getBoundingClientRect().bottom > bottom);
      });
      expect(fold).toBeGreaterThan(0);
      await openRow(page, `row-${fold - 1}`);
      const covered = await page.evaluate(
        (id) =>
          document.getElementById(id)!.getBoundingClientRect().bottom >
          document.querySelector(".k2b-app-workspace__main")!.getBoundingClientRect().bottom,
        `row-${fold}`,
      );
      expect(covered).toBe(true);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe(`row-${fold - 1}`);
      await page.keyboard.press("j");
      await page.waitForFunction((id) => {
        const row = document.getElementById(id)!.getBoundingClientRect();
        const main = document.querySelector(".k2b-app-workspace__main")!.getBoundingClientRect();
        const detail = document.querySelector(".k2b-app-workspace__detail")!.getBoundingClientRect();
        return row.top >= main.top && row.left >= main.left && row.bottom <= main.bottom && row.right <= detail.left;
      }, `row-${fold}`);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe(`row-${fold}`);
    } finally {
      await page.close();
    }
  });

  test("390×844: J reveals the next row above the phone sheet", async () => {
    const page = await load(390, 844);
    try {
      await openRow(page, "row-20");
      await page.waitForFunction(
        () =>
          document.getElementById("row-20")!.getBoundingClientRect().bottom <=
          document.querySelector(".k2b-app-workspace__detail")!.getBoundingClientRect().top,
      );
      const shape = await geometry(page);
      expect(await page.locator("#row-21").evaluate((element) => element.getBoundingClientRect().bottom)).toBeGreaterThan(shape.detail.top);
      await page.keyboard.press("j");
      await page.waitForFunction(
        () =>
          document.getElementById("row-21")!.getBoundingClientRect().bottom <=
          document.querySelector(".k2b-app-workspace__detail")!.getBoundingClientRect().top,
      );
    } finally {
      await page.close();
    }
  });
  test("390×844: K reveals a previous row above Main's top", async () => {
    const page = await load(390, 844);
    try {
      await openRow(page, "row-20");
      // The opened row starts Main's scrollport, so the row before it is out of view above.
      await page.locator("#row-20").evaluate((row) => row.scrollIntoView({ block: "start" }));
      const visibleTop = () =>
        page.evaluate(() => Math.max(0, document.querySelector(".k2b-app-workspace__main")!.getBoundingClientRect().top));
      expect(await page.locator("#row-19").evaluate((row) => row.getBoundingClientRect().top)).toBeLessThan(await visibleTop());
      await page.keyboard.press("k");
      await page.waitForFunction(
        () =>
          document.getElementById("row-19")!.getBoundingClientRect().top >=
          Math.max(0, document.querySelector(".k2b-app-workspace__main")!.getBoundingClientRect().top),
      );
    } finally {
      await page.close();
    }
  });

  test("390×844: J reveals the next card of a board beside the screen", async () => {
    const page = await load(390, 844, "trail=1");
    try {
      await openRow(page, "row-0");
      expect(await page.locator("#row-1").evaluate((card) => card.getBoundingClientRect().right)).toBeGreaterThan(390);
      await page.keyboard.press("j");
      await page.waitForFunction(() => {
        const card = document.getElementById("row-1")!.getBoundingClientRect();
        return card.left >= 0 && card.right <= innerWidth;
      });
    } finally {
      await page.close();
    }
  });

  test("J/K step selection and F6 switches focus between the item and detail title", async () => {
    const page = await load(1366, 900);
    try {
      await openRow(page, "row-2");
      await page.keyboard.press("j");
      expect(await page.locator("body").getAttribute("data-steps")).toBe("1");
      await page.keyboard.press("k");
      expect(await page.locator("body").getAttribute("data-steps")).toBe("0");
      await page.keyboard.press("F6");
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Selected record");
      await page.keyboard.press("Shift+F6");
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("row-2");
    } finally {
      await page.close();
    }
  });
  test("URL-open geometry is final before motion starts, and reduced motion has no transitions", async () => {
    for (const reducedMotion of ["no-preference", "reduce"] as const) {
      const page = await load(1366, 900, "initial=1&persisted=520", { reducedMotion });
      try {
        await page.waitForFunction(() => document.body.dataset.secondMotion !== undefined);
        expect(await page.locator("body").getAttribute("data-initial-motion")).toBe("false");
        expect(await page.locator("body").getAttribute("data-first-motion")).toBe("false");
        expect(await page.locator("body").getAttribute("data-second-motion")).toBe("true");
        expect(await page.locator("body").getAttribute("data-initial-transition")).toBe("0s");
        expect(Number(await page.locator("body").getAttribute("data-initial-width"))).toBeCloseTo(520, 1);
        expectInset(await geometry(page));
        expect(await page.locator(".k2b-app-workspace__detail").evaluate((element) => element.getAnimations().length)).toBe(0);
        if (reducedMotion === "reduce") {
          await page.locator("#close").click();
          expect(await page.locator(".k2b-app-workspace__detail").evaluate((element) => element.getAnimations().length)).toBe(0);
          await openRow(page);
          expect(await page.locator(".k2b-app-workspace__detail").evaluate((element) => getComputedStyle(element).transitionDuration)).toBe(
            "0s",
          );
        }
      } finally {
        await page.close();
      }
    }
  });

  // WebKit cannot construct Touch objects in this fixture. Geometry, mouse
  // drags, keyboard interaction, and detents still run in both engines.
  test.skipIf(browserName === "webkit")("touch content pulls a full sheet to half and drawer swipes respect scroll owners", async () => {
    const touch = async (page: Page, type: string, x: number, y: number, target: string) =>
      page.evaluate(
        ({ type, x, y, target }) => {
          const element = document.querySelector(target)!;
          const sample = new Touch({ identifier: 1, target: element, clientX: x, clientY: y });
          element.dispatchEvent(
            new TouchEvent(type, {
              bubbles: true,
              cancelable: true,
              touches: type === "touchend" || type === "touchcancel" ? [] : [sample],
              changedTouches: [sample],
            }),
          );
        },
        { type, x, y, target },
      );
    const phone = await load(390, 844, "initial=1", { hasTouch: true });
    try {
      await phone.locator(".k2b-app-workspace__detail-grabber").click();
      await settlePanel(phone);
      await touch(phone, "touchstart", 100, 100, "#detail-text");
      await touch(phone, "touchmove", 100, 200, "#detail-text");
      await touch(phone, "touchend", 100, 200, "#detail-text");
      await settlePanel(phone);
      expect((await geometry(phone)).full).toBeNull();
    } finally {
      await phone.close();
    }
    const drawer = await load(820, 1180, "initial=1", { hasTouch: true });
    try {
      await drawer.locator("#detail-text").evaluate((element) => {
        const scroller = document.createElement("div");
        scroller.id = "horizontal-owner";
        scroller.style.cssText = "width:200px;overflow-x:auto";
        const wide = document.createElement("div");
        wide.id = "horizontal-content";
        wide.style.cssText = "width:1000px;height:40px";
        wide.textContent = "Scrollable content";
        scroller.append(wide);
        element.append(scroller);
        scroller.scrollLeft = 100;
      });
      // A slider owns its horizontal drag.
      await drawer.locator("#detail-text").evaluate((element) => {
        const slider = document.createElement("input");
        slider.id = "slider";
        slider.type = "range";
        element.append(slider);
      });
      await touch(drawer, "touchstart", 400, 100, "#slider");
      await touch(drawer, "touchmove", 520, 100, "#slider");
      await touch(drawer, "touchend", 520, 100, "#slider");
      expect(await drawer.locator("body").getAttribute("data-closes")).toBeNull();
      await touch(drawer, "touchstart", 400, 100, "#horizontal-content");
      await touch(drawer, "touchmove", 500, 100, "#horizontal-content");
      await touch(drawer, "touchend", 500, 100, "#horizontal-content");
      expect(await drawer.locator("body").getAttribute("data-closes")).toBeNull();
      expect(await drawer.locator(".k2b-app-workspace__detail").getAttribute("data-workspace-detail-dragging")).toBeNull();
      await touch(drawer, "touchstart", 400, 100, "#detail-text");
      await touch(drawer, "touchmove", 500, 100, "#detail-text");
      await touch(drawer, "touchend", 500, 100, "#detail-text");
      await settlePanel(drawer);
      expect(await drawer.locator("body").getAttribute("data-closes")).toBe("1");
    } finally {
      await drawer.close();
    }
  });
});
