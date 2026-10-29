import { expect, test } from "bun:test";
import * as T from "@k2b/ui/text-editor/model";
import { createStructuralFixture } from "../../../scripts/fixtures/shared-text-history";

test("native Redo cannot turn a peer cell delimiter into escaped content", async () => {
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
    const table = T.findTables(before)[0]!;
    expect(T.gridLine(table, 1)!.cells.map((cell) => cell.text)).toEqual(["q", "rPEER"]);
    try {
      await f.own.history.redo();
    } catch (error) {
      expect(String(error)).toContain("The input history target is unavailable");
      expect(f.own.text.toString()).toBe(before);
      expect(f.own.history.undoDepth()).toBe(undoDepth);
      expect(f.own.history.redoDepth()).toBe(redoDepth);
      return; // Safe unchanged refusal is permitted.
    }
    expect((await f.accept(f.own)).status).toBe("accepted");
    const after = T.findTables((await f.canonical()).text!)[0]!;
    // Current source predicts this fails: rPEER is in cells[0], cells[1] absent.
    expect(T.gridLine(after, 1)!.cells[1]?.text).toContain("PEER");
  } finally {
    f.destroy();
  }
});

test("native Undo cannot split a peer cell by restoring ordinary text after an escape", async () => {
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
    try {
      await f.own.history.undo();
    } catch (error) {
      expect(String(error)).toContain("The input history target is unavailable");
      expect(f.own.text.toString()).toBe(before);
      expect(f.own.history.undoDepth()).toBe(undoDepth);
      expect(f.own.history.redoDepth()).toBe(redoDepth);
      expect(f.events).toHaveLength(publications);
      expect((await f.canonical()).text).toBe(before);
      return;
    }
    expect((await f.accept(f.own)).status).toBe("accepted");
    const after = T.gridLine(T.findTables((await f.canonical()).text!)[0]!, 1)!;
    expect(after.cells[0]!.text).toContain("PEER");
  } finally {
    f.destroy();
  }
});
