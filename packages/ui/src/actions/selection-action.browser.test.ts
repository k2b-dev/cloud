import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

// Whether a press keeps the selection, the top layer, keyboard focus and touch placement are browser behavior, so a
// real engine runs the shipped build against two messages in a scroll area.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "selection-action.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { SelectionAction } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

window.calls = [];
window.select = (part, from, to, endPart = part) => {
  const start = document.querySelectorAll(".part")[part].firstChild;
  const end = document.querySelectorAll(".part")[endPart].firstChild;
  const range = document.createRange();
  range.setStart(start, from);
  range.setEnd(end, to);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
};
render(
  () =>
    createComponent(SelectionAction, {
      root: document.getElementById("feed"),
      within: (node) => (node instanceof Element ? node : node.parentElement)?.closest(".part"),
      label: "Quote",
      icon: "ti ti-quote",
      onAction: (selection) => window.calls.push({ text: selection.text, part: selection.element.dataset.part }),
    }),
  document.getElementById("app"),
);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the selection action fixture for the browser.");
const script = await build.outputs[0]!.text();

const html =
  "<!doctype html><html><head><meta name='viewport' content='width=device-width, initial-scale=1'>" +
  `<style>${css}</style><style>
    body { margin: 0; }
    #feed { position: fixed; inset: 0 0 80px; overflow: auto; padding: 120px 24px 0; }
    .part { font: 16px/1.6 sans-serif; margin: 0 0 24px; }
    #after { position: fixed; inset: auto 0 0; height: 80px; }
  </style></head><body class="k2b-ui" data-theme="light">` +
  "<div id='feed'><button id='before' type='button'>Before</button>" +
  "<p class='part' data-part='a'>Lea Muster wrote that the  quarterly\nreport is ready for review today.</p>" +
  "<p class='part' data-part='b'>Ben Schulz answered that he reads it tomorrow morning.</p></div>" +
  "<button id='after' type='button'>After</button><div id='app'></div></body></html>";

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (touch = false) => {
  const page = await (
    await browser.newContext({ viewport: touch ? { width: 390, height: 800 } : { width: 1200, height: 800 }, hasTouch: touch, isMobile: touch })
  ).newPage();
  await page.setContent(html);
  await page.addScriptTag({ content: script });
  await settled(page);
  return page;
};
type Win = { select: (part: number, from: number, to: number, endPart?: number) => void; calls: { text: string; part: string }[] };
const select = (page: Page, part: number, from: number, to: number, endPart?: number) =>
  page.evaluate(([p, f, t, e]) => (window as unknown as Win).select(p!, f!, t!, e), [part, from, to, endPart] as const);
const state = (page: Page) =>
  page.evaluate(() => {
    const pill = document.querySelector<HTMLElement>(".k2b-selection-toolbar")!;
    const selection = getSelection()!;
    const range = selection.rangeCount && !selection.isCollapsed ? selection.getRangeAt(0).getClientRects() : null;
    const box = pill.getBoundingClientRect();
    const first = range?.[0];
    const last = range?.[range.length - 1];
    return {
      open: pill.matches(":popover-open"),
      side: pill.dataset.side,
      text: pill.textContent,
      focused: pill.contains(document.activeElement),
      active: document.activeElement?.id ?? null,
      pill: { top: box.top, bottom: box.bottom, center: box.left + box.width / 2 },
      first: first && { top: first.top, center: first.left + first.width / 2 },
      last: last && { bottom: last.bottom },
      calls: (window as unknown as Win).calls,
      selected: selection.toString(),
    };
  });
const layout = (page: Page) =>
  page.evaluate(() =>
    ["#before", ".part[data-part='a']", ".part[data-part='b']", "#after"].map((selector) => {
      const box = document.querySelector(selector)!.getBoundingClientRect();
      return [box.top, box.left, box.width, box.height];
    }),
  );

describe("SelectionAction", () => {
  test("a pointer selection shows the pill above it once released, without moving the page, and quotes the text", async () => {
    const page = await load();
    try {
      const before = await layout(page);
      const word = await page.evaluate(() => {
        const node = document.querySelector(".part")!.firstChild!;
        const range = document.createRange();
        range.setStart(node, 0);
        range.setEnd(node, 3);
        const start = range.getBoundingClientRect();
        range.setStart(node, 37);
        range.setEnd(node, 43);
        const end = range.getBoundingClientRect();
        return { x1: start.left + 1, y: start.top + start.height / 2, x2: end.right + 1 };
      });
      await page.mouse.move(word.x1, word.y);
      await page.mouse.down();
      await page.mouse.move(word.x2, word.y, { steps: 4 });
      await settled(page);
      // Not while the pointer still drags.
      expect((await state(page)).open).toBe(false);
      await page.mouse.up();
      await settled(page);
      const shown = await state(page);
      expect(shown.open).toBe(true);
      expect(shown.side).toBe("above");
      expect(shown.text).toContain("Quote");
      expect(shown.pill.bottom).toBeCloseTo(shown.first!.top - 8, 0);
      expect(await layout(page)).toEqual(before);

      await page.locator(".k2b-selection-toolbar button").click();
      await settled(page);
      const done = await state(page);
      expect(done.calls).toEqual([{ text: "Lea Muster wrote that the quarterly report", part: "a" }]);
      expect(done.open).toBe(false);
      expect(done.selected).toBe("");
    } finally {
      await page.context().close();
    }
  });

  test("offers nothing for a selection across two parts", async () => {
    const page = await load();
    try {
      await select(page, 0, 4, 10, 1);
      await settled(page);
      expect((await state(page)).open).toBe(false);
      await select(page, 1, 0, 10);
      await settled(page);
      expect((await state(page)).open).toBe(true);
    } finally {
      await page.context().close();
    }
  });

  test("Tab after a keyboard selection reaches the pill, Enter runs it, and Escape closes it and returns the focus", async () => {
    const page = await load();
    try {
      await page.focus("#before");
      await select(page, 1, 0, 10);
      await settled(page);
      expect((await state(page)).open).toBe(true);
      await page.keyboard.press("Tab");
      expect((await state(page)).focused).toBe(true);
      await page.keyboard.press("Escape");
      await settled(page);
      const closed = await state(page);
      expect(closed.open).toBe(false);
      expect(closed.active).toBe("before");
      // The same selection stays closed; a new one shows it again.
      await select(page, 1, 0, 10);
      await settled(page);
      expect((await state(page)).open).toBe(false);
      await select(page, 1, 0, 14);
      await settled(page);
      expect((await state(page)).open).toBe(true);
      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");
      await settled(page);
      const done = await state(page);
      expect(done.calls).toEqual([{ text: "Ben Schulz ans", part: "b" }]);
      expect(done.active).toBe("before");
      expect(done.open).toBe(false);
    } finally {
      await page.context().close();
    }
  });

  test("on a touch screen the pill sits below the selection's last line", async () => {
    const page = await load(true);
    try {
      const before = await layout(page);
      await select(page, 0, 4, 60);
      await settled(page);
      const shown = await state(page);
      expect(shown.open).toBe(true);
      expect(shown.side).toBe("below");
      expect(shown.pill.top).toBeGreaterThanOrEqual(shown.last!.bottom + 8);
      expect(await layout(page)).toEqual(before);
    } finally {
      await page.context().close();
    }
  });
});
