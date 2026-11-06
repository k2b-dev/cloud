/**
 * Dragging the navigation's resize handle beside an open note: the editor stays mounted, its rendered blocks stay the
 * same elements, and the text at the top of the page stays in place in every painted frame while lines above it
 * rewrap. Uses the Notebook editor composition in the notebook page's workspace, with "Full width" so the column
 * follows the drag.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser } from "playwright";
import { launchBrowser, pageErrors } from "../../../../../../ui/test/browser";
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

const prose = "Wir planen das Budget und halten fest, welche Fragen noch offen sind. Everyone reads the same notes";
// Paragraphs of different lengths, tables with formulas and formulas: a narrower column rewraps some of them on
// nearly every frame of the drag.
const doc = [
  "# Budget",
  "",
  ...Array.from({ length: 48 }, (_, index) =>
    index % 6 === 0
      ? [
          `@costs${index}`,
          "| Item | Hours | Cost |",
          "| --- | ---: | ---: |",
          "| Design | 2 | =Hours*50 |",
          "| Build | 3 | =Hours*50 |",
          "",
          "$$",
          `x_{${index}} = \\frac{a}{b}`,
          "$$",
          "",
        ].join("\n")
      : `Absatz ${index}. ${Array.from({ length: 1 + (index % 4) }, () => prose).join(". ")}.\n`,
  ),
].join("\n");

test("dragging the navigation keeps the editor mounted and the text at the top of the page in place", async () => {
  const context = await browser.newContext({ viewport: { width: 1100, height: 860 } });
  const page = await context.newPage();
  const errors = pageErrors(page);
  try {
    const url = new URL(server.url.href);
    url.searchParams.set("workspace", "");
    url.searchParams.set("fullWidth", "");
    url.searchParams.set("doc", doc);
    await page.goto(url.href);
    await page.waitForFunction(() => window.noteHarness?.ready());
    // The reader is in the middle of the note, with tables and formulas above.
    await page.evaluate(async () => {
      const port = document.querySelector<HTMLElement>(".notebook-document-surface .k2b-scroll-area")!;
      port.scrollTop = 2400;
      await window.noteHarness.settle();
    });
    await page.evaluate(() => {
      const state = window as unknown as { replaced: number; offsets: number[] };
      const port = document.querySelector<HTMLElement>(".notebook-document-surface .k2b-scroll-area")!;
      const content = document.querySelector(".cm-content")!;
      const top = port.getBoundingClientRect().top;
      // The reading point: the block at the page's top edge and how far into it the edge falls. A table there keeps the
      // point inside it, so lines below it move with its own rewrap.
      const left = content.getBoundingClientRect().left + 2;
      const anchor = document.elementFromPoint(left, top + 1)!.closest(".cm-content > *")!;
      const share = (top - anchor.getBoundingClientRect().top) / anchor.getBoundingClientRect().height;
      const point = () => {
        const box = anchor.getBoundingClientRect();
        return box.top + share * box.height - port.getBoundingClientRect().top;
      };
      const start = point();
      state.replaced = 0;
      state.offsets = [];
      // Rendered tables and formulas are replaced only when the editor rebuilds them.
      new MutationObserver((records) => {
        for (const record of records)
          for (const node of record.removedNodes)
            if (node instanceof Element && node.matches(".k2b-ste-table, .cm-katex-block, [class*='widget']")) state.replaced++;
      }).observe(content, { childList: true, subtree: true });
      // Each resize of the page's scroll area reads the layout the browser paints next: this observer was created after
      // the editor's, so it runs after the editor held its place and before the paint. A read in an animation frame
      // could see a width the pointer set before the resize callbacks ran, a state that is never painted.
      new ResizeObserver(() => state.offsets.push(Math.round(point() - start))).observe(port);
    });
    const handle = (await page.locator('.k2b-app-workspace__resize[data-app-workspace-resize="sidebar"]').boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    for (let step = 1; step <= 40; step++) await page.mouse.move(handle.x + handle.width / 2 + step * 3, handle.y + handle.height / 2);
    for (let step = 39; step >= 0; step--) await page.mouse.move(handle.x + handle.width / 2 + step * 3, handle.y + handle.height / 2);
    await page.mouse.up();
    await page.evaluate(() => window.noteHarness.settle());
    const result = await page.evaluate(() => {
      const state = window as unknown as { replaced: number; offsets: number[] };
      return {
        mounts: window.noteHarness.mounts(),
        replaced: state.replaced,
        moved: state.offsets.filter((offset) => Math.abs(offset) > 1),
      };
    });
    expect(result).toEqual({ mounts: 1, replaced: 0, moved: [] });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 60_000);
