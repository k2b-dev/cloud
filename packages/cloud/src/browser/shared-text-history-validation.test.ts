import { expect, test } from "bun:test";
import * as Y from "yjs";
import { createSharedTextActionHistory } from "./shared-text-history";
import { validateNativeHistory } from "./shared-text-history-validation";

test("adopted insertion-only history without prior restorations still reverses", async () => {
  const doc = new Y.Doc();
  const text = doc.getText("codemirror");
  text.insert(0, "base");
  const manager = new Y.UndoManager(text);
  text.insert(4, " own");
  const history = createSharedTextActionHistory(doc, manager);
  try {
    doc.transact(() => text.insert(0, "peer "), "peer");
    await history.undo();
    expect(text.toString()).toBe("peer base");
    await history.redo();
    expect(text.toString()).toBe("peer base own");
  } finally {
    history.dispose();
    manager.destroy();
    doc.destroy();
  }
});

test("independent native input in an extra physical cell remains reversible", async () => {
  const doc = new Y.Doc();
  const text = doc.getText("codemirror");
  text.insert(0, "| A | B |\n| --- | --- |\n| a | b | extra | other |");
  const manager = new Y.UndoManager(text);
  const history = createSharedTextActionHistory(doc, manager);
  try {
    text.insert(text.toString().indexOf("extra") + 5, "OWN");
    doc.transact(() => text.insert(text.toString().indexOf("other") + 5, "PEER"), "peer");
    await history.undo();
    expect(text.toString()).toContain("| extra | otherPEER |");
    await history.redo();
    expect(text.toString()).toContain("| extraOWN | otherPEER |");
  } finally {
    history.dispose();
    manager.destroy();
    doc.destroy();
  }
});

for (const merge of [false, true])
  test(`public native text projection matches replacement, deletion and repeated restoration, merged=${merge}`, () => {
    const doc = new Y.Doc();
    const text = doc.getText("codemirror");
    text.insert(0, "| A | B |\n| --- | --- |\n| q\\x| r |");
    const manager = new Y.UndoManager(text, { captureTimeout: merge ? 500 : 0 });
    try {
      text.delete(text.toString().indexOf("x"), 1);
      if (!merge) manager.stopCapturing();
      text.insert(text.toString().indexOf("q") + 1, "😀new");
      if (!merge) manager.stopCapturing();
      text.delete(text.toString().indexOf("new"), 3);
      manager.stopCapturing();
      for (const direction of ["undo", "redo", "undo", "redo", "undo", "redo", "undo", "redo"] as const) {
        const stack = direction === "undo" ? manager.undoStack : manager.redoStack;
        const frame = stack.at(-1);
        if (!frame) continue;
        const before = text.toString();
        const vector = Y.encodeStateVector(doc);
        const expected = validateNativeHistory(text, frame, frame.insertions, vector);
        expect(text.toString()).toBe(before);
        expect(Y.encodeStateVector(doc)).toEqual(vector);
        expect(manager[direction]()).not.toBeNull();
        expect(text.toString()).toBe(expected);
      }
    } finally {
      manager.destroy();
      doc.destroy();
    }
  });
