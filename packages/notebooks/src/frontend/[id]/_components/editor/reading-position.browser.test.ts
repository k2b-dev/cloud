import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type Browser, chromium } from "playwright";

// Rewrapping depends on real text layout, so the note editor's arrangement runs
// in Chromium: a wrapping CodeMirror grows inside a scroll port beside a sidebar.
const entry = resolve(import.meta.dir, "reading-position.fixture.ts");
const fixture = `
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { keepReadingPosition } from ${JSON.stringify(resolve(import.meta.dir, "reading-position.ts"))};

const sidebar = document.getElementById("sidebar");
const port = document.getElementById("port");
const sentence = "A long paragraph of meeting notes that wraps across several lines in a narrow editor column. ";
const doc = Array.from({ length: 80 }, (_, index) => \`Paragraph \${index + 1}: \${sentence.repeat(3)}\`).join("\\n\\n");
const view = new EditorView({ parent: port, state: EditorState.create({ doc, extensions: [EditorView.lineWrapping] }) });
const frame = () => new Promise((settle) => requestAnimationFrame(settle));
const paragraph = view.state.doc.line(79); // "Paragraph 40"
/** Where paragraph 40 starts, relative to the port's top edge, without making the editor measure. */
const offset = () => Math.round(port.querySelectorAll(".cm-line")[Array.from(port.querySelectorAll(".cm-line")).findIndex((line) => line.textContent.startsWith("Paragraph 40:"))].getBoundingClientRect().top - port.getBoundingClientRect().top);

window.run = async ({ focus, keep }) => {
  view.dispatch({ selection: { anchor: paragraph.from + 5 } });
  if (focus) view.focus();
  for (let i = 0; i < 4; i++) {
    port.scrollTop += Math.round(view.coordsAtPos(paragraph.from).top - port.getBoundingClientRect().top) - 40;
    for (let j = 0; j < 3; j++) await frame();
  }
  const result = { before: offset(), steps: [] };
  for (const hidden of [true, false]) {
    const restore = keep ? keepReadingPosition(view, port) : () => {};
    sidebar.hidden = hidden;
    await Promise.resolve();
    restore();
    // Every painted frame after the change, read before the next paint.
    const painted = [];
    for (let i = 0; i < 6; i++) {
      await frame();
      painted.push(offset());
    }
    result.steps.push(painted);
  }
  result.selection = view.state.selection.main.head;
  result.focused = view.hasFocus;
  result.caret = paragraph.from + 5;
  return result;
};
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the reading position fixture.");
const script = await build.outputs[0]!.text();

type Run = { before: number; steps: number[][]; selection: number; focused: boolean; caret: number };

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const run = async (options: { focus: boolean; keep: boolean }): Promise<Run> => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  try {
    await page.setContent(
      `<!doctype html><html><body style="margin:0;font:16px/1.5 sans-serif">` +
        `<div style="display:flex;height:600px"><aside id="sidebar" style="flex:0 0 360px"></aside>` +
        `<div id="port" style="flex:1;min-width:0;overflow:auto"></div></div></body></html>`,
    );
    await page.addScriptTag({ content: script });
    return (await page.evaluate("window.run(" + JSON.stringify(options) + ")")) as Run;
  } finally {
    await page.close();
  }
};

/** The paragraph moves by less than a line in every painted frame. */
const steady = (offsets: number[], expected: number) => offsets.every((offset) => Math.abs(offset - expected) < 24);

describe("note reading position when the navigation hides and shows", () => {
  for (const focus of [true, false]) {
    test(`keeps the paragraph at the top steady in every painted frame with ${focus ? "a focused" : "an unfocused"} editor`, async () => {
      const result = await run({ focus, keep: true });
      expect(Math.abs(result.before - 40)).toBeLessThanOrEqual(2);
      for (const painted of result.steps) {
        expect({ painted, steady: steady(painted, result.before) }).toEqual({ painted, steady: true });
        // No later correction either: the first painted frame is the final position.
        expect(new Set(painted).size).toBe(1);
      }
      expect(result.selection).toBe(result.caret);
      expect(result.focused).toBe(focus);
    });
  }

  test("without it a focused editor paints the rewrapped note at a different position first", async () => {
    const result = await run({ focus: true, keep: false });
    expect(result.steps.some((painted) => !steady(painted, result.before) || new Set(painted).size > 1)).toBe(true);
  });
});
