import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MenuAction, TableTarget } from "@k2b/ui/text-editor";
import * as T from "@k2b/ui/text-editor/model";
import * as Y from "yjs";
import { captureTextAnchor, resolveTextAnchor } from "./anchors";
import {
  captureTableAction,
  planTableAction,
  type TableActionIntent,
  TableActionLimitError,
  TableActionRejectedError,
} from "./table-actions";

const docs: Y.Doc[] = [];
const histories: Y.UndoManager[] = [];
let client = 100;
beforeEach(() => {
  client = 100;
});
afterEach(() => {
  for (const history of histories.splice(0)) history.destroy();
  for (const doc of docs.splice(0)) doc.destroy();
});
const document = (source = "") => {
  const doc = new Y.Doc();
  doc.clientID = ++client;
  docs.push(doc);
  const text = doc.getText("codemirror");
  if (source) text.insert(0, source);
  return { doc, text };
};
const table = (text: Y.Text, at = 0) => {
  const result = T.findTables(text.toString())[at];
  if (!result) throw new Error("Missing test table");
  return result;
};
const target = (text: Y.Text, row = 1, column = 1, at = 0): TableTarget => {
  const t = table(text, at);
  return {
    tableFrom: t.from,
    rowFrom: T.gridLine(t, row)!.from,
    columnFrom: t.lines[0]!.cells[Math.min(column, t.columns - 1)]!.from,
    row,
    column,
  };
};
const capture = (text: Y.Text, action: MenuAction, row = 1, column = 1, at = 0) =>
  captureTableAction(text, action, target(text, row, column, at));
const apply = (text: Y.Text, changes: T.Change[]) => {
  const expected = T.applyChanges(text.toString(), changes);
  text.doc!.transact(() => {
    for (const change of [...changes].sort((a, b) => b.from - a.from || b.to - a.to)) {
      if (change.to > change.from) text.delete(change.from, change.to - change.from);
      if (change.insert) text.insert(change.from, change.insert);
    }
  });
  expect(text.toString()).toBe(expected);
};
// Every server plan uses a fresh reconstruction, never the capturing Y.Text.
const plan = (text: Y.Text, intent: TableActionIntent) => {
  const server = document();
  Y.applyUpdate(server.doc, Y.encodeStateAsUpdate(text.doc!));
  const before = Y.encodeStateAsUpdate(server.doc);
  try {
    return planTableAction(server.text, intent, 2_097_152);
  } finally {
    expect(Y.encodeStateAsUpdate(server.doc)).toEqual(before);
  }
};
const rejected = (text: Y.Text, intent: TableActionIntent) => {
  expect(() => plan(text, intent)).toThrow(TableActionRejectedError);
  try {
    plan(text, intent);
  } catch (error) {
    expect(error).toHaveProperty("code", "table_target_rejected");
  }
};
const source = "Before 🦉\n\n| A | B | C |\n| --- | --- | --- |\n| a1 | b1 | c1 |\n| a2 | b2 | c2 |\n\nAfter";
const grid = (text: Y.Text) =>
  table(text)
    .lines.filter((_, i) => i !== 1)
    .map((line) => line.cells.map((cell) => cell.text));

describe("synchronous capture and reconstructed server planning", () => {
  test("all menu intents return the existing model's disjoint changes", () => {
    const expected: Record<MenuAction, (t: T.Table) => T.Change[]> = {
      completeColumns: T.completeColumns,
      rowAbove: (t) => T.insertRow(t, 0),
      rowBelow: (t) => T.insertRow(t, 1),
      colLeft: (t) => T.insertColumn(t, 1),
      colRight: (t) => T.insertColumn(t, 2),
      deleteRow: (t) => T.deleteRow(t, 1),
      deleteCol: (t) => T.deleteColumn(t, 1),
      alignLeft: (t) => T.setAlign(t, 1, "left"),
      alignCenter: (t) => T.setAlign(t, 1, "center"),
      alignRight: (t) => T.setAlign(t, 1, "right"),
    };
    const actions: MenuAction[] = [
      "completeColumns",
      "rowAbove",
      "rowBelow",
      "colLeft",
      "colRight",
      "deleteRow",
      "deleteCol",
      "alignLeft",
      "alignCenter",
      "alignRight",
    ];
    for (const action of actions) {
      const { text } = document(source);
      const intent = capture(text, action);
      expect(intent).not.toBeInstanceOf(Promise);
      const changes = plan(text, intent);
      expect(changes).toEqual(expected[action](table(text)));
      apply(text, changes);
      expect(text.toString().startsWith("Before 🦉\n\n")).toBe(true);
      expect(text.toString().endsWith("\n\nAfter")).toBe(true);
    }
  });

  test("shifted prose and replaced header/body text do not change structural identity", () => {
    const { text } = document(source);
    const columnIntent = capture(text, "alignRight");
    const rowIntent = capture(text, "rowBelow");
    text.insert(0, "New introductory prose\n\n");
    const header = table(text).lines[0]!.cells[1]!;
    text.delete(header.from, header.to - header.from);
    text.insert(header.from, "Renamed completely 🦉");
    const body = T.gridLine(table(text), 1)!.cells[1]!;
    text.delete(body.from, body.to - body.from);
    text.insert(body.from, "Replacement body text");
    apply(text, plan(text, columnIntent));
    expect(table(text).align).toEqual([null, "right", null]);
    apply(text, plan(text, rowIntent));
    expect(grid(text)[1]).toEqual(["a1", "Replacement body text", "c1"]);
    expect(grid(text)[2]).toEqual(["", "", ""]);
    expect(grid(text)[3]).toEqual(["a2", "b2", "c2"]);
  });

  test("unrelated rows and columns inserted ahead shift the resolved ordinals", () => {
    const { text } = document(source);
    const rowIntent = capture(text, "deleteRow", 2, 2);
    const columnIntent = capture(text, "deleteCol", 2, 2);
    apply(text, T.insertRow(table(text), 0));
    apply(text, T.insertColumn(table(text), 0));
    apply(text, plan(text, rowIntent));
    expect(grid(text)).toEqual([
      ["", "A", "B", "C"],
      ["", "", "", ""],
      ["", "a1", "b1", "c1"],
    ]);
    apply(text, plan(text, columnIntent));
    expect(grid(text)).toEqual([
      ["", "A", "B"],
      ["", "", ""],
      ["", "a1", "b1"],
    ]);
  });

  test("a delayed browser intent follows peer edits through duplicate Yjs update delivery", () => {
    const browser = document(source),
      peer = document();
    Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(browser.doc));
    const intent = capture(browser.text, "deleteCol", 2, 2);
    const basis = Y.encodeStateVector(browser.doc);
    apply(peer.text, T.insertColumn(table(peer.text), 0));
    apply(peer.text, T.insertRow(table(peer.text), 0));
    peer.text.insert(0, "Peer prose\n\n");
    const update = Y.encodeStateAsUpdate(peer.doc, basis);
    Y.applyUpdate(browser.doc, update);
    Y.applyUpdate(browser.doc, update);
    const changes = plan(browser.text, intent);
    apply(browser.text, changes);
    Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(browser.doc));
    expect(peer.text.toString()).toBe(browser.text.toString());
    expect(grid(browser.text)).toEqual([
      ["", "A", "B"],
      ["", "", ""],
      ["", "a1", "b1"],
      ["", "a2", "b2"],
    ]);
  });

  test("an alignment intent stays targetable after another alignment changes colons", () => {
    const { text } = document(source);
    const left = capture(text, "alignLeft"),
      center = capture(text, "alignCenter"),
      right = capture(text, "alignRight");
    for (const [intent, alignment] of [
      [center, "center"],
      [right, "right"],
      [left, "left"],
    ] as const) {
      apply(text, plan(text, intent));
      expect(table(text).align[1]).toBe(alignment);
    }
  });

  test("header row actions keep model semantics, including harmless header deletion", () => {
    for (const action of ["rowAbove", "rowBelow", "deleteRow"] as const) {
      const { text } = document(source);
      const changes = plan(text, capture(text, action, 0));
      expect(changes).toEqual(action === "deleteRow" ? [] : T.insertRow(table(text), 0));
    }
  });
});

describe("stale and forged intents cannot retarget surviving neighbours", () => {
  test("exact row/column deletion rejects even when another target occupies the old ordinal", () => {
    for (const action of ["deleteRow", "deleteCol"] as const) {
      const { text } = document(source);
      const intent = capture(text, action);
      apply(text, action === "deleteRow" ? T.deleteRow(table(text), 1) : T.deleteColumn(table(text), 1));
      rejected(text, intent);
    }
  });

  test("same-looking row, column and entire table replacements reject", () => {
    for (const action of ["deleteRow", "deleteCol", "completeColumns"] as const) {
      const { text } = document(source);
      const intent = capture(text, action);
      const t = table(text);
      const changes =
        action === "deleteRow"
          ? T.deleteRow(t, 1)
          : action === "deleteCol"
            ? T.deleteColumn(t, 1)
            : [{ from: t.from, to: t.to, insert: "" }];
      const replacements = changes.map((change) => ({ ...change, insert: text.toString().slice(change.from, change.to) }));
      apply(text, replacements);
      expect(text.toString()).toBe(source);
      rejected(text, intent);
    }
  });

  test("undo resurrection never revives captured row, column or table identity", () => {
    for (const action of ["deleteRow", "deleteCol", "completeColumns"] as const) {
      const { text } = document(source);
      const intent = capture(text, action);
      const history = new Y.UndoManager(text, { captureTimeout: 0 });
      histories.push(history);
      const t = table(text);
      apply(
        text,
        action === "deleteRow"
          ? T.deleteRow(t, 1)
          : action === "deleteCol"
            ? T.deleteColumn(t, 1)
            : [{ from: t.from, to: t.to, insert: "" }],
      );
      history.undo();
      expect(text.toString()).toBe(source);
      rejected(text, intent);
      // Freshly captured structure is usable; only the old identity is stale.
      expect(() => plan(text, capture(text, action))).not.toThrow();
    }
  });

  test("a row's surviving ending newline cannot substitute for its deleted preceding boundary", () => {
    const { text } = document(source);
    const intent = capture(text, "rowBelow", 2);
    const row = T.gridLine(table(text), 2)!;
    const ending = captureTextAnchor(text, row.to);
    apply(text, T.deleteRow(table(text), 2));
    expect(resolveTextAnchor(text, ending)).not.toBeNull();
    rejected(text, intent);
  });

  test("current parser context rejects tables moved into code, quotes, lists or prose", () => {
    const bare = "| A | B |\n| --- | --- |\n| x | y |";
    for (const context of ["fence", "indent", "quote", "list", "prose"] as const) {
      const { text } = document(bare);
      const intent = capture(text, "deleteCol");
      if (context === "fence") {
        text.insert(text.length, "\n```");
        text.insert(0, "```md\n");
      } else if (context === "prose") {
        // Original witnesses survive, but the separator is no longer GFM.
        text.insert(table(text).lines[1]!.from + 2, "not a separator ");
      } else {
        const starts = table(text)
          .lines.map((line) => line.from)
          .reverse();
        for (const at of starts) text.insert(at, context === "quote" ? "> " : context === "indent" ? "    " : at === 0 ? "- " : "  ");
      }
      rejected(text, intent);
    }
    for (const raw of [
      "ordinary prose",
      `\`\`\`\n${bare}\n\`\`\``,
      bare
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n"),
    ]) {
      const { text } = document(raw);
      expect(() => captureTableAction(text, "deleteCol", { tableFrom: 0, rowFrom: 0, columnFrom: 0, row: 0, column: 0 })).toThrow(
        TableActionRejectedError,
      );
    }
  });

  test("mixed tables, mixed row boundaries and mixed column edges reject", () => {
    const { text } = document(`${source}\n\n${source}`);
    const first = capture(text, "deleteCol"),
      second = capture(text, "deleteCol", 1, 1, 1),
      otherColumn = capture(text, "deleteCol", 1, 2),
      row1 = capture(text, "deleteRow", 1),
      row2 = capture(text, "deleteRow", 2);
    if (!("column" in first && "column" in second && "column" in otherColumn && "row" in row1 && "row" in row2))
      throw new Error("Wrong fixture intents");
    rejected(text, { ...first, column: second.column });
    rejected(text, { ...first, table: { ...first.table, separatorHyphen: second.table.separatorHyphen } });
    rejected(text, { ...first, column: { ...first.column, right: otherColumn.column.right } });
    if (row1.row.kind !== "body" || row2.row.kind !== "body") throw new Error("Missing body witness");
    rejected(text, { ...row1, row: { ...row1.row, inside: row2.row.inside } });
  });

  test("invalid bytes, unknown/type-mismatched anchors, sentinels and malformed transport reject", () => {
    const { doc, text } = document(source);
    const intent = capture(text, "deleteCol");
    if (!("column" in intent)) throw new Error("Missing column witness");
    const other = document(source);
    const heading = doc.getText("heading");
    heading.insert(0, "---");
    const bad = [
      new Uint8Array(),
      new Uint8Array([255, 255, 255]),
      captureTextAnchor(other.text, 0),
      captureTextAnchor(heading, 0),
      Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, text.length)),
      Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, table(text).lines[1]!.cells[1]!.from, -1)),
      captureTextAnchor(text, table(text).lines[0]!.cells[1]!.from),
    ];
    for (const hyphen of bad) rejected(text, { ...intent, column: { ...intent.column, hyphen } });
    // The API's static type cannot vouch for a decoded transport body.
    for (const malformed of [
      null,
      {},
      { ...intent, action: "arbitrary" },
      { ...intent, column: null },
      { ...intent, table: { headerBreak: [] } },
    ]) {
      // @ts-expect-error Deliberately untrusted wire input.
      rejected(text, malformed);
    }
  });

  test("stale or inconsistent UI offsets reject at capture", () => {
    const { text } = document(source);
    const valid = target(text);
    expect(() => captureTableAction(new Y.Text(), "deleteCol", valid)).toThrow(TableActionRejectedError);
    for (const invalid of [
      { ...valid, rowFrom: 0 },
      { ...valid, columnFrom: 0 },
      { ...valid, tableFrom: 0 },
      { ...valid, row: NaN },
      { ...valid, column: -1 },
    ]) {
      expect(() => captureTableAction(text, "deleteCol", invalid)).toThrow(TableActionRejectedError);
    }
  });
});

describe("valid GFM variations and identity preservation", () => {
  test("ragged extras complete without turning the UI's clamped offset into another column", () => {
    const { text } = document("| A | B |\n| --- | --- |\n| x | y | EXTRA |\n| short |");
    const complete = capture(text, "completeColumns", 1, 2);
    for (const action of ["colLeft", "colRight", "deleteCol", "alignLeft", "alignCenter", "alignRight"] as const)
      expect(() => capture(text, action, 1, 2)).toThrow(TableActionRejectedError);
    apply(text, plan(text, complete));
    expect(table(text).lines.map((line) => line.cells.length)).toEqual([3, 3, 3, 3]);
    expect(grid(text)[1]).toEqual(["x", "y", "EXTRA"]);
    expect(plan(text, complete)).toEqual([]);
    apply(text, plan(text, capture(text, "deleteCol", 1, 2)));
    expect(grid(text)[1]).toEqual(["x", "y"]);
  });

  test("omitted outer pipes use existing physical newline boundaries, including CRLF/CR", () => {
    for (const newline of ["\n", "\r\n", "\r"]) {
      for (const column of [0, 1]) {
        const { text } = document(["A | B", "--- | ---", "x | y", "z | w"].join(newline));
        const intent = capture(text, "alignCenter", 1, column);
        const deletion = capture(text, "deleteRow", 2, column);
        text.insert(0, `intro${newline}${newline}`);
        apply(text, plan(text, intent));
        expect(table(text).align[column]).toBe("center");
        apply(text, plan(text, deletion));
        expect(grid(text)).toEqual([
          ["A", "B"],
          ["x", "y"],
        ]);
      }
    }
  });

  test("missing actual boundaries reject instead of anchoring editable text or EOF", () => {
    const { text } = document("A | B\n--- | ---");
    // The left column has two existing boundaries; the last column lacks one.
    expect(() => plan(text, capture(text, "alignLeft", 0, 0))).not.toThrow();
    expect(() => capture(text, "alignLeft", 0, 1)).toThrow(TableActionRejectedError);
    expect(plan(text, capture(text, "completeColumns", 0, 1))).toEqual([]);
    const pipeless = document("A | B\n--- | ---\nplain body\n\nAfter").text;
    apply(pipeless, plan(pipeless, capture(pipeless, "deleteRow", 1, 0)));
    expect(grid(pipeless)).toEqual([["A", "B"]]);
    const eof = document("A | B\n--- | ---\nplain body").text;
    expect(() => capture(eof, "deleteRow", 1, 0)).toThrow(TableActionRejectedError);
  });

  test("a new separator boundary inside a captured column rejects rather than splitting its identity", () => {
    const { text } = document(source);
    const intent = capture(text, "alignRight");
    // Insert a new column inside the target's old left/right boundaries.
    apply(text, T.insertColumn(table(text), 1));
    rejected(text, intent);
  });

  test("descending disjoint edits preserve untouched Yjs identities between changes", () => {
    const { text } = document(source);
    const original = table(text);
    const positions = [
      original.lines[0]!.cells[2]!.from,
      original.lines[1]!.cells[2]!.from,
      T.gridLine(original, 1)!.cells[0]!.from,
      T.gridLine(original, 2)!.cells[2]!.from,
      0,
      text.length - 1,
    ];
    const witnesses = positions.map((at) => ({ anchor: captureTextAnchor(text, at), character: text.toString()[at] }));
    const futureColumnAction = capture(text, "alignCenter", 2, 2);
    const changes = plan(text, capture(text, "colLeft", 1, 1));
    expect(changes).toHaveLength(original.lines.length);
    expect(changes.every((change) => change.from === change.to)).toBe(true);
    apply(text, changes);
    for (const witness of witnesses) {
      const at = resolveTextAnchor(text, witness.anchor);
      expect(at).not.toBeNull();
      expect(text.toString()[at!]).toBe(witness.character);
    }
    apply(text, plan(text, futureColumnAction));
    expect(table(text).align).toEqual([null, null, null, "center"]);
  });
});

test("column completion and insertion refuse expanded grids before allocating them", () => {
  const source = "| A | B |\n| --- | --- |\n" + "|x".repeat(100) + "|\n" + "x\n".repeat(100);
  const { text } = document(source);
  const intent = capture(text, "completeColumns", 1, 0);
  expect(() => planTableAction(text, intent, 4096)).toThrow(TableActionLimitError);
  expect(text.toString()).toBe(source);
  const wide = document("|A".repeat(100) + "|\n" + "|---".repeat(100) + "|\n" + "x\n".repeat(100));
  const column = capture(wide.text, "colRight", 1, 99);
  expect(() => planTableAction(wide.text, column, 4096)).toThrow(TableActionLimitError);
});
