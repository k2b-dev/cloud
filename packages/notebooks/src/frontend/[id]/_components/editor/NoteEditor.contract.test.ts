import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

describe("Note editor surface", () => {
  test("terminal sync errors end in the inline recovery bar, never in an automatic reload", async () => {
    // sync-ended.behavior.test.tsx covers the bar itself; this pins the editor's wiring to it.
    const source = await Bun.file(resolve(import.meta.dir, "NoteEditor.client.tsx")).text();
    expect(source).toContain("onFatal: syncEnded.end");
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
});
