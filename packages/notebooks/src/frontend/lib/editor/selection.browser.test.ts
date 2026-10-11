import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Browser, type BrowserContextOptions, devices, type Page } from "playwright";
import { browserName, launchBrowser } from "../../../../../ui/test/browser";
import type {} from "./selection.browser-harness";

// Painted selections, pointer drags and remote carets depend on real layout, so two editors run in a real browser.

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [new URL("./selection.browser-harness.ts", import.meta.url).pathname],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
  });
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the selection harness.");
  const bundle = await build.outputs[0]!.text();
  const css = Bun.file(new URL("../../../../../ui/dist/styles.css", import.meta.url));
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/harness.js") return new Response(bundle, { headers: { "content-type": "application/javascript" } });
      if (path === "/ui.css") return new Response(css, { headers: { "content-type": "text/css" } });
      return new Response(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/ui.css"></head>' +
          '<body class="k2b-ui" style="margin:0"><div id="root"></div><script src="/harness.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  browser = await launchBrowser();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

const open = async (options: BrowserContextOptions = { viewport: { width: 1440, height: 1000 } }) => {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await page.goto(server.url.href);
  await page.waitForFunction(() => "selectionHarness" in window && document.querySelectorAll(".cm-table-widget").length === 2);
  await settle(page);
  return page;
};

const settle = (page: Page) => page.evaluate(() => window.selectionHarness.settle());
const select = async (page: Page, side: "a" | "b", anchor: number, head = anchor) => {
  await page.evaluate(({ side, anchor, head }) => window.selectionHarness.select(side, anchor, head), { side, anchor, head });
  await settle(page);
};
const find = (page: Page, text: string, offset = 0) =>
  page.evaluate(({ text, offset }) => window.selectionHarness.find("a", text, offset), { text, offset });
const selection = (page: Page) => page.evaluate(() => window.selectionHarness.selection("a"));
const coords = (page: Page, pos: number) => page.evaluate((pos) => window.selectionHarness.coords("a", pos), pos);
const point = async (page: Page, pos: number) => {
  const rect = await coords(page, pos);
  return { x: rect.left, y: (rect.top + rect.bottom) / 2 };
};
const release = async (page: Page) => {
  await page.mouse.up();
  await page.waitForFunction(() => !window.selectionHarness.held("a"));
  await settle(page);
};
const drag = async (page: Page, from: number, to: number) => {
  const start = await point(page, from);
  const end = await point(page, to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await release(page);
};
const expectCopy = async (page: Page) => {
  const selected = await selection(page);
  expect(selected.to).toBeGreaterThan(selected.from);
  expect(await page.evaluate(() => window.selectionHarness.copy("a"))).toBe(selected.text);
};
const near = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1);

const caret = (page: Page) => page.locator('#b .cm-remoteCaret[style*="#7c3aed"]');
const expectCaret = async (page: Page, head: number, anchor = head) => {
  const expected = await page.evaluate(({ head, anchor }) => window.selectionHarness.caretCoords("b", head, anchor), { head, anchor });
  await page.waitForFunction(({ left, top, height }) => {
    const carets = document.querySelectorAll('#b .cm-remoteCaret[style*="#7c3aed"]');
    if (carets.length !== 1) return false;
    const box = carets[0]!.getBoundingClientRect();
    return Math.abs(box.left + 1 - left) <= 1 && Math.abs(box.top - top) <= 1 && Math.abs(box.height - height) <= 1;
  }, expected);
  expect(await caret(page).count()).toBe(1);
  const box = (await caret(page).boundingBox())!;
  near(box.x + 1, expected.left);
  near(box.y, expected.top);
  near(box.height, expected.height);
  const label = (await caret(page).locator(".cm-remoteCaretLabel").boundingBox())!;
  near(label.y + label.height, box.y);
  near(label.x, box.x);
  return box;
};

describe("rich editor selection", () => {
  test("a partial drag paints only the selected range and copies its source", async () => {
    const page = await open();
    try {
      const from = await find(page, "plain words");
      const to = from + "plain words".length;
      await drag(page, from, to);
      expect((await selection(page)).from).toBe(from);
      expect((await selection(page)).to).toBe(to);
      const left = await coords(page, from);
      const right = await coords(page, to);
      const rects = await page.locator("#a .cm-selectionBackground").evaluateAll((rects) =>
        rects.map((rect) => {
          const box = rect.getBoundingClientRect();
          return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
        }),
      );
      expect(rects).toHaveLength(1);
      near(rects[0]!.left, left.left);
      near(rects[0]!.right, right.left);
      near(rects[0]!.top, left.top);
      near(rects[0]!.bottom, left.bottom);
      expect(
        await page.locator("#a .cm-line").evaluateAll((lines) =>
          lines.every((line) => {
            const background = getComputedStyle(line).backgroundColor;
            return background === "transparent" || background === "rgba(0, 0, 0, 0)";
          }),
        ),
      ).toBe(true);
      expect(
        await page
          .locator("#a .cm-line")
          .first()
          .evaluate((line) => getComputedStyle(line, "::selection").backgroundColor),
      ).toBe("rgba(0, 0, 0, 0)");
      await expectCopy(page);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("matching text uses a different background from the selected text", async () => {
    const page = await open();
    try {
      const from = await find(page, "words to select");
      await select(page, "a", from, from + 5);
      await page.waitForSelector("#a .cm-selectionMatch");
      const match = await page
        .locator("#a .cm-selectionMatch")
        .first()
        .evaluate((node) => getComputedStyle(node).backgroundColor);
      const selected = await page
        .locator("#a .cm-selectionBackground")
        .first()
        .evaluate((node) => getComputedStyle(node).backgroundColor);
      expect(match).not.toBe(selected);
      expect(match).toBe("rgb(228, 228, 231)");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("web link text starts a drag and a click reveals its source after release", async () => {
    const page = await open();
    try {
      const from = await find(page, "[web link]");
      const to = await find(page, "inside prose", 6);
      const label = (await page.locator("#a .cm-link-label:not(.cm-link-open)").boundingBox())!;
      const end = await point(page, to);
      await page.mouse.move(label.x + 1, label.y + label.height / 2);
      await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 8 });
      await release(page);
      expect((await selection(page)).from).toBe(from);
      expect((await selection(page)).to).toBe(to);
      await expectCopy(page);
      await select(page, "a", await find(page, "Final paragraph"));
      const rendered = (await page.locator("#a .cm-link-label:not(.cm-link-open)").boundingBox())!;
      await page.mouse.move(rendered.x + 1, rendered.y + rendered.height / 2);
      await page.mouse.down();
      expect(await page.evaluate(() => window.selectionHarness.held("a"))).toBe(true);
      expect(await page.locator("#a .cm-link-label:not(.cm-link-open)").count()).toBe(1);
      await release(page);
      expect((await selection(page)).head).toBe(from);
      expect(await page.locator("#a .cm-link-label:not(.cm-link-open)").count()).toBe(0);
      expect(await page.locator("#a .cm-content").textContent()).toContain("[web link](https://example.com)");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("dragging across bold text keeps its geometry until the button is released", async () => {
    const page = await open();
    try {
      const from = await find(page, "Some **bold**");
      const to = await find(page, "text and");
      const before = { anchor: await coords(page, from), target: await coords(page, to) };
      const start = await point(page, from);
      const end = await point(page, to);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      for (const fraction of [0.3, 0.6, 1]) {
        await page.mouse.move(start.x + (end.x - start.x) * fraction, start.y);
        await settle(page);
        expect(await coords(page, from)).toEqual(before.anchor);
        expect(await coords(page, to)).toEqual(before.target);
        expect(await page.locator("#a .cm-content").textContent()).not.toContain("**bold**");
      }
      expect((await selection(page)).head).toBe(to);
      await release(page);
      expect((await selection(page)).head).toBe(to);
      expect(await page.locator("#a .cm-content").textContent()).toContain("**bold**");
      await expectCopy(page);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test.each([
    // Each drag ends next to plain text: a position beside a hidden mark shares its point with the mark's other side.
    ["heading", "Project heading", "Some"],
    ["list", "First bullet", "Open task"],
    ["checklist", "Open task", "Done task"],
    ["table", "Done task", "Final paragraph"],
  ])(
    "dragging across a %s selects from the pressed to the released character and copies that source",
    async (_name, start, end) => {
      const page = await open();
      try {
        // Leave all target blocks rendered before taking pointer coordinates.
        await select(page, "a", await find(page, "words to select"));
        const from = await find(page, start);
        const to = await find(page, end, end.length);
        await drag(page, from, to);
        const selected = await selection(page);
        // The press on a heading's first character may resolve before its hidden `# `.
        const lineStart = await page.evaluate((from) => window.selectionHarness.views.a.state.doc.lineAt(from).from, from);
        expect(selected.anchor).toBeGreaterThanOrEqual(lineStart);
        expect(selected.anchor).toBeLessThanOrEqual(from);
        expect(selected.head).toBe(to);
        await expectCopy(page);
      } finally {
        await page.context().close();
      }
    },
    30_000,
  );

  test.each([
    ["tag", "#a .cm-tag-pill", "#mytag"],
    ["note reference", "#a .k2b-reference", "[Other note]"],
    ["mail link", "#a .cm-link-label.cm-link-open", "[mail me]"],
  ])(
    "a drag that starts on a %s selects text and keeps the pill until release",
    async (_name, selector, source) => {
      const page = await open();
      try {
        await select(page, "a", await find(page, "words to select"));
        const from = await find(page, source);
        const to = await find(page, "trailing words", "trailing words".length);
        const pill = (await page.locator(selector).boundingBox())!;
        const end = await point(page, to);
        await page.mouse.move(pill.x + 2, pill.y + pill.height / 2);
        await page.mouse.down();
        await page.mouse.move(end.x, end.y, { steps: 8 });
        expect(await page.locator(selector).count()).toBe(1);
        await release(page);
        expect((await selection(page)).anchor).toBe(from);
        expect((await selection(page)).head).toBe(to);
        expect(await page.locator(selector).count()).toBe(0);
        await expectCopy(page);
        expect(await page.evaluate(() => window.selectionHarness.opened)).toEqual([]);
      } finally {
        await page.context().close();
      }
    },
    30_000,
  );

  test.each([
    ["note reference", "#a .k2b-reference", "/app/notebooks/n1/notes/abc123"],
    ["mail link", "#a .cm-link-label.cm-link-open", "mailto:ada@example.com"],
  ])(
    "a click on a %s opens it and keeps the editor's cursor",
    async (_name, selector, target) => {
      const page = await open();
      try {
        const caret = await find(page, "words to select");
        await select(page, "a", caret);
        await page.locator(selector).click();
        await page.waitForFunction(() => !window.selectionHarness.held("a"));
        await settle(page);
        expect(await page.evaluate(() => window.selectionHarness.opened)).toEqual([target]);
        expect((await selection(page)).head).toBe(caret);
        expect((await selection(page)).anchor).toBe(caret);
        expect(await page.locator(selector).count()).toBe(1);
      } finally {
        await page.context().close();
      }
    },
    30_000,
  );

  test("a click on a tag opens the tag's notes", async () => {
    const page = await open();
    try {
      await select(page, "a", await find(page, "words to select"));
      await Promise.all([page.waitForURL("**/app/notebooks/n1/tags/mytag"), page.locator("#a .cm-tag-pill").click()]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("remote carets follow text height and remain visible in replaced links and tables", async () => {
    const page = await open();
    try {
      await select(page, "b", await find(page, "Final paragraph"));
      for (const [text, offset] of [
        ["Project heading", 5],
        ["bold", 2],
        ["text and", 0],
        ["Open task item", 5],
        ["https://example.com", 8],
        ["Alpha", 2],
      ] as const) {
        const head = await find(page, text, offset);
        await select(page, "a", head);
        const box = await expectCaret(page, head);
        if (text === "Project heading") expect(box.height).toBeGreaterThan(20);
      }
      const lineEnd = await page.evaluate(() => {
        const view = window.selectionHarness.views.a;
        return view.state.doc.lineAt(window.selectionHarness.find("a", "Some **bold**")).to;
      });
      await select(page, "a", lineEnd);
      await expectCaret(page, lineEnd);
      await page.keyboard.type("!");
      const moved = (await selection(page)).head;
      expect(moved).toBe(lineEnd + 1);
      await expectCaret(page, moved);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("a remote multi-line selection leaves every line's text in place", async () => {
    const page = await open();
    try {
      await select(page, "b", await find(page, "Final paragraph"));
      const before = await page.evaluate(() => window.selectionHarness.lineEdges("b"));
      const anchor = await find(page, "Some **bold**");
      const head = await find(page, "Done task item", 4);
      await select(page, "a", anchor, head);
      await page.waitForSelector("#b .cm-remoteSelection");
      const after = await page.evaluate(() => window.selectionHarness.lineEdges("b"));
      expect(after).toEqual(before);
      expect(await page.locator("#b .cm-remoteSelection").count()).toBeGreaterThan(1);
      expect(await page.locator("#b .cm-line.cm-yLineSelection, #b .cm-content .cm-remoteSelection").count()).toBe(0);
      await expectCaret(page, head, anchor);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("a phone tap places the caret without holding subsequent touch selections", async () => {
    const { defaultBrowserType: _, ...device } = devices[browserName === "webkit" ? "iPhone 15" : "Pixel 7"];
    const page = await open({ ...device, viewport: { width: 390, height: 844 } });
    try {
      const pos = await find(page, "Final paragraph", 6);
      const target = await point(page, pos);
      await page.touchscreen.tap(target.x, target.y);
      await settle(page);
      expect((await selection(page)).head).toBe(pos);
      expect(await page.evaluate(() => window.selectionHarness.held("a"))).toBe(false);
      await select(page, "a", pos, pos + 5);
      expect(await page.locator("#a .cm-selectionBackground").count()).toBeGreaterThan(0);
      await expectCopy(page);
      expect(await page.evaluate(() => window.selectionHarness.held("a"))).toBe(false);
    } finally {
      await page.context().close();
    }
  }, 30_000);
});
