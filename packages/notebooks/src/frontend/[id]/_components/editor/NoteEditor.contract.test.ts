import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

describe("Note editor surface", () => {
  test("terminal sync errors end in the inline recovery bar, never in an automatic reload", async () => {
    // sync-ended.behavior.test.tsx covers the bar itself; this pins the editor's wiring to it.
    const source = await Bun.file(resolve(import.meta.dir, "NoteEditor.client.tsx")).text();
    expect(source).toMatch(/onFatal: \(error\) => \{\s*syncState\.end\(\);\s*syncEnded\.end\(error\);/);
    expect(source).not.toContain("refreshCurrentPath");
  });
  test("moves the caret to the end only for presses that missed the editor", async () => {
    // Ticking a checklist box redraws the pressed box out of the editor, so a plain `.closest(".cm-editor")` check
    // treats that press as a miss and scrolls to the end. lists.browser.test.ts covers the shared guard in a browser.
    const source = await Bun.file(resolve(import.meta.dir, "NoteEditor.client.tsx")).text();

    expect(source).toMatch(
      /onMouseDown=\{\(event\) => \{\s*if \(props\.readOnly \|\| !pressMissedEditor\(event\)\) return;\s*event\.preventDefault\(\);\s*if \(focusEditor\(0, "end"\)\)/,
    );
  });
  test("parses the note for headings only in the debounced pass, never on every text update", async () => {
    // A long note took about half a second per parse; the text observer only restarts the debounce.
    const source = await Bun.file(resolve(import.meta.dir, "NoteEditor.client.tsx")).text();
    const observer = source.match(/const onTextUpdate = \(\) => \{([\s\S]*?)\n {2}\};/)?.[1] ?? "";
    expect(observer).toContain("scheduleDerivedEmit()");
    expect(observer).not.toMatch(/extractHeadingLines|toString\(\)|schedulePanelLocations/);
    expect(source).toMatch(
      /const emitDerivedDocState = \(\) => \{\s*const md = currentText\(\);\s*headingLines = extractHeadingLines\(md\);/,
    );
  });
  test("jumps to a heading found in the current document, not the debounced index", async () => {
    // The cached index lags an edit by the debounce; a stale line could land elsewhere or throw for a shorter note.
    const source = await Bun.file(resolve(import.meta.dir, "NoteEditor.client.tsx")).text();
    const handler = source.match(/const onScrollToHeading = \(event: Event\) => \{([\s\S]*?)\n {2}\};/)?.[1] ?? "";
    expect(handler).toContain("extractHeadingLines(view.state.doc.toString())");
    expect(handler).toContain("target.line > view.state.doc.lines");
    expect(handler).not.toContain("headingLines.find");
  });
  test("answers a late panel's state request with the text mode too", async () => {
    // A panel that hydrates after the editor missed the first mode event and would invert Formatted and Markdown.
    const source = await Bun.file(resolve(import.meta.dir, "NoteEditor.client.tsx")).text();
    const handler = source.match(/const onSyncStateRequest = \(\) => \{([\s\S]*?)\n {2}\};/)?.[1] ?? "";
    expect(handler).toContain("RICH_MODE_CHANGED_EVENT");
  });
  test("ignores a Back that stays on the shown address, such as a closing phone sheet", async () => {
    // A sheet leaves its same-address history entry with a Back; handling it as note navigation jumped to the heading
    // in the address and reset the reader's scroll.
    const source = await Bun.file(resolve(import.meta.dir, "NoteEditor.client.tsx")).text();
    const handler = source.match(/const onPopState = \(\) => \{([\s\S]*?)\n {4}\};/)?.[1] ?? "";
    expect(handler).toMatch(/if \(window\.location\.href === shownHref\) \{\s*navigation\.cancel\(\);\s*return;\s*\}[\s\S]*navigateSoft/);
  });
});
