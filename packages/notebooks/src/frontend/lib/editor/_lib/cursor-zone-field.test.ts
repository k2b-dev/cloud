import { describe, expect, test } from "bun:test";
import { markdown } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { isPointerSelectionTransaction, selectionIntersectsRange, treeOrDocChanged } from "./cursor-zone-field";

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
