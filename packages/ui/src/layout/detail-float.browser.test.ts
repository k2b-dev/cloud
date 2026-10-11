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
import { AppWorkspace, DetailPanel } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const params = new URLSearchParams(document.body.dataset.params);
const [open, setOpen] = createSignal(params.has("initial"));
const close = () => { document.body.dataset.closes = String(Number(document.body.dataset.closes || 0) + 1); setOpen(false); };
const button = (index) => {
  const element = document.createElement("button");
  element.id = "row-" + index;
  element.textContent = "Row " + index;
  // Cards carry their own width, as a board's columns do: WebKit sizes a max-content row from its items' widths, not their flex bases.
  element.style.cssText = params.has("trail") ? "flex:none;width:260px;height:160px" : "display:block;width:100%;height:42px;text-align:left";
  element.addEventListener("click", () => setOpen(true));
  return element;
};
const mainContent = () => {
  const toolbar = document.createElement("div");
  toolbar.id = "toolbar";
  toolbar.textContent = "Fixed toolbar";
  toolbar.style.cssText = "height:40px;flex-shrink:0;padding-inline-end:var(--k2b-detail-space,0px)";
  if (params.has("table")) {
    // A data table that fits its scroller, as a Grids table with few fields does.
    const wrap = document.createElement("div");
    wrap.id = "table";
    wrap.className = "k2b-table-wrap k2b-detail-trail";
    wrap.style.cssText = "flex:1;min-height:0;height:auto";
    const table = document.createElement("table");
    table.className = "k2b-data-table";
    table.innerHTML = "<tbody>" + Array.from({length:6}, (_, row) => "<tr>" + Array.from({length:4}, (_, column) => "<td>Cell " + row + "." + column + "</td>").join("") + "</tr>").join("") + "</tbody>";
    table.querySelector("td").replaceChildren(button(0));
    wrap.append(table);
    return [toolbar, wrap];
  }
  if (!params.has("trail")) return [toolbar, ...Array.from({length:40}, (_, index) => button(index))];
  const trail = document.createElement("div");
  trail.id = "board";
  trail.className = "k2b-detail-trail";
  trail.style.cssText = "min-height:0;flex:1;overflow:auto";
  const cards = document.createElement("div");
  cards.style.cssText = "display:flex;width:max-content;gap:16px";
  cards.append(...Array.from({length:8}, (_, index) => button(index)));
  trail.append(cards);
  return [toolbar, trail];
};
// A documentation-style frame that contains layout, inside a longer page.
if (params.has("frame")) document.getElementById("app").style.cssText = "height:480px;margin-top:100px;contain:layout";
render(() => createComponent(AppWorkspace, {
  layoutState: () => ({version:2, sidebarWidth: Number(params.get("sidebar")) || 208, detailWidths: params.has("persisted") ? {record:Number(params.get("persisted"))} : undefined}),
  get children() { return [
    createComponent(AppWorkspace.Sidebar, { id:"navigation", maxSize:960, children:"Navigation" }),
    createComponent(AppWorkspace.Content, { get children() { return [
      createComponent(AppWorkspace.Main, { scroll:!params.has("trail") && !params.has("table"), get children() { return mainContent(); } }),
      createComponent(AppWorkspace.Detail, {
        id:"record", width:params.get("width") || "md", get open() { return open(); }, onClose:params.has("fixed") ? undefined : close,
        get children() { return createComponent(DetailPanel, { get children() { return [
          createComponent(DetailPanel.Header, { title:"Selected record", get actions() { const element = document.createElement("button"); element.id="close"; element.textContent="Close"; element.addEventListener("click", close); return element; } }),
          createComponent(DetailPanel.Body, { get children() { const text = document.createElement("p"); text.id="detail-text"; text.textContent="Text in the selected record"; return text; } }),
        ]; } }); },
      }),
    ]; } }),
    createComponent(AppWorkspace.BottomDrawer, { id:"events", get open() { return params.has("drawer"); }, height:"sm", children:"Recent events" }),
  ]; },
}), document.getElementById("app"));
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
    `<!doctype html><html lang="en"><head><style>${css}</style></head><body class="k2b-ui" style="margin:0"><div id="app" style="height:100vh"></div></body></html>`,
  );
  await page.evaluate((params) => {
    document.body.dataset.params = params;
  }, params);
  await page.addScriptTag({ content: script });
  await page.locator("#row-0").waitFor();
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
            hold: board.style.getPropertyValue("--k2b-detail-trail-hold"),
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
  expect(shape.detail.top - shape.content.top).toBeCloseTo(8, 1);
  expect(shape.content.right - shape.detail.right).toBeCloseTo(8, 1);
  expect(shape.content.bottom - shape.detail.bottom).toBeCloseTo(8, 1);
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
          expect(shape.detail.left - shape.main.right).toBeCloseTo(8, 1);
          expect(shape.main.width).toBeGreaterThanOrEqual(320);
        } finally {
          await page.close();
        }
      });
    }
  }
  test("fits a preferred width while keeping Main at 320 px", async () => {
    const page = await load(1024, 900, "sidebar=208&persisted=640");
    try {
      await openRow(page);
      const shape = await geometry(page);
      expectInset(shape);
      expect(shape.main.width).toBeCloseTo(320, 1);
      expect(shape.detail.width).toBeCloseTo(shape.content.width - 336, 1);
      expect(shape.detail.left - shape.main.right).toBeCloseTo(8, 1);
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
  test("a trail board reveals its card, pads the toolbar, and retains only visible space on close", async () => {
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
      expect(opened.main.width).toBeCloseTo(opened.content.width, 1);
      expect(opened.board!.scrollWidth - before.board!.scrollWidth).toBeCloseTo(opened.detail.width + 16, 1);
      expect(opened.toolbarPadding).toBeCloseTo(opened.detail.width + 16, 1);
      await page.locator("#board").evaluate((element) => {
        element.scrollLeft = element.scrollWidth;
      });
      const atEnd = (await geometry(page)).board!.left;
      await page.locator("#close").click();
      await settlePanel(page);
      const closed = await geometry(page);
      expect(closed.board!.left).toBeCloseTo(atEnd, 1);
      expect(Number.parseFloat(closed.board!.hold)).toBeCloseTo(opened.detail.width + 16, 1);
      await page.locator("#board").evaluate((element) => {
        element.scrollLeft = 0;
      });
      await page.waitForFunction(() => document.getElementById("board")!.style.getPropertyValue("--k2b-detail-trail-hold") === "");
    } finally {
      await page.close();
    }
  });
  test("a table that fits keeps its width under the panel, gets the space after it, and lets it go on close", async () => {
    const page = await load(1920, 1080, "table=1");
    try {
      const table = () =>
        page.locator("#table").evaluate((wrap) => ({
          width: wrap.querySelector("table")!.getBoundingClientRect().width,
          client: wrap.clientWidth,
          scroll: wrap.scrollWidth,
          hold: wrap.style.getPropertyValue("--k2b-detail-trail-hold"),
        }));
      const before = await table();
      expect(before.width).toBeCloseTo(before.client, 0);
      await openRow(page);
      const opened = await table();
      const shape = await geometry(page);
      // Main keeps its width, the columns keep theirs, and the panel's space follows the table.
      expect(shape.main.width).toBeCloseTo(shape.content.width, 1);
      expect(opened.width).toBeCloseTo(before.width, 0);
      expect(opened.scroll - opened.client).toBeCloseTo(shape.detail.width + 16, 0);
      await page.locator("#close").click();
      await settlePanel(page);
      // At the start of the scroller, nothing can move, so the space goes at once.
      expect(await table()).toEqual(before);
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
        expect(shape.main.width).toBeCloseTo(fixed ? shape.content.width - shape.detail.width - 16 : shape.content.width, 1);
      } finally {
        await page.close();
      }
    });
  }
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
