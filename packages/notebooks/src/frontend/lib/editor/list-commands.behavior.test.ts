import { describe, expect, spyOn, test } from "bun:test";
import { autocompletion, completionStatus, startCompletion } from "@codemirror/autocomplete";
import { history, undo } from "@codemirror/commands";
import { forceParsing, syntaxTreeAvailable } from "@codemirror/language";
import { EditorSelection, EditorState, type Extension, StateEffect, Transaction } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { isServer } from "solid-js/web";
import { YSyncConfig, yCollab, ySyncAnnotation } from "y-codemirror.next";
import * as Y from "yjs";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import { isolateYjsHistory } from "../yjs/history";
import { basicExtensions } from "./basic";
import { markdownExtension } from "./markdown";

// Notebook block scanners load UI browser exports after DOM globals exist.
const loading = createDomTestHarness();
const { excludedSpans, listStructure } = await import("./_lib/list-structure");
const { indentListItems, listCommandsExtension, listIndentAvailability, outdentListItems, setListKind, toggleTaskAtCaret } = await import(
  "./list-commands"
);
const { tabIndentExtension } = await import("./tab-indent");
const { listsExtension } = await import("./lists");
loading.cleanup();

const mount = (doc: string, head = doc.length, tab = true, extensions: Extension[] = [], parse = true) => {
  const dom = createDomTestHarness();
  const view = new EditorView({
    parent: dom.root,
    state: EditorState.create({
      doc,
      selection: { anchor: head },
      extensions: [basicExtensions(), markdownExtension(), listCommandsExtension(), tab ? tabIndentExtension() : [], ...extensions],
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

const mod = { ctrlKey: true };

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

  test.each([
    ["9) A\n   - lift\n   1) following\n10) end", "lift", "9) A\n10) lift\n    1) following\n11) end"],
    ["9. A\n   - B\n\n   para of A\n10. D", "B", "9. A\n10. B\n\n    para of A\n11. D"],
  ])("lifting shifts all following parent content: %s", (doc, caret, expected) => {
    using editor = mount(doc, doc.indexOf(caret));
    expect(editor.press("Tab", { shiftKey: true })).toBe(true);
    expect(editor.text()).toBe(expected);
  });

  test.each([
    ["1. a\n2. b\n3. c", 0, 5, "delete.line", "1. b\n2. c"],
    ["5. a\n6. b\n7. c", 0, 5, "delete.line", "5. b\n6. c"],
    ["- x\n  1. a\n  2. b", 4, 11, "delete.line", "- x\n  1. b"],
    ["1. a\n2. b\n3. c", 0, 5, "delete.cut", "1. b\n2. c"],
  ] as const)("removing the first marker retains the list start: %s (%i..%i, %s)", (doc, from, to, userEvent, expected) => {
    using editor = mount(doc);
    editor.view.dispatch({ changes: { from, to }, userEvent });
    expect(editor.text()).toBe(expected);
  });

  test("removing the first nested marker restores parsing and repairs all surviving siblings", () => {
    using editor = mount("- x\n  1. a\n  2. b\n  3. c");
    editor.view.dispatch({ changes: { from: 4, to: 11 }, userEvent: "delete.line" });
    expect(editor.text()).toBe("- x\n  1. b\n  2. c");
  });

  test.each(["ArrowUp", "ArrowDown"] as const)("macOS Cmd-Shift-%s retains document selection", (key) => {
    const doc = "1. A\n2. B\n3. C";
    using editor = mount(doc, doc.indexOf("B"));
    // Resolve macOS bindings onto the test platform so the real key handlers run with their normal precedence.
    const bindings = editor.view.state
      .facet(keymap)
      .flat()
      .map((binding) => ({
        ...binding,
        key: (binding.mac ?? binding.key)?.replace(/^(?:Mod|Cmd)-/, "Ctrl-"),
        mac: undefined,
        win: undefined,
        linux: undefined,
      }));
    editor.view.dispatch({ effects: StateEffect.reconfigure.of([markdownExtension(), keymap.of(bindings)]) });
    expect(editor.press(key, { ctrlKey: true, shiftKey: true })).toBe(true);
    expect(editor.text()).toBe(doc);
    expect(editor.view.state.selection.main.anchor).toBe(doc.indexOf("B"));
    expect(editor.view.state.selection.main.head).toBe(key === "ArrowUp" ? 0 : doc.length);
  });

  test.each([
    ["1. A\n1. B\n\nplain", 10, "1. A\n1. B\n\n\nplain"],
    ["- a\n  1. x\n  1. y\n- b\n- c", 25, "- a\n  1. x\n  1. y\n- b\n- c\n- "],
  ] as const)("Enter leaves untouched adjacent or nested ordered lists alone: %s", (doc, head, expected) => {
    using editor = mount(doc, head);
    expect(editor.press("Enter")).toBe(true);
    expect(editor.text()).toBe(expected);
  });

  test("plain line move falls back when parsing times out", () => {
    const prefix = "paragraph\n\n".repeat(50000);
    const doc = prefix + "one\ntwo";
    using editor = mount(doc, doc.length, true, [], false);
    expect(editor.press("ArrowUp", { altKey: true })).toBe(true);
    expect(editor.text()).toBe(prefix + "two\none");
  });

  test("raw mode caches excluded spans across caret moves in the same document", () => {
    const doc = "- A\n- B";
    using editor = mount(doc);
    const source = spyOn(editor.view.state.doc, "toString");
    try {
      expect(listIndentAvailability(editor.view.state)).toEqual({ indent: true, outdent: false });
      editor.view.dispatch({ selection: { anchor: doc.indexOf("B") } });
      expect(listIndentAvailability(editor.view.state)).toEqual({ indent: true, outdent: false });
      expect(source.mock.calls.length).toBeLessThanOrEqual(1);
    } finally {
      source.mockRestore();
    }
  });

  test.each(["- - -", "* * *", "-  -  -"])("spaced thematic break stays a rule on Tab and Mod brackets: %s", (rule) => {
    const doc = `- A\n  1. child\n\n${rule}`;
    for (const key of ["Tab", "]"] as const) {
      using editor = mount(doc);
      expect(editor.press(key, key === "]" ? mod : {})).toBe(true);
      expect(editor.text()).toContain(rule);
      expect(editor.text()).not.toContain("2.");
    }
  });

  test("selected siblings share one column across an ordinal width boundary", () => {
    const doc = "999. A\n1000. B\n1001. C\n1002. D";
    using editor = mount(doc);
    editor.view.dispatch({ selection: { anchor: doc.indexOf("1000"), head: doc.indexOf("C") + 1 } });
    expect(editor.press("Tab")).toBe(true);
    expect(editor.text()).toBe("999. A\n     1. B\n     2. C\n1000. D");
    expect(editor.press("Tab", { shiftKey: true })).toBe(true);
    expect(editor.text()).toBe(doc);
  });

  test.each([
    ["- a\n- b\n- c", "- b\n- c\n- a"],
    ["1. a\n2. b\n3. c", "1. b\n2. c\n3. a"],
  ])("selection outside the caret subtree uses the default line move: %s", (doc, expected) => {
    using editor = mount(doc);
    editor.view.dispatch({ selection: { anchor: doc.indexOf("b"), head: doc.indexOf("c") + 1 } });
    expect(editor.press("ArrowUp", { altKey: true })).toBe(true);
    expect(editor.text()).toBe(expected);
  });

  test.each([
    ["- A\n- B", "B", "ArrowUp", "- B\n- A"],
    ["1. A\n2. B\n3. C", "B", "ArrowUp", "1. B\n2. A\n3. C"],
    ["- A\n- B\n- C", "A", "ArrowDown", "- B\n- A\n- C"],
  ] as const)("moving an item keeps its end caret: %s (%s, %s)", (doc, item, key, expected) => {
    using editor = mount(doc, doc.indexOf(item) + 1);
    expect(editor.press(key, { altKey: true })).toBe(true);
    expect(editor.text()).toBe(expected);
    expect(editor.view.state.selection.main.head).toBe(expected.indexOf(item) + 1);
  });

  test("Tab creates a real ordered sublist and repairs following numbers in one dispatch", () => {
    const doc = "1. A\n2. B\n3. C";
    const transactions: Transaction[] = [];
    using editor = mount(doc, doc.indexOf("B"), true, [
      EditorView.updateListener.of((update) => transactions.push(...update.transactions)),
    ]);
    transactions.length = 0;
    expect(editor.press("Tab")).toBe(true);
    expect(editor.text()).toBe("1. A\n   1. B\n2. C");
    expect(transactions).toHaveLength(1);
    expect(transactions[0]!.isUserEvent("input.indent")).toBe(true);
    expect(editor.view.state.sliceDoc(editor.view.state.selection.main.head, editor.view.state.selection.main.head + 1)).toBe("B");
    expect(editor.structure().items.map((item) => [item.depth, item.parent])).toEqual([
      [0, -1],
      [1, 0],
      [0, -1],
    ]);
  });

  test("lifting continues the parent's count and creates a new child list from following siblings", () => {
    const doc = "1. A\n   1. B\n   2. C\n   3. D\n2. E";
    using editor = mount(doc, doc.indexOf("B"));
    expect(editor.press("Tab", { shiftKey: true })).toBe(true);
    expect(editor.text()).toBe("1. A\n2. B\n   1. C\n   2. D\n3. E");
    expect(editor.structure().items.map((item) => [item.depth, item.parent])).toEqual([
      [0, -1],
      [0, -1],
      [1, 1],
      [1, 1],
      [0, -1],
    ]);
  });

  test("Tab nests under the item above even when it belongs to a list of another kind", () => {
    const doc = "1. Pack\n- [ ] Charger";
    using editor = mount(doc);
    expect(editor.press("Tab")).toBe(true);
    expect(editor.text()).toBe("1. Pack\n   - [ ] Charger");
    expect(editor.structure().items.map((item) => [item.depth, item.kind])).toEqual([
      [0, "ordered"],
      [1, "task"],
    ]);
  });

  test.each([
    ["- A\n  1) child\n- B", "- A\n  1) child\n  2) B"],
    ["1. A\n   * child\n2. B", "1. A\n   * child\n   * B"],
    ["- A\n  1. child\n- [ ] B", "- A\n  1. child\n  2. [ ] B"],
    ["- A\n  1. child\n- [x] B", "- A\n  1. child\n  2. [x] B"],
  ])("indent adopts the existing last child list: %s", (doc, expected) => {
    using editor = mount(doc);
    expect(editor.press("Tab")).toBe(true);
    expect(editor.text()).toBe(expected);
  });

  test("first items and top-level outdent keep the key without fabricating indentation", () => {
    using editor = mount("1. A\n2. B", 3);
    expect(listIndentAvailability(editor.view.state)).toEqual({ indent: false, outdent: false });
    expect(editor.press("Tab")).toBe(true);
    expect(editor.press("Tab", { shiftKey: true })).toBe(true);
    expect(editor.text()).toBe("1. A\n2. B");
    editor.view.dispatch({ selection: { anchor: editor.text().length } });
    expect(listIndentAvailability(editor.view.state)).toEqual({ indent: true, outdent: false });
  });

  test("delete, Enter and paste repair numbers and preserve the caret's character", () => {
    using deleted = mount("1. A\n2. B\n3. C");
    deleted.view.dispatch({ changes: { from: 5, to: 10 }, userEvent: "delete" });
    expect(deleted.text()).toBe("1. A\n2. C");
    using entered = mount("1. A\n2. Bee\n3. C", 10);
    expect(entered.press("Enter")).toBe(true);
    expect(entered.text()).toBe("1. A\n2. Be\n3. e\n4. C");
    expect(entered.view.state.sliceDoc(entered.view.state.selection.main.head, entered.view.state.selection.main.head + 1)).toBe("e");
    using pasted = mount("1. A\n2. B\n3. C", 10);
    pasted.view.dispatch({ changes: { from: 10, insert: "1. X\n1. Y\n" }, userEvent: "input.paste" });
    expect(pasted.text()).toBe("1. A\n2. B\n3. X\n4. Y\n5. C");
  });

  test("crossing 9 to 10 shifts continuation and descendants without changing their parents", () => {
    const doc =
      Array.from({ length: 8 }, (_, i) => `${i + 1}. item${i + 1}`).join("\n") +
      "\n9. tail\n   continuation\n   - child\n     - grandchild";
    using editor = mount(doc, doc.indexOf("item5") + 5);
    const before = editor.structure().items.map(({ depth, parent }) => [depth, parent]);
    expect(editor.press("Enter")).toBe(true);
    expect(editor.text()).toContain("10. tail\n    continuation\n    - child\n      - grandchild");
    const items = editor.structure().items;
    expect(items.slice(-2).map(({ depth, parent }) => [depth, parent])).toEqual([
      [1, 9],
      [2, 10],
    ]);
    expect(before.slice(-2)).toEqual([
      [1, 8],
      [2, 9],
    ]);
  });

  test("lifting to item 10 keeps following siblings and the lifted subtree nested", () => {
    const prefix = Array.from({ length: 9 }, (_, i) => `${i + 1}. item${i + 1}`).join("\n");
    const doc = prefix + "\n   - lift\n     continuation\n     - child\n   - following\n     - grandchild\n10. end";
    using editor = mount(doc, doc.indexOf("lift"));
    expect(editor.press("Tab", { shiftKey: true })).toBe(true);
    expect(editor.text()).toBe(prefix + "\n10. lift\n    continuation\n    - child\n    - following\n      - grandchild\n11. end");
    expect(
      editor
        .structure()
        .items.slice(-5)
        .map(({ depth, parent }) => [depth, parent]),
    ).toEqual([
      [0, -1],
      [1, 9],
      [1, 9],
      [2, 11],
      [0, -1],
    ]);
  });

  test("Enter creates item 10 and shifts its continuation and children by one column", () => {
    const doc = Array.from({ length: 8 }, (_, i) => `${i + 1}. item${i + 1}`).join("\n") + "\n9. tail\n   continuation\n   - child";
    using editor = mount(doc, doc.indexOf("item8") + 5);
    expect(editor.press("Enter")).toBe(true);
    expect(editor.text()).toEndWith("8. item8\n9. \n10. tail\n    continuation\n    - child");
    expect(editor.structure().items.at(-1)?.depth).toBe(1);
  });

  test("selected siblings adopt together and preserve their descendants", () => {
    const doc = "- A\n  8. child\n- B\n  - nested\n- C\n- D";
    using editor = mount(doc);
    editor.view.dispatch({ selection: { anchor: doc.indexOf("- B"), head: doc.indexOf("C") + 1 } });
    expect(editor.press("Tab")).toBe(true);
    expect(editor.text()).toBe("- A\n  8. child\n  9. B\n     - nested\n  10. C\n- D");
    expect(editor.press("Tab", { shiftKey: true })).toBe(true);
    expect(editor.text()).toBe(doc);
  });

  test("disjoint lifted items each keep their unselected following siblings as children", () => {
    const doc = "1. A\n   1. B\n   2. C\n   3. D\n   4. E\n2. F";
    using editor = mount(doc);
    editor.view.dispatch({
      selection: EditorSelection.create([EditorSelection.cursor(doc.indexOf("B")), EditorSelection.cursor(doc.indexOf("D"))], 1),
    });
    expect(editor.press("Tab", { shiftKey: true })).toBe(true);
    expect(editor.text()).toBe("1. A\n2. B\n   1. C\n3. D\n   1. E\n4. F");
  });

  test("disjoint subtrees outdent by their own parent widths", () => {
    const doc = "- A\n  - B\n    - child\n- C\n   1. D\n      - childD";
    using editor = mount(doc);
    editor.view.dispatch({
      selection: EditorSelection.create([EditorSelection.cursor(doc.indexOf("B")), EditorSelection.cursor(doc.indexOf("D"))], 1),
    });
    expect(editor.press("Tab", { shiftKey: true })).toBe(true);
    expect(editor.text()).toBe("- A\n- B\n  - child\n- C\n- D\n  - childD");
  });

  test("a top-level main caret does not prevent another selected subtree from outdenting", () => {
    const doc = "- A\n  - B\n    - child\n- C";
    using editor = mount(doc);
    editor.view.dispatch({
      selection: EditorSelection.create([EditorSelection.cursor(doc.indexOf("B")), EditorSelection.cursor(doc.indexOf("C"))], 1),
    });
    expect(editor.press("Tab", { shiftKey: true })).toBe(true);
    expect(editor.text()).toBe("- A\n- B\n  - child\n- C");
  });

  test("disjoint subtrees indent by their own previous item's content column", () => {
    const doc = "- A\n- B\n  - child\n\n1. C\n2. D\n   - childD";
    using editor = mount(doc);
    editor.view.dispatch({
      selection: EditorSelection.create([EditorSelection.cursor(doc.indexOf("B")), EditorSelection.cursor(doc.indexOf("D"))], 1),
    });
    expect(editor.press("Tab")).toBe(true);
    expect(editor.text()).toBe("- A\n  - B\n    - child\n\n1. C\n   1. D\n      - childD");
  });

  test("selected non-list lines retain the main caret's indentation width", () => {
    const doc = "- A\n- B\n  - child\n\nplain\n\n1. C\n2. D\n   - childD";
    using editor = mount(doc);
    editor.view.dispatch({
      selection: EditorSelection.create(
        [EditorSelection.cursor(doc.indexOf("B")), EditorSelection.cursor(doc.indexOf("plain")), EditorSelection.cursor(doc.indexOf("D"))],
        2,
      ),
    });
    expect(editor.press("Tab")).toBe(true);
    expect(editor.text()).toBe("- A\n  - B\n    - child\n\n   plain\n\n1. C\n   1. D\n      - childD");
  });

  test.each(["Tab", "]"] as const)("%s never rewrites fenced markers beyond the initial parse", (key) => {
    const prefix = "paragraph\n\n".repeat(3000);
    const doc = prefix + "```\n- A\n  1. child\n- B\n```";
    using editor = mount(doc, doc.indexOf("B"), true, [], false);
    expect(syntaxTreeAvailable(editor.view.state, doc.indexOf("B"))).toBe(false);
    expect(editor.press(key, key === "]" ? mod : {})).toBe(true);
    expect(editor.text()).toContain("- A\n  1. child\n");
    expect(editor.text().slice(prefix.length)).not.toMatch(/2\. B/);
    expect(editor.text()).toContain("B\n```");
  });

  test.each(["available", "exhausted"] as const)("indent checks selected code lines with an %s parser budget", (budget) => {
    const prefix = "- A\n- B\n\n" + "paragraph\n\n".repeat(3000);
    const doc = prefix + "```\n- A\n  1. child\n- codeB\n```";
    using editor = mount(doc, doc.indexOf("B"), true, [], false);
    editor.view.dispatch({
      selection: EditorSelection.create([EditorSelection.cursor(doc.indexOf("B")), EditorSelection.cursor(doc.indexOf("codeB"))], 0),
    });
    expect(syntaxTreeAvailable(editor.view.state, doc.indexOf("codeB"))).toBe(false);
    let now = Date.UTC(2026, 9, 26);
    // CodeMirror measures its existing 50 ms parse slice with Date.now().
    // Test lookahead and safe budget exhaustion independently of host speed.
    const clock = spyOn(Date, "now").mockImplementation(() => {
      if (budget === "exhausted") now += 51;
      return now;
    });
    try {
      expect(editor.press("Tab")).toBe(true);
      expect(editor.text()).toBe(budget === "exhausted" ? doc : doc.replace("- B", "  - B").replace("- codeB", "  - codeB"));
    } finally {
      clock.mockRestore();
    }
  });

  test("move uses the newly parsed list at the tail of a long document", () => {
    const prefix = "paragraph\n\n".repeat(3000);
    const doc = prefix + "1. A\n2. B\n3. C";
    using editor = mount(doc, doc.indexOf("B"), true, [], false);
    expect(syntaxTreeAvailable(editor.view.state, doc.indexOf("B"))).toBe(false);
    expect(editor.press("ArrowUp", { altKey: true })).toBe(true);
    expect(editor.text()).toBe(prefix + "1. B\n2. A\n3. C");
  });

  test("Tab repairs an ordered block beyond the initial parse boundary", () => {
    const lines = Array.from({ length: 500 }, (_, index) => `${index + 1}. item${index + 1}`);
    const doc = lines.join("\n");
    using editor = mount(doc, doc.indexOf("item2"), true, [], false);
    expect(syntaxTreeAvailable(editor.view.state, doc.length)).toBe(false);
    expect(editor.press("Tab")).toBe(true);
    expect(editor.text()).toBe(
      [lines[0], "   1. item2", ...lines.slice(2).map((line, index) => line.replace(/^\d+/, String(index + 2)))].join("\n"),
    );
  });

  test("Backspace in a fenced list-looking prefix leaves enclosing lazy numbering alone", () => {
    const doc = "1. A\n   ```\n   1. example\n   ```\n1. B";
    using editor = mount(doc, doc.indexOf("1. example") + 1);
    expect(editor.press("Backspace")).toBe(true);
    expect(editor.text()).toBe(doc.replace("1. example", ". example"));
  });

  test.each(["query", "data"])("%s source uses plain indentation and line moves, with and without the list cache", (block) => {
    const doc = `:::${block}\n- A\n  1. child\n- B\n:::`;
    for (const extensions of [[], [listsExtension()]]) {
      using tab = mount(doc, doc.indexOf("B"), true, extensions);
      expect(tab.press("Tab")).toBe(true);
      expect(tab.text()).toBe(doc.replace("- B", "-   B"));
      using indent = mount(doc, doc.indexOf("B"), true, extensions);
      expect(indentListItems(indent.view)).toBe(false);
      expect(outdentListItems(indent.view)).toBe(false);
      expect(listIndentAvailability(indent.view.state)).toEqual({ indent: false, outdent: false });
      expect(indent.press("]", mod)).toBe(true);
      expect(indent.text()).toBe(doc.replace("- B", "  - B"));
      expect(indent.press("[", mod)).toBe(true);
      expect(indent.text()).toBe(doc);
      using moved = mount(doc, doc.indexOf("B"), true, extensions);
      expect(moved.press("ArrowUp", { altKey: true })).toBe(true);
      expect(moved.text()).toBe(doc.replace("  1. child\n- B", "- B\n  1. child"));
    }
  });

  test("availability checks only the main caret even with 2,000 selected siblings", () => {
    const doc = Array.from({ length: 2000 }, (_, index) => `- item${index}`).join("\n");
    using editor = mount(doc, doc.length, true, [listsExtension()]);
    editor.view.dispatch({ selection: { anchor: doc.indexOf("- item1\n"), head: doc.length } });
    const changes = spyOn(editor.view.state, "changes");
    const source = spyOn(editor.view.state.doc, "toString");
    try {
      const start = performance.now();
      expect(listIndentAvailability(editor.view.state)).toEqual({ indent: true, outdent: false });
      expect(performance.now() - start).toBeLessThan(50);
      expect(changes).not.toHaveBeenCalled();
      expect(source).not.toHaveBeenCalled();
    } finally {
      changes.mockRestore();
      source.mockRestore();
    }
    editor.view.dispatch({ selection: { anchor: 0, head: doc.length } });
    expect(listIndentAvailability(editor.view.state)).toEqual({ indent: true, outdent: false });
  });

  test.each(["plain", "1. A\n2. B", "- A\n  1. child\n- B", "1. A\n   * child\n2. B", "  - A", "- A\n  - B\n    - child"])(
    "availability agrees with single-caret commands on every line: %s",
    (doc) => {
      for (let number = 1; number <= doc.split("\n").length; number++) {
        for (const [direction, command] of [
          ["indent", indentListItems],
          ["outdent", outdentListItems],
        ] as const) {
          using editor = mount(doc);
          editor.view.dispatch({ selection: { anchor: editor.view.state.doc.line(number).to } });
          const available = listIndentAvailability(editor.view.state)[direction];
          command(editor.view);
          expect(available).toBe(editor.text() !== doc);
        }
      }
    },
  );

  test("move remaps a selection in a continuation across marker width changes", () => {
    const doc = "9. A\n10. B\n    continuation\n    - child\n11. C";
    using editor = mount(doc, doc.indexOf("continuation") + 2);
    expect(editor.press("ArrowUp", { altKey: true })).toBe(true);
    expect(editor.text()).toBe("9. B\n   continuation\n   - child\n10. A\n11. C");
    expect(editor.view.state.sliceDoc(editor.view.state.selection.main.head, editor.view.state.selection.main.head + 3)).toBe("nti");
    expect(editor.press("ArrowDown", { altKey: true })).toBe(true);
    expect(editor.text()).toBe(doc);
    expect(editor.view.state.sliceDoc(editor.view.state.selection.main.head, editor.view.state.selection.main.head + 3)).toBe("nti");
  });

  test("read-only state disables availability and number repair", () => {
    using editor = mount("1. A\n1. B", 8, true, [EditorState.readOnly.of(true)]);
    expect(listIndentAvailability(editor.view.state)).toEqual({ indent: false, outdent: false });
    editor.view.dispatch({ changes: { from: 5, insert: "1. inserted\n" }, userEvent: "input.paste" });
    expect(editor.text()).toBe("1. A\n1. inserted\n1. B");
  });

  test("Mod brackets work with Tab moving focus and retain the plain-text fallback", () => {
    const doc = "1. A\n2. B";
    using editor = mount(doc, doc.length, false);
    expect(editor.press("Tab")).toBe(false);
    expect(editor.press("]", mod)).toBe(true);
    expect(editor.text()).toBe("1. A\n   1. B");
    expect(listIndentAvailability(editor.view.state)).toEqual({ indent: false, outdent: true });
    expect(editor.press("[", mod)).toBe(true);
    expect(editor.text()).toBe(doc);
    using text = mount("plain", 2, false);
    expect(indentListItems(text.view)).toBe(false);
    expect(outdentListItems(text.view)).toBe(false);
    expect(text.press("]", mod)).toBe(true);
    expect(text.text()).toBe("  plain");
  });

  test("Alt arrows move whole subtrees, preserving list start, gaps and the selected character", () => {
    const doc = "7. A\n   - childA\n\n8. B\n   - childB\n9. C";
    using editor = mount(doc, doc.indexOf("childB") + 2);
    // On continuation text the innermost item moves, and its list edge prevents reparenting.
    expect(editor.press("ArrowUp", { altKey: true })).toBe(true);
    expect(editor.text()).toBe(doc);
    editor.view.dispatch({ selection: { anchor: doc.indexOf("B\n") } });
    expect(editor.press("ArrowUp", { altKey: true })).toBe(true);
    expect(editor.text()).toBe("7. B\n   - childB\n\n8. A\n   - childA\n9. C");
    expect(editor.view.state.sliceDoc(editor.view.state.selection.main.head, editor.view.state.selection.main.head + 1)).toBe("B");
    expect(editor.press("ArrowUp", { altKey: true })).toBe(true);
    expect(editor.text()).toBe("7. B\n   - childB\n\n8. A\n   - childA\n9. C");
    expect(editor.press("ArrowDown", { altKey: true })).toBe(true);
    expect(editor.text()).toBe(doc);
    expect(editor.press("ArrowUp", { ...mod, shiftKey: true })).toBe(true);
    expect(editor.text()).toStartWith("7. B\n   - childB");
    using plain = mount("one\ntwo", 5);
    expect(plain.press("ArrowUp", { altKey: true })).toBe(true);
    expect(plain.text()).toBe("two\none");
  });

  test("move stops at another list and falls back for a selection outside the subtree", () => {
    using editor = mount("- A\n* B");
    expect(editor.press("ArrowUp", { altKey: true })).toBe(true);
    expect(editor.text()).toBe("- A\n* B");
    using selected = mount("- A\n- B\n- C");
    selected.view.dispatch({ selection: { anchor: 6, head: 11 } });
    expect(selected.press("ArrowUp", { altKey: true })).toBe(true);
    expect(selected.text()).toBe("- B\n- C\n- A");
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

  test("repair touches only nearby lists and skips code, data, directives and quotes", () => {
    const doc =
      "1. A\n1. B\n\nseparator\n\n1. X\n1. Y\n\n```\n1. code\n1. code\n```\n\n:::data\n1. data\n1. data\n:::\n\n:::query\n1. query\n1. query\n:::\n\n> 1. quote\n> 1. quote";
    using editor = mount(doc);
    editor.view.dispatch({ changes: { from: 5, insert: "1. new\n" }, userEvent: "input.paste" });
    expect(editor.text()).toBe(doc.replace("1. A\n1. B", "1. A\n2. new\n3. B"));
    const untouched = editor.text();
    for (const word of ["code", "data", "query", "quote"]) {
      const pos = editor.text().lastIndexOf(`1. ${word}`);
      editor.view.dispatch({ changes: { from: pos, to: pos + 1, insert: "2" }, userEvent: "input" });
      expect(editor.text()).toContain(`1. ${word}\n${word === "quote" ? "> " : ""}2. ${word}`);
    }
    expect(untouched).toContain("1. X\n1. Y");
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
  test("the physical Digit7 shortcut takes precedence over toggleComment", () => {
    using editor = mount("- a");
    expect(editor.press("/", { ctrlKey: true, shiftKey: true, code: "Digit7" })).toBe(true);
    expect(editor.text()).toBe("1. a");
  });

  test.each([undefined, "KeyA"])("a shifted key without a physical digit code does not convert: %s", (code) => {
    using editor = mount("- a");
    expect(editor.press("&", { ctrlKey: true, shiftKey: true, code })).toBe(false);
    expect(editor.text()).toBe("- a");
  });

  test("Mod-Enter toggles the task from a continuation line", () => {
    using editor = mount("- [ ] buy\n  milk and eggs");
    expect(editor.press("Enter", mod)).toBe(true);
    expect(editor.text()).toBe("- [x] buy\n  milk and eggs");
  });

  test("a non-task child does not toggle its task parent", () => {
    using editor = mount("- [ ] p\n  - child");
    expect(toggleTaskAtCaret(editor.view)).toBe(false);
    expect(editor.text()).toBe("- [ ] p\n  - child");
  });

  test.each([
    ["-", 1, "- [ ] "],
    ["1.", 2, "- [ ] "],
    ["-\n- b", 1, "- [ ] \n- b"],
  ] as const)("a bare marker becomes a task without touching the next line: %s", (doc, head, expected) => {
    using editor = mount(doc, head);
    expect(setListKind("task")(editor.view)).toBe(true);
    expect(editor.text()).toBe(expected);
  });

  test.each([
    ["1. a\n2. b\n3. [ ] c\n4. d", "kind", "1. a\n- b\n1. [ ] c\n2. d"],
    ["1. a\n2. b\n3. [ ] c\n4. d", "Backspace", "1. a\n\nb\n\n1. [ ] c\n2. d"],
    ["1. a\n2. \n3. [ ] c\n4. d", "Enter", "1. a\n\n\n\n1. [ ] c\n2. d"],
  ] as const)("leaving an ordered item restarts ordered task siblings: %s (%s)", (doc, command, expected) => {
    using editor = mount(doc, 8);
    expect(command === "kind" ? setListKind("bullet")(editor.view) : editor.press(command)).toBe(true);
    expect(editor.text()).toBe(expected);
  });

  test.each(["Backspace", "kind"] as const)("converting a wide marker to prose removes continuation indentation: %s", (command) => {
    using editor = mount("10. a\n\n    continuation", 4);
    expect(command === "kind" ? setListKind("ordered")(editor.view) : editor.press(command)).toBe(true);
    expect(editor.text()).toBe("a\n\ncontinuation");
  });

  test("a converted item separates its continuation block from the following list", () => {
    using editor = mount("- a\n- b\n  more\n- c", 6);
    expect(editor.press("Backspace")).toBe(true);
    expect(editor.text()).toBe("- a\n\nb\nmore\n\n- c");
  });

  test("Enter again after ending a list keeps the restarted suffix when typing prose", () => {
    using editor = mount("1. a\n2. \n3. c", 8, true, [history()]);
    expect(editor.press("Enter")).toBe(true);
    expect(editor.text()).toBe("1. a\n\n\n\n1. c");
    expect(editor.press("Enter")).toBe(true);
    expect(editor.text()).toBe("1. a\n\n\n\n\n1. c");
    editor.type("x");
    expect(editor.text()).toBe("1. a\n\n\nx\n\n1. c");
  });

  test("inserting a blank line inside blank lines keeps the ordered suffix start", () => {
    using editor = mount("1. a\n\n\n1. c", 6);
    editor.type("\n");
    expect(editor.text()).toBe("1. a\n\n\n\n1. c");
  });

  test.each([
    ["> # Titel", "> Titel"],
    ["- # Titel", "- Titel"],
  ])("Backspace removes a heading mark inside its container: %s", (doc, expected) => {
    using editor = mount(doc, 4);
    expect(editor.press("Backspace")).toBe(true);
    expect(editor.text()).toBe(expected);
    expect(editor.view.state.selection.main.head).toBe(2);
  });

  test.each([
    ["1. a\n2. b\n3. c", "task", 8, 8, "1. a\n- [ ] b\n1. c", 11, 11],
    ["1. a\n2. b\n3. c", "bullet", 8, 8, "1. a\n- b\n1. c", 7, 7],
    ["1. a\n2. b\n3. c\n4. d", "bullet", 8, 14, "1. a\n- b\n- c\n1. d", 7, 12],
    ["1. a\n2. b\n3. c", "ordered", 8, 8, "1. a\n\nb\n\n1. c", 6, 6],
  ] as const)(
    "leaving ordered siblings via %s to %s restarts numbers with one undo",
    (doc, kind, anchor, head, expected, nextAnchor, nextHead) => {
      using editor = mount(doc, anchor, true, [history()]);
      editor.view.dispatch({ selection: { anchor, head } });
      const selection = editor.view.state.selection;
      expect(setListKind(kind)(editor.view)).toBe(true);
      expect(editor.text()).toBe(expected);
      expect(editor.view.state.selection.main.anchor).toBe(nextAnchor);
      expect(editor.view.state.selection.main.head).toBe(nextHead);
      expect(undo(editor.view)).toBe(true);
      expect(editor.text()).toBe(doc);
      expect(editor.view.state.selection.eq(selection)).toBe(true);
    },
  );

  test.each([
    ["1. a\n2. \n3. c", "Enter", "1. a\n\n\n\n1. c"],
    ["1. a\n2. b\n3. c", "Backspace", "1. a\n\nb\n\n1. c"],
  ] as const)("leaving ordered siblings via %s with %s restarts numbers with one undo", (doc, key, expected) => {
    using editor = mount(doc, 8, true, [history()]);
    expect(editor.press(key)).toBe(true);
    expect(editor.text()).toBe(expected);
    expect(editor.view.state.selection.main.anchor).toBe(6);
    expect(editor.view.state.selection.main.head).toBe(6);
    expect(undo(editor.view)).toBe(true);
    expect(editor.text()).toBe(doc);
    expect(editor.view.state.selection.main.head).toBe(8);
  });

  test.each([
    ["    - child", "   - child", 1],
    ["    continuation\n    1) child\n    2) next", "   continuation\n   1) child\n   2) next", 2],
  ] as const)("leaving ordered siblings repairs marker width and child indentation with one undo: %s", (tail, nextTail, children) => {
    const doc = Array.from({ length: 10 }, (_, i) => `${i + 1}. ${String.fromCharCode(97 + i)}`).join("\n") + "\n" + tail;
    const expected =
      "1. a\n- b\n" + Array.from({ length: 8 }, (_, i) => `${i + 1}. ${String.fromCharCode(99 + i)}`).join("\n") + "\n" + nextTail;
    using editor = mount(doc, 8, true, [history()]);
    expect(setListKind("bullet")(editor.view)).toBe(true);
    expect(editor.text()).toBe(expected);
    expect(editor.view.state.selection.main.head).toBe(7);
    forceParsing(editor.view, expected.length, 5000);
    expect(editor.structure().items.map((item) => item.depth)).toEqual([...Array(10).fill(0), ...Array(children).fill(1)]);
    expect(undo(editor.view)).toBe(true);
    expect(editor.text()).toBe(doc);
    expect(editor.view.state.selection.main.head).toBe(8);
  });

  test.each([
    ["1) a\n2) b\n3) c\n- stop\n7) later", "1) a\n- b\n1) c\n- stop\n7) later"],
    ["1. a\n2. b\n3. c\n7) later", "1. a\n- b\n1. c\n7) later"],
    ["- parent\n  1. a\n  2. b\n  3. c\n- other\n  7. untouched", "- parent\n  1. a\n  - b\n  1. c\n- other\n  7. untouched"],
    ["1. a\n2. b\n3. c\n   1) child\n   2) next\n4. d", "1. a\n- b\n1. c\n   1) child\n   2) next\n2. d"],
  ])("leaving ordered siblings preserves other kinds, delimiters, parents and sub-list numbers: %s", (doc, expected) => {
    using editor = mount(doc, doc.indexOf("b"), true, [history()]);
    expect(setListKind("bullet")(editor.view)).toBe(true);
    expect(editor.text()).toBe(expected);
    expect(editor.view.state.selection.main.head).toBe(expected.indexOf("b"));
    expect(undo(editor.view)).toBe(true);
    expect(editor.text()).toBe(doc);
    expect(editor.view.state.selection.main.head).toBe(doc.indexOf("b"));
  });

  test.each([
    ["- a\n  - ", 8, "Enter", "- a\n- ", 6],
    ["1. a\n   1. \n2. b", 11, "Enter", "1. a\n2. \n3. b", 8],
    ["- a\n- ", 6, "Enter", "- a\n\n", 5],
    ["- a\n-    ", 9, "Enter", "- a\n\n", 5],
    ["- a\n- b", 4, "Enter", "- a\n- \n- b", 9],
    ["- a\n- b", 4, "Backspace", "- a\n\nb", 5],
    ["- a\n  continuation\n- b", 21, "Backspace", "- a\n  continuation\n\nb", 20],
    ["- a\n  continuation", 3, "Backspace", "- \n  continuation", 2],
    ["- a\n- \n- c", 6, "Enter", "- a\n\n\n\n- c", 5],
    ["- \n  - child", 2, "Enter", "- \n  - child", 2],
    ["- a", 2, "Enter", "- \n- a", 5],
    ["1. a\n2. b", 3, "Enter", "1. \n2. a\n3. b", 7],
    ["- [x] a", 6, "Enter", "- [ ] \n- [x] a", 13],
    ["para\n- a", 7, "Enter", "para\n\n- \n- a", 11],
    ["- parent\n  1) old\n  2) next", 8, "Enter", "- parent\n  1) \n  2) old\n  3) next", 14],
    ["- par ent\n  - [x] old", 6, "Enter", "- par\n  - [ ] ent\n  - [x] old", 14],
    ["- parent\n  1. [x] old", 8, "Enter", "- parent\n  1. [ ] \n  2. [x] old", 18],
    ["1. a\n2. b", 4, "Enter", "1. a\n2. \n3. b", 8],
    ["- a\n  - b", 8, "Backspace", "- a\n- b", 6],
    ["- a\n- b\n- c", 6, "Backspace", "- a\n\nb\n\n- c", 5],
    ["- a\n  - child", 2, "Backspace", "- a\n  - child", 2],
    ["- [x] a", 6, "Backspace", "a", 0],
    ["a\nb", 2, "Backspace", "ab", 1],
    ["- ab", 4, "Backspace", "- a", 3],
    ["# Titel", 2, "Backspace", "Titel", 0],
    ["### Titel", 4, "Backspace", "Titel", 0],
    ["```\n# Titel\n```", 6, "Backspace", "```\n#Titel\n```", 5],
  ] as const)("%s at %i: %s keeps structure, caret and one undo", (doc, head, key, expected, nextHead) => {
    using editor = mount(doc, head, true, [history()]);
    expect(editor.press(key)).toBe(true);
    expect(editor.text()).toBe(expected);
    expect(editor.view.state.selection.main.head).toBe(nextHead);
    if (doc !== expected) {
      expect(undo(editor.view)).toBe(true);
      expect(editor.text()).toBe(doc);
    }
  });

  test("Shift+Enter keeps its plain newline", () => {
    using editor = mount("- ab", 3);
    expect(editor.press("Enter", { shiftKey: true })).toBe(true);
    expect(editor.text()).toBe("- a\nb");
  });

  test("an active completion keeps Enter", async () => {
    using editor = mount("- a", 2, true, [
      autocompletion({ override: [() => ({ from: 2, options: [{ label: "chosen" }] })], activateOnTyping: false, interactionDelay: 0 }),
    ]);
    startCompletion(editor.view);
    for (let attempt = 0; attempt < 30 && completionStatus(editor.view.state) !== "active"; attempt++) await Bun.sleep(10);
    expect(completionStatus(editor.view.state)).toBe("active");
    expect(editor.press("Enter")).toBe(true);
    expect(editor.text()).toBe("- chosena");
  });

  test.each([
    ["&", "Digit7", "1. a"],
    ["*", "Digit8", "a"],
    ["(", "Digit9", "- [ ] a"],
  ] as const)("shifted key %s uses the physical key %s", (key, code, expected) => {
    using editor = mount("- a");
    expect(editor.press(key, { ctrlKey: true, shiftKey: true, code })).toBe(true);
    expect(editor.text()).toBe(expected);
  });

  test("kind conversion preserves three selected depths and selection text", () => {
    using editor = mount("- a\n  - b\n    - c", 2);
    editor.view.dispatch({ selection: { anchor: 2, head: editor.text().length } });
    expect(editor.press("&", { ctrlKey: true, shiftKey: true, code: "Digit7" })).toBe(true);
    expect(editor.text()).toBe("1. a\n   1. b\n      1. c");
    expect(editor.view.state.sliceDoc(editor.view.state.selection.main.anchor, editor.view.state.selection.main.anchor + 1)).toBe("a");
    expect(editor.view.state.selection.main.head).toBe(editor.text().length);
  });

  test.each([
    ["- a", "task", "- [ ] a"],
    ["- [x] a", "bullet", "- a"],
    ["1. a", "task", "- [ ] a"],
    ["- a", "bullet", "a"],
    ["- a\n  - b", "bullet", "- a\n  - b"],
    ["", "ordered", "1. "],
    ["para\n", "task", "para\n\n- [ ] "],
  ] as const)("%s to %s has one undo", (doc, kind, expected) => {
    using editor = mount(doc, doc.length, true, [history()]);
    expect(setListKind(kind)(editor.view)).toBe(true);
    expect(editor.text()).toBe(expected);
    if (doc !== expected) {
      expect(undo(editor.view)).toBe(true);
      expect(editor.text()).toBe(doc);
    }
  });

  test.each(["bullet", "ordered", "task"] as const)("count creates %s items on an empty line and keeps the first caret", (kind) => {
    using editor = mount("");
    setListKind(kind, 3)(editor.view);
    const prefix = kind === "bullet" ? "- " : kind === "ordered" ? "1. " : "- [ ] ";
    expect(editor.text()).toBe(kind === "ordered" ? "1. \n2. \n3. " : [prefix, prefix, prefix].join("\n"));
    expect(editor.view.state.selection.main.head).toBe(prefix.length);
  });

  test("same-kind parent keeps its children", () => {
    using editor = mount("- parent\n  - child", 2);
    setListKind("bullet")(editor.view);
    expect(editor.text()).toBe("- parent\n  - child");
  });

  test("kind conversion skips blank lines, code, data and directives", () => {
    const doc = "text\n\n```\n- code\n```\n:::data\n- data\n:::\n:::query\n- query\n:::\nlast";
    using editor = mount(doc);
    editor.view.dispatch({ selection: { anchor: 0, head: doc.length } });
    setListKind("bullet")(editor.view);
    expect(editor.text()).toBe(doc.replace("text", "- text").replace("last", "- last"));
  });

  test("kind conversion shifts continuation and children across marker widths", () => {
    using editor = mount("- root\n  continuation\n  - child", 2);
    setListKind("ordered")(editor.view);
    expect(editor.text()).toBe("1. root\n   continuation\n   - child");
    expect(editor.structure().items.map((item) => item.depth)).toEqual([0, 1]);
  });

  test("ordered conversion adopts the next sibling's delimiter", () => {
    using editor = mount("- before\n- a\n1) b", 11);
    setListKind("ordered")(editor.view);
    expect(editor.text()).toBe("- before\n1) a\n2) b");
  });

  test("bullet, task and bullet keep the text caret", () => {
    using editor = mount("- word", 4);
    setListKind("task")(editor.view);
    expect(editor.text()).toBe("- [ ] word");
    expect(editor.view.state.selection.main.head).toBe(8);
    setListKind("bullet")(editor.view);
    expect(editor.text()).toBe("- word");
    expect(editor.view.state.selection.main.head).toBe(4);
  });

  test("ordered count at nested depth repairs source-only empty items", () => {
    using editor = mount("- root\n  - child", 11);
    setListKind("ordered", 3)(editor.view);
    expect(editor.text()).toBe("- root\n  1. child\n  2. \n  3. ");
    expect(editor.view.state.selection.main.head).toBe(12);
  });

  test.each(["newline", "delete line"] as const)("%s inside lazy ordered-looking text preserves its written numbers", (edit) => {
    const doc = edit === "newline" ? "- x\n  5. foo\n  7. bar" : "- x\n  5. foo\n  continuation\n  7. bar";
    using editor = mount(doc);
    expect(editor.structure().items).toHaveLength(1);
    if (edit === "newline") {
      editor.view.dispatch({ changes: { from: doc.indexOf("foo") + 1, insert: "\n  " }, userEvent: "input.type" });
      expect(editor.text()).toBe("- x\n  5. f\n  oo\n  7. bar");
    } else {
      editor.view.dispatch({ changes: { from: doc.indexOf("  continuation"), to: doc.indexOf("  7.") }, userEvent: "delete.line" });
      expect(editor.text()).toBe("- x\n  5. foo\n  7. bar");
    }
  });

  test("read-only commands and typed input do not convert", () => {
    using editor = mount("[]", 2, true, [EditorState.readOnly.of(true)]);
    expect(setListKind("task")(editor.view)).toBe(false);
    expect(toggleTaskAtCaret(editor.view)).toBe(false);
    const handled = editor.view.state
      .facet(EditorView.inputHandler)
      .some((handler) => handler(editor.view, 2, 2, " ", () => editor.view.state.update({ changes: { from: 2, insert: " " } })));
    expect(handled).toBe(false);
    expect(editor.text()).toBe("[]");
  });

  test("task typing waits for composition to finish", () => {
    using editor = mount("[]");
    Object.defineProperty(editor.view, "compositionStarted", { configurable: true, get: () => true });
    editor.type(" ");
    expect(editor.text()).toBe("[] ");
  });

  test("toggle-off separates groups, without blanks between converted lines", () => {
    using editor = mount("- a\n- b\n- c\n- d");
    editor.view.dispatch({ selection: { anchor: 6, head: 11 } });
    setListKind("bullet")(editor.view);
    expect(editor.text()).toBe("- a\n\nb\nc\n\n- d");
  });

  test.each([
    ["- a\n  continuation\n- b\n- c\n\n", 21, "Backspace", "- a\n  continuation\n\nb\n\n- c\n\n"],
    ["para\n- a\n\n", 7, "Enter", "para\n\n- \n- a\n\n"],
    ["- a\n- b\n- c\n- d\n\n", 6, "kind", "- a\n\nb\nc\n\n- d\n\n"],
  ] as const)("%s at %i: %s separates neighbours without parsing a long note's tail", (prefix, head, command, expected) => {
    const tail = "paragraph\n\n".repeat(50000);
    using editor = mount(prefix + tail, head, true, [], false);
    expect(syntaxTreeAvailable(editor.view.state, editor.text().length)).toBe(false);
    if (command === "kind") {
      editor.view.dispatch({ selection: { anchor: head, head: 11 } });
      expect(setListKind("bullet")(editor.view)).toBe(true);
    } else {
      expect(editor.press(command)).toBe(true);
    }
    expect(editor.text()).toBe(expected + tail);
    expect(syntaxTreeAvailable(editor.view.state, editor.text().length)).toBe(false);
  });

  test("ordered count on an empty line after prose keeps the first caret without parsing the tail", () => {
    const tail = "paragraph\n\n".repeat(50000);
    using editor = mount("para\n\n" + tail, 5, true, [], false);
    expect(setListKind("ordered", 3)(editor.view)).toBe(true);
    expect(editor.text()).toBe("para\n\n1. \n2. \n3. \n" + tail);
    expect(editor.view.state.selection.main.head).toBe(9);
    expect(syntaxTreeAvailable(editor.view.state, editor.text().length)).toBe(false);
  });

  test.each([
    ["7) a\n   continuation\n   - child\n8) b", "ordered", "7) a\n   continuation\n   - child\n8) \n9) \n10) b", 3],
    ["- \n- b", "task", "- [ ] \n- [ ] \n- [ ] \n- b", 6],
    ["7) [x] a", "task", "7) [x] a\n8) [ ] \n9) [ ] ", 7],
    ["* a", "bullet", "* a\n* \n* ", 2],
  ] as const)("count converts %s to %s and maps the first text caret", (doc, kind, expected, head) => {
    using editor = mount(doc, doc.indexOf(" ") + 1, true, [history()]);
    expect(setListKind(kind, 3)(editor.view)).toBe(true);
    expect(editor.text()).toBe(expected);
    expect(editor.view.state.selection.main.head).toBe(head);
    expect(undo(editor.view)).toBe(true);
    expect(editor.text()).toBe(doc);
  });

  test("todo3 inserts after the subtree, never toggling off", () => {
    using editor = mount("- [x] a\n  - child\n- b", 6);
    setListKind("task", 3)(editor.view);
    expect(editor.text()).toBe("- [x] a\n  - child\n- [ ] \n- [ ] \n- b");
    expect(editor.view.state.selection.main.head).toBe(6);
  });

  test.each(["[]", "[ ]", "- []", "1. []"])("typed %s space converts, and undo keeps the typed space", (prefix) => {
    using editor = mount(prefix, prefix.length, true, [history()]);
    editor.type(" ");
    expect(editor.text()).toBe(prefix.startsWith("1.") ? "1. [ ] " : "- [ ] ");
    expect(editor.view.state.selection.main.head).toBe(editor.text().length);
    expect(undo(editor.view)).toBe(true);
    expect(editor.text()).toBe(prefix + " ");
  });

  test("a typed `- [ ] ` is already a task and adds no extra undo step", () => {
    using editor = mount("- [ ]", 5, true, [history()]);
    editor.type(" ");
    expect(editor.text()).toBe("- [ ] ");
    expect(undo(editor.view)).toBe(true);
    expect(editor.text()).toBe("- [ ]");
  });

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

  test.each([false, true])("closeBrackets typing path with a space inside: %s", (space) => {
    using editor = mount("");
    editor.type("[");
    expect(editor.text()).toBe("[]");
    expect(editor.view.state.selection.main.head).toBe(1);
    if (space) editor.type(" ");
    editor.type("]");
    editor.type(" ");
    expect(editor.text()).toBe("- [ ] ");
  });

  test("typed shortcut stays literal in code", () => {
    using editor = mount("```\n[]\n```", 6);
    editor.type(" ");
    expect(editor.text()).toBe("```\n[] \n```");
  });

  test("an uppercase X is a checked task", () => {
    using editor = mount("1. [X] done", 10);
    toggleTaskAtCaret(editor.view);
    expect(editor.text()).toBe("1. [ ] done");
    expect(editor.view.state.selection.main.head).toBe(10);
  });

  test("Mod-Enter changes only the box and never scrolls", () => {
    const transactions: Transaction[] = [];
    using editor = mount("- [ ] a", 7, true, [
      history(),
      EditorView.updateListener.of((update) => transactions.push(...update.transactions)),
    ]);
    const selection = editor.view.state.selection;
    editor.press("Enter", mod);
    expect(editor.text()).toBe("- [x] a");
    expect(editor.view.state.selection.eq(selection)).toBe(true);
    expect(transactions.at(-1)!.scrollIntoView).toBe(false);
    expect(undo(editor.view)).toBe(true);
    expect(editor.text()).toBe("- [ ] a");
    editor.press("Enter", mod);
    editor.press("Enter", mod);
    expect(editor.text()).toBe("- [ ] a");
    using plain = mount("plain");
    expect(toggleTaskAtCaret(plain.view)).toBe(false);
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
