import { expect, test } from "bun:test";
import * as T from "@k2b/ui/text-editor/model";
import * as Y from "yjs";
import { captureTextAnchor, resolveTextAnchor } from "./anchors";
import { createDoc } from "./documents";
import { createStructuralFixture } from "./structural-history.test-fixture";
import {
  captureTableAction,
  captureTableFocus,
  captureTableSource,
  planTableAction,
  prepareTableActionFocus,
  resolveTableFocus,
} from "./table-actions";

for (const alignment of ["alignLeft", "alignCenter", "alignRight"] as const)
  test(`durable server Undo retains accepted ${alignment}, and Redo consumes its own frame`, async () => {
    const f = createStructuralFixture();
    try {
      await f.action(f.own, "colLeft");
      await f.action(f.peer, alignment, 0, false);
      await f.own.history.undo();
      const canonical = (await f.canonical()).text!;
      expect(T.findTables(canonical)[0]!.columns).toBe(2);
      expect(f.own.text.toString()).toBe(canonical);
      expect(f.own.hints()).toBe(1);
      expect(f.own.history.undoDepth()).toBe(0);
      expect(f.own.history.redoDepth()).toBe(1);
      await f.own.history.redo();
      expect((await f.canonical()).text).toBe(canonical);
      await f.own.history.undo();
      expect((await f.canonical()).text).toBe(canonical);
      expect(f.own.hints()).toBe(2);
    } finally {
      f.destroy();
    }
  });

test("server inverse survives fresh document reload and removes appended empty-column syntax", async () => {
  const f = createStructuralFixture();
  try {
    await f.action(f.own, "colLeft");
    const table = T.findTables(f.peer.text.toString())[0]!;
    const append = T.insertRow(table, 1)[0]!;
    f.peer.text.insert(append.from, append.insert);
    f.peer.text.insert(T.gridLine(T.findTables(f.peer.text.toString())[0]!, 2)!.cells[1]!.from, "neighbor");
    expect((await f.accept(f.peer)).status).toBe("accepted");
    const neighbor = captureTextAnchor(f.own.text, f.own.text.toString().indexOf("neighbor"));
    await f.own.history.undo();
    let canonical = (await f.canonical()).text!;
    expect(T.findTables(canonical)[0]!.lines.map((line) => line.cells.length)).toEqual([1, 1, 1, 1]);
    expect(T.gridLine(T.findTables(canonical)[0]!, 2)!.cells[0]!.text).toBe("neighbor");
    expect(resolveTextAnchor(f.own.text, neighbor)).not.toBeNull();
    await f.own.history.redo();
    canonical = (await f.canonical()).text!;
    expect(T.findTables(canonical)[0]!.lines.map((line) => line.cells.length)).toEqual([2, 2, 2, 2]);
    expect(T.gridLine(T.findTables(canonical)[0]!, 2)!.cells[1]!.text).toBe("neighbor");
  } finally {
    f.destroy();
  }
});

for (const redo of [false, true])
  for (const kind of ["typing", "alignment", "appended"] as const)
    test(`closed-author ingress preserves late ${kind} after Undo${redo ? "/Redo" : ""} without confirming another target`, async () => {
      const f = createStructuralFixture();
      try {
        await f.action(f.own, "colLeft");
        const baseCursor = f.peer.cursor;
        const vector = Y.encodeStateVector(f.peer.doc);
        let table = T.findTables(f.peer.text.toString())[0]!;
        if (kind === "appended") {
          const change = T.insertRow(table, 1)[0]!;
          f.peer.text.insert(change.from, change.insert);
          table = T.findTables(f.peer.text.toString())[0]!;
        }
        if (kind === "alignment")
          for (const change of T.setAlign(table, 0, "center").toReversed()) f.peer.text.insert(change.from, change.insert);
        else f.peer.text.insert(T.gridLine(table, kind === "appended" ? 2 : 1)!.cells[0]!.from, "late input");
        const update = Y.encodeStateAsUpdate(f.peer.doc, vector),
          recoveryText = f.peer.text.toString();
        await f.own.history.undo();
        if (redo) await f.own.history.redo();
        f.own.history.dispose();
        f.own.manager.destroy();
        const saved = f.stored();
        const reloaded = createDoc(saved);
        reloaded.destroy();
        const count = f.events.length;
        const result = await f.accept(f.peer, update, baseCursor);
        expect(result.status).toBe("recoveryRequired");
        expect(f.events).toHaveLength(count);
        expect(f.peer.recovery.at(-1)).toEqual({ update, baseCursor, text: recoveryText });
        const canonical = (await f.canonical()).text!;
        expect(T.inspectTableStructure(canonical)).toEqual({ extraCells: false, missingSeparator: false });
        expect(T.gridLine(T.findTables(canonical)[0]!, 1)!.cells[redo ? 1 : 0]!.text).toBe("Original");
      } finally {
        f.destroy();
      }
    });

test("inverse rejects another actor and expired provenance without changing accepted state", async () => {
  const f = createStructuralFixture();
  try {
    await f.action(f.own, "colLeft");
    const before = await f.canonical();
    await expect(
      f.documents().inverse("fixture", {
        actor: f.peer.actor,
        actionId: "foreign",
        receiptCursor: f.events[0]!.cursor,
        restoreRevision: "0",
        maxLength: 2_097_152,
      }),
    ).rejects.toThrow();
    await expect(
      f.documents().inverse("fixture", {
        actor: f.own.actor,
        actionId: "expired",
        receiptCursor: "s6t.history.99",
        restoreRevision: "0",
        maxLength: 2_097_152,
      }),
    ).rejects.toThrow();
    expect((await f.canonical()).text).toBe(before.text);
    expect(f.events).toHaveLength(1);
  } finally {
    f.destroy();
  }
});

for (const [action, column, row] of [
  ["moveRowDown", 0, 1],
  ["moveRowUp", 0, 2],
  ["moveColRight", 0, 1],
  ["moveColLeft", 1, 1],
  ["toggleHeader", 0, 1],
  ["deleteTable", 0, 1],
  ["deleteRow", 0, 1],
] as const)
  test(`authorized ${action} has a durable exact Undo and Redo`, async () => {
    const original = "Before\n\n| A | B |\n| --- | ---: |\n| a | b |\n| c | d |\n\nAfter";
    const f = createStructuralFixture(original);
    try {
      await f.action(f.own, action, column, true, row);
      const changed = (await f.canonical()).text;
      expect(changed).not.toBe(original);
      await f.own.history.undo();
      expect((await f.canonical()).text).toBe(original);
      await f.own.history.redo();
      expect((await f.canonical()).text).toBe(changed);
    } finally {
      f.destroy();
    }
  });

test("ingress refuses future/foreign bases, missing dependencies and stale appended schemas without publication", async () => {
  const f = createStructuralFixture();
  try {
    const oldBase = f.peer.cursor;
    const append = T.insertRow(T.findTables(f.peer.text.toString())[0]!, 1)[0]!;
    f.peer.text.insert(append.from, append.insert);
    await f.action(f.own, "colLeft", 0, false);
    const before = f.events.length;
    for (const base of [oldBase, "s6t.history.999", "s6t.foreign.1"]) {
      expect((await f.accept(f.peer, Y.encodeStateAsUpdate(f.peer.doc), base)).status).toBe("recoveryRequired");
      expect(f.events).toHaveLength(before);
    }
    const child = new Y.Doc();
    try {
      child.getText("codemirror").insert(0, "prerequisite");
      const vector = Y.encodeStateVector(child);
      child.getText("codemirror").insert(12, " dependent");
      expect((await f.accept(f.peer, Y.encodeStateAsUpdate(child, vector), f.events.at(-1)!.cursor)).status).toBe("recoveryRequired");
      expect(f.events).toHaveLength(before);
    } finally {
      child.destroy();
    }
  } finally {
    f.destroy();
  }
});

test("source drafts fence exact expected text and a single complete target; rejection never mutates text", () => {
  const f = createStructuralFixture();
  try {
    const target = { tableFrom: 0, rowFrom: 0, columnFrom: 2, row: 0, column: 0 };
    const expected = f.own.text.toString();
    const valid = "| A | B |\n| --- | --- |\n| preserved | x |\n";
    const intent = captureTableSource(f.own.text, target, expected, valid);
    expect(planTableAction(f.own.text, intent, 2_097_152)).toEqual([{ from: 0, to: expected.length, insert: valid }]);
    for (const source of ["not a table", valid + "\noutside text", "| A |\n| --- |\n| x | extra |"])
      expect(() => planTableAction(f.own.text, { ...intent, action: "replaceSource", expected, source }, 2_097_152)).toThrow();
    f.own.text.insert(expected.indexOf("Original"), "peer ");
    const before = f.own.text.toString();
    expect(() => planTableAction(f.own.text, intent, 2_097_152)).toThrow();
    expect(f.own.text.toString()).toBe(before);
  } finally {
    f.destroy();
  }
});

for (const kind of ["row", "column"] as const)
  test(`a delayed ${kind} move rejects an interposed neighbor rather than moving a new target`, async () => {
    const f = createStructuralFixture("| A | B |\n| --- | --- |\n| a | b |\n| c | d |");
    try {
      const intent = captureTableAction(f.own.text, kind === "row" ? "moveRowDown" : "moveColRight", {
        tableFrom: 0,
        rowFrom: T.gridLine(T.findTables(f.own.text.toString())[0]!, 1)!.from,
        columnFrom: 2,
        row: 1,
        column: 0,
      });
      if (kind === "row") await f.action(f.peer, "rowAbove", 0, true, 2);
      else await f.action(f.peer, "colRight", 0);
      const before = f.own.text.toString();
      expect(() => planTableAction(f.own.text, intent, 2_097_152)).toThrow();
      expect(f.own.text.toString()).toBe(before);
    } finally {
      f.destroy();
    }
  });

for (const action of [
  "colLeft",
  "colRight",
  "rowAbove",
  "rowBelow",
  "moveColRight",
  "moveRowDown",
  "toggleHeader",
  "deleteTable",
  "replaceSource",
] as const)
  test(`server focus for ${action} captures actual receipt identities and refuses later deleted targets`, async () => {
    const f = createStructuralFixture("| A | B |\n| --- | --- |\n| a | b |\n| c | d |");
    try {
      const table = T.findTables(f.own.text.toString())[0]!;
      const target = {
        tableFrom: table.from,
        rowFrom: T.gridLine(table, 1)!.from,
        columnFrom: table.lines[0]!.cells[0]!.from,
        row: 1,
        column: 0,
      };
      const focus = captureTableFocus(f.own.text, target);
      const intent =
        action === "replaceSource"
          ? captureTableSource(f.own.text, target, f.own.text.toString(), "| X | Y | Z |\n| --- | --- | --- |\n| x | y | z |")
          : captureTableAction(f.own.text, action, target);
      const state = Y.encodeStateAsUpdate(f.own.doc);
      const finish = prepareTableActionFocus(f.own.text, intent, focus, { row: 1, column: 2 });
      const result = await f.documents().change("fixture", { actor: f.own.actor, actionId: "focus", maxLength: 2_097_152 }, (current) => {
        const doc = createDoc({ text: null, cursor: null, state: current.state(), restoreRevision: "0" });
        try {
          return planTableAction(doc.getText("codemirror"), intent, 2_097_152);
        } finally {
          doc.destroy();
        }
      });
      expect(result.status).toBe("edited");
      const after = createDoc({ state, text: null, cursor: null, restoreRevision: "0" });
      try {
        if (!("receipt" in result) || !result.receipt) throw new Error("Missing receipt");
        Y.applyUpdate(after, result.receipt.update);
        const witness = finish(after.getText("codemirror"));
        if (action === "deleteTable") {
          expect(witness).toBeNull();
          return;
        }
        expect(witness).not.toBeNull();
        const resolved = resolveTableFocus(after.getText("codemirror"), witness!)!;
        expect([resolved.row, resolved.column]).toEqual(
          action === "replaceSource"
            ? [1, 2]
            : action === "colRight" || action === "moveColRight"
              ? [1, 1]
              : action === "rowBelow" || action === "moveRowDown" || action === "toggleHeader"
                ? [2, 0]
                : [1, 0],
        );
        // Newer prefix input changes offsets but never the selected cell.
        after.getText("codemirror").insert(0, "prefix\n\n");
        expect(resolveTableFocus(after.getText("codemirror"), witness!)!.tableFrom).toBe(8);
        const current = T.findTables(after.getText("codemirror").toString())[0]!;
        for (const change of T.deleteRow(current, resolved.row).toReversed())
          after.getText("codemirror").delete(change.from, change.to - change.from);
        expect(resolveTableFocus(after.getText("codemirror"), witness!)).toBeNull();
      } finally {
        after.destroy();
      }
    } finally {
      f.destroy();
    }
  });
