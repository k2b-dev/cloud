import { describe, expect, spyOn, test } from "bun:test";
import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import * as namedBlocks from "../../../../lib/named-blocks";
import * as queryBlocks from "../../../../lib/query-blocks";
import { listStateField } from "../lists";
import { markdownExtension } from "../markdown";
import { excludedSpans, listItemAtLine, listStructure, markerChanges, orderedLabel, renumberChanges, siblingIndex } from "./list-structure";
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
  [2, 6, "ii."],
  [3, 9, "iii."],
];

describe("Markdown list structure", () => {
  test.each(listStructureCases)("$name", ({ markdown, items }) => {
    const state = stateFor(markdown);
    expect(syntaxTree(state).length).toBe(markdown.length);
    const structure = listStructure(state, () => excludedSpans(state));
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
    const state = stateFor("Intro\n- root\n  - child\n    continuation\n\n- next\n");
    const structure = listStructure(state, () => excludedSpans(state));
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map((line) => listItemAtLine(structure, line))).toEqual([-1, -1, 0, 1, -1, -1, 2, -1, -1]);
    expect(listItemAtLine({ items: [] }, 1)).toBe(-1);
  });

  test("keeps item ends around their full subtree and their list's start", () => {
    const state = stateFor("3. root\n   2. child\n7. next");
    const { items } = listStructure(state, () => excludedSpans(state));
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

describe("cached notebook block exclusions", () => {
  const create = (doc: string) => EditorState.create({ doc, extensions: [markdownExtension(), listStateField] });
  const check = (state: EditorState) => {
    const fresh = excludedSpans(state);
    const field = state.field(listStateField);
    expect(field.structure).toEqual(listStructure(state, () => fresh));
    if (field.excluded) expect(field.excluded).toEqual(fresh);
  };

  test("maps text edits and rescans block delimiters, fences and handles", () => {
    let state = create("Intro\n\n:::data\nvalues:\n  - hidden\n:::\n\n- outside\n");
    check(state);
    const replace = (source: string, insert: string) => {
      const from = state.doc.toString().indexOf(source);
      expect(from).toBeGreaterThanOrEqual(0);
      state = state.update({ changes: { from, to: from + source.length, insert } }).state;
      check(state);
    };
    replace("hidden", "hidden text");
    replace("outside", "outside text");
    replace("Intro", "Longer intro");
    replace("\n:::\n\n", "\n");
    replace("\n- outside", "\n:::\n\n- outside");
    replace(":::data", "```\n:::data");
    replace(":::data", "```\n\n:::data");
    replace("```\n```", "```\n    ```");
    replace("    ```", "```");
    replace("```\n```\n\n", "");
    replace(":::data", "@profile\n:::data");
    const block = "@profile\n:::data\nvalues:\n  - hidden text\n:::\n";
    replace(block, "");
    replace("Longer intro\n\n", `Longer intro\n\n${block}`);
  });

  test("plain list and block-body keystrokes do not run either scanner", () => {
    const dataScan = spyOn(namedBlocks, "extractDataBlocks");
    const directiveScan = spyOn(queryBlocks, "extractNotebookDirectiveRanges");
    try {
      let state = create(":::data\nvalues:\n  - hidden\n:::\n\n" + "- ordinary list text\n".repeat(100));
      expect(dataScan).toHaveBeenCalledTimes(1);
      expect(directiveScan).toHaveBeenCalledTimes(1);
      for (const line of [state.doc.lines - 1, 3]) {
        state = state.update({ changes: { from: state.doc.line(line).to, insert: "x" } }).state;
      }
      expect(dataScan).toHaveBeenCalledTimes(1);
      expect(directiveScan).toHaveBeenCalledTimes(1);
      check(state);
    } finally {
      dataScan.mockRestore();
      directiveScan.mockRestore();
    }
  });

  test("does not scan on create without lists and initializes when a list appears", () => {
    const dataScan = spyOn(namedBlocks, "extractDataBlocks");
    const directiveScan = spyOn(queryBlocks, "extractNotebookDirectiveRanges");
    try {
      let state = create(":::data\nvalue: text\n:::\n");
      expect(state.field(listStateField).excluded).toBeUndefined();
      expect(dataScan).not.toHaveBeenCalled();
      expect(directiveScan).not.toHaveBeenCalled();
      state = state.update({ changes: { from: state.doc.length, insert: "\n- item" } }).state;
      expect(dataScan).toHaveBeenCalledTimes(1);
      expect(directiveScan).toHaveBeenCalledTimes(1);
      check(state);
    } finally {
      dataScan.mockRestore();
      directiveScan.mockRestore();
    }
  });

  test.each([
    ["~~~", "    ~~~"],
    ["> quote", "quote"],
    ["<div>", "ordinary text"],
    ["- container", "ordinary text"],
    ["- container", "- # heading"],
    ["  continuation", "  #heading"],
    ["- container", "- - nested"],
    ["- ", "- container"],
    ["1. container", "2. container"],
    ["    code", "code"],
    ["\tcode", "code"],
    ["ordinary text", ""],
    ["ordinary text", "---"],
    ["ordinary text", "@profile"],
    ["a | b", "a b"],
    [":::note", "ordinary text"],
  ])("container edit %s → %s agrees with a fresh scan", (before, after) => {
    let state = create(`${before}\n:::data\nvalues:\n  - hidden\n:::\n\n- outside\n`);
    check(state);
    state = state.update({ changes: { from: 0, to: before.length, insert: after } }).state;
    check(state);
    state = state.update({ changes: { from: 0, to: after.length, insert: before } }).state;
    check(state);
  });

  test("maps multiple edits and the EOF of an unclosed directive", () => {
    let state = create("- outside\n\n:::query\ncolumns:\n  - $title");
    state = state.update({
      changes: [
        { from: 3, insert: "x" },
        { from: state.doc.length, insert: "x" },
      ],
    }).state;
    check(state);
    state = state.update({ changes: { from: state.doc.length, insert: "\n:::\n\n- after" } }).state;
    check(state);
  });
});

describe("source list marker repair", () => {
  const structureFor = (state: EditorState) => listStructure(state, () => excludedSpans(state));

  test("marker width shifts a continuation and the entire child subtree, leaving blank lines blank", () => {
    const state = stateFor("9. root\n   continuation\n\n   - child\n     - grandchild");
    const structure = structureFor(state);
    const changes = markerChanges(state, structure, new Map([[0, "10."]]));
    expect(changes.apply(state.doc).toString()).toBe("10. root\n    continuation\n\n    - child\n      - grandchild");
    const after = stateFor(changes.apply(state.doc).toString());
    expect(structureFor(after).items.map(({ depth, parent }) => [depth, parent])).toEqual(
      structure.items.map(({ depth, parent }) => [depth, parent]),
    );
  });

  test("nested marker deltas add up once per line without overlapping edits", () => {
    const state = stateFor("9. root\n   9) child\n      continuation\n      - grandchild");
    const structure = structureFor(state);
    const changed = markerChanges(
      state,
      structure,
      new Map([
        [0, "10."],
        [1, "10)"],
      ]),
    );
    expect(changed.apply(state.doc).toString()).toBe("10. root\n    10) child\n        continuation\n        - grandchild");
    const after = stateFor(changed.apply(state.doc).toString());
    const reversed = markerChanges(
      after,
      structureFor(after),
      new Map([
        [0, "9."],
        [1, "9)"],
      ]),
    );
    expect(reversed.apply(after.doc).toString()).toBe(state.doc.toString());
  });

  test("adoption keeps both task checkbox states and removes only existing indentation", () => {
    const state = stateFor("- [ ] open\n  - [x] done\n    continuation");
    expect(
      markerChanges(
        state,
        structureFor(state),
        new Map([
          [0, "10)"],
          [1, "11."],
        ]),
      )
        .apply(state.doc)
        .toString(),
    ).toBe("10) [ ] open\n    11. [x] done\n        continuation");
    const malformed = stateFor("100. root\n continuation");
    expect(
      markerChanges(malformed, structureFor(malformed), new Map([[0, "-"]]))
        .apply(malformed.doc)
        .toString(),
    ).toBe("- root\ncontinuation");
  });

  test("renumber preserves start, delimiter and tasks, and is idempotent", () => {
    const state = stateFor("8) [ ] one\n1) [x] two\n2) three\n   continuation\n   - child");
    const changes = renumberChanges(state, structureFor(state));
    expect(changes.apply(state.doc).toString()).toBe("8) [ ] one\n9) [x] two\n10) three\n    continuation\n    - child");
    const after = stateFor(changes.apply(state.doc).toString());
    expect(renumberChanges(after, structureFor(after)).empty).toBe(true);
  });

  test("repair ignores data, query, code and quote lists", () => {
    const doc =
      "1. real\n1. real\n\n:::data\n1. data\n1. data\n:::\n\n:::query\n1. query\n1. query\n:::\n\n```md\n1. code\n1. code\n```\n\n> 1. quote\n> 1. quote";
    const state = stateFor(doc);
    expect(renumberChanges(state, structureFor(state)).apply(state.doc).toString()).toBe(
      doc.replace("1. real\n1. real", "1. real\n2. real"),
    );
  });

  test("range scans retain depth and ordinals and siblings never cross list boundaries", () => {
    const doc = "- before\n\nparagraph\n\n3. root\n   - child\n4. sibling\n\n* separate\n* next";
    const state = stateFor(doc);
    const range = { from: doc.indexOf("3."), to: doc.indexOf("\n\n* separate") };
    const structure = listStructure(state, () => excludedSpans(state), range);
    expect(structure.items.map(({ depth, ordinal, parent }) => [depth, ordinal, parent])).toEqual([
      [0, 3, -1],
      [1, null, 0],
      [0, 4, -1],
    ]);
    expect(siblingIndex(structure, 0, 1)).toBe(2);
    expect(siblingIndex(structure, 2, -1)).toBe(0);
    expect(siblingIndex(structure, 1, 1)).toBe(-1);
    const full = structureFor(state);
    expect(siblingIndex(full, 3, 1)).toBe(-1);
  });
});
