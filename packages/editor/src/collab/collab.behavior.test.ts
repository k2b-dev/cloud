import { describe, expect, test } from "bun:test";
import { isolateHistory } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

describe("@k2b/editor/collab", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  const mount = async () => {
    const dom = createDomTestHarness();
    // lib0 captures document at import time, so load Yjs after the harness.
    const Y = await import("yjs");
    const { Awareness } = await import("y-protocols/awareness");
    const { collab } = await import("./index");
    const doc = new Y.Doc();
    const text = doc.getText("text");
    text.insert(0, "shared");
    const undoManager = new Y.UndoManager(text);
    const awareness = new Awareness(doc);
    const view = new EditorView({
      parent: dom.root,
      state: EditorState.create({ doc: text.toString(), extensions: collab({ text, undoManager, awareness }) }),
    });
    return {
      Y,
      doc,
      text,
      undoManager,
      awareness,
      view,
      type(insert: string, isolate?: "before" | "after" | "full") {
        const at = view.state.selection.main.head;
        view.dispatch({
          changes: { from: at, insert },
          selection: { anchor: at + insert.length },
          userEvent: "input.type",
          annotations: isolate ? isolateHistory.of(isolate) : [],
        });
      },
      [Symbol.dispose]() {
        view.destroy();
        awareness.destroy();
        doc.destroy();
        dom.cleanup();
      },
    };
  };

  test("local typing reaches the shared text and remote changes reach the view", async () => {
    using page = await mount();
    page.view.dispatch({ selection: { anchor: 6 } });
    page.type("!");
    expect(page.text.toString()).toBe("shared!");
    page.doc.transact(() => page.text.insert(0, "a "), "remote");
    expect(page.view.state.doc.toString()).toBe("a shared!");
  });

  test("a history boundary in CodeMirror closes the Yjs undo step, so one undo removes one step", async () => {
    using page = await mount();
    page.view.dispatch({ selection: { anchor: 6 } });
    page.type(" one");
    page.type(" two", "before");
    page.undoManager.undo();
    expect(page.text.toString()).toBe("shared one");
    page.undoManager.undo();
    expect(page.text.toString()).toBe("shared");
  });

  test("the editor publishes its cursor as relative positions in the shared text", async () => {
    using page = await mount();
    page.view.focus();
    page.view.dispatch({ selection: { anchor: 2, head: 4 } });
    const cursor: unknown = page.awareness.getLocalState()?.cursor;
    if (!cursor || typeof cursor !== "object" || !("anchor" in cursor) || !("head" in cursor)) throw new Error("No cursor");
    const head = page.Y.createAbsolutePositionFromRelativePosition(page.Y.createRelativePositionFromJSON(cursor.head), page.doc);
    expect(head?.index).toBe(4);
  });

  test("focus in another field withdraws the cursor, and returning publishes the current selection", async () => {
    using page = await mount();
    const head = () => {
      const cursor: unknown = page.awareness.getLocalState()?.cursor;
      if (!cursor || typeof cursor !== "object" || !("head" in cursor)) return null;
      return page.Y.createAbsolutePositionFromRelativePosition(page.Y.createRelativePositionFromJSON(cursor.head), page.doc)?.index;
    };
    page.view.focus();
    page.view.dispatch({ selection: { anchor: 2, head: 4 } });
    expect(head()).toBe(4);

    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    // CodeMirror reports a focus change after 10 ms.
    await Bun.sleep(30);
    expect(page.view.hasFocus).toBe(false);
    expect(page.awareness.getLocalState()?.cursor).toBeNull();

    page.view.dispatch({ selection: { anchor: 5 } });
    page.view.focus();
    await Bun.sleep(30);
    expect(head()).toBe(5);

    // Focus in a control inside the editor, such as a table cell that publishes its own cursor, keeps the cursor.
    const cell = document.createElement("button");
    page.view.dom.append(cell);
    cell.focus();
    await Bun.sleep(30);
    page.view.dispatch({ changes: { from: 0, insert: "a" } });
    expect(page.view.hasFocus).toBe(false);
    expect(page.awareness.getLocalState()?.cursor).not.toBeNull();
  });
});
