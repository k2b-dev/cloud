import { expect, test } from "bun:test";
import * as T from "@k2b/ui/text-editor/model";
import * as Y from "yjs";
import { createStructuralFixture } from "../../../scripts/fixtures/shared-text-history";
import { captureTextAnchor, resolveTextAnchor } from "../src/shared-text/anchors";
import { captureTableAction, planTableAction } from "../src/shared-text/table-actions";

test("Redo cannot retarget a row accepted after column Undo", async () => {
  const f = createStructuralFixture();
  try {
    await f.action(f.own, "colLeft");
    await f.own.history.undo();
    f.deliver(f.peer);
    let table = T.findTables(f.peer.text.toString())[0]!;
    const append = T.insertRow(table, 1)[0]!;
    f.peer.text.insert(append.from, append.insert);
    table = T.findTables(f.peer.text.toString())[0]!;
    f.peer.text.insert(T.gridLine(table, 2)!.cells[0]!.from, "peer");
    expect((await f.accept(f.peer)).status).toBe("accepted");
    const before = (await f.canonical()).text;
    try {
      await f.own.history.redo();
    } catch {
      expect((await f.canonical()).text).toBe(before);
      return;
    }
    table = T.findTables((await f.canonical()).text!)[0]!;
    const column = table.lines[0]!.cells.findIndex((cell) => cell.text === "Header");
    expect(T.gridLine(table, 2)!.cells[column]?.text).toBe("peer");
    expect(table.lines.every((line) => line.cells.length === table.columns)).toBe(true);
  } finally {
    f.destroy();
  }
});

test("column Undo retains confirmed peer whitespace identities", async () => {
  const f = createStructuralFixture();
  try {
    await f.action(f.own, "colLeft");
    const table = T.findTables(f.peer.text.toString())[0]!;
    const at = T.gridLine(table, 1)!.cells[0]!.from;
    f.peer.text.insert(at, " ");
    const space = captureTextAnchor(f.peer.text, at);
    expect((await f.accept(f.peer)).status).toBe("accepted");
    await f.own.history.undo();
    expect(resolveTextAnchor(f.own.text, space)).not.toBeNull();
    expect(T.findTables((await f.canonical()).text!)[0]!.columns).toBe(2);
    expect(f.own.hints()).toBe(1);
  } finally {
    f.destroy();
  }
});

for (const writer of ["change", "edit"] as const)
  test(`server ${writer} without a UI action id fences stale schema input before acknowledging it`, async () => {
    const initial = "| Deleted | Kept |\n| --- | --- |\n| old | value |";
    const f = createStructuralFixture(initial);
    try {
      const base = f.peer.cursor;
      const vector = Y.encodeStateVector(f.peer.doc);
      const table = T.findTables(f.peer.text.toString())[0]!;
      const append = T.insertRow(table, 1)[0]!;
      f.peer.text.insert(append.from, append.insert);
      f.peer.text.insert(T.gridLine(T.findTables(f.peer.text.toString())[0]!, 2)!.cells[0]!.from, "peer");
      const update = Y.encodeStateAsUpdate(f.peer.doc, vector);
      expect(
        (
          await (writer === "change"
            ? f
                .documents()
                .change("fixture", { actor: f.own.actor, maxLength: 2_097_152 }, (current) =>
                  T.deleteColumn(T.findTables(current.text)[0]!, 0),
                )
            : f.documents().edit("fixture", { actor: f.own.actor }, () => "| Kept |\n| --- |\n| value |"))
        ).status,
      ).toBe("edited");
      const count = f.events.length;
      expect((await f.accept(f.peer, update, base)).status).toBe("recoveryRequired");
      expect(f.events).toHaveLength(count);
      expect(f.peer.recovery.at(-1)?.update).toEqual(update);
    } finally {
      f.destroy();
    }
  });

for (const appended of [false, true])
  test(`peer whitespace keeps original target, appended=${appended}`, async () => {
    const f = createStructuralFixture();
    try {
      await f.action(f.own, "colLeft");
      if (appended) {
        const append = T.insertRow(T.findTables(f.peer.text.toString())[0]!, 1)[0]!;
        f.peer.text.insert(append.from, append.insert);
      }
      const table = T.findTables(f.peer.text.toString())[0]!;
      const at = T.gridLine(table, appended ? 2 : 1)!.cells[0]!.from;
      f.peer.text.insert(at, " ");
      const space = captureTextAnchor(f.peer.text, at);
      expect((await f.accept(f.peer)).status).toBe("accepted");
      await f.own.history.undo();
      expect(resolveTextAnchor(f.own.text, space)).not.toBeNull();
      expect(f.own.hints()).toBe(1);
    } finally {
      f.destroy();
    }
  });

test("Undo cannot falsely consume a now sole-column insertion", async () => {
  const f = createStructuralFixture();
  try {
    await f.action(f.own, "colLeft");
    await f.action(f.peer, "deleteCol", 1);
    const before = (await f.canonical()).text;
    const depth = f.own.history.undoDepth();
    await expect(f.own.history.undo()).rejects.toThrow();
    expect((await f.canonical()).text).toBe(before);
    expect(f.own.history.undoDepth()).toBe(depth);
    expect(f.own.hints()).toBe(0);
  } finally {
    f.destroy();
  }
});

test("native deletion Undo cannot resurrect input into a peer-deleted row", async () => {
  const f = createStructuralFixture("| H |\n| --- |\n| deleted |\n| kept |");
  try {
    const at = f.own.text.toString().indexOf("deleted");
    f.own.text.delete(at, "deleted".length);
    expect((await f.accept(f.own)).status).toBe("accepted");
    await f.action(f.peer, "deleteRow", 0, true, 1);
    const before = f.own.text.toString();
    await expect(f.own.history.undo()).rejects.toThrow();
    expect(f.own.text.toString()).toBe(before);
  } finally {
    f.destroy();
  }
});

for (const insertion of [false, true])
  test(`independent native frames follow only their own proven restoration, insertion=${insertion}`, async () => {
    const f = createStructuralFixture(insertion ? "ab" : "abc");
    try {
      if (insertion) f.own.text.insert(1, "x");
      else f.own.text.delete(1, 1);
      f.own.manager.stopCapturing();
      if (insertion) f.own.text.delete(1, 1);
      else f.own.text.delete(0, 1);
      await f.own.history.undo();
      expect(f.own.text.toString()).toBe(insertion ? "axb" : "ac");
      await f.own.history.undo();
      expect(f.own.text.toString()).toBe(insertion ? "ab" : "abc");
      await f.own.history.redo();
      await f.own.history.redo();
      expect(f.own.text.toString()).toBe(insertion ? "ab" : "c");
    } finally {
      f.destroy();
    }
  });

test("native restoration refuses a column whose semantic contents were moved by a peer", async () => {
  const f = createStructuralFixture("| A | B |\n| --- | --- |\n| x | y |");
  try {
    f.own.text.delete(f.own.text.toString().indexOf("x"), 1);
    expect((await f.accept(f.own)).status).toBe("accepted");
    await f.action(f.peer, "moveColRight", 0);
    const before = f.own.text.toString(),
      depth = f.own.history.undoDepth();
    await expect(f.own.history.undo()).rejects.toThrow();
    expect(f.own.text.toString()).toBe(before);
    expect(f.own.history.undoDepth()).toBe(depth);
    const table = T.findTables(before)[0]!;
    expect(table.lines[0]!.cells.map((cell) => cell.text)).toEqual(["B", "A"]);
    expect(T.gridLine(table, 1)!.cells.map((cell) => cell.text)).toEqual(["y", ""]);
  } finally {
    f.destroy();
  }
});

for (const hidden of [false, true])
  test(`moved columns fence delayed actions, native Redo and unconfirmed input, hidden=${hidden}`, async () => {
    const f = createStructuralFixture(hidden ? "|   |   |\n| --- | --- |\n| x | y |" : "| A | B |\n| --- | --- |\n| x | y |");
    try {
      const table = T.findTables(f.own.text.toString())[0]!;
      const target = { tableFrom: 0, rowFrom: T.gridLine(table, 1)!.from, columnFrom: table.lines[0]!.cells[0]!.from, row: 1, column: 0 };
      const intent = captureTableAction(f.own.text, "deleteCol", target);
      const base = f.peer.cursor,
        vector = Y.encodeStateVector(f.peer.doc);
      f.peer.text.insert(f.peer.text.toString().indexOf("x"), "late");
      const late = Y.encodeStateAsUpdate(f.peer.doc, vector);
      f.own.text.insert(f.own.text.toString().indexOf("x"), "own");
      await f.accept(f.own);
      await f.own.history.undo();
      await f.accept(f.own);
      await f.action(f.own, "moveColRight", 0);
      // The structural action clears Redo by design. Exercise an independent
      // editor's already-created restoration frame in the separate case below.
      expect(() => planTableAction(f.own.text, intent, 2_097_152)).toThrow();
      const count = f.events.length;
      expect((await f.accept(f.peer, late, base)).status).toBe("recoveryRequired");
      expect(f.events).toHaveLength(count);
      expect(f.peer.recovery.at(-1)?.update).toEqual(late);
      const moved = T.findTables((await f.canonical()).text!)[0]!;
      expect(T.gridLine(moved, 1)!.cells.map((cell) => cell.text)).toEqual(["y", "x"]);
    } finally {
      f.destroy();
    }
  });

test("native Redo refuses a moved column and independent untouched-column Undo still works", async () => {
  const f = createStructuralFixture("| A | B | C |\n| --- | --- | --- |\n| x | y | z |");
  try {
    f.own.text.insert(f.own.text.toString().indexOf("x"), "own");
    await f.accept(f.own);
    await f.own.history.undo();
    await f.accept(f.own);
    await f.action(f.peer, "moveColRight", 0);
    const before = f.own.text.toString(),
      depth = f.own.history.redoDepth();
    await expect(f.own.history.redo()).rejects.toThrow();
    expect(f.own.text.toString()).toBe(before);
    expect(f.own.history.redoDepth()).toBe(depth);
    f.own.history.clear();
    f.own.text.delete(f.own.text.toString().indexOf("z"), 1);
    await f.accept(f.own);
    await f.action(f.peer, "moveColLeft", 1);
    await f.own.history.undo();
    const table = T.findTables(f.own.text.toString())[0]!;
    expect(table.lines[0]!.cells.map((cell) => cell.text)).toEqual(["A", "B", "C"]);
    expect(T.gridLine(table, 1)!.cells.map((cell) => cell.text)).toEqual(["x", "y", "z"]);
  } finally {
    f.destroy();
  }
});

test("native restoration proof survives a new edit clearing native Redo", async () => {
  const f = createStructuralFixture("abc");
  try {
    f.own.text.delete(1, 1);
    f.own.text.delete(0, 1);
    await f.own.history.undo();
    f.own.text.insert(0, "new");
    await f.own.history.undo();
    await f.own.history.undo();
    expect(f.own.text.toString()).toBe("abc");
  } finally {
    f.destroy();
  }
});

for (const writer of ["ordinary", "legacy-server", "legacy-no-lineage"] as const)
  test(`unclassified ${writer} schema deletion cannot acknowledge a stale row in different columns`, async () => {
    const f = createStructuralFixture("| Deleted | Kept |\n| --- | --- |\n| old | value |");
    try {
      const base = f.peer.cursor;
      const vector = Y.encodeStateVector(f.peer.doc);
      const append = T.insertRow(T.findTables(f.peer.text.toString())[0]!, 1)[0]!;
      f.peer.text.insert(append.from, append.insert);
      const row = T.gridLine(T.findTables(f.peer.text.toString())[0]!, 2)!;
      f.peer.text.insert(row.cells[0]!.from, "peer-deleted-target");
      const delayed = Y.encodeStateAsUpdate(f.peer.doc, vector);
      if (writer === "ordinary") {
        const changes = T.deleteColumn(T.findTables(f.own.text.toString())[0]!, 0);
        f.own.doc.transact(() => {
          for (const change of [...changes].reverse()) {
            f.own.text.delete(change.from, change.to - change.from);
            if (change.insert) f.own.text.insert(change.from, change.insert);
          }
        });
        expect((await f.accept(f.own)).status).toBe("accepted");
        expect(f.events.at(-1)!.data.history?.ingressBarrier).toBe(true);
      } else {
        await f.documents().edit("fixture", { actor: f.own.actor }, () => "| Kept |\n| --- |\n| value |");
        // Actual retained event shape from deployments before admission
        // provenance existed. Its missing classification is unavailable proof.
        delete f.events.at(-1)!.data.history;
        if (writer === "legacy-no-lineage") delete f.events.at(-1)!.data.restoreRevision;
      }
      const before = (await f.canonical()).text;
      const count = f.events.length;
      expect((await f.accept(f.peer, delayed, base)).status).toBe("recoveryRequired");
      expect(f.events).toHaveLength(count);
      expect((await f.canonical()).text).toBe(before);
      expect(f.peer.recovery.at(-1)?.update).toEqual(delayed);
      expect(f.peer.recovery.at(-1)?.baseCursor).toBe(base);
    } finally {
      f.destroy();
    }
  });

test("server-classified ordinary cell input preserves concurrent target-safe merging", async () => {
  const f = createStructuralFixture("| A | B |\n| --- | --- |\n| first | second |");
  try {
    const base = f.peer.cursor;
    const vector = Y.encodeStateVector(f.peer.doc);
    f.peer.text.insert(f.peer.text.toString().indexOf("second"), "peer ");
    const delayed = Y.encodeStateAsUpdate(f.peer.doc, vector);
    f.own.text.insert(f.own.text.toString().indexOf("first"), "own ");
    expect((await f.accept(f.own)).status).toBe("accepted");
    expect(f.events.at(-1)!.data.history).toEqual({ patches: [], tables: [] });
    expect((await f.accept(f.peer, delayed, base)).status).toBe("accepted");
    const table = T.findTables((await f.canonical()).text!)[0]!;
    expect(T.gridLine(table, 1)!.cells.map((cell) => cell.text)).toEqual(["own first", "peer second"]);
    expect(f.peer.recovery).toHaveLength(0);
  } finally {
    f.destroy();
  }
});

for (const delivered of [false, true])
  test(`unconfirmed deletion-only delta across a moved column stays recoverable, delivered=${delivered}`, async () => {
    const f = createStructuralFixture("| A | B |\n| --- | --- |\n| x | y |");
    try {
      const base = f.peer.cursor,
        vector = Y.encodeStateVector(f.peer.doc);
      f.peer.text.delete(f.peer.text.toString().indexOf("x"), 1);
      const delayed = Y.encodeStateAsUpdate(f.peer.doc, vector);
      expect(Y.decodeUpdate(delayed).structs).toHaveLength(0);
      await f.action(f.own, "moveColRight", 0, delivered);
      const before = (await f.canonical()).text,
        count = f.events.length;
      expect((await f.accept(f.peer, delayed, base)).status).toBe("recoveryRequired");
      expect(f.events).toHaveLength(count);
      expect((await f.canonical()).text).toBe(before);
      expect(f.peer.recovery.at(-1)?.update).toEqual(delayed);
      expect(f.peer.recovery.at(-1)?.baseCursor).toBe(base);
      const table = T.findTables(before!)[0]!;
      expect(table.lines[0]!.cells.map((cell) => cell.text)).toEqual(["B", "A"]);
      expect(T.gridLine(table, 1)!.cells.map((cell) => cell.text)).toEqual(["y", "x"]);
    } finally {
      f.destroy();
    }
  });

test("already accepted deletion retries and current-base full-state reconnect remain safe after a move", async () => {
  const f = createStructuralFixture("| A | B |\n| --- | --- |\n| x | y |");
  try {
    const base = f.peer.cursor,
      vector = Y.encodeStateVector(f.peer.doc);
    f.peer.text.delete(f.peer.text.toString().indexOf("x"), 1);
    const accepted = Y.encodeStateAsUpdate(f.peer.doc, vector);
    expect((await f.accept(f.peer, accepted, base)).status).toBe("accepted");
    await f.action(f.own, "moveColRight", 0);
    expect((await f.accept(f.peer, accepted, base)).status).toBe("accepted");
    expect((await f.accept(f.peer, Y.encodeStateAsUpdate(f.peer.doc), f.peer.cursor)).status).toBe("accepted");
    const table = T.findTables((await f.canonical()).text!)[0]!;
    expect(table.lines[0]!.cells.map((cell) => cell.text)).toEqual(["B", "A"]);
    expect(T.gridLine(table, 1)!.cells.map((cell) => cell.text)).toEqual(["y", ""]);
  } finally {
    f.destroy();
  }
});

test("a stale covering full state cannot hide an original unconfirmed removal behind observed move deletions", async () => {
  const f = createStructuralFixture("| A | B |\n| --- | --- |\n| x | y |");
  try {
    const base = f.peer.cursor;
    f.peer.text.delete(f.peer.text.toString().indexOf("x"), 1);
    await f.action(f.own, "moveColRight", 0);
    const covering = Y.encodeStateAsUpdate(f.peer.doc);
    const before = (await f.canonical()).text,
      count = f.events.length;
    expect((await f.accept(f.peer, covering, base)).status).toBe("recoveryRequired");
    expect(f.events).toHaveLength(count);
    expect((await f.canonical()).text).toBe(before);
    expect(f.peer.recovery.at(-1)?.update).toEqual(covering);
    expect(f.peer.recovery.at(-1)?.baseCursor).toBe(base);
  } finally {
    f.destroy();
  }
});
