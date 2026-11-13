import { afterEach, expect, setSystemTime, test } from "bun:test";
import type { Sync } from "@k2b/sync";
import * as Y from "yjs";
import { bindProcessSync, unbindProcessSync } from "../_internal/process-sync";
import { createDoc } from "./documents";
import { sharedText } from "./log";
import { createRoomLifecycle } from "./room-lifecycle";
import type { SharedTextStoredState, SharedTextSyncEvent } from "./types";

const NOW = new Date("2026-11-13T00:00:00Z");
afterEach(() => {
  unbindProcessSync();
  setSystemTime();
});
const fixture = (state: Uint8Array, flushed: Uint8Array, flush?: () => void) => {
  setSystemTime(NOW);
  let marker: SharedTextSyncEvent | undefined;
  let cursor: string | null = null;
  const topic = {
    latestCursor: async () => cursor,
    cursorSequence: () => 1,
    cursorAt: (sequence: number) => `s6t.freeze.${sequence}`,
    replay: async function* () {
      if (marker && cursor) yield { cursor, data: marker };
    },
    publish: async (input: { data: SharedTextSyncEvent }) => {
      marker = input.data;
      cursor = "s6t.freeze.1";
      return { cursor };
    },
  };
  bindProcessSync({
    topic: () => topic,
    mutex: () => ({ withLock: async (_input: unknown, run: () => Promise<unknown>) => run() }),
  } as unknown as Sync);
  const stored: SharedTextStoredState = { state, text: "visible", restoreRevision: "0", cursor: "s6t.freeze.0" };
  return {
    marker: () => marker,
    room: createRoomLifecycle({
      log: sharedText.define({ id: "freeze", whenFull: "reject", retention: { maxBytes: 1_000_000 } }),
      load: async () => stored,
      flushNow: async () => {
        flush?.();
        return { ...stored, cursor, state: flushed };
      },
    }),
  };
};

const deleted = () => {
  const source = new Y.Doc({ gc: false });
  source.clientID = 42;
  source.getText("codemirror").insert(0, "visible");
  source.getMap("metadata").set("transient", "deleted");
  const beforeDeletion = Y.encodeStateAsUpdate(source);
  source.getMap("metadata").delete("transient");
  return { source, beforeDeletion, state: Y.encodeStateAsUpdate(source) };
};

test("freeze accepts equivalent state encoded differently by a concurrent snapshot writer", async () => {
  const { source, state } = deleted();
  const normalized = createDoc({ state, cursor: null, text: "visible", restoreRevision: "0" });
  try {
    expect(Buffer.from(Y.encodeStateAsUpdate(normalized)).equals(Buffer.from(state))).toBe(false);
    const f = fixture(state, state);
    const frozen = await f.room.freeze("doc");
    expect(frozen?.text).toBe("visible");
    expect(frozen?.cursor).toBe("s6t.freeze.1");
    expect(frozen?.expiresAt).toBe(NOW.getTime() + 55_000);
    expect(f.marker()?.room).toEqual({ state: "frozen", expiresAt: NOW.getTime() + 60_000 });
  } finally {
    source.destroy();
    normalized.destroy();
  }
});

test("freeze rejects equal text and state vectors when the delete set differs", async () => {
  const { source, state, beforeDeletion } = deleted();
  const before = new Y.Doc();
  try {
    Y.applyUpdate(before, beforeDeletion);
    expect(Y.encodeStateVector(before)).toEqual(Y.encodeStateVector(source));
    expect(before.getText("codemirror").toString()).toBe("visible");
    const f = fixture(state, beforeDeletion);
    await expect(f.room.freeze("doc")).rejects.toThrow("flush differs");
  } finally {
    source.destroy();
    before.destroy();
  }
});

test("freeze rejects equal text when causal coverage differs", async () => {
  const { source, state } = deleted();
  try {
    source.getMap("metadata").set("new", "different causal state");
    const f = fixture(state, Y.encodeStateAsUpdate(source));
    await expect(f.room.freeze("doc")).rejects.toThrow("flush differs");
  } finally {
    source.destroy();
  }
});

test("freeze refuses a result after its safe window even while the raw lease is active", async () => {
  const { source, state } = deleted();
  try {
    const f = fixture(state, state, () => setSystemTime(new Date(NOW.getTime() + 55_000)));
    await expect(f.room.freeze("doc")).rejects.toThrow("expired");
    expect(f.marker()?.room).toEqual({ state: "frozen", expiresAt: NOW.getTime() + 60_000 });
  } finally {
    source.destroy();
  }
});

test("cursor-fenced thaw and close refuse the clock-skew safety margin", async () => {
  const { source, state } = deleted();
  try {
    const f = fixture(state, state);
    const frozen = await f.room.freeze("doc");
    expect(frozen).not.toBeNull();
    setSystemTime(new Date(frozen!.expiresAt));
    await expect(f.room.thaw("doc", { freezeCursor: frozen!.cursor })).rejects.toThrow("no longer owned");
    await expect(f.room.closeDocument("doc", { freezeCursor: frozen!.cursor })).rejects.toThrow("no longer owned");
    expect(f.marker()?.room?.state).toBe("frozen");
  } finally {
    source.destroy();
  }
});
