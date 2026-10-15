import { describe, expect, test } from "bun:test";
import { Compartment, EditorState, type Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";

const loading = createDomTestHarness();
const { insertAttachment } = await import("./attachments-client");
loading.cleanup();

describe("attachment insertion", () => {
  if (isServer) {
    test.skip("attachment insertion runs with browser export conditions", () => {});
    return;
  }

  test("an insertion after the note becomes read-only dispatches no changes", () => {
    const dom = createDomTestHarness();
    const readOnly = new Compartment();
    const transactions: Transaction[] = [];
    const view = new EditorView({
      parent: dom.root,
      state: EditorState.create({
        doc: "note",
        selection: { anchor: 2 },
        extensions: [
          readOnly.of(EditorState.readOnly.of(false)),
          EditorView.updateListener.of((update) => transactions.push(...update.transactions)),
        ],
      }),
    });
    try {
      view.dispatch({ effects: readOnly.reconfigure(EditorState.readOnly.of(true)) });
      transactions.length = 0;
      insertAttachment(view, { id: "File01", kind: "file", filename: "file.txt" });
      insertAttachment(view, { id: "Image1", kind: "image", filename: "image.png" });
      expect(view.state.doc.toString()).toBe("note");
      expect(view.state.selection.main.head).toBe(2);
      expect(transactions).toHaveLength(0);
    } finally {
      view.destroy();
      dom.cleanup();
    }
  });
});
