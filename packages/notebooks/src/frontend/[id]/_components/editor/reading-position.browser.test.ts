import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser } from "../../../../../../ui/test/browser";

// Rewrapping depends on real text layout, so the note editor's arrangement runs
// in a real browser: a wrapping CodeMirror grows inside a scroll port beside a sidebar.
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
const lines = () => Array.from(port.querySelectorAll(".cm-line"));
const portTop = () => port.getBoundingClientRect().top;
/** Where a paragraph starts, relative to the port's top edge, without making the editor measure. */
const offset = (label) => Math.round(lines().find((line) => line.textContent.startsWith(label)).getBoundingClientRect().top - portTop());
/** The first paragraph that starts at or below the port's top edge, such as "Paragraph 40:". */
const topParagraph = () => lines().find((line) => line.textContent && line.getBoundingClientRect().top >= portTop()).textContent.split(":")[0] + ":";

/** Scrolls paragraph 40 to 40px below the port's top edge; its line stays rendered as the selected one. */
const scrollToParagraph = () => {
  port.scrollTop += Math.round(view.coordsAtPos(paragraph.from).top - portTop()) - 40;
};

window.run = async ({ focus, keep, focusOnHide, unnoticedScroll }) => {
  view.dispatch({ selection: { anchor: paragraph.from + 5 } });
  if (focus) view.focus();
  if (!unnoticedScroll) {
    for (let i = 0; i < 4; i++) {
      scrollToParagraph();
      for (let j = 0; j < 3; j++) await frame();
    }
  }
  // A tree row in the navigation has focus when the navigation hides.
  if (focusOnHide) document.getElementById("row").focus();
  for (let j = 0; j < 3; j++) await frame();
  // Scroll events arrive with the next frame, so the editor has not seen this
  // jump yet when the navigation hides in the same task: it still renders the
  // start of the note and only a gap at the port's top edge.
  if (unnoticedScroll) scrollToParagraph();
  const result = { scrolled: offset("Paragraph 40:"), steps: [] };
  let label;
  for (const hidden of [true, false]) {
    const restore = keep ? keepReadingPosition(view, port) : () => {};
    // The text a reader sees at the top right before the navigation changes.
    // An editor that had not drawn this part of the note yet has drawn it now,
    // with its real line heights in place of estimates.
    if (!label) {
      label = topParagraph();
      result.before = offset(label);
    }
    sidebar.hidden = hidden;
    // Hiding the navigation while a tree row had focus hands focus to the note.
    if (focusOnHide && hidden) view.focus();
    await Promise.resolve();
    restore();
    // Every painted frame after the change, read before the next paint.
    const painted = [];
    for (let i = 0; i < 6; i++) {
      await frame();
      painted.push(offset(label));
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

type Run = { scrolled: number; before: number; steps: number[][]; selection: number; focused: boolean; caret: number };

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const run = async (options: { focus: boolean; keep: boolean; focusOnHide?: boolean; unnoticedScroll?: boolean }): Promise<Run> => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  try {
    await page.setContent(
      `<!doctype html><html><body style="margin:0;font:16px/1.5 sans-serif">` +
        `<div style="display:flex;height:600px"><aside id="sidebar" style="flex:0 0 360px"><button id="row">Note</button></aside>` +
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
      expect(Math.abs(result.scrolled - 40)).toBeLessThanOrEqual(2);
      for (const painted of result.steps) {
        expect({ painted, steady: steady(painted, result.before) }).toEqual({ painted, steady: true });
        // No later correction either: the first painted frame is the final position.
        expect(new Set(painted).size).toBe(1);
      }
      expect(result.selection).toBe(result.caret);
      expect(result.focused).toBe(focus);
    });
  }

  // The writer was in the note before a tree row took focus, so the editor has
  // drawn text above the port's top edge too. Once it has focus again, it
  // scrolls by itself to keep that text in place when it measures.
  test("keeps the paragraph steady when hiding moves focus from a tree row back into the editor", async () => {
    const result = await run({ focus: true, keep: true, focusOnHide: true });
    expect(Math.abs(result.scrolled - 40)).toBeLessThanOrEqual(2);
    for (const painted of result.steps) {
      expect({ painted, steady: steady(painted, result.before) }).toEqual({ painted, steady: true });
      expect(new Set(painted).size).toBe(1);
    }
    expect(result.selection).toBe(result.caret);
    expect(result.focused).toBe(true);
  });

  // A scroll reaches the editor with the next frame, and not at all while it
  // does not yet know it is visible (on a busy machine, right after it
  // mounts); until it measures, the port's top edge is only a gap to it.
  for (const focusOnHide of [false, true]) {
    test(`keeps the paragraph steady when an unfocused editor has not noticed the last scroll yet${focusOnHide ? " and hiding moves focus into it" : ""}`, async () => {
      const result = await run({ focus: false, keep: true, focusOnHide, unnoticedScroll: true });
      expect(Math.abs(result.scrolled - 40)).toBeLessThanOrEqual(2);
      for (const painted of result.steps) {
        expect({ painted, steady: steady(painted, result.before) }).toEqual({ painted, steady: true });
        expect(new Set(painted).size).toBe(1);
      }
      expect(result.selection).toBe(result.caret);
      expect(result.focused).toBe(focusOnHide);
    });
  }

  test("without it a focused editor paints the rewrapped note at a different position first", async () => {
    const result = await run({ focus: true, keep: false });
    expect(result.steps.some((painted) => !steady(painted, result.before) || new Set(painted).size > 1)).toBe(true);
  });
});
