import { expect, test } from "bun:test";
import * as T from "@k2b/ui/text-editor/model";
import { createStructuralFixture } from "../src/shared-text/structural-history.test-fixture";

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
