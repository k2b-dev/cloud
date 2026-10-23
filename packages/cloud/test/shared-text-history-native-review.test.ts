import { expect, test } from "bun:test";
import * as T from "@k2b/ui/text-editor/model";
import { createStructuralFixture } from "../../../scripts/fixtures/shared-text-history";

for (const mode of ["deletions", "restored insertion"] as const)
  test(`native Undo crosses independent own ${mode} frames`, async () => {
    const f = createStructuralFixture(mode === "deletions" ? "abc" : "ab");
    try {
      if (mode === "deletions") f.own.text.delete(1, 1);
      else f.own.text.insert(1, "x");
      expect((await f.accept(f.own)).status).toBe("accepted");
      f.own.manager.stopCapturing();
      f.own.text.delete(mode === "deletions" ? 0 : 1, 1);
      expect((await f.accept(f.own)).status).toBe("accepted");
      await f.own.history.undo();
      expect(f.own.text.toString()).toBe(mode === "deletions" ? "ac" : "axb");
      await f.own.history.undo();
      expect(f.own.text.toString()).toBe(mode === "deletions" ? "abc" : "ab");
      expect(f.own.history.undoDepth()).toBe(0);
    } finally {
      f.destroy();
    }
  });

test("native deletion Undo cannot restore input under another header after a peer column move", async () => {
  const f = createStructuralFixture("| A | B |\n| --- | --- |\n| x | y |");
  try {
    f.own.text.delete(f.own.text.toString().indexOf("x"), 1);
    expect((await f.accept(f.own)).status).toBe("accepted");
    await f.action(f.peer, "moveColRight", 0);
    const before = f.own.text.toString();
    const depth = f.own.history.undoDepth();
    try {
      await f.own.history.undo();
    } catch {
      expect(f.own.text.toString()).toBe(before);
      expect(f.own.history.undoDepth()).toBe(depth);
      expect((await f.canonical()).text).toBe(before);
      return;
    }
    expect((await f.accept(f.own)).status).toBe("accepted");
    const table = T.findTables((await f.canonical()).text!)[0]!;
    const headers = table.lines[0]!.cells.map((cell) => cell.text);
    expect(headers).toEqual(["B", "A"]);
    expect(T.gridLine(table, 1)!.cells[headers.indexOf("A")]!.text).toBe("x");
    expect(T.gridLine(table, 1)!.cells[headers.indexOf("B")]!.text).toBe("y");
    expect(table.lines.every((line) => line.cells.length === table.columns)).toBe(true);
  } finally {
    f.destroy();
  }
});

test("native Redo keeps its cell after a peer deletes and restores the adjacent content boundary", async () => {
  const f = createStructuralFixture("| A | B |\n| --- | --- |\n| b | y |");
  try {
    f.peer.text.insert(f.peer.text.toString().indexOf("b"), "x");
    await f.accept(f.peer);
    f.own.text.insert(f.own.text.toString().indexOf("b"), "z");
    await f.accept(f.own);
    await f.own.history.undo();
    await f.accept(f.own);
    f.peer.manager.stopCapturing();
    f.peer.text.delete(f.peer.text.toString().indexOf("x"), 1);
    await f.accept(f.peer);
    await f.peer.history.undo();
    await f.accept(f.peer);
    await f.own.history.redo();
    expect((await f.accept(f.own)).status).toBe("accepted");
    const table = T.findTables((await f.canonical()).text!)[0]!;
    expect(T.gridLine(table, 1)!.cells[0]!.text).toContain("z");
    expect(T.gridLine(table, 1)!.cells[1]!.text).toBe("y");
  } finally {
    f.destroy();
  }
});

test("native Redo keeps its original column after a peer inserts a column and restores adjacent content", async () => {
  const f = createStructuralFixture("| A | B |\n| --- | --- |\n| b | y |");
  try {
    f.peer.text.insert(f.peer.text.toString().indexOf("b"), "x");
    await f.accept(f.peer);
    f.own.text.insert(f.own.text.toString().indexOf("b"), "z");
    await f.accept(f.own);
    await f.own.history.undo();
    await f.accept(f.own);
    await f.action(f.peer, "colLeft", 0);
    f.peer.manager.stopCapturing();
    f.peer.text.delete(f.peer.text.toString().indexOf("x"), 1);
    await f.accept(f.peer);
    await f.peer.history.undo();
    await f.accept(f.peer);
    await f.own.history.redo();
    expect((await f.accept(f.own)).status).toBe("accepted");
    const table = T.findTables((await f.canonical()).text!)[0]!;
    expect(table.columns).toBe(3);
    expect(table.lines[0]!.cells[1]!.text).toBe("A");
    expect(T.gridLine(table, 1)!.cells[1]!.text).toContain("z");
    expect(T.gridLine(table, 1)!.cells[2]!.text).toBe("y");
  } finally {
    f.destroy();
  }
});

test("native Redo cannot escape a cell delimiter and retarget confirmed peer input", async () => {
  const f = createStructuralFixture("| A | B |\n| --- | --- |\n| q| r |");
  try {
    f.own.text.insert(f.own.text.toString().indexOf("q|") + 1, String.fromCharCode(92));
    expect((await f.accept(f.own)).status).toBe("accepted");
    await f.own.history.undo();
    expect((await f.accept(f.own)).status).toBe("accepted");
    f.peer.text.insert(f.peer.text.toString().indexOf("r") + 1, "PEER");
    expect((await f.accept(f.peer)).status).toBe("accepted");
    f.peer.manager.stopCapturing();
    f.peer.text.delete(f.peer.text.toString().indexOf("q"), 1);
    expect((await f.accept(f.peer)).status).toBe("accepted");
    await f.peer.history.undo();
    expect((await f.accept(f.peer)).status).toBe("accepted");
    const before = f.own.text.toString();
    const undoDepth = f.own.history.undoDepth();
    const redoDepth = f.own.history.redoDepth();
    expect(T.gridLine(T.findTables(before)[0]!, 1)!.cells.map((cell) => cell.text)).toEqual(["q", "rPEER"]);
    await expect(f.own.history.redo()).rejects.toThrow("The input history target is unavailable");
    expect(f.own.text.toString()).toBe(before);
    expect(f.own.history.undoDepth()).toBe(undoDepth);
    expect(f.own.history.redoDepth()).toBe(redoDepth);
    expect((await f.canonical()).text).toBe(before);
  } finally {
    f.destroy();
  }
});

test("native Undo cannot restore a letter that changes an escaped pipe into a cell delimiter", async () => {
  const slash = String.fromCharCode(92);
  const f = createStructuralFixture(`| A | B |\n| --- | --- |\n| q${slash}x| r |`);
  try {
    f.own.text.delete(f.own.text.toString().indexOf("x"), 1);
    expect((await f.accept(f.own)).status).toBe("accepted");
    f.peer.text.insert(f.peer.text.toString().indexOf("r") + 1, "PEER");
    expect((await f.accept(f.peer)).status).toBe("accepted");
    f.peer.manager.stopCapturing();
    f.peer.text.delete(f.peer.text.toString().indexOf(slash), 1);
    expect((await f.accept(f.peer)).status).toBe("accepted");
    await f.peer.history.undo();
    expect((await f.accept(f.peer)).status).toBe("accepted");
    const before = f.own.text.toString();
    const undoDepth = f.own.history.undoDepth();
    const redoDepth = f.own.history.redoDepth();
    const publications = f.events.length;
    const row = T.gridLine(T.findTables(before)[0]!, 1)!;
    expect(row.cells).toHaveLength(1);
    expect(row.cells[0]!.text).toContain("PEER");
    await expect(f.own.history.undo()).rejects.toThrow("The input history target is unavailable");
    expect(f.own.text.toString()).toBe(before);
    expect(f.own.history.undoDepth()).toBe(undoDepth);
    expect(f.own.history.redoDepth()).toBe(redoDepth);
    expect(f.events).toHaveLength(publications);
    expect((await f.canonical()).text).toBe(before);
  } finally {
    f.destroy();
  }
});
