import { afterEach, expect, setSystemTime, test } from "bun:test";
import { ConflictError, StoreFullError, type Sync } from "@k2b/sync";
import * as Y from "yjs";
import { bindProcessSync, unbindProcessSync } from "../_internal/process-sync";
import { createDoc } from "./documents";
import { checkLifecycleAdmission, type SharedTextLifecycleEntry, type SharedTextLifecycleStore } from "./lifecycle-store";
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
  let sequence = 0;
  let publicationFailure: Error | undefined;
  let abortAfterPreparation: (() => void) | undefined;
  let removed = false;
  const topic = {
    latestCursor: async () => cursor,
    cursorSequence: () => sequence,
    cursorAt: (sequence: number) => `s6t.freeze.${sequence}`,
    replay: async function* () {
      if (marker && cursor) yield { cursor, data: marker };
    },
    publish: async (input: { data: SharedTextSyncEvent }) => {
      if (publicationFailure) {
        const error = publicationFailure;
        publicationFailure = undefined;
        throw error;
      }
      marker = input.data;
      cursor = `s6t.freeze.${++sequence}`;
      return { cursor };
    },
  };
  bindProcessSync({
    topic: () => topic,
    mutex: () => ({ withLock: async (_input: unknown, run: () => Promise<unknown>) => run() }),
  } as unknown as Sync);
  const stored: SharedTextStoredState = { state, text: "visible", restoreRevision: "0", cursor: "s6t.freeze.0" };
  let entry: SharedTextLifecycleEntry | null = null;
  const lifecycle: SharedTextLifecycleStore = {
    forget: async () => {
      throw new Error("Not used");
    },
    get: async () => entry,
    put: async (_docId, previous, value) => {
      if (previous !== entry) throw new Error("Stale lifecycle CAS");
      entry = { revision: (entry?.revision ?? 0) + 1, value };
      if (value.state === "frozen" && value.freezeCursor === null) abortAfterPreparation?.();
      return entry;
    },
  };
  return {
    marker: () => marker,
    lifecycle,
    removeSnapshot: () => {
      removed = true;
    },
    abortAfterPreparation: (abort: () => void) => {
      abortAfterPreparation = abort;
    },
    failNextPublish: (error = new Error("broker unavailable")) => {
      publicationFailure = error;
    },
    room: createRoomLifecycle({
      log: { ...sharedText.define({ id: "freeze", whenFull: "reject", retention: { maxBytes: 1_000_000 } }), lifecycle },
      load: async () => {
        if (removed) throw new Error("retired snapshot cannot be loaded");
        return stored;
      },
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

test("a committed freeze token can close after expiry, idempotently, without allowing thaw", async () => {
  const { source, state } = deleted();
  try {
    const f = fixture(state, state);
    const frozen = await f.room.freeze("doc");
    expect(frozen).not.toBeNull();
    setSystemTime(new Date(frozen!.expiresAt));
    const closed = await f.room.closeDocument("doc", { freezeCursor: frozen!.cursor });
    expect(await f.room.closeDocument("doc", { freezeCursor: frozen!.cursor })).toBe(closed);
    await expect(f.room.thaw("doc", { freezeCursor: frozen!.cursor })).rejects.toThrow("DOCUMENT_CLOSED");
    expect(f.marker()?.room?.state).toBe("closed");
  } finally {
    source.destroy();
  }
});

test("rollback can thaw a freeze; close requires the current freeze token", async () => {
  const { source, state } = deleted();
  try {
    const f = fixture(state, state);
    await expect(f.room.closeDocument("doc", { freezeCursor: "s6t.freeze.1" })).rejects.toThrow("no longer owned");
    const first = await f.room.freeze("doc");
    await f.room.thaw("doc", { freezeCursor: first!.cursor });
    expect(f.marker()?.room?.state).toBe("open");
    await expect(f.room.closeDocument("doc", { freezeCursor: first!.cursor })).rejects.toThrow("no longer owned");
    const second = await f.room.freeze("doc");
    await expect(f.room.closeDocument("doc", { freezeCursor: first!.cursor })).rejects.toThrow("no longer owned");
    await f.room.closeDocument("doc", { freezeCursor: second!.cursor });
    expect(f.marker()?.room?.state).toBe("closed");
  } finally {
    source.destroy();
  }
});

test("a crash after durable close but before notification is retryable with the same token", async () => {
  const { source, state } = deleted();
  try {
    const f = fixture(state, state);
    const frozen = await f.room.freeze("doc");
    f.removeSnapshot();
    f.failNextPublish();
    await expect(f.room.closeDocument("doc", { freezeCursor: frozen!.cursor })).rejects.toThrow("broker unavailable");
    await expect(checkLifecycleAdmission(f.lifecycle, "doc")).rejects.toThrow("DOCUMENT_CLOSED");
    await f.room.closeDocument("doc", { freezeCursor: frozen!.cursor });
    expect(f.marker()?.room?.state).toBe("closed");
  } finally {
    source.destroy();
  }
});

test("resuming after a crashed freeze expires invalidates its token before accepting new input", async () => {
  const { source, state } = deleted();
  try {
    const f = fixture(state, state);
    const frozen = await f.room.freeze("doc");
    await expect(checkLifecycleAdmission(f.lifecycle, "doc")).rejects.toThrow("DOCUMENT_FROZEN");
    setSystemTime(new Date(NOW.getTime() + 60_001));
    await checkLifecycleAdmission(f.lifecycle, "doc");
    expect((await f.lifecycle.get("doc"))?.value).toEqual({ state: "open" });
    await expect(f.room.closeDocument("doc", { freezeCursor: frozen!.cursor })).rejects.toThrow("no longer owned");
  } finally {
    source.destroy();
  }
});

test("a crash before the freeze marker leaves only a bounded admission lease", async () => {
  const { source, state } = deleted();
  try {
    const f = fixture(state, state);
    f.failNextPublish();
    await expect(f.room.freeze("doc")).rejects.toThrow("broker unavailable");
    await expect(checkLifecycleAdmission(f.lifecycle, "doc")).rejects.toThrow("DOCUMENT_FROZEN");
    setSystemTime(new Date(NOW.getTime() + 60_001));
    await checkLifecycleAdmission(f.lifecycle, "doc");
    expect((await f.lifecycle.get("doc"))?.value.state).toBe("open");
  } finally {
    source.destroy();
  }
});

for (const rejection of [new StoreFullError("storage exhausted"), new ConflictError("head changed")])
  test(`a definitely rejected freeze releases preparation immediately: ${rejection.name}`, async () => {
    const { source, state } = deleted();
    try {
      const f = fixture(state, state);
      f.failNextPublish(rejection);
      await expect(f.room.freeze("doc")).rejects.toThrow(rejection.message);
      await checkLifecycleAdmission(f.lifecycle, "doc");
      expect((await f.lifecycle.get("doc"))?.value.state).toBe("open");
      expect((await f.room.freeze("doc"))?.cursor).toBe("s6t.freeze.1");
    } finally {
      source.destroy();
    }
  });

test("aborting before marker publication releases preparation immediately", async () => {
  const { source, state } = deleted();
  try {
    const f = fixture(state, state);
    const abort = new AbortController();
    f.abortAfterPreparation(() => abort.abort(new Error("cancelled")));
    await expect(f.room.freeze("doc", { signal: abort.signal })).rejects.toThrow();
    await checkLifecycleAdmission(f.lifecycle, "doc");
    expect(f.marker()).toBeUndefined();
  } finally {
    source.destroy();
  }
});

test("thaw requires its freeze cursor and retries after an open authority put without a notification", async () => {
  const { source, state } = deleted();
  try {
    const f = fixture(state, state);
    const frozen = await f.room.freeze("doc");
    await expect(f.room.thaw("doc")).rejects.toThrow("requires the current freeze cursor");
    await expect(f.room.thaw("doc", { freezeCursor: "wrong" })).rejects.toThrow("requires the current freeze cursor");
    f.failNextPublish();
    await expect(f.room.thaw("doc", { freezeCursor: frozen!.cursor })).rejects.toThrow("broker unavailable");
    await checkLifecycleAdmission(f.lifecycle, "doc");
    const cursor = await f.room.thaw("doc", { freezeCursor: frozen!.cursor });
    expect(f.marker()?.room?.state).toBe("open");
    expect(await f.room.thaw("doc", { freezeCursor: frozen!.cursor })).toBe(cursor);
    const second = await f.room.freeze("doc");
    await expect(f.room.thaw("doc", { freezeCursor: frozen!.cursor })).rejects.toThrow();
    await f.room.thaw("doc", { freezeCursor: second!.cursor });
  } finally {
    source.destroy();
  }
});

test("rejected preparation restores the prior thaw retry token", async () => {
  const { source, state } = deleted();
  try {
    const f = fixture(state, state);
    const frozen = await f.room.freeze("doc");
    const thawCursor = await f.room.thaw("doc", { freezeCursor: frozen!.cursor });
    const previous = (await f.lifecycle.get("doc"))!.value;
    f.failNextPublish(new StoreFullError("storage exhausted"));
    await expect(f.room.freeze("doc")).rejects.toThrow("storage exhausted");
    expect((await f.lifecycle.get("doc"))!.value).toEqual(previous);
    expect(await f.room.thaw("doc", { freezeCursor: frozen!.cursor })).toBe(thawCursor);
  } finally {
    source.destroy();
  }
});

test("a freeze followed by thaw cannot hide a lifecycle transition from a stalled publisher", async () => {
  const { source, state } = deleted();
  try {
    const f = fixture(state, state);
    const confirm = await checkLifecycleAdmission(f.lifecycle, "doc");
    const frozen = await f.room.freeze("doc");
    await f.room.thaw("doc", { freezeCursor: frozen!.cursor });
    await expect(confirm()).rejects.toThrow("DOCUMENT_FROZEN");
  } finally {
    source.destroy();
  }
});
