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
import { isolateYjsHistory } from "../../../lib/yjs/history";

const loading = createDomTestHarness();
const { toggleInlineMark, caretFormat, setHeadingLevel, toggleHeadingLevel } = await import("./editor-actions");
const { formattingKeymap } = await import("./EditorToolbar");
const { renderNotebookBook } = await import("../../../../lib/book-renderer");
loading.cleanup();

const mount = (doc: string, anchor: number, head = anchor, extensions: Extension[] = [], parse = true) => {
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
        EditorView.updateListener.of((update) => transactions.push(...update.transactions.filter((tr) => tr.docChanged))),
      ],
    }),
  });
  if (parse) forceParsing(view, doc.length, 5000);
  view.focus();
  view.dispatch({ selection: { anchor, head } });
  transactions.length = 0;
  return {
    view,
    transactions,
    text: () => view.state.doc.toString(),
    selected: () => view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to),
    press(key: "b" | "i" | "s" | "e" | "h", shiftKey = false) {
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
      if (parse) forceParsing(view, view.state.doc.length, 5000);
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

  test.each([
    ["`code` x", 2, 2, "b"],
    ["`a*b` x", 1, 1, "i"],
    ["```\nlet wert = 1\n```", 9, 9, "b"],
    ["```\nlet wert = 1\n```", 9, 9, "e"],
    ["    let wert = 1", 9, 9, "b"],
    ["[Wort](https://x.y/abc)", 14, 14, "b"],
    ["#projekt x", 3, 3, "b"],
    ["- a\n- b", 2, 7, "b"],
    ["foo\n\nbar", 0, 8, "b"],
    ["*kursiv* mehr", 5, 11, "b"],
    ["foobar.baz", 3, 7, "b"],
    ["x(Wort)y", 1, 7, "b"],
  ] as const)("invalid wrap dispatches nothing: %s (%i..%i, Mod-%s)", (doc, anchor, head, key) => {
    using editor = mount(doc, anchor, head);
    for (let press = 0; press < 2; press++) {
      editor.press(key);
      expect(editor.text()).toBe(doc);
      expect(editor.transactions).toHaveLength(0);
    }
  });

  test.each([
    ["*kursiv*", 1, 7, "b", "***kursiv***"],
    ["a `x` b", 0, 7, "b", "**a `x` b**"],
    ["foo\nbar", 0, 7, "b", "**foo\nbar**"],
    ["- a b", 2, 5, "i", "- *a b*"],
  ] as const)("valid wraps around other syntax still apply: %s", (doc, anchor, head, key, expected) => {
    using editor = mount(doc, anchor, head);
    editor.press(key);
    expect(editor.text()).toBe(expected);
    editor.press(key);
    expect(editor.text()).toBe(doc);
  });

  test("bold in link text keeps the URL intact", () => {
    using editor = mount("[Wort](https://x.y/abc)", 3);
    editor.press("b");
    expect(editor.text()).toBe("[**Wort**](https://x.y/abc)");
    editor.press("b");
    expect(editor.text()).toBe("[Wort](https://x.y/abc)");
  });

  test.each([
    ["**fett wort**", 7, 11, "**fett** wort", "wort", "**fett** **wort**"],
    ["**fett wort**", 11, 7, "**fett** wort", "wort", "**fett** **wort**"],
    ["**a b c**", 4, 5, "**a** b **c**", "b", "**a** **b** **c**"],
    ["**fett wort**", 2, 6, "fett **wort**", "fett", "**fett** **wort**"],
    ["__a b c__", 4, 5, "__a__ b __c__", "b", "__a__ **b** __c__"],
  ] as const)("splits the selection out of %s (%i..%i), a second press bolds it again", (doc, anchor, head, split, selected, again) => {
    using editor = mount(doc, anchor, head);
    editor.press("b");
    expect(editor.text()).toBe(split);
    expect(editor.selected()).toBe(selected);
    expect(editor.view.state.selection.main.anchor > editor.view.state.selection.main.head).toBe(anchor > head);
    expect(editor.transactions).toHaveLength(1);
    editor.press("b");
    expect(editor.text()).toBe(again);
    expect(editor.selected()).toBe(selected);
  });

  test.each([false, true])("absorbs a touching span (caret: %s)", (caret) => {
    using editor = mount("**a**b", 5, caret ? 5 : 6);
    editor.press("b");
    expect(editor.text()).toBe("**ab**");
    if (!caret) expect(editor.selected()).toBe("ab");
    editor.press("b");
    expect(editor.text()).toBe("ab");
  });

  test("word expansion absorbs touching intraword italic", () => {
    using editor = mount("Wo*r*t", 1);
    editor.press("i");
    expect(editor.text()).toBe("*Wor*t");
    const { html } = renderNotebookBook({ markdown: editor.text(), notebookId: "n", locale: "en" });
    expect(html).toContain("<em>Wor</em>");
    expect(html).not.toContain("*");
    editor.press("i");
    expect(editor.text()).toBe("Wort");
  });

  test("parses a distant span before toggling without forceParsing", () => {
    const prefix = "Paragraph\n\n".repeat(1000);
    using editor = mount(prefix + "**word**", prefix.length + 2, prefix.length + 6, [], false);
    editor.press("b");
    expect(editor.text()).toBe(prefix + "word");
    expect(editor.selected()).toBe("word");
  });

  test.each([false, true])("Yjs isolates formatting from adjacent typing (type after: %s)", (after) => {
    const doc = new Y.Doc();
    const text = doc.getText("codemirror");
    text.insert(0, "Ein ");
    const undoManager = new Y.UndoManager(text);
    using editor = mount("Ein ", 4, undefined, [yCollab(text, null, { undoManager }), isolateYjsHistory(undoManager)]);
    try {
      editor.view.dispatch({ changes: { from: 4, insert: "Wort" }, selection: { anchor: 6 }, userEvent: "input.type" });
      editor.press("b");
      expect(editor.text()).toBe("Ein **Wort**");
      if (after) {
        editor.view.dispatch({ changes: { from: 8, insert: "X" }, userEvent: "input.type" });
        expect(editor.text()).toBe("Ein **WoXrt**");
      }
      undoManager.undo();
      expect(editor.text()).toBe(after ? "Ein **Wort**" : "Ein Wort");
    } finally {
      undoManager.destroy();
      doc.destroy();
    }
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

describe("caret formats and highlight", () => {
  if (isServer) {
    test.skip("needs browser export conditions", () => {});
    return;
  }

  test.each([
    ["**word**", "bold", 2, 6],
    ["_word_", "italic", 1, 5],
    ["~~word~~", "strikethrough", 2, 6],
    ["==word==", "highlight", 2, 6],
  ] as const)("%s is pressed inside content and its toggle removes the format", (doc, mark, from, to) => {
    for (const [anchor, head] of [
      [from, from],
      [to, to],
      [from, to],
      [to, from],
    ]) {
      using editor = mount(doc, anchor!, head!);
      expect(caretFormat(editor.view.state)[mark]).toBe(true);
      toggleInlineMark(editor.view, mark);
      expect(editor.text()).toBe("word");
      expect(caretFormat(editor.view.state)[mark]).toBe(false);
    }
    using outside = mount(`plain ${doc}`, 2);
    expect(caretFormat(outside.view.state)[mark]).toBe(false);
    toggleInlineMark(outside.view, mark);
    expect(caretFormat(outside.view.state)[mark]).toBe(true);
    using delimiter = mount(doc, 0);
    expect(caretFormat(delimiter.view.state)[mark]).toBe(false);
  });

  test("trims selection whitespace for active formats", () => {
    using editor = mount("**word next**", 2, 7);
    expect(caretFormat(editor.view.state).bold).toBe(true);
    toggleInlineMark(editor.view, "bold");
    expect(editor.text()).toBe("word **next**");
    expect(caretFormat(editor.view.state).bold).toBe(false);
  });

  test("an existing highlight containing inline code is pressed and can be removed", () => {
    using editor = mount("==text `code`==", 4);
    expect(caretFormat(editor.view.state).highlight).toBe(true);
    toggleInlineMark(editor.view, "highlight");
    expect(editor.text()).toBe("text `code`");
    expect(editor.transactions).toHaveLength(1);
    expect(caretFormat(editor.view.state).highlight).toBe(false);
    using shortcut = mount("==text `code`==", 4);
    shortcut.press("h", true);
    expect(shortcut.text()).toBe("text `code`");
  });

  test("splitting an existing highlight never inserts delimiters inside code", () => {
    const doc = "==text `code`==";
    using editor = mount(doc, 9, 11);
    toggleInlineMark(editor.view, "highlight");
    expect(editor.text()).toBe(doc);
    expect(editor.transactions).toHaveLength(0);
  });

  test.each([
    ["word", 2, 2, "==word=="],
    ["a word b", 1, 7, "a ==word== b"],
    ["==word==", 4, 4, "word"],
    ["==a b c==", 4, 5, "==a== b ==c=="],
    ["==a==b", 5, 6, "==ab=="],
    ["==a== b", 2, 7, "==a b=="],
  ] as const)("highlight toggles %s (%i..%i)", (doc, anchor, head, expected) => {
    using editor = mount(doc, anchor, head);
    toggleInlineMark(editor.view, "highlight");
    expect(editor.text()).toBe(expected);
    expect(editor.transactions).toHaveLength(1);
    expect(editor.view.hasFocus).toBe(true);
  });

  test.each([
    ["`word`", 2, 2],
    ["```\nword\n```", 6, 6],
    ["    word", 6, 6],
    ["[word](https://example.test)", 17, 17],
    ["#tag", 2, 2],
    ["one\ntwo", 0, 7],
    ["a=b", 0, 3],
    ["word=", 0, 4],
    ["word===", 0, 4],
    ["word `code`", 0, 11],
    ["`==word==`", 4, 4],
    ["```\n==word==\n```", 8, 8],
    ["    ==word==", 8, 8],
    ["[word](https://example.test/==word==)", 30, 30],
  ] as const)("refuses invalid highlight in %s", (doc, anchor, head) => {
    using editor = mount(doc, anchor, head);
    toggleInlineMark(editor.view, "highlight");
    expect(editor.text()).toBe(doc);
    expect(editor.transactions).toHaveLength(0);
    expect(caretFormat(editor.view.state).highlight).toBe(false);
  });

  test.each([
    ["- word", "bullet"],
    ["1. word", "ordered"],
    ["- [ ] word", "task"],
    ["- [x] word", "task"],
  ] as const)("list pressed state matches the toggle for %s", (doc, kind) => {
    using editor = mount(doc, doc.length);
    expect(caretFormat(editor.view.state).list).toBe(kind);
  });

  test("mixed list selections have no pressed kind", () => {
    using editor = mount("- first\n1. second", 0, 17);
    expect(caretFormat(editor.view.state).list).toBeNull();
    using uniform = mount("- first\n- second", 0, 16);
    expect(caretFormat(uniform.view.state).list).toBe("bullet");
  });

  test.each([
    ["## word", 4, 2],
    ["word\n====", 2, 1],
    ["Title\n---\nnext", 2, 2],
    ["Title\n---\nnext", 7, 2],
    ["> Title\n> ---", 11, 2],
    ["plain", 2, 0],
    ["> ## word", 6, 2],
    ["- ## word", 6, 2],
  ] as const)("reports heading level in %s", (doc, head, level) => {
    using editor = mount(doc, head);
    expect(caretFormat(editor.view.state).heading).toBe(level);
  });
});

describe("heading levels", () => {
  if (isServer) {
    test.skip("needs browser export conditions", () => {});
    return;
  }
  test.each([
    ["word", "## word"],
    ["# word", "## word"],
    ["- word", "- ## word"],
    ["> word", "> ## word"],
    ["> - word", "> - ## word"],
  ] as const)("sets H2 after structural prefixes in %s and toggles back", (doc, expected) => {
    using editor = mount(doc, doc.indexOf("word") + 2);
    setHeadingLevel(editor.view, 2);
    expect(editor.text()).toBe(expected);
    expect(editor.view.state.selection.main.head).toBe(expected.indexOf("word") + 2);
    expect(caretFormat(editor.view.state).heading).toBe(2);
    toggleHeadingLevel(editor.view, 2);
    expect(editor.text()).toBe(expected.replace("## ", ""));
    setHeadingLevel(editor.view, 6);
    expect(caretFormat(editor.view.state).heading).toBe(6);
    setHeadingLevel(editor.view, 0);
    expect(caretFormat(editor.view.state).heading).toBe(0);
  });
  test.each(["- [ ] foo", "- [x] foo", "- [X] foo", "> - [ ] foo", "1. [ ] foo", "- [ ] ## foo"])(
    "leaves task items unchanged at levels 0 through 3: %s",
    (doc) => {
      using editor = mount(doc, doc.indexOf("foo") + 1);
      for (const level of [0, 1, 2, 3] as const) setHeadingLevel(editor.view, level);
      expect(editor.text()).toBe(doc);
      expect(editor.transactions).toHaveLength(0);
    },
  );
  test.each([
    ["Title\n---\nnext", 1, "# Title\nnext"],
    ["Title\n---\nnext", 0, "Title\n\nnext"],
    ["Title\n===   \nnext", 2, "## Title\nnext"],
    ["Title\n===   \nnext", 0, "Title\n\nnext"],
    ["> Title\n> ---", 2, "> ## Title"],
    ["> Title\n> ---", 0, "> Title\n> "],
    ["- Title\n  ---", 2, "- ## Title"],
  ] as const)("converts single-line setext heading %s to level %i", (doc, level, expected) => {
    for (const head of [doc.indexOf("Title") + 2, doc.indexOf("\n") + 2]) {
      using editor = mount(doc, head, undefined, [history()]);
      setHeadingLevel(editor.view, level);
      expect(editor.text()).toBe(expected);
      expect(editor.view.state.selection.main.head).toBe(expected.indexOf("Title") + (head > doc.indexOf("\n") ? 5 : 2));
      expect(editor.transactions).toHaveLength(1);
      expect(caretFormat(editor.view.state).heading).toBe(level);
      expect(undo(editor.view)).toBe(true);
      expect(editor.text()).toBe(doc);
    }
  });
  test("setext headings toggle off through their current level", () => {
    using editor = mount("Title\n---\nnext", 2);
    toggleHeadingLevel(editor.view, 2);
    expect(editor.text()).toBe("Title\n\nnext");
  });
  test.each([0, 1, 2, 3] as const)("leaves a multi-line setext heading unchanged at level %i", (level) => {
    const doc = "First\nsecond\n---";
    for (const head of [2, 8, 14]) {
      using editor = mount(doc, head);
      expect(caretFormat(editor.view.state).heading).toBe(2);
      setHeadingLevel(editor.view, level);
      expect(editor.text()).toBe(doc);
      expect(editor.transactions).toHaveLength(0);
    }
  });
  test.each(["```\nword\n```", "    word", "> ```\n> word\n> ```", "- ```\n  word\n  ```", ">     word", ":::data\nword\n:::"])(
    "leaves code and excluded blocks intact: %s",
    (doc) => {
      using editor = mount(doc, doc.indexOf("word") + 2);
      setHeadingLevel(editor.view, 2);
      expect(editor.text()).toBe(doc);
    },
  );
});
