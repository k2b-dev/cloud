import { describe, expect, spyOn, test } from "bun:test";
import { history, isolateHistory, undo } from "@codemirror/commands";
import { forceParsing } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import { basicExtensions } from "../editor/basic";
import { markdownExtension } from "../editor/markdown";
import { asUndoStep, isolateYjsHistory } from "./history";

const loading = createDomTestHarness();
const { listCommandsExtension } = await import("../editor/list-commands");
const { caretFormat, insertTable } = await import("../../[id]/_components/editor/editor-actions");
const { default: EditorToolbar } = await import("../../[id]/_components/editor/EditorToolbar");
const { LocaleProvider } = await import("@k2b/ui");
loading.cleanup();

const mount = (doc: string, extensions: Extension[] = []) => {
  const dom = createDomTestHarness();
  const view = new EditorView({
    parent: dom.root,
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [basicExtensions(), markdownExtension(), listCommandsExtension(), ...extensions],
    }),
  });
  forceParsing(view, doc.length, 5000);
  return {
    dom,
    view,
    text: () => view.state.doc.toString(),
    type(text: string) {
      const at = view.state.selection.main.head;
      view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent: "input.type" });
    },
    [Symbol.dispose]() {
      view.destroy();
      dom.cleanup();
    },
  };
};

describe("Yjs undo boundaries", () => {
  if (isServer) {
    test.skip("needs browser export conditions", () => {});
    return;
  }

  test.each(["Bold", "Highlight", "Heading 2", "Bullet list", "Indent", "Info", "Table"])(
    "one undo removes toolbar %s and preserves both clients' text",
    async (label) => {
      const original = label === "Indent" ? "- parent\n- " : "base\n\n";
      const a = new Y.Doc(),
        b = new Y.Doc();
      const aText = a.getText("codemirror"),
        bText = b.getText("codemirror");
      aText.insert(0, original);
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
      const manager = new Y.UndoManager(aText);
      const [format, setFormat] = createSignal(caretFormat(EditorState.create()));
      using clientA = mount(original, [
        yCollab(aText, null, { undoManager: manager }),
        isolateYjsHistory(manager),
        EditorView.updateListener.of((update) => {
          if (update.docChanged || update.selectionSet) setFormat(caretFormat(update.state));
        }),
      ]);
      const toolbarHost = clientA.dom.document.createElement("div");
      clientA.dom.root.append(toolbarHost);
      const dispose = render(
        () => (
          <LocaleProvider locale="en">
            <EditorToolbar
              connected
              editorView={clientA.view}
              notebookId="Book01"
              noteId="Note01"
              initialPanelOpen={false}
              format={format()}
              onUndo={() => {
                manager.undo();
              }}
              onRedo={() => {
                manager.redo();
              }}
            />
          </LocaleProvider>
        ),
        toolbarHost,
      );
      using clientB = mount(original, [yCollab(bText, null)]);
      try {
        clientA.type("word");
        const typed = clientA.text();
        if (label === "Table") await asUndoStep(clientA.view, () => insertTable(clientA.view, { rows: 1, cols: 1 }, "en"));
        else {
          const button = Array.from(toolbarHost.querySelectorAll<HTMLButtonElement>("button")).find(
            (button) => button.getAttribute("aria-label") === label || button.textContent?.trim().startsWith(label),
          );
          if (!button) throw new Error(`Missing ${label}`);
          button.click();
        }
        expect(clientA.text()).not.toBe(typed);
        clientB.view.dispatch({ changes: { from: 1, insert: "X" }, userEvent: "input.type" });
        Y.applyUpdate(a, Y.encodeStateAsUpdate(b), "remote");
        Y.applyUpdate(b, Y.encodeStateAsUpdate(a), "remote");
        expect(clientA.text()).toBe(clientB.text());
        manager.undo();
        expect(clientA.text()).toBe(typed.slice(0, 1) + "X" + typed.slice(1));
        manager.undo();
        expect(clientA.text()).toBe(original.slice(0, 1) + "X" + original.slice(1));
      } finally {
        dispose();
        manager.destroy();
        a.destroy();
        b.destroy();
      }
    },
  );

  test.each(["seed\n", "- "])("typing, Enter, typing are three undo steps (prefix %s)", (prefix) => {
    const a = new Y.Doc(),
      b = new Y.Doc();
    const text = a.getText("codemirror");
    text.insert(0, prefix);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const manager = new Y.UndoManager(text);
    using editor = mount(prefix, [yCollab(text, null, { undoManager: manager }), isolateYjsHistory(manager)]);
    try {
      editor.type("abc");
      const event = new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true, cancelable: true });
      editor.view.contentDOM.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      const entered = editor.text();
      editor.type("def");
      b.getText("codemirror").insert(1, "X");
      Y.applyUpdate(a, Y.encodeStateAsUpdate(b), "remote");
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a), "remote");
      const peer = (text: string) => text.slice(0, 1) + "X" + text.slice(1);
      expect(editor.text()).toBe(`${peer(entered)}def`);
      manager.undo();
      expect(editor.text()).toBe(peer(entered));
      manager.undo();
      expect(editor.text()).toBe(`${peer(prefix)}abc`);
      manager.undo();
      expect(editor.text()).toBe(peer(prefix));
    } finally {
      manager.destroy();
      a.destroy();
      b.destroy();
    }
  });

  test("empty boundary transactions reach the extender and listener", () => {
    const doc = new Y.Doc();
    const text = doc.getText("codemirror");
    const manager = new Y.UndoManager(text);
    const stop = spyOn(manager, "stopCapturing");
    const boundaries: string[] = [];
    using editor = mount("", [
      yCollab(text, null, { undoManager: manager }),
      isolateYjsHistory(manager),
      EditorView.updateListener.of((update) => {
        for (const tr of update.transactions) {
          const value = tr.annotation(isolateHistory);
          if (value) boundaries.push(value);
        }
      }),
    ]);
    try {
      stop.mockClear();
      asUndoStep(editor.view, () => {});
      expect(boundaries).toEqual(["before", "after"]);
      expect(stop).toHaveBeenCalledTimes(2);
    } finally {
      stop.mockRestore();
      manager.destroy();
      doc.destroy();
    }
  });

  test("async actions also isolate CodeMirror history", async () => {
    using editor = mount("", [history()]);
    editor.type("before");
    await asUndoStep(editor.view, async () => {
      await Promise.resolve();
      editor.type("action");
    });
    editor.type("after");
    undo(editor.view);
    expect(editor.text()).toBe("beforeaction");
    undo(editor.view);
    expect(editor.text()).toBe("before");
    undo(editor.view);
    expect(editor.text()).toBe("");
  });

  test("an async action may finish after the note closed", async () => {
    using editor = mount("");
    let finish = () => {};
    const pending = asUndoStep(
      editor.view,
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    editor.view.destroy();
    finish();
    await pending;
    expect(editor.text()).toBe("");
  });
});
