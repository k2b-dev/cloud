import { expect, spyOn, test } from "bun:test";
import * as Y from "yjs";
import { RoomWriterBase } from "./room-base";

test("a base behind the admission target catches up before applying a dependent delta", () => {
  const source = new Y.Doc();
  source.clientID = 7;
  const base = new RoomWriterBase({ state: Y.encodeStateAsUpdate(source), text: "", cursor: "s6t.room.0", restoreRevision: "0" });
  const merge = spyOn(base, "merge");
  try {
    source.getText("codemirror").insert(0, "remote");
    const before = Y.encodeStateVector(source);
    source.getText("codemirror").insert(6, " local");
    const state = Y.encodeStateAsUpdate(source);
    base.commit(
      { state, text: "remote local", cursor: "s6t.room.2", restoreRevision: "0" },
      "s6t.room.1",
      Y.encodeStateAsUpdate(source, before),
    );
    expect(merge).toHaveBeenCalledTimes(1);
    expect(base.doc.getText("codemirror").toString()).toBe("remote local");
    expect(base.doc.store.pendingStructs).toBeNull();
    expect(base.snapshot().state).toBe(state);
    const encode = spyOn(Y, "encodeStateAsUpdate");
    try {
      expect(base.snapshot().cursor).toBe("s6t.room.2");
      expect(encode).not.toHaveBeenCalled();
    } finally {
      encode.mockRestore();
    }
  } finally {
    merge.mockRestore();
    base.doc.destroy();
    source.destroy();
  }
});
