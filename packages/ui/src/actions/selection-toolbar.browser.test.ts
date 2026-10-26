import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

// The top layer, selection geometry, and whether a press keeps the selection are browser behavior, so a real engine
// runs the shipped build against a text in a clipping scroll container below a sticky bar.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "selection-toolbar.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { Button, SelectionToolbar, Toolbar } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const text = document.getElementById("text");
const [open, setOpen] = createSignal(false);
window.calls = [];
const rect = () => {
  const selection = getSelection();
  return selection && selection.rangeCount && !selection.isCollapsed ? selection.getRangeAt(0).getBoundingClientRect() : null;
};
window.select = (from, to) => {
  const node = text.querySelector("p").firstChild;
  const range = document.createRange();
  range.setStart(node, from);
  range.setEnd(node, to);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
  setOpen(true);
};
window.closeToolbar = () => setOpen(false);
render(
  () =>
    createComponent(SelectionToolbar, {
      label: "Selection",
      get placement() { return window.placement; },
      anchor: () => (open() ? rect() : null),
      boundary: () => document.getElementById("text"),
      onEscape: () => { window.calls.push("escape"); setOpen(false); },
      get children() {
        return [
          createComponent(Toolbar.Action, { label: "Bold", icon: "ti ti-bold", onClick: () => window.calls.push("bold:" + getSelection().toString()) }),
          createComponent(Toolbar.Separator, {}),
          createComponent(Button, { size: "sm", variant: "ghost", onClick: () => window.calls.push("comment"), children: "Comment" }),
        ];
      },
    }),
  document.getElementById("app"),
);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the selection toolbar fixture for the browser.");
const script = await build.outputs[0]!.text();

const filler = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(40);
const html =
  "<!doctype html><html><head><meta name='viewport' content='width=device-width, initial-scale=1'>" +
  `<style>${css}</style><style>
    body { margin: 0; }
    #bar { position: fixed; inset: 0 0 auto; height: 56px; background: #eee; z-index: 5; }
    #text { position: fixed; inset: 56px 0 0; overflow: auto; padding: 0 40px; contain: paint; }
    #text p { font: 16px/1.7 sans-serif; margin: 0 0 1200px; padding-top: 12px; }
  </style></head><body class="k2b-ui" data-theme="light">` +
  `<div id='bar'></div><div id='text'><p>${filler}</p></div><div id='app'></div></body></html>`;

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (width = 1200) => {
  const page = await (await browser.newContext({ viewport: { width, height: 800 } })).newPage();
  await page.setContent(html);
  await page.addScriptTag({ content: script });
  return page;
};
const geometry = (page: Page) =>
  page.evaluate(() => {
    const toolbar = document.querySelector<HTMLElement>(".k2b-selection-toolbar")!;
    const range = getSelection()!.rangeCount ? getSelection()!.getRangeAt(0).getBoundingClientRect() : null;
    const box = toolbar.getBoundingClientRect();
    return {
      open: toolbar.matches(":popover-open"),
      side: toolbar.dataset.side,
      toolbar: { top: box.top, bottom: box.bottom, center: box.left + box.width / 2 },
      range: range && { top: range.top, bottom: range.bottom, center: range.left + range.width / 2 },
    };
  });
const settle = (page: Page) => settled(page);

describe("SelectionToolbar", () => {
  test("opens centered above the selection, follows it while scrolling, and goes below under the sticky bar", async () => {
    const page = await load();
    try {
      await page.evaluate(() => (window as unknown as { select: (a: number, b: number) => void }).select(1000, 1030));
      await settle(page);
      const first = await geometry(page);
      expect(first.open).toBe(true);
      expect(first.side).toBe("above");
      expect(first.toolbar.bottom).toBeCloseTo(first.range!.top - 8, 0);
      expect(Math.abs(first.toolbar.center - first.range!.center)).toBeLessThan(1.5);

      await page.evaluate(() => document.getElementById("text")!.scrollBy(0, 40));
      await settle(page);
      const scrolled = await geometry(page);
      expect(scrolled.toolbar.bottom).toBeCloseTo(scrolled.range!.top - 8, 0);

      // Scrolled so the selection sits just under the bar: there is no room above.
      await page.evaluate(() => {
        const text = document.getElementById("text")!;
        const top = getSelection()!.getRangeAt(0).getBoundingClientRect().top;
        text.scrollBy(0, top - 70);
      });
      await settle(page);
      const below = await geometry(page);
      expect(below.side).toBe("below");
      expect(below.toolbar.top).toBeCloseTo(below.range!.bottom + 8, 0);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("keeps the selection when a button is pressed, and Escape asks the application to close", async () => {
    const page = await load();
    try {
      await page.evaluate(() => (window as unknown as { select: (a: number, b: number) => void }).select(20, 31));
      await settle(page);
      const bold = page.getByRole("button", { name: "Bold" });
      await bold.click();
      await page.getByRole("button", { name: "Comment" }).click();
      expect(await page.evaluate(() => getSelection()!.toString())).toBe(filler.slice(20, 31));
      await page.getByRole("button", { name: "Comment" }).focus();
      await page.keyboard.press("Escape");
      await settle(page);
      expect(await page.evaluate(() => (window as unknown as { calls: string[] }).calls)).toEqual([
        `bold:${filler.slice(20, 31)}`,
        "comment",
        "escape",
      ]);
      expect((await geometry(page)).open).toBe(false);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("goes below the selection on request, for touch", async () => {
    const page = await load(390);
    try {
      await page.evaluate(() => {
        (window as unknown as { placement: string }).placement = "below";
        (window as unknown as { select: (a: number, b: number) => void }).select(300, 320);
      });
      await settle(page);
      const placed = await geometry(page);
      expect(placed.side).toBe("below");
      expect(placed.toolbar.top).toBeGreaterThanOrEqual(placed.range!.bottom);
    } finally {
      await page.context().close();
    }
  }, 30_000);
});
