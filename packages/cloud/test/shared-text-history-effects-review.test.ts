import { expect, test } from "bun:test";
import * as Y from "yjs";
import { createSharedTextActionHistory } from "../src/browser/shared-text-history";
import { createStructuralFixture } from "../src/shared-text/structural-history.test-fixture";

test("whole-text replacement remains reversible after its own independent deletion was undone", async () => {
  const doc = new Y.Doc();
  const text = doc.getText("codemirror");
  text.insert(0, "abc");
  const manager = new Y.UndoManager(text);
  const history = createSharedTextActionHistory(doc, manager);
  try {
    text.delete(0, 3);
    text.insert(0, "xyz");
    expect(history.undoDepth()).toBe(1);
    manager.stopCapturing();
    text.delete(0, 3);
    expect(text.toString()).toBe("");
    await history.undo();
    expect(text.toString()).toBe("xyz");
    await history.undo();
    expect(text.toString()).toBe("abc");
    await history.redo();
    expect(text.toString()).toBe("xyz");
    await history.redo();
    expect(text.toString()).toBe("");
  } finally {
    history.dispose();
    manager.destroy();
    doc.destroy();
  }
});

test("a held deletion-only edit cannot be acknowledged after its target was recreated by a column move", async () => {
  const f = createStructuralFixture("| A | B |\n| --- | --- |\n| x | y |");
  try {
    const base = f.peer.cursor;
    const vector = Y.encodeStateVector(f.peer.doc);
    f.peer.text.delete(f.peer.text.toString().indexOf("x"), 1);
    const original = f.peer.text.toString();
    const delta = Y.encodeStateAsUpdate(f.peer.doc, vector);
    expect(Y.decodeUpdate(delta).structs).toHaveLength(0);
    await f.action(f.own, "moveColRight", 0, false);
    const before = (await f.canonical()).text;
    const count = f.events.length;
    expect((await f.accept(f.peer, delta, base)).status).toBe("recoveryRequired");
    expect(f.events).toHaveLength(count);
    expect((await f.canonical()).text).toBe(before);
    expect(f.peer.recovery.at(-1)).toEqual({ update: delta, text: original, baseCursor: base });
  } finally {
    f.destroy();
  }
});
