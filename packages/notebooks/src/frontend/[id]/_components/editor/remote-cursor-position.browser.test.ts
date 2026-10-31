/**
 * Where another person's caret shows in the Notebook editor: on the character in text, also after scrolling, an edit
 * of theirs above it and a narrower window, and along the whole block when it sits inside a rendered table, formula or
 * info block, whose source this editor does not show.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../../../../ui/test/browser";
import { startNotebookEditorFixture } from "./shared-text-editor.browser-fixture";

let browser: Browser;
let server: Awaited<ReturnType<typeof startNotebookEditorFixture>>;
beforeAll(async () => {
  server = await startNotebookEditorFixture();
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.stop();
});

const prose = "Wir planen das Budget und halten fest, welche Fragen noch offen sind";
const doc = [
  "# Budget",
  "",
  `Intro ${prose}.`,
  "",
  "@costs",
  "| Item | Hours | Cost |",
  "| --- | ---: | ---: |",
  "| Design | 2 | =Hours*50 |",
  "",
  "$$",
  "E = mc^2",
  "$$",
  "",
  ":::info",
  "Hinweis zum Ablauf",
  ":::",
  "",
  ...Array.from({ length: 30 }, (_, index) => `Zeile${index} ${prose} und **fett** Ende${index}.\n`),
  "Schluss Zielwort hier.",
].join("\n");

const open = async (page: Page) => {
  const url = new URL(server.url.href);
  url.searchParams.set("doc", doc);
  await page.goto(url.href);
  await page.waitForFunction(() => window.noteHarness?.ready());
};

const caret = (page: Page) =>
  page.evaluate(() => {
    const box = document.querySelector(".cm-remoteCaret")?.getBoundingClientRect();
    return box ? { left: Math.round(box.left), top: Math.round(box.top), bottom: Math.round(box.bottom) } : null;
  });

/** The second character of the first drawn text that contains `target`: the peer's caret sits right after the first. */
const character = (page: Page, target: string) =>
  page.evaluate((target) => {
    const walker = document.createTreeWalker(document.querySelector(".cm-content")!, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent!.indexOf(target);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at + 1);
      range.setEnd(node, at + 2);
      const box = range.getBoundingClientRect();
      return { left: Math.round(box.left), top: Math.round(box.top) };
    }
    return null;
  }, target);

/** CodeMirror redraws its layers 50 ms after a resize, so the caret may take a moment to reach its character. */
const onCharacter = async (page: Page, target: string) => {
  const reached = async () => {
    const [expected, drawn] = [await character(page, target), await caret(page)];
    return !!expected && !!drawn && Math.abs(drawn.left - expected.left) <= 1 && drawn.top === expected.top;
  };
  for (let attempt = 0; attempt < 20 && !(await reached()); attempt++) await page.waitForTimeout(25);
  expect({ target, onCharacter: await reached(), drawn: await caret(page), expected: await character(page, target) }).toMatchObject({
    target,
    onCharacter: true,
  });
};

test("another person's caret stays on its character in text", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 700 } });
  const page = await context.newPage();
  const errors = pageErrors(page);
  try {
    await open(page);
    await page.evaluate(() => window.noteHarness.peerCursor("Intro"));
    await page.evaluate(() => window.noteHarness.settle());
    await onCharacter(page, "Intro");

    await page.evaluate(() => window.noteHarness.peerCursor("Zielwort"));
    await page.evaluate(async () => {
      const port = document.querySelector<HTMLElement>(".k2b-scroll-area")!;
      port.scrollTop = port.scrollHeight;
      await window.noteHarness.settle();
    });
    await onCharacter(page, "Zielwort");

    await page.evaluate(() =>
      window.noteHarness.peerType("Zeile1 ", "Eine längere Ergänzung der anderen Person, die eine Zeile umbricht. "),
    );
    await page.evaluate(() => window.noteHarness.settle());
    await onCharacter(page, "Zielwort");

    await page.setViewportSize({ width: 900, height: 700 });
    await settled(page);
    await onCharacter(page, "Zielwort");
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 60_000);

test("inside a rendered block, another person's caret runs along the whole block", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = pageErrors(page);
  try {
    await open(page);
    for (const [target, block] of [
      ["Design", ".k2b-ste-table"],
      ["mc^2", ".cm-katex-block"],
      ["Hinweis", ".cm-notice-card-widget"],
    ] as const) {
      await page.evaluate((target) => window.noteHarness.peerCursor(target), target);
      await page.evaluate(() => window.noteHarness.settle());
      const box = await page.evaluate((selector) => {
        const rect = document.querySelector(selector)!.getBoundingClientRect();
        return { top: Math.round(rect.top), bottom: Math.round(rect.bottom) };
      }, block);
      const drawn = await caret(page);
      // The caret covers the rendered block from its top to its bottom, not one line at its top. The block's line
      // includes the widget's margin of a few pixels.
      expect({ target, covers: !!drawn && drawn.top <= box.top + 3 && drawn.bottom >= box.bottom - 3 }).toEqual({ target, covers: true });
    }
    // In a table the cell itself names the person as well.
    await page.evaluate(() => window.noteHarness.peerCursor("Design"));
    await page.evaluate(() => window.noteHarness.settle());
    expect(await page.locator(".k2b-ste-table [data-peer='Paul']").count()).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 60_000);
