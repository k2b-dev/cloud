import { expect, test } from "bun:test";
import * as T from "@k2b/ui/text-editor/model";
import * as Y from "yjs";
import { createStructuralFixture } from "../../../scripts/fixtures/shared-text-history";
import { createSharedTextActionHistory } from "../src/browser/shared-text-history";

test("native Undo preserves the distinct target of peer text in additional visible cells", async () => {
  const f = createStructuralFixture("| A | B |\n| --- | --- |\n| a | b | c d |");
  try {
    f.own.text.insert(f.own.text.toString().indexOf("c d") + 1, "|");
    expect((await f.accept(f.own)).status).toBe("accepted");
    f.peer.text.insert(f.peer.text.toString().indexOf("d |") + 1, "PEER");
    expect((await f.accept(f.peer)).status).toBe("accepted");
    const before = f.own.text.toString();
    const binary = Y.encodeStateAsUpdate(f.own.doc);
    const undo = f.own.history.undoDepth();
    const redo = f.own.history.redoDepth();
    const nativeUndo = [...f.own.manager.undoStack];
    const nativeRedo = [...f.own.manager.redoStack];
    const publications = f.events.length;
    expect(T.gridLine(T.findTables(before)[0]!, 1)!.cells[3]!.text).toBe("dPEER");
    try {
      await f.own.history.undo();
    } catch (error) {
      expect(String(error)).toContain("The input history target is unavailable");
      expect(f.own.text.toString()).toBe(before);
      expect(Y.encodeStateAsUpdate(f.own.doc)).toEqual(binary);
      expect(f.own.history.undoDepth()).toBe(undo);
      expect(f.own.history.redoDepth()).toBe(redo);
      expect(f.own.manager.undoStack).toEqual(nativeUndo);
      expect(f.own.manager.redoStack).toEqual(nativeRedo);
      expect(f.events).toHaveLength(publications);
      expect((await f.canonical()).text).toBe(before);
      return;
    }
    expect((await f.accept(f.own)).status).toBe("accepted");
    expect(T.gridLine(T.findTables((await f.canonical()).text!)[0]!, 1)!.cells[3]?.text).toContain("PEER");
  } finally {
    f.destroy();
  }
});

test("adopted native history accounts for insertion identities restored before registration", async () => {
  const doc = new Y.Doc();
  const text = doc.getText("codemirror");
  const slash = String.fromCharCode(92);
  text.insert(0, `| A | B |\n| --- | --- |\n| q${slash}| r |`);
  const manager = new Y.UndoManager(text, { captureTimeout: 0 });
  doc.transact(() => {
    text.insert(text.toString().indexOf(`${slash}|`) + 1, "x");
    text.insert(0, "Z\n\n");
  });
  manager.stopCapturing();
  text.delete(text.toString().indexOf(`${slash}x`) + 1, 1);
  manager.undo();
  manager.stopCapturing();
  const history = createSharedTextActionHistory(doc, manager);
  try {
    doc.transact(() => text.insert(text.toString().indexOf("r |") + 1, "PEER"), "peer");
    const before = text.toString();
    const binary = Y.encodeStateAsUpdate(doc);
    const undo = history.undoDepth();
    const redo = history.redoDepth();
    const nativeUndo = [...manager.undoStack];
    const nativeRedo = [...manager.redoStack];
    expect(T.gridLine(T.findTables(before)[0]!, 1)!.cells[1]!.text).toContain("PEER");
    try {
      await history.undo();
    } catch (error) {
      expect(String(error)).toContain("unavailable");
      expect(text.toString()).toBe(before);
      expect(Y.encodeStateAsUpdate(doc)).toEqual(binary);
      expect(history.undoDepth()).toBe(undo);
      expect(history.redoDepth()).toBe(redo);
      expect(manager.undoStack).toEqual(nativeUndo);
      expect(manager.redoStack).toEqual(nativeRedo);
      return;
    }
    expect(T.gridLine(T.findTables(text.toString())[0]!, 1)!.cells[1]?.text).toContain("PEER");
  } finally {
    history.dispose();
    manager.destroy();
    doc.destroy();
  }
});
