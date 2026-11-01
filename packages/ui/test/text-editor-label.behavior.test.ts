import { describe, expect, test } from "bun:test";
import { ViewPlugin } from "@codemirror/view";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "./dom";

describe("text editor label", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test("a label derived from the text changes during an editor update without a nested dispatch", async () => {
    const dom = createDomTestHarness();
    const { createTextEditor } = await import("../src/text-editor/engine");
    let editor: ReturnType<typeof createTextEditor> | undefined;
    editor = createTextEditor({
      parent: dom.root,
      doc: "# Draft",
      label: "Draft",
      host: {
        undo() {},
        redo() {},
        boundary() {},
        cellLabel: (row, column) => `${row}, ${column}`,
        maxLength: 10_000,
        maxPasteCells: 100,
        onError() {},
        onRecovery() {},
      },
      // A host that names the editor after the note's title sets the label while the view is still updating, for
      // example from a Solid effect that a plugin's signal write runs synchronously.
      extensions: ViewPlugin.define(() => ({
        update(update) {
          if (update.docChanged) editor?.setLabel(update.state.doc.line(1).text.replace(/^#\s*/, ""));
        },
      })),
    });
    try {
      editor.view.dispatch({ changes: { from: 7, insert: " notes" } });
      expect(editor.view.contentDOM.getAttribute("aria-label")).toBe("Draft notes");
      // The next update keeps the label instead of restoring the initial one.
      editor.view.dispatch({ selection: { anchor: 0 } });
      expect(editor.view.contentDOM.getAttribute("aria-label")).toBe("Draft notes");
      editor.setLabel("Renamed");
      expect(editor.view.contentDOM.getAttribute("aria-label")).toBe("Renamed");
    } finally {
      editor.destroy();
      dom.cleanup();
    }
  });
});
