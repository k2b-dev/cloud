import { describe, expect, test } from "bun:test";
import { history, undo } from "@codemirror/commands";
import { forceParsing, syntaxTree } from "@codemirror/language";
import { EditorState, type Extension, type Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isServer } from "solid-js/web";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import { basicExtensions } from "../../../lib/editor/basic";
import { markdownExtension } from "../../../lib/editor/markdown";

const loading = createDomTestHarness();
const { toggleInlineMark } = await import("./editor-actions");
const { formattingKeymap } = await import("./EditorToolbar");
const { renderNotebookBook } = await import("../../../../lib/book-renderer");
loading.cleanup();

const mount = (doc: string, anchor: number, head = anchor, extensions: Extension[] = []) => {
  const dom = createDomTestHarness();
  const transactions: Transaction[] = [];
  const view = new EditorView({
    parent: dom.root,
    state: EditorState.create({
      doc,
      selection: { anchor, head },
      extensions: [
        basicExtensions(),
        markdownExtension(),
        formattingKeymap({ notebookId: "n" }),
        ...extensions,
        EditorView.updateListener.of((update) => transactions.push(...update.transactions)),
      ],
    }),
  });
  forceParsing(view, doc.length, 5000);
  view.focus();
  view.dispatch({ selection: { anchor, head } });
  transactions.length = 0;
  return {
    view,
    transactions,
    text: () => view.state.doc.toString(),
    selected: () => view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to),
    press(key: "b" | "i" | "s" | "e", shiftKey = false) {
      const event = new KeyboardEvent("keydown", {
        key: shiftKey ? key.toUpperCase() : key,
        keyCode: key.toUpperCase().charCodeAt(0),
        ctrlKey: true,
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      view.contentDOM.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      forceParsing(view, view.state.doc.length, 5000);
    },
    [Symbol.dispose]() {
      view.destroy();
      dom.cleanup();
    },
  };
};

describe("notebook inline formatting", () => {
  if (isServer) {
    test.skip("formatting needs browser export conditions", () => {});
    return;
  }

  test.each([false, true])("trims double-click whitespace and preserves selection direction (backward: %s)", (backward) => {
    using editor = mount("Ein Wort hier", backward ? 9 : 4, backward ? 4 : 9);
    toggleInlineMark(editor.view, "bold");
    expect(editor.text()).toBe("Ein **Wort** hier");
    expect(editor.selected()).toBe("Wort");
    expect(editor.view.state.selection.main.anchor > editor.view.state.selection.main.head).toBe(backward);
    expect(editor.transactions).toHaveLength(1);
    toggleInlineMark(editor.view, "bold");
    expect(editor.text()).toBe("Ein Wort hier");
    expect(editor.selected()).toBe("Wort");
  });

  test("intraword italic renders as emphasis in Book", () => {
    using editor = mount("Wort", 2, 3);
    toggleInlineMark(editor.view, "italic");
    expect(editor.text()).toBe("Wo*r*t");
    expect(editor.selected()).toBe("r");
    expect(renderNotebookBook({ markdown: editor.text(), notebookId: "n", locale: "en" }).html).toContain("Wo<em>r</em>t");
    editor.press("i");
    expect(editor.text()).toBe("Wort");
  });

  test("Ctrl+B toggles the caret's word without moving its character", () => {
    using editor = mount("Wort", 2);
    editor.press("b");
    expect(editor.text()).toBe("**Wort**");
    expect(editor.view.state.selection.main.head).toBe(4);
    editor.press("b");
    expect(editor.text()).toBe("Wort");
    expect(editor.view.state.selection.main.head).toBe(2);
  });

  test.each([0, 4])("caret at word boundary %i stays inside new marks", (head) => {
    using editor = mount("Wort", head);
    toggleInlineMark(editor.view, "bold");
    expect(editor.text()).toBe("**Wort**");
    expect(editor.view.state.selection.main.head).toBe(head + 2);
  });

  test.each([
    ["Ein  Wort", 4, 4],
    ["Ein   Wort", 4, 6],
  ] as const)("whitespace target dispatches nothing: %s (%i..%i)", (doc, anchor, head) => {
    using editor = mount(doc, anchor, head);
    editor.press("b");
    expect(editor.text()).toBe(doc);
    expect(editor.transactions).toHaveLength(0);
  });

  test.each([
    ["_x_", 1, 1, "italic", "x"],
    ["_x_", 0, 3, "italic", "x"],
    ["__x__", 2, 2, "bold", "x"],
    ["**Wort**", 0, 8, "bold", "Wort"],
  ] as const)("recognizes existing marks: %s (%i..%i)", (doc, anchor, head, mark, expected) => {
    using editor = mount(doc, anchor, head);
    toggleInlineMark(editor.view, mark);
    expect(editor.text()).toBe(expected);
    if (anchor !== head) expect(editor.selected()).toBe(expected);
  });

  test.each([0, 1, 2, 6, 12, 13, 14])("Ctrl+B removes a multi-word span at inclusive position %i", (head) => {
    using editor = mount("**zwei Worte**", head);
    editor.press("b");
    expect(editor.text()).toBe("zwei Worte");
    expect(editor.view.state.selection.main.head).toBe(Math.max(0, Math.min(10, head - 2)));
  });

  test.each([
    ["**fett** mehr", 4, 13, "**fett mehr**", "fett mehr"],
    ["mehr **fett**", 0, 9, "**mehr fett**", "mehr fett"],
    ["ein **fett** mehr", 0, 17, "**ein fett mehr**", "ein fett mehr"],
    ["**a** und **b**", 3, 12, "**a und b**", "a und b"],
  ] as const)("merges overlapping or contained spans: %s", (doc, anchor, head, expected, selected) => {
    using editor = mount(doc, anchor, head);
    toggleInlineMark(editor.view, "bold");
    expect(editor.text()).toBe(expected);
    expect(editor.selected()).toBe(selected);
    forceParsing(editor.view, editor.text().length, 5000);
    expect(syntaxTree(editor.view.state).toString()).toContain("StrongEmphasis");
    expect(editor.transactions).toHaveLength(1);
  });

  test("uses the innermost matching span", () => {
    using editor = mount("*a **b *c* d** e*", 8);
    toggleInlineMark(editor.view, "italic");
    expect(editor.text()).toBe("*a **b c d** e*");
  });

  test.each([
    ["s", true, "~~Wort~~"],
    ["e", false, "`Wort`"],
  ] as const)("Mod-%s toggles on and off", (key, shift, marked) => {
    using editor = mount("Wort", 2);
    editor.press(key, shift);
    expect(editor.text()).toBe(marked);
    editor.press(key, shift);
    expect(editor.text()).toBe("Wort");
    expect(editor.view.state.selection.main.head).toBe(2);
  });

  test("one undo restores text and selection after merging a span", () => {
    using editor = mount("**fett** mehr", 4, 13, [history()]);
    toggleInlineMark(editor.view, "bold");
    expect(editor.text()).toBe("**fett mehr**");
    expect(editor.transactions).toHaveLength(1);
    expect(undo(editor.view)).toBe(true);
    expect(editor.text()).toBe("**fett** mehr");
    expect(editor.view.state.selection.main.anchor).toBe(4);
    expect(editor.view.state.selection.main.head).toBe(13);
  });

  test.each([false, true])("Yjs keeps a concurrent edit inside the word (toggle off: %s)", (off) => {
    const original = off ? "**Wort**" : "Wort";
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.getText("codemirror").insert(0, original);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    using clientA = mount(original, off ? 4 : 2, undefined, [yCollab(a.getText("codemirror"), null)]);
    using clientB = mount(original, off ? 4 : 2, undefined, [yCollab(b.getText("codemirror"), null)]);
    try {
      clientA.press("b");
      clientB.view.dispatch({ changes: { from: off ? 4 : 2, insert: "X" } });
      Y.applyUpdate(a, Y.encodeStateAsUpdate(b), "remote");
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a), "remote");
      expect(clientA.text()).toBe(clientB.text());
      expect(clientA.text()).toBe(off ? "WoXrt" : "**WoXrt**");
    } finally {
      a.destroy();
      b.destroy();
    }
  });
});
