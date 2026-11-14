import { expect, test } from "bun:test";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { pointerSelectionHeld, pointerSelectionHoldEffect, refreshMarkdownDecorationsEffect } from "./_lib/cursor-zone-field";
import { listStateField, listsExtension } from "./lists";
import { markdownExtension } from "./markdown";
import { markupExtension } from "./markup";

const create = (doc: string, selection = EditorSelection.single(doc.length)) => {
  const state = EditorState.create({
    doc,
    selection,
    extensions: [markdownExtension(), pointerSelectionHeld, markupExtension(), listsExtension()],
  });
  ensureSyntaxTree(state, doc.length, 1000);
  return state.update({}).state;
};
const decorations = (state: EditorState) =>
  state.facet(EditorView.decorations).flatMap((set) => {
    if (typeof set === "function") return [];
    const entries: unknown[] = [];
    for (let cursor = set.iter(); cursor.value; cursor.next()) entries.push([cursor.from, cursor.to, cursor.value.spec]);
    return entries;
  });

test("incremental markup and lists agree with a fresh complete parse after edits and selections", () => {
  let state = create("# Title\n\n**bold** and *italic*\n\n---\n\n8. first\n   - child\n9. second\n\nTail\n");
  const check = () => {
    ensureSyntaxTree(state, state.doc.length, 1000);
    state = state.update({}).state;
    const fresh = create(state.doc.toString(), state.selection);
    expect(state.field(listStateField).structure).toEqual(fresh.field(listStateField).structure);
    expect(decorations(state), JSON.stringify({ doc: state.doc.toString(), selection: state.selection.toJSON() })).toEqual(
      decorations(fresh),
    );
  };
  for (const find of ["Title", "bold", "italic", "---", "first", "child", "second", "Tail"]) {
    const at = state.doc.toString().indexOf(find);
    state = state.update({ selection: { anchor: at + 1 } }).state;
    check();
    state = state.update({ changes: { from: at + 1, insert: "x" }, selection: { anchor: at + 2 } }).state;
    check();
    state = state.update({ changes: { from: at + 1, to: at + 2 } }).state;
    check();
  }
  for (const insert of ["```\n", "\n", "- ", "> ", "## "]) {
    state = state.update({ changes: { from: 0, insert } }).state;
    check();
    state = state.update({ changes: { from: 0, to: insert.length } }).state;
    check();
  }
});

test("pointer release conceals the block left behind during a held selection", () => {
  let state = create("**bold** text\n\nTail *it*\n", EditorSelection.single(3));
  state = state.update({ effects: pointerSelectionHoldEffect.of(true) }).state;
  state = state.update({ selection: { anchor: 17 }, userEvent: "select.pointer" }).state;
  state = state.update({ effects: refreshMarkdownDecorationsEffect.of() }).state;
  expect(decorations(state)).toEqual(decorations(create(state.doc.toString(), state.selection)));
});

test.each(["- one\n- two", "# Title\n\n**bold**\n\n---\n\n- first\n  - child"])(
  "deleting every block removes its cached structure: %s",
  (doc) => {
    let state = create(doc);
    state = state.update({ changes: { from: 0, to: doc.length } }).state;
    const fresh = create("");
    expect(state.field(listStateField).structure).toEqual(fresh.field(listStateField).structure);
    expect(decorations(state)).toEqual(decorations(fresh));
  },
);
