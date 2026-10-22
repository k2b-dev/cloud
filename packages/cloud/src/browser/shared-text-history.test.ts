import { expect, test } from "bun:test";
import * as Y from "yjs";
import { createSharedTextActionHistory } from "./shared-text-history";

const fixture = () => {
  const local = new Y.Doc(),
    remote = new Y.Doc();
  local.clientID = 101;
  remote.clientID = 202;
  local.getText("codemirror").insert(0, "base");
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(local));
  const undo = new Y.UndoManager(local.getText("codemirror"));
  const history = createSharedTextActionHistory(local, undo);
  const insert = (value: string) => {
    const before = Y.encodeStateVector(remote);
    remote.getText("codemirror").insert(remote.getText("codemirror").length, value);
    return Y.encodeStateAsUpdate(remote, before);
  };
  return {
    local,
    remote,
    undo,
    history,
    insert,
    destroy: () => {
      history.dispose();
      undo.destroy();
      local.destroy();
      remote.destroy();
    },
  };
};

test("one server action is an isolated local undo step, with duplicate and other-device receipts excluded", async () => {
  const f = fixture();
  try {
    f.local.getText("codemirror").insert(0, "mine ");
    const action = f.history.begin("own-action");
    const update = f.insert(" table");
    f.history.apply(update, "own-action");
    await action.applied;
    f.history.apply(update, "own-action");
    f.history.apply(f.insert(" peer"), "other-device-action");
    expect(f.local.getText("codemirror").toString()).toBe("mine base table peer");
    expect(f.history.hasPending()).toBe(false);
    f.undo.undo();
    expect(f.local.getText("codemirror").toString()).toBe("mine base peer");
    f.undo.redo();
    expect(f.local.getText("codemirror").toString()).toBe("mine base table peer");
    f.undo.undo();
    f.undo.undo();
    expect(f.local.getText("codemirror").toString()).toBe("base peer");
  } finally {
    f.destroy();
  }
});

test("a receipt missing causal predecessors is rejected before mutation, then tracked after coverage arrives", async () => {
  const f = fixture();
  try {
    const action = f.history.begin("action");
    const predecessor = f.insert(" prerequisite");
    const update = f.insert(" table");
    expect(() => f.history.apply(update, "action")).toThrow("preceding updates");
    expect(f.local.store.pendingStructs).toBeNull();
    expect(f.local.getText("codemirror").toString()).toBe("base");
    f.history.apply(predecessor);
    f.history.apply(update, "action");
    await action.applied;
    f.undo.undo();
    expect(f.local.getText("codemirror").toString()).toBe("base prerequisite");
  } finally {
    f.destroy();
  }
});

test("rejected actions release the single pending slot; disposal leaves a rejected waiter", async () => {
  const f = fixture();
  try {
    const first = f.history.begin("rejected");
    expect(() => f.history.begin("second")).toThrow("awaiting");
    first.cancel(new Error("stale target"));
    await expect(first.applied).rejects.toThrow("stale target");
    const second = f.history.begin("accepted");
    f.history.dispose();
    await expect(second.applied).rejects.toThrow("editor closed");
    expect(() => f.history.begin("late")).toThrow("unavailable");
  } finally {
    f.destroy();
  }
});
