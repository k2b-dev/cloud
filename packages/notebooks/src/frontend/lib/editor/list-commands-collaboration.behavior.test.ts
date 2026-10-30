import { describe, expect, test } from "bun:test";
import { forceParsing } from "@codemirror/language";
import { EditorState, type Extension, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { isServer } from "solid-js/web";
import { YSyncConfig, yCollab, ySyncAnnotation } from "y-codemirror.next";
import * as Y from "yjs";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import { isolateYjsHistory } from "../yjs/history";

// Notebook block scanners load UI browser exports after DOM globals exist.
const loading = createDomTestHarness();
const { basicExtensions, markdownExtension } = await import("@k2b/editor/markdown");
const { notebookListOptions } = await import("./notebook-options");
const { excludedSpans, listStructure } = await import("@k2b/editor/markdown");
const { listCommandsExtension } = await import("@k2b/editor/markdown");
const { tabIndentExtension } = await import("@k2b/editor/markdown");
loading.cleanup();

const mount = (doc: string, head = doc.length, tab = true, extensions: Extension[] = [], parse = true) => {
  const dom = createDomTestHarness();
  const view = new EditorView({
    parent: dom.root,
    state: EditorState.create({
      doc,
      selection: { anchor: head },
      extensions: [
        basicExtensions(),
        markdownExtension(),
        listCommandsExtension(notebookListOptions),
        tab ? tabIndentExtension() : [],
        ...extensions,
      ],
    }),
  });
  if (parse) forceParsing(view, doc.length, 5000);
  const press = (
    key: "Tab" | "Enter" | "Backspace" | "ArrowUp" | "ArrowDown" | "]" | "[" | "&" | "*" | "(" | "/",
    modifiers: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; code?: string } = {},
  ) => {
    const keyCode = { Tab: 9, Enter: 13, Backspace: 8, ArrowUp: 38, ArrowDown: 40, "]": 221, "[": 219, "&": 55, "*": 56, "(": 57, "/": 55 }[
      key
    ];
    const event = new KeyboardEvent("keydown", { key, keyCode, ...modifiers, bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const type = (text: string) => {
    const { from, to } = view.state.selection.main;
    const insert = () =>
      view.state.update({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: "input.type" });
    if (!view.state.facet(EditorView.inputHandler).some((handler) => handler(view, from, to, text, insert))) view.dispatch(insert());
  };
  const text = () => view.state.doc.toString();
  const structure = () => listStructure(view.state, () => excludedSpans(view.state));
  return {
    view,
    press,
    type,
    text,
    structure,
    [Symbol.dispose]() {
      view.destroy();
      dom.cleanup();
    },
  };
};

describe("notebook structural list commands", () => {
  if (isServer) {
    test.skip("list keys need browser export conditions", () => {});
    return;
  }

  test.each(["delete", "enter", "move"] as const)("concurrent %s preserves list syntax and retained subtree edits", (action) => {
    const original =
      action === "delete"
        ? "1. A\n2. B\n3. C\n4. D\n5. E\n6. F"
        : action === "enter"
          ? "1. A\n2. B\n3. C\n4. D"
          : "- A\n- B\n  - child\n- C";
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.getText("codemirror").insert(0, original);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    using clientA = mount(original, action === "enter" ? original.indexOf("A") + 1 : original.indexOf("B"), true, [
      yCollab(a.getText("codemirror"), null),
    ]);
    using clientB = mount(original, original.length, true, [yCollab(b.getText("codemirror"), null)]);
    try {
      if (action === "delete") {
        clientA.view.dispatch({ changes: { from: original.indexOf("2. B"), to: original.indexOf("3. C") }, userEvent: "delete.line" });
        clientB.view.dispatch({ changes: { from: original.indexOf("4. D"), to: original.indexOf("5. E") }, userEvent: "delete.line" });
      } else if (action === "enter") {
        expect(clientA.press("Enter")).toBe(true);
        clientB.view.dispatch({ changes: { from: original.indexOf("2. B"), to: original.indexOf("3. C") }, userEvent: "delete.line" });
      } else {
        expect(clientA.press("ArrowUp", { altKey: true })).toBe(true);
        clientB.view.dispatch({ changes: { from: original.indexOf("child") + 1, insert: "X" }, userEvent: "input.type" });
      }
      Y.applyUpdate(a, Y.encodeStateAsUpdate(b), "remote");
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a), "remote");
      expect(clientA.text()).toBe(clientB.text());
      if (action === "move") expect(clientA.text()).toBe("- B\n  - cXhild\n- A\n- C");
      else {
        for (const client of [clientA, clientB]) {
          forceParsing(client.view, client.text().length, 5000);
          const items = client.structure().items;
          expect(items).toHaveLength(4);
          expect(items.every((item) => item.ordered && item.depth === 0)).toBe(true);
          expect(new Set(items.map((item) => item.listFrom)).size).toBe(1);
        }
      }
    } finally {
      a.destroy();
      b.destroy();
    }
  });

  test("remote, undo, redo and ordinary text edits never repair lazy numbering", () => {
    const remoteDoc = new Y.Doc();
    for (const annotation of [
      ySyncAnnotation.of(new YSyncConfig(remoteDoc.getText("codemirror"), null)),
      Transaction.userEvent.of("undo"),
      Transaction.userEvent.of("redo"),
    ]) {
      using editor = mount("1. A\n1. B\n1. C");
      editor.view.dispatch({ changes: { from: 5, insert: "1. X\n" }, annotations: annotation });
      expect(editor.text()).toBe("1. A\n1. X\n1. B\n1. C");
    }
    remoteDoc.destroy();
    using typed = mount("1. A\n1. B\n1. C");
    typed.view.dispatch({ changes: { from: 8, insert: "x" }, userEvent: "input.type" });
    expect(typed.text()).toBe("1. A\n1. xB\n1. C");
  });

  test("Yjs groups indentation and repair into one exact undo and redo", () => {
    const doc = new Y.Doc();
    const text = doc.getText("codemirror");
    const original = "1. A\n2. B\n3. C";
    text.insert(0, original);
    const undoManager = new Y.UndoManager(text);
    using editor = mount(original, original.indexOf("B"), true, [yCollab(text, null, { undoManager })]);
    expect(editor.press("Tab")).toBe(true);
    expect(text.toString()).toBe("1. A\n   1. B\n2. C");
    expect(undoManager.undoStack).toHaveLength(1);
    undoManager.undo();
    expect(editor.text()).toBe(original);
    expect(text.toString()).toBe(original);
    undoManager.redo();
    expect(editor.text()).toBe("1. A\n   1. B\n2. C");
    undoManager.destroy();
    doc.destroy();
  });

  test("Yjs undoes Enter's existing number changes and column repair together", () => {
    const doc = new Y.Doc();
    const text = doc.getText("codemirror");
    const original = Array.from({ length: 8 }, (_, i) => `${i + 1}. item${i + 1}`).join("\n") + "\n9. tail\n   continuation\n   - child";
    text.insert(0, original);
    const undoManager = new Y.UndoManager(text);
    using editor = mount(original, original.indexOf("item5") + 5, true, [yCollab(text, null, { undoManager })]);
    let updates = 0;
    doc.on("update", () => updates++);
    expect(editor.press("Enter")).toBe(true);
    expect(text.toString()).toEndWith("10. tail\n    continuation\n    - child");
    expect(updates).toBe(1);
    expect(undoManager.undoStack).toHaveLength(1);
    undoManager.undo();
    expect(editor.text()).toBe(original);
    expect(text.toString()).toBe(original);
    undoManager.destroy();
    doc.destroy();
  });

  test("two clients receive without repair echoes and converge after concurrent edits", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const original = "1. A\n2. B\n3. C";
    a.getText("codemirror").insert(0, original);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const aUndo = new Y.UndoManager(a.getText("codemirror"));
    const bUndo = new Y.UndoManager(b.getText("codemirror"));
    using clientA = mount(original, original.indexOf("B"), true, [yCollab(a.getText("codemirror"), null, { undoManager: aUndo })]);
    using clientB = mount(original, original.indexOf("C"), true, [yCollab(b.getText("codemirror"), null, { undoManager: bUndo })]);
    let localB = 0;
    b.on("update", (_update, _origin, _doc, transaction) => {
      if (transaction.local) localB++;
    });
    clientA.press("Tab");
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a), "remote");
    expect(clientB.text()).toBe(clientA.text());
    expect(localB).toBe(0);
    // Disconnect, then make structural edits to the same list on both clients.
    clientA.view.dispatch({ changes: { from: clientA.text().length, insert: "\n1. D" }, userEvent: "input.paste" });
    clientB.view.dispatch({ changes: { from: clientB.text().length, insert: "\n1. E" }, userEvent: "input.paste" });
    expect(localB).toBe(1);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b), "remote");
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a), "remote");
    expect(clientA.text()).toBe(clientB.text());
    expect(localB).toBe(1);
    aUndo.destroy();
    bUndo.destroy();
    a.destroy();
    b.destroy();
  });
});

describe("notebook list typing and kinds", () => {
  test("collaborative undo restores the typed task prefix and space", () => {
    const doc = new Y.Doc();
    const text = doc.getText("codemirror");
    text.insert(0, "[]");
    const undoManager = new Y.UndoManager(text);
    using editor = mount("[]", 2, true, [yCollab(text, null, { undoManager }), isolateYjsHistory(undoManager)]);
    editor.type(" ");
    expect(editor.text()).toBe("- [ ] ");
    undoManager.undo();
    expect(editor.text()).toBe("[] ");
    undoManager.destroy();
    doc.destroy();
  });

  test.each(["Enter", "Backspace"] as const)("concurrent %s and another item edit converge", (key) => {
    const original = "- parent\n  - child\n- other";
    const a = new Y.Doc(),
      b = new Y.Doc();
    a.getText("codemirror").insert(0, original);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    using clientA = mount(original, key === "Enter" ? original.indexOf("parent") + 3 : original.indexOf("child"), true, [
      yCollab(a.getText("codemirror"), null),
    ]);
    using clientB = mount(original, original.length, true, [yCollab(b.getText("codemirror"), null)]);
    clientA.press(key);
    clientB.type("!");
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b), "remote");
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a), "remote");
    expect(clientA.text()).toBe(clientB.text());
    expect(clientA.text()).toBe(key === "Enter" ? "- par\n  - ent\n  - child\n- other!" : "- parent\n- child\n- other!");
    for (const client of [clientA, clientB]) {
      forceParsing(client.view, client.text().length, 5000);
      expect(client.structure().items).toHaveLength(key === "Enter" ? 4 : 3);
      expect(client.structure().items.every((item) => item.kind === "bullet")).toBe(true);
      expect(client.text()).toContain("- other!");
    }
    a.destroy();
    b.destroy();
  });
});
