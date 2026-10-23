import { expect, test } from "bun:test";
import * as Y from "yjs";
import { fromBase64 } from "../shared-text/events";
import { createStructuralFixture } from "../shared-text/structural-history.test-fixture";
import { createSharedTextActionHistory } from "./shared-text-history";

const append = async (f: ReturnType<typeof createStructuralFixture>, value: string, actionId: string, peer = false) => {
  return f
    .documents()
    .change("fixture", { actor: (peer ? f.peer : f.own).actor, actionId, maxLength: 2_097_152 }, (current) => [
      { from: current.text.length, to: current.text.length, insert: value },
    ]);
};

test("one server action is an isolated local undo step, with duplicate and other-device receipts excluded", async () => {
  const f = createStructuralFixture("base");
  try {
    f.own.text.insert(0, "mine ");
    await f.accept(f.own);
    const action = f.own.history.begin("own-action");
    await append(f, " table", "own-action");
    f.deliver(f.own);
    await action.applied;
    const receipt = f.events.at(-1)!;
    f.own.history.apply(fromBase64(receipt.data.payload), receipt.data.actionId, receipt.cursor);
    await append(f, " peer", "other-device-action", true);
    f.deliver(f.own);
    expect(f.own.text.toString()).toBe("mine base table peer");
    expect(f.own.history.hasPending()).toBe(false);
    await f.own.history.undo();
    expect(f.own.text.toString()).toBe("mine base peer");
    await f.own.history.redo();
    expect(f.own.text.toString()).toBe("mine base table peer");
    await f.own.history.undo();
    await f.own.history.undo();
    expect(f.own.text.toString()).toBe("base peer");
  } finally {
    f.destroy();
  }
});

test("a receipt missing causal predecessors is rejected before mutation, then tracked after coverage arrives", async () => {
  const f = createStructuralFixture("base");
  try {
    const action = f.own.history.begin("action");
    await append(f, " prerequisite", "predecessor", true);
    await append(f, " table", "action");
    const receipt = f.events.at(-1)!;
    expect(() => f.own.history.apply(fromBase64(receipt.data.payload), "action", receipt.cursor)).toThrow("preceding updates");
    expect(f.own.doc.store.pendingStructs).toBeNull();
    expect(f.own.text.toString()).toBe("base");
    f.deliver(f.own);
    await action.applied;
    await f.own.history.undo();
    expect(f.own.text.toString()).toBe("base prerequisite");
  } finally {
    f.destroy();
  }
});

test("rejected actions release the single pending slot; disposal leaves a rejected waiter", async () => {
  const f = createStructuralFixture("base");
  try {
    const first = f.own.history.begin("rejected");
    expect(() => f.own.history.begin("second")).toThrow("awaiting");
    first.cancel(new Error("stale target"));
    await expect(first.applied).rejects.toThrow("stale target");
    const second = f.own.history.begin("accepted");
    f.own.history.dispose();
    await expect(second.applied).rejects.toThrow("editor closed");
    expect(() => f.own.history.begin("late")).toThrow("unavailable");
  } finally {
    f.destroy();
  }
});

test("an async structural inverse consumes its requested frame while newer typing remains independently undoable", async () => {
  const f = createStructuralFixture("base");
  try {
    const initial = f.own.history.begin("structure");
    await append(f, " table", "structure");
    f.deliver(f.own);
    await initial.applied;
    const request = Promise.withResolvers<Parameters<Parameters<typeof f.own.history.setInverseHandler>[0]>[0]>();
    f.own.history.setInverseHandler(async (value) => {
      request.resolve(value);
    });
    const undone = f.own.history.undo();
    const inverse = await request.promise;
    f.own.text.insert(0, "newer ");
    await f.accept(f.own);
    await f.documents().inverse("fixture", {
      actor: f.own.actor,
      actionId: inverse.actionId,
      receiptCursor: inverse.receiptCursor,
      restoreRevision: "0",
      maxLength: 2_097_152,
    });
    f.deliver(f.own);
    await undone;
    expect(f.own.text.toString()).toBe("newer base");
    expect(f.own.history.undoDepth()).toBe(1);
    await f.own.history.undo();
    expect(f.own.text.toString()).toBe("base");
  } finally {
    f.destroy();
  }
});

test("typing whose row was structurally deleted cannot make native Undo consume an earlier independent edit", async () => {
  const f = createStructuralFixture("Before\n\n| A |\n| --- |\n| cell |\n\nAfter");
  try {
    f.own.text.insert(0, "independent ");
    f.own.manager.stopCapturing();
    const at = f.own.text.toString().indexOf("cell");
    f.own.text.insert(at, "typing ");
    await f.accept(f.own);
    await f.action(f.peer, "deleteRow");
    const before = f.own.text.toString();
    const depth = f.own.history.undoDepth();
    await expect(f.own.history.undo()).rejects.toThrow("frame is unavailable");
    expect(f.own.text.toString()).toBe(before);
    expect(before).toContain("independent");
    expect(f.own.history.undoDepth()).toBe(depth);
  } finally {
    f.destroy();
  }
});

for (const full of [false, true])
  test(`merged native deletion/replacement keeps its one normal Undo/Redo frame, full=${full}`, async () => {
    const doc = new Y.Doc();
    const text = doc.getText("codemirror");
    text.insert(0, "abc");
    const manager = new Y.UndoManager(text);
    const history = createSharedTextActionHistory(doc, manager);
    try {
      if (full) {
        text.delete(0, 3);
        text.insert(0, "xyz");
      } else {
        text.delete(1, 1);
        text.delete(0, 1);
        text.insert(0, "x");
      }
      const after = text.toString();
      expect(history.undoDepth()).toBe(1);
      await history.undo();
      expect(text.toString()).toBe("abc");
      await history.redo();
      expect(text.toString()).toBe(after);
    } finally {
      history.dispose();
      manager.destroy();
      doc.destroy();
    }
  });

test("native history notifications leave the Yjs/CodeMirror transaction before reactive host updates", async () => {
  const doc = new Y.Doc();
  const text = doc.getText("codemirror");
  const manager = new Y.UndoManager(text);
  let updating = false;
  let notifications = 0;
  const history = createSharedTextActionHistory(doc, manager, () => {
    // A reactive host may dispatch/reconfigure its EditorView here.
    expect(updating).toBe(false);
    notifications++;
  });
  try {
    updating = true;
    text.insert(0, "first");
    expect(history.canUndo()).toBe(true);
    expect(notifications).toBe(0);
    updating = false;
    await Promise.resolve();
    expect(notifications).toBe(1);
    history.clear();
    history.dispose();
    await Promise.resolve();
    expect(notifications).toBe(1);
  } finally {
    history.dispose();
    manager.destroy();
    doc.destroy();
  }
});

test("whole-text merged replacement follows its own native restoration across independent frames", async () => {
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
    expect(history.undoDepth()).toBe(2);
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

test("whole-text replacement still refuses genuinely foreign live text", async () => {
  const doc = new Y.Doc();
  const text = doc.getText("codemirror");
  text.insert(0, "abc");
  const manager = new Y.UndoManager(text);
  const history = createSharedTextActionHistory(doc, manager);
  try {
    text.delete(0, 3);
    text.insert(0, "xyz");
    doc.transact(() => text.insert(1, "foreign"), "remote");
    const before = text.toString(),
      depth = history.undoDepth();
    await expect(history.undo()).rejects.toThrow("target is unavailable");
    expect(text.toString()).toBe(before);
    expect(history.undoDepth()).toBe(depth);
  } finally {
    history.dispose();
    manager.destroy();
    doc.destroy();
  }
});
