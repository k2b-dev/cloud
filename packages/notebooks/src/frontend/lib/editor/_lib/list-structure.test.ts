import { describe, expect, test } from "bun:test";
import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { markdownExtension } from "../markdown";
import { listItemAtLine, listStructure, orderedLabel } from "./list-structure";
import { type ItemTuple, listStructureCases } from "./list-structure.fixture";

const stateFor = (doc: string) => EditorState.create({ doc, extensions: [markdownExtension()] });

const labelCases: Array<[number, number, string]> = [
  [1, 0, "1."],
  [0, 1, "0."],
  [-1, 1, "-1."],
  [1, 1, "a."],
  [26, 1, "z."],
  [27, 1, "aa."],
  [52, 1, "az."],
  [703, 1, "aaa."],
  [0, 2, "0."],
  [1, 2, "i."],
  [4, 2, "iv."],
  [944, 2, "cmxliv."],
  [3999, 2, "mmmcmxcix."],
  [4000, 2, "4000."],
  [2, 3, "2."],
  [2, 4, "b."],
  [2, 5, "ii."],
];

describe("Markdown list structure", () => {
  test.each(listStructureCases)("$name", ({ markdown, items }) => {
    const state = stateFor(markdown);
    expect(syntaxTree(state).length).toBe(markdown.length);
    const structure = listStructure(state);
    expect(
      structure.items.map(
        (item): ItemTuple => [
          item.line,
          item.depth,
          item.orderedDepth,
          item.kind,
          item.ordinal,
          item.ordinal === null ? null : orderedLabel(item.ordinal, item.orderedDepth),
          item.parent,
          item.subtreeEnd,
          item.contentFrom - item.from,
        ],
      ),
    ).toEqual(items);
    for (const item of structure.items) {
      expect(state.sliceDoc(item.markerFrom, item.markerTo)).toMatch(/^(?:[-*+]|\d+[.)])$/);
      if (!item.ordered) expect(item.start).toBeNull();
      expect(item.to).toBeGreaterThanOrEqual(item.contentFrom);
      if (item.taskFrom !== null && item.taskTo !== null) {
        const marker = state.sliceDoc(item.taskFrom, item.taskTo);
        expect(marker).toMatch(/^\[[ xX]\]$/);
        expect(item.checked).toBe(marker !== "[ ]");
      } else expect(item.checked).toBe(false);
    }
  });

  test("finds only marker lines by binary search", () => {
    const structure = listStructure(stateFor("Intro\n- root\n  - child\n    continuation\n\n- next\n"));
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map((line) => listItemAtLine(structure, line))).toEqual([-1, -1, 0, 1, -1, -1, 2, -1, -1]);
    expect(listItemAtLine({ items: [] }, 1)).toBe(-1);
  });

  test("keeps item ends around their full subtree and their list's start", () => {
    const state = stateFor("3. root\n   2. child\n7. next");
    const { items } = listStructure(state);
    expect(items.map(({ start, ordinal, to }) => [start, ordinal, to])).toEqual([
      [3, 3, 19],
      [2, 2, 19],
      [3, 4, 27],
    ]);
  });

  test.each(labelCases)("orderedLabel(%s, %s)", (ordinal, depth, label) => {
    expect(orderedLabel(ordinal, depth)).toBe(label);
  });
});
