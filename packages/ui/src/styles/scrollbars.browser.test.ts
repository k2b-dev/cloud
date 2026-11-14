import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser, settled } from "../../test/browser";

// The one shared scrollbar (index.css) must never move content: not when a scroller starts or stops overflowing,
// not when its thumb widens under the pointer. Whether a scrollbar takes room is a question of real rendering, so a
// real engine lays out the shipped stylesheet around the real components. Each surface grows from fitting content to
// overflowing content; the boxes of its content may not change, and its scrollbar room stays the same 0.5rem.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "scrollbars.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { AppWorkspace, Chat, DataTable, LocaleProvider, Panes, ScrollArea, applyPanesPreset } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const [grown, setGrown] = createSignal(false);
window.grow = () => setGrown(true);
const h = createComponent;
const div = (className, text, style) => { const element = document.createElement("div"); if (className) element.className = className; if (style) element.style.cssText = style; element.textContent = text ?? ""; return element; };
const paragraphs = (prefix, few) => () => Array.from({ length: grown() ? 40 : few }, (_, index) => div("probe", prefix + " " + index, "height: 1.5rem"));
const item = (index) => h(AppWorkspace.SidebarItem, { href: "#n" + index, children: "Note " + index });

const workspace = () => h(AppWorkspace, {
  resizable: false,
  get children() {
    return [
      h(AppWorkspace.Sidebar, { id: "navigation", label: "Notebooks", get children() {
        return h(AppWorkspace.SidebarDesktop, { get children() {
          return h(AppWorkspace.SidebarBody, { sidebarMode: "expanded", get children() {
            return h(AppWorkspace.SidebarSection, { title: "Notes", get children() {
              // A wide tree row makes the bar overflow sideways, as a deep notebook tree can.
              return [() => Array.from({ length: grown() ? 40 : 3 }, (_, index) => item(index)), () => grown() ? div("wide", "", "width: 40rem; height: 1px") : null];
            } });
          } });
        } });
      } }),
      h(AppWorkspace.Content, { get children() {
        return h(AppWorkspace.Main, { level: "reader", get children() {
          return [
            h(AppWorkspace.MainPane, { id: "list", label: "Inbox", href: "#list", scroll: false, get children() {
              return h(ScrollArea, { id: "mail-list", inset: true, style: "flex: 1", get children() { return paragraphs("Message", 3)(); } });
            } }),
            h(AppWorkspace.MainPane, { id: "reader", label: "Reader", get children() { return paragraphs("Paragraph", 3)(); } }),
          ];
        } });
      } }),
    ];
  },
});

const chatItems = () => Array.from({ length: grown() ? 30 : 1 }, (_, index) => ({ kind: "message", id: "m" + index, role: index % 2 ? "assistant" : "user", content: "Message " + index }));
const columns = Array.from({ length: 6 }, (_, index) => ({ id: "c" + index, header: "Field " + index, value: "name" }));
const tableRows = () => Array.from({ length: grown() ? 30 : 2 }, (_, index) => ({ name: "Row " + String(index).padStart(2, "0") }));
const pane = (id) => ({ id, title: "Document " + id, icon: "ti-file", render: () => div("pane-body probe", "Pane " + id) });

render(() => h(LocaleProvider, { locale: "en", get children() { return workspace(); } }), document.getElementById("workspace"));
render(() => h(LocaleProvider, { locale: "en", get children() {
  return h(ScrollArea, { id: "notebook", style: "height: 100%", get children() { return paragraphs("Line", 2)(); } });
} }), document.getElementById("notebook-host"));
render(() => h(LocaleProvider, { locale: "en", get children() {
  return h(Chat.Timeline, { get items() { return chatItems(); }, label: "Chat" });
} }), document.getElementById("chat-host"));
render(() => h(LocaleProvider, { locale: "en", get children() {
  return h(DataTable, { columns, get rows() { return tableRows(); }, getRowId: (row) => row.name, surface: "plain", fillHeight: true });
} }), document.getElementById("table-host"));
render(() => h(LocaleProvider, { locale: "en", get children() {
  // One tab row; the grown set no longer fits it, so it scrolls sideways under the shared overlay thumb.
  const ids = () => (grown() ? ["a", "b", "c", "d", "e", "f", "g", "h"] : ["a", "b"]);
  return h(Panes, { get items() { return ids().map(pane); }, get layout() { return applyPanesPreset("tabs", ids()); } });
} }), document.getElementById("panes-host"));
`;
const build = await Bun.build({
  entrypoints: [entry],
  files: { [entry]: fixture },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the scrollbar fixture for the browser.");
const script = await build.outputs[0]!.text();

// The PDF viewer's page stack needs pdf.js to draw; its scroller is the same markup the viewer renders.
const pdf = (pages: number) =>
  `<div class="k2b-pdf-viewer" style="height: 100%"><div class="k2b-pdf-viewer__pages" id="pdf"><div class="k2b-pdf-viewer__stack">${Array.from(
    { length: pages },
    (_, index) => `<div class="k2b-pdf-viewer__page probe" style="width: 14rem; height: 18rem">Page ${index}</div>`,
  ).join("")}</div></div></div>`;

const html = `<!doctype html><html lang="en"><head><style>${css}</style><style>
  *, *::before, *::after { transition: none !important; animation: none !important; }
  body { margin: 0; }
  .cells { display: grid; grid-template-columns: repeat(3, 24rem); gap: 1rem; padding: 1rem; }
  .cell { display: flex; height: 18rem; flex-direction: column; overflow: hidden; }
  .cell > * { flex: 1; min-height: 0; }
</style></head><body class="k2b-ui">
  <section id="workspace" style="display: flex; height: 30rem"></section>
  <div class="cells">
    <div class="cell" id="notebook-host"></div>
    <div class="cell" id="chat-host"></div>
    <div class="cell" id="table-host"></div>
    <div class="cell" id="pdf-host">${pdf(1)}</div>
    <div class="cell" id="panes-host"></div>
  </div>
</body></html>`;

/**
 * A scroller, the element whose box must stay put inside it, and the axis its scrollbar takes room on. A probe that
 * follows new content down, as the chat's does, or grows with it keeps only its inline position and width.
 */
type Surface = { name: string; scroller: string; probe: string; axis: "y" | "x"; inlineOnly?: boolean };
const surfaces: Surface[] = [
  { name: "sidebar (vertical)", scroller: ".k2b-app-workspace__sidebar-body", probe: ".k2b-app-workspace__sidebar-item", axis: "y" },
  { name: "sidebar (horizontal)", scroller: ".k2b-app-workspace__sidebar-body", probe: ".k2b-app-workspace__sidebar-item", axis: "x" },
  { name: "mail list", scroller: "#mail-list", probe: "#mail-list .probe", axis: "y" },
  {
    name: "mail reader level",
    scroller: '[data-workspace-level="2"] .k2b-app-workspace__level-body',
    probe: '[data-workspace-level="2"] .probe',
    axis: "y",
  },
  { name: "notebook content", scroller: "#notebook", probe: "#notebook .probe", axis: "y" },
  { name: "chat timeline", scroller: ".k2b-chat-timeline__viewport", probe: ".k2b-chat-timeline__content", axis: "y", inlineOnly: true },
  // A filling table stretches its few rows; only the columns' inline geometry belongs to the scrollbar.
  { name: "data table", scroller: ".k2b-table-wrap", probe: ".k2b-data-table thead th", axis: "y", inlineOnly: true },
  { name: "pdf viewer", scroller: "#pdf", probe: "#pdf .probe", axis: "y" },
  // More tabs share the row, so each one narrows; the row itself and the pane below it stay put.
  { name: "panes", scroller: ".k2b-panes__tabs", probe: ".k2b-panes__head", axis: "x" },
];

type Box = [number, number, number, number];
type Reading = { probe: Box; scroller: Box; room: number; overflows: boolean };

const read = (page: Page, surface: Surface) =>
  page.evaluate(({ scroller, probe, axis, inlineOnly }): Reading => {
    const element = document.querySelector<HTMLElement>(scroller)!;
    const target = document.querySelector<HTMLElement>(probe)!;
    const box = (node: Element): Box => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return [x, y, width, height];
    };
    const [x, y, width, height] = box(target);
    return {
      probe: inlineOnly ? [x, 0, width, 0] : [x, y, width, height],
      scroller: box(element),
      room: axis === "y" ? element.offsetWidth - element.clientWidth : element.offsetHeight - element.clientHeight,
      overflows: axis === "y" ? element.scrollHeight > element.clientHeight : element.scrollWidth > element.clientWidth,
    };
  }, surface);

const readAll = async (page: Page) =>
  Object.fromEntries(await Promise.all(surfaces.map(async (surface) => [surface.name, await read(page, surface)] as const)));

/** How many pixels across the scrollbar lane differ from the page background, along one line through the thumb. */
const thumbWidth = async (page: Page, lane: { x: number; y: number; width: number; height: number }) => {
  const png = (await page.screenshot({ clip: lane })).toString("base64");
  return page.evaluate(
    async ([data, width]) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const row = context.getImageData(0, Math.floor(image.height / 2), image.width, 1).data;
      let inked = 0;
      for (let index = 0; index < row.length; index += 4) if (Math.abs(row[index]! - 255) > 12) inked += 1;
      return inked / (image.width / width);
    },
    [png, lane.width] as const,
  );
};

let browser: Browser;
beforeAll(async () => {
  // Headless Chromium hides classic scrollbars by default; these tests need them laid out and painted.
  browser = await launchBrowser({ ignoreDefaultArgs: ["--hide-scrollbars"] });
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.on("pageerror", (error) => console.error("PAGEERROR", error.message));
  page.on("console", (m) => m.type() === "error" && console.error("CONSOLE", m.text()));
  await page.setContent(html);
  await page.addScriptTag({ content: script });
  await page.locator(".k2b-panes__tab").first().waitFor();
  await page.mouse.move(1, 1);
  await settled(page);
  return page;
};

describe(`one shared scrollbar (${browserName})`, () => {
  test("no surface moves its content when it starts to overflow", async () => {
    const page = await open();
    try {
      const before = await readAll(page);
      await page.evaluate(() => {
        (window as unknown as { grow: () => void }).grow();
        document
          .getElementById("pdf-host")!
          .querySelector(".k2b-pdf-viewer__stack")!
          .insertAdjacentHTML(
            "beforeend",
            Array.from(
              { length: 4 },
              (_, index) => `<div class="k2b-pdf-viewer__page" style="width: 14rem; height: 18rem">Page ${index + 1}</div>`,
            ).join(""),
          );
      });
      await settled(page);
      const after = await readAll(page);
      for (const { name } of surfaces) {
        expect([name, after[name]!.overflows]).toEqual([name, true]);
        expect([name, after[name]!.probe]).toEqual([name, before[name]!.probe]);
        expect([name, after[name]!.scroller]).toEqual([name, before[name]!.scroller]);
      }
      // A vertical scrollbar keeps the same room from the start. A sideways one inside a scroller of fixed height
      // takes its room from that scroller's own height, which moves nothing above it.
      for (const { name, axis } of surfaces) if (axis === "y") expect([name, after[name]!.room]).toEqual([name, before[name]!.room]);
      // A classic scrollbar is the shared 0.5rem, or takes no room where an overlay draws it (DataTable, Panes).
      for (const { name } of surfaces) expect([name, after[name]!.room === 0 || after[name]!.room === 8]).toEqual([name, true]);
    } finally {
      await page.close();
    }
  });

  test("the thumb is 4px at rest and 6px under the pointer, inside the same 0.5rem", async () => {
    const page = await open();
    try {
      await page.evaluate(() => (window as unknown as { grow: () => void }).grow());
      await settled(page);
      const notebook = { name: "notebook content", scroller: "#notebook", probe: "#notebook .probe", axis: "y" } as const;
      const rest = await read(page, notebook);
      expect(rest.room).toBe(8);
      const [x, y, width] = rest.scroller;
      const lane = { x: x + width - 8, y: y + 12, width: 8, height: 8 };
      expect(await thumbWidth(page, lane)).toBe(4);
      await page.mouse.move(x + width - 4, y + 16);
      await settled(page);
      expect(await thumbWidth(page, lane)).toBe(6);
      expect(await read(page, notebook)).toEqual(rest);
    } finally {
      await page.close();
    }
  });
});
