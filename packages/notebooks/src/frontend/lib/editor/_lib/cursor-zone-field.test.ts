import { describe, expect, spyOn, test } from "bun:test";
import { markdown } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import type { Tree } from "@lezer/common";
import { cursorZoneStateField, isPointerSelectionTransaction, selectionIntersectsRange, treeOrDocChanged } from "./cursor-zone-field";

describe("selectionIntersectsRange", () => {
  test("keeps empty cursor containment semantics", () => {
    expect(selectionIntersectsRange(EditorSelection.cursor(5), 3, 8)).toBe(true);
    expect(selectionIntersectsRange(EditorSelection.cursor(9), 3, 8)).toBe(false);
  });

  test("matches non-empty selections that overlap a range", () => {
    expect(selectionIntersectsRange(EditorSelection.range(0, 20), 3, 8)).toBe(true);
    expect(selectionIntersectsRange(EditorSelection.range(0, 3), 3, 8)).toBe(false);
    expect(selectionIntersectsRange(EditorSelection.range(8, 12), 3, 8)).toBe(false);
  });
});

describe("isPointerSelectionTransaction", () => {
  test("matches pointer-only selection transactions", () => {
    const state = EditorState.create({ doc: "hello" });

    expect(isPointerSelectionTransaction(state.update({ selection: { anchor: 1, head: 4 }, userEvent: "select.pointer" }))).toBe(true);
    expect(isPointerSelectionTransaction(state.update({ selection: { anchor: 1, head: 4 }, userEvent: "select" }))).toBe(false);
    expect(
      isPointerSelectionTransaction(
        state.update({ changes: { from: 1, insert: "!" }, selection: { anchor: 2 }, userEvent: "select.pointer" }),
      ),
    ).toBe(false);
  });
});

describe("treeOrDocChanged", () => {
  const doc = Array.from({ length: 400 }, (_, index) => `Paragraph ${index} with some ordinary prose.\n`).join("\n");

  test("ignores selection-only transactions and reports doc changes", () => {
    const state = EditorState.create({ doc, extensions: [markdown()] });
    expect(treeOrDocChanged(state.update({ selection: { anchor: 10 } }))).toBe(false);
    expect(treeOrDocChanged(state.update({ changes: { from: 0, insert: "# " } }))).toBe(true);
  });

  test("reports a later part of the syntax tree that arrives without a doc change", () => {
    const state = EditorState.create({ doc, extensions: [markdown()] });
    expect(syntaxTree(state).length).toBeLessThan(doc.length);
    expect(ensureSyntaxTree(state, doc.length, 5000)?.length).toBe(doc.length);
    expect(treeOrDocChanged(state.update({}))).toBe(true);
  });
});

describe("cursorZoneStateField in incremental mode", () => {
  const doc = Array.from({ length: 400 }, (_, index) => `Paragraph ${index} with some ordinary prose.\n`).join("\n");

  test("rebuilds when an edit also carries the syntax tree past its old end", () => {
    // CodeMirror parses an edit within a 20 ms budget; a frozen clock keeps a busy machine from cutting it short.
    const now = spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      // A field without marker syntax whose edits never look relevant: only a grown tree may rebuild it.
      const trees: Tree[] = [];
      const field = cursorZoneStateField(
        (state) => {
          trees.push(syntaxTree(state));
          return { decorations: Decoration.none, ranges: [], hasSyntax: false };
        },
        { changesMightAffectSyntax: () => false },
      );
      const state = EditorState.create({ doc, extensions: [markdown(), field] });
      expect(syntaxTree(state).length).toBeLessThan(doc.length);
      expect(trees).toHaveLength(1);

      // The parser has reached the end but not handed the tree over yet; the next edit carries it.
      expect(ensureSyntaxTree(state, doc.length, 5000)?.length).toBe(doc.length);
      const edited = state.update({ changes: { from: 10, insert: "x" } }).state;
      expect(syntaxTree(edited).length).toBe(edited.doc.length);
      expect(trees).toHaveLength(2);
      expect(trees[1]).toBe(syntaxTree(edited));

      // With the whole note parsed, plain edits keep skipping the rebuild, also at the end.
      const typed = edited.update({ changes: { from: 20, insert: "y" } }).state;
      const appended = typed.update({ changes: { from: typed.doc.length, insert: "z" } }).state;
      expect(syntaxTree(appended).length).toBe(appended.doc.length);
      expect(trees).toHaveLength(2);
    } finally {
      now.mockRestore();
    }
  });
});
