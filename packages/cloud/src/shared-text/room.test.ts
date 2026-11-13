import { afterEach, expect, jest, setSystemTime, spyOn, test } from "bun:test";
import type { Sync, Topic, TopicEvent } from "@k2b/sync";
import { ConflictError, CursorMismatchError, RetentionGapError } from "@k2b/sync";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { z } from "zod";
import { bindProcessSync, unbindProcessSync } from "../_internal/process-sync";
import { toBase64 } from "./events";
import { sharedText } from "./log";
import { createSharedTextRoom, createSharedTextRoomContext, type SharedTextRoomMessages } from "./room";
import { RoomWriterBase } from "./room-base";
import type { SharedTextEvent } from "./types";

const NOW = new Date("2026-11-12T12:00:00Z");
afterEach(() => {
  unbindProcessSync();
  setSystemTime();
  jest.useRealTimers();
});
const waitFor = async (check: () => boolean) => {
  while (!check()) await Bun.sleep(1);
  expect(check()).toBe(true);
};
const stream = <T>() => {
  const values: T[] = [];
  let wake = () => {};
  return {
    push(value: T) {
      values.push(value);
      wake();
    },
    async *read(signal: AbortSignal) {
      while (!signal.aborted) {
        if (values.length) yield values.shift()!;
        else
          await new Promise<void>((resolve) => {
            const finish = () => {
              signal.removeEventListener("abort", finish);
              resolve();
            };
            wake = finish;
            signal.addEventListener("abort", finish, { once: true });
            if (signal.aborted || values.length) finish();
          });
      }
    },
  };
};
const fixture = () => {
  setSystemTime(NOW);
  const invalidations = stream<void>();
  const live = new Set<ReturnType<typeof stream<TopicEvent<SharedTextEvent>>>>();
  let authenticateWait: Promise<void> | undefined;
  let revalidateWait: Promise<void> | undefined;
  let joinWait: Promise<void> | undefined;
  let admissionWait: Promise<void> | undefined;
  let joinEntered = Promise.withResolvers<void>();
  let admissionEntered = Promise.withResolvers<void>();
  let queueFailure = false,
    leaveFailure = false;
  let admissionCalls = 0,
    leaveCalls = 0;
  let denied = false,
    revoked = false,
    readOnly = false;
  let sql = 0,
    snapshots = 0;
  let failure: Error | undefined;
  let admissionBusy = false;
  let head: string | null = null;
  const entries: TopicEvent<SharedTextEvent>[] = [];
  const replays: number[] = [];
  const topic = {
    cursorSequence: (cursor: string) => Number(cursor.split(".").at(-1)),
    cursorAt: (sequence: number) => `s6t.room.${sequence}`,
    latestCursor: async () => head,
    publish: async (input: { data: SharedTextEvent; tenantId?: string }) => {
      const sequence = entries.length + 1;
      head = `s6t.room.${sequence}`;
      const entry = {
        data: input.data,
        cursor: head,
        sequence,
        eventId: String(sequence),
        tenantId: input.tenantId ?? "doc",
        publishedAt: NOW,
      };
      entries.push(entry);
      for (const subscriber of live) subscriber.push(entry);
      return { cursor: head, streamSequence: sequence, messageId: String(sequence), duplicate: false };
    },
    replay: async function* (options: { after?: string; until?: string }) {
      if (failure) throw failure;
      const batch = entries.filter(
        (e) =>
          Number(e.cursor.split(".").at(-1)) > Number(options.after?.split(".").at(-1) ?? 0) &&
          (!options.until || Number(e.cursor.split(".").at(-1)) <= Number(options.until.split(".").at(-1))),
      );
      replays.push(batch.length);
      yield* batch;
    },
    hub: () => ({
      subscribe: async function* ({ signal }: { signal: AbortSignal }) {
        const subscriber = stream<TopicEvent<SharedTextEvent>>();
        live.add(subscriber);
        try {
          yield* subscriber.read(signal);
        } finally {
          live.delete(subscriber);
        }
      },
    }),
    live: ({ signal }: { signal: AbortSignal }) => stream<TopicEvent<SharedTextEvent>>().read(signal),
  };
  bindProcessSync({
    topic: () => topic,
    mutex: () => ({
      withLock: async (_input: unknown, run: () => Promise<unknown>) => {
        admissionCalls++;
        admissionEntered.resolve();
        await admissionWait;
        if (admissionBusy) throw new ConflictError("busy");
        return run();
      },
    }),
  } as unknown as Sync);
  const messages: SharedTextRoomMessages = {
    notFound: "missing",
    sessionExpired: "expired",
    accessDenied: "denied",
    writeAccessRequired: "write",
    accessRefreshFailed: "refresh",
    liveSyncStorageExhausted: "storage",
    liveSyncStreamFailed: "sync",
    liveAwarenessStreamFailed: "awareness",
    replayRequired: "replay",
    reopenRequired: "reopen",
    loginRequired: "login",
    invalidSyncUpdate: "invalid",
    invalidBase64: "base64",
    invalidMessage: "message",
    invalidJson: "json",
    jsonTextOnly: "text",
    messageTooLarge: "large",
    tooManyMessages: "many",
    busy: "Document is busy; retrying",
    handlingFailed: "handling",
    messageNotAllowed: () => "phase",
  };
  const sent: Array<{ type: string; payload: { code?: string; message?: string; updates?: unknown[] } }> = [];
  const closed: number[] = [];
  const ready = Promise.withResolvers<void>();
  const callbackContexts: unknown[] = [];
  const validatedContexts: unknown[] = [];
  const room = createSharedTextRoom({
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    protocol: {
      wsType: {
        replayRequest: "replay",
        replayReady: "ready",
        syncPublish: "edit",
        awarenessPublish: "cursor",
        syncPush: "push",
        awarenessPush: "awareness",
        error: "error",
      },
      documentId: z.string(),
      maxSyncPayloadLength: 8_000_000,
      streamCursorPattern: /^s6t\./,
      decode: (value) => value,
      encode: (type, payload, ctx) => {
        callbackContexts.push(ctx);
        return { type, payload };
      },
    },
    log: sharedText.define({ id: "room", retention: { maxAgeMs: 60_000, maxBytes: 1_000_000 } }),
    awarenessTopic: () => topic as unknown as Topic<SharedTextEvent & { kind: "awareness" }>,
    snapshots: {
      queue: async () => {
        snapshots++;
        if (queueFailure) throw new Error("queue failed");
      },
    },
    validateState: (_state, ctx) => {
      validatedContexts.push(ctx);
      return true;
    },
    adapter: {
      authenticate: async () => {
        sql++;
        await authenticateWait;
        return { id: "user" };
      },
      authorize: async () => {
        sql++;
        return { ok: !denied, resolvedDocId: "doc", canWrite: !readOnly };
      },
      load: async () => {
        sql++;
        return { state: new Uint8Array([0, 0]), text: "", cursor: "s6t.room.0", restoreRevision: "0" };
      },
      join: async () => {
        joinEntered.resolve();
        await joinWait;
      },
      leave: async () => {
        leaveCalls++;
        if (leaveFailure) throw new Error("leave failed");
      },
      actor: (user) => ({ kind: "user", id: user.id }),
      awarenessUser: (user) => ({ userId: user.id, name: "User", color: "#fff" }),
      revalidate: async () => {
        sql++;
        const ok = !revoked;
        await revalidateWait;
        return { ok, code: "ACCESS_REVOKED", canWrite: !readOnly };
      },
      invalidations: (_ctx, signal) => invalidations.read(signal),
      recover: async () => {
        sql++;
      },
    },
  });
  const ctx = createSharedTextRoomContext<{ id: string }, SharedTextRoomMessages>(
    {
      send: (data) => {
        const message = JSON.parse(data);
        sent.push(message);
        if (message.type === "ready") ready.resolve();
      },
      close: (code) => closed.push(code),
    },
    "credential",
    messages,
  );
  const connection = room.connect(ctx);
  const request = (type: string, payload: object) => connection.receive(JSON.stringify({ type, payload: { docId: "public", ...payload } }));
  return {
    room,
    callbackContexts,
    validatedContexts,
    ready: ready.promise,
    ctx,
    connection,
    sent,
    closed,
    invalidations,
    entries,
    replays,
    sql: () => sql,
    admissionCalls: () => admissionCalls,
    leaveCalls: () => leaveCalls,
    holdJoin: (wait: Promise<void>) => {
      joinWait = wait;
      joinEntered = Promise.withResolvers<void>();
      return joinEntered.promise;
    },
    holdAdmission: (wait: Promise<void>) => {
      admissionWait = wait;
      admissionEntered = Promise.withResolvers<void>();
      return admissionEntered.promise;
    },
    failQueue: (value: boolean) => {
      queueFailure = value;
    },
    failLeave: (value: boolean) => {
      leaveFailure = value;
    },
    writable: () => {
      readOnly = false;
    },
    snapshots: () => snapshots,
    holdAuthentication: (wait: Promise<void>) => {
      authenticateWait = wait;
    },
    holdRevalidation: (wait: Promise<void>) => {
      revalidateWait = wait;
    },
    busy: (value: boolean) => {
      admissionBusy = value;
    },
    readOnly: () => {
      readOnly = true;
    },
    deny: () => {
      denied = true;
    },
    revoke: () => {
      revoked = true;
      invalidations.push();
    },
    fail: (error: Error) => {
      failure = error;
      head = "s6t.room.1";
    },
    join: () => request("replay", { restoreRevision: null }),
    request,
  };
};
test("adapter join denial closes without loading document bytes", async () => {
  const f = fixture();
  f.deny();
  await f.join();
  await waitFor(() => f.closed.length > 0);
  expect(f.sent.at(-1)?.payload.code).toBe("ACCESS_DENIED");
  expect(f.sql()).toBe(2);
  await f.connection.close();
});
test("access events close an affected session; edit admission and fan-out perform zero SQL", async () => {
  const f = fixture();
  try {
    await f.join();
    await waitFor(() => f.sent.some((m) => m.type === "ready"));
    const joined = f.sql();
    const doc = new Y.Doc();
    doc.clientID = 42;
    doc.getText("codemirror").insert(0, "hello");
    await f.request("edit", { payload: toBase64(Y.encodeStateAsUpdate(doc)), baseCursor: "s6t.room.0", restoreRevision: "0" });
    doc.destroy();
    await waitFor(() => f.entries.length === 1);
    await waitFor(() => f.sent.some((m) => m.type === "push"));
    expect(f.sql() - joined).toBe(0);
    expect(f.entries[0]?.data.kind).toBe("sync");
    f.revoke();
    await waitFor(() => f.closed.length > 0);
    expect(f.sent.at(-1)?.payload.code).toBe("ACCESS_REVOKED");
    expect(f.sql() - joined).toBe(1);
  } finally {
    await f.connection.close();
  }
});
test("idle sessions schedule no access checks and execute zero SQL over virtual time", async () => {
  jest.useFakeTimers();
  const intervals = spyOn(globalThis, "setInterval");
  const timeouts = spyOn(globalThis, "setTimeout");
  const f = fixture();
  await f.join();
  await f.ready;
  expect(f.sent.some((m) => m.type === "ready")).toBe(true);
  const joined = f.sql();
  try {
    // Advancing the deterministic clock cannot produce an access callback: no timer exists.
    jest.advanceTimersByTime(3_600_000);
    await Promise.resolve();
    expect(f.sql()).toBe(joined);
    expect(intervals).not.toHaveBeenCalled();
    expect(timeouts).not.toHaveBeenCalled();
  } finally {
    intervals.mockRestore();
    timeouts.mockRestore();
    await f.connection.close();
  }
});
for (const failure of [new RetentionGapError("s6t.room.0", "s6t.room.2"), new CursorMismatchError("foreign")])
  test(`broker ${failure.name} requires resync with unchanged close semantics`, async () => {
    const f = fixture();
    f.fail(failure);
    await f.join();
    await waitFor(() => f.closed.length > 0);
    expect(f.sent.at(-1)?.payload.code).toBe("RESYNC_REQUIRED");
    expect(f.closed[0]).toBe(1012);
    await f.connection.close();
  });

test("an identity invalidation during join cannot be lost before access subscriptions start", async () => {
  const f = fixture();
  const released = Promise.withResolvers<void>();
  f.holdAuthentication(released.promise);
  try {
    await f.join();
    await waitFor(() => f.sql() === 1);
    f.revoke();
    await f.room.revalidate(f.ctx);
    released.resolve();
    await waitFor(() => f.closed.length > 0);
    expect(f.sent.at(-1)?.payload.code).toBe("ACCESS_REVOKED");
    expect(f.sent.some((message) => message.type === "ready")).toBe(false);
  } finally {
    released.resolve();
    await f.connection.close();
  }
});

test("each accepted edit advances the base: replay stays bounded across a long session", async () => {
  const f = fixture();
  const doc = new Y.Doc();
  doc.clientID = 42;
  try {
    await f.join();
    await f.ready;
    const joined = f.sql();
    let baseCursor = "s6t.room.0";
    for (let index = 0; index < 50; index++) {
      const vector = Y.encodeStateVector(doc);
      doc.getText("codemirror").insert(index, "x");
      await f.room.handle(f.ctx, {
        type: "edit",
        payload: { docId: "public", payload: toBase64(Y.encodeStateAsUpdate(doc, vector)), baseCursor, restoreRevision: "0" },
      });
      baseCursor = f.entries.at(-1)!.cursor;
    }
    expect(f.entries).toHaveLength(50);
    expect(Math.max(...f.replays)).toBeLessThanOrEqual(1);
    expect(f.sql()).toBe(joined);
  } finally {
    doc.destroy();
    await f.connection.close();
  }
});

test("retention loss during admission requires reopen rather than internal error", async () => {
  const f = fixture();
  try {
    await f.join();
    await f.ready;
    f.fail(new RetentionGapError("s6t.room.0", "s6t.room.2"));
    await f.room.handle(f.ctx, {
      type: "edit",
      payload: { docId: "public", payload: "AAA=", baseCursor: "s6t.room.0", restoreRevision: "0" },
    });
    expect(f.sent.at(-1)?.payload.code).toBe("RESYNC_REQUIRED");
    expect(f.closed.at(-1)).toBe(1012);
  } finally {
    await f.connection.close();
  }
});

test("revalidation is single-flight and an invalidation during its query is checked again", async () => {
  const f = fixture();
  const release = Promise.withResolvers<void>();
  try {
    await f.join();
    await f.ready;
    const joined = f.sql();
    f.holdRevalidation(release.promise);
    const first = f.room.revalidate(f.ctx);
    const repeated = Array.from({ length: 20 }, () => f.room.revalidate(f.ctx));
    expect(repeated.every((task) => task === first)).toBe(true);
    f.revoke();
    release.resolve();
    await first;
    await waitFor(() => f.closed.length > 0);
    expect(f.sql() - joined).toBe(2);
    expect(f.sent.at(-1)?.payload.code).toBe("ACCESS_REVOKED");
  } finally {
    release.resolve();
    await f.connection.close();
  }
});

for (const fromCursor of ["s6t.room.1", "s6t.room.2"])
  test(`reconnect at ${fromCursor} ahead of SQL preserves the complete admission base`, async () => {
    const f = fixture();
    const topic = sharedText.define({ id: "room", retention: { maxAgeMs: 60_000, maxBytes: 1_000_000 } }).topic();
    const remote = new Y.Doc();
    const local = new Y.Doc();
    remote.clientID = 7;
    local.clientID = 42;
    try {
      remote.getText("codemirror").insert(0, "ab");
      const first = Y.encodeStateAsUpdate(remote);
      const vector = Y.encodeStateVector(remote);
      await topic.publish({
        tenantId: "doc",
        data: {
          kind: "sync",
          payload: toBase64(first),
          restoreRevision: "0",
          originNodeId: "n",
          originPeerId: "p",
          history: { patches: [], tables: [] },
        },
      });
      remote.getText("codemirror").insert(2, "c");
      const second = Y.encodeStateAsUpdate(remote, vector);
      await topic.publish({
        tenantId: "doc",
        data: {
          kind: "sync",
          payload: toBase64(second),
          restoreRevision: "0",
          originNodeId: "n",
          originPeerId: "p",
          history: { patches: [], tables: [] },
        },
      });
      await f.request("replay", { restoreRevision: "0", fromCursor });
      await f.ready;
      Y.applyUpdate(local, first);
      Y.applyUpdate(local, second);
      const before = Y.encodeStateVector(local);
      local.getText("codemirror").insert(3, "d");
      await f.room.handle(f.ctx, {
        type: "edit",
        payload: {
          docId: "public",
          payload: toBase64(Y.encodeStateAsUpdate(local, before)),
          baseCursor: "s6t.room.2",
          restoreRevision: "0",
        },
      });
      expect(f.entries).toHaveLength(3);
      expect(f.closed).toEqual([]);
      expect(f.sent.filter((packet) => packet.type === "error")).toEqual([]);
      const replayed = f.sent.filter((packet) => packet.type === "push").flatMap((packet) => packet.payload.updates ?? []);
      expect(replayed).toHaveLength(fromCursor === "s6t.room.1" ? 1 : 0);
    } finally {
      local.destroy();
      remote.destroy();
      await f.connection.close();
    }
  });

test("fan-out shares one live base across writers, keeps none for readers, and never encodes it", async () => {
  const f = fixture();
  const additional: Array<ReturnType<typeof f.room.connect>> = [];
  const join = async () => {
    const ready = Promise.withResolvers<void>();
    const ctx = createSharedTextRoomContext<{ id: string }, SharedTextRoomMessages>(
      {
        send: (raw) => {
          if (JSON.parse(raw).type === "ready") ready.resolve();
        },
        close() {},
      },
      "credential",
      f.ctx.messages,
    );
    const connection = f.room.connect(ctx);
    additional.push(connection);
    await f.room.handle(ctx, { type: "replay", payload: { docId: "public", restoreRevision: null } });
    await ready.promise;
  };
  const source = new Y.Doc();
  source.clientID = 7;
  const bases = new Set<RoomWriterBase>();
  const original = RoomWriterBase.prototype.apply;
  const applied = Promise.withResolvers<void>();
  let calls = 0;
  const apply = spyOn(RoomWriterBase.prototype, "apply").mockImplementation(function (this: RoomWriterBase, ...args) {
    bases.add(this);
    original.apply(this, args);
    if (++calls === 2) applied.resolve();
  });
  let encode: ReturnType<typeof spyOn> | undefined;
  try {
    await f.join();
    await f.ready;
    await join();
    f.readOnly();
    await join();
    source.getText("codemirror").insert(0, "remote");
    const payload = toBase64(Y.encodeStateAsUpdate(source));
    encode = spyOn(Y, "encodeStateAsUpdate");
    await sharedText
      .define({ id: "room", retention: { maxAgeMs: 60_000, maxBytes: 1_000_000 } })
      .topic()
      .publish({
        tenantId: "doc",
        data: {
          kind: "sync",
          payload,
          restoreRevision: "0",
          originNodeId: "remote",
          originPeerId: "remote",
          history: { patches: [], tables: [] },
        },
      });
    await applied.promise;
    expect(bases.size).toBe(1);
    expect(calls).toBe(2);
    expect([...bases][0]!.doc.getText("codemirror").toString()).toBe("remote");
    expect(encode).not.toHaveBeenCalled();
  } finally {
    encode?.mockRestore();
    apply.mockRestore();
    source.destroy();
    for (const connection of additional) await connection.close();
    await f.connection.close();
  }
});

test("admission contention warns BUSY without closing or acknowledging; the same socket can retry", async () => {
  const f = fixture();
  const source = new Y.Doc();
  source.clientID = 7;
  try {
    await f.join();
    await f.ready;
    source.getText("codemirror").insert(0, "pending");
    const payload = { payload: toBase64(Y.encodeStateAsUpdate(source)), baseCursor: "s6t.room.0", restoreRevision: "0" };
    f.busy(true);
    await f.request("edit", payload);
    await waitFor(() => f.sent.some((packet) => packet.payload.code === "BUSY"));
    expect(f.closed).toEqual([]);
    expect(f.entries).toHaveLength(0);
    expect(f.ctx.phase).toBe("joined");
    f.busy(false);
    await f.request("edit", { ...payload, retry: true });
    await waitFor(() => f.entries.length === 1);
    expect(f.closed).toEqual([]);
  } finally {
    source.destroy();
    await f.connection.close();
  }
});

test("BUSY gates queued dependent edits without admission, then accepts the complete retry", async () => {
  const f = fixture();
  const source = new Y.Doc();
  source.clientID = 7;
  try {
    await f.join();
    await f.ready;
    source.getText("codemirror").insert(0, "one");
    const first = toBase64(Y.encodeStateAsUpdate(source));
    const vector = Y.encodeStateVector(source);
    source.getText("codemirror").insert(3, " two");
    const second = toBase64(Y.encodeStateAsUpdate(source, vector));
    const request = (payload: string, retry?: true) =>
      f.room.handle(f.ctx, {
        type: "edit",
        payload: { docId: "public", payload, baseCursor: "s6t.room.0", restoreRevision: "0", ...(retry ? { retry } : {}) },
      });
    f.busy(true);
    await request(first);
    expect(f.sent.at(-1)?.payload.message).toBe("Document is busy; retrying");
    const attempts = f.admissionCalls();
    f.busy(false);
    for (let index = 0; index < 10; index++) await request(second);
    expect(f.admissionCalls()).toBe(attempts);
    expect(f.sent.at(-1)?.payload.message).toBe("Document is busy; retrying");
    expect(f.closed).toEqual([]);
    expect(f.entries).toHaveLength(0);
    // A malformed retry with missing predecessors must also stay recoverable.
    await request(second, true);
    expect(f.sent.at(-1)?.payload.code).toBe("BUSY");
    expect(f.sent.at(-1)?.payload.message).toBe("Document is busy; retrying");
    expect(f.closed).toEqual([]);
    await request(toBase64(Y.encodeStateAsUpdate(source)), true);
    expect(f.entries).toHaveLength(1);
    const received = new Y.Doc();
    try {
      Y.applyUpdate(received, Buffer.from(f.entries[0]!.data.payload, "base64"));
      expect(received.getText("codemirror").toString()).toBe("one two");
    } finally {
      received.destroy();
    }
    const before = Y.encodeStateVector(source);
    source.getText("codemirror").insert(7, " three");
    await f.room.handle(f.ctx, {
      type: "edit",
      payload: {
        docId: "public",
        payload: toBase64(Y.encodeStateAsUpdate(source, before)),
        baseCursor: f.entries[0]!.cursor,
        restoreRevision: "0",
      },
    });
    expect(f.entries).toHaveLength(2);
    expect(f.closed).toEqual([]);
    expect(f.sent.filter((packet) => packet.type === "error").every((packet) => packet.payload.code === "BUSY")).toBe(true);
  } finally {
    source.destroy();
    await f.connection.close();
  }
});

test("a reader upgraded by an event reconnects to obtain a writer admission base", async () => {
  const f = fixture();
  try {
    f.readOnly();
    await f.join();
    await f.ready;
    expect(f.ctx.canWrite).toBe(false);
    f.writable();
    expect(await f.room.revalidate(f.ctx)).toBe(false);
    expect(f.sent.at(-1)?.payload.code).toBe("STREAM_FAILED");
    expect(f.closed).toEqual([1012]);
    expect(f.sent.some((packet) => packet.payload.code === "RESYNC_REQUIRED")).toBe(false);
  } finally {
    await f.connection.close();
  }
});

test("a same-socket rejoin stops the old stream before replacing its sole writer base", async () => {
  const f = fixture();
  const source = new Y.Doc();
  source.clientID = 7;
  const release = Promise.withResolvers<void>();
  const topic = sharedText.define({ id: "room", retention: { maxAgeMs: 60_000, maxBytes: 1_000_000 } }).topic();
  const publish = (update: Uint8Array) =>
    topic.publish({
      tenantId: "doc",
      data: {
        kind: "sync",
        payload: toBase64(update),
        restoreRevision: "0",
        originNodeId: "remote",
        originPeerId: "remote",
        history: { patches: [], tables: [] },
      },
    });
  try {
    await f.join();
    await f.ready;
    source.getText("codemirror").insert(0, "one");
    await publish(Y.encodeStateAsUpdate(source));
    await waitFor(() => f.sent.filter((packet) => packet.type === "push").length >= 2);
    const entered = f.holdJoin(release.promise);
    const rejoin = f.room.handle(f.ctx, { type: "replay", payload: { docId: "public", restoreRevision: "0", fromCursor: "s6t.room.1" } });
    await entered;
    const vector = Y.encodeStateVector(source);
    source.getText("codemirror").insert(3, " two");
    await publish(Y.encodeStateAsUpdate(source, vector));
    release.resolve();
    await rejoin;
    await waitFor(() => f.sent.filter((packet) => packet.type === "ready").length === 2);
    const before = Y.encodeStateVector(source);
    source.getText("codemirror").insert(7, " three");
    await f.room.handle(f.ctx, {
      type: "edit",
      payload: {
        docId: "public",
        payload: toBase64(Y.encodeStateAsUpdate(source, before)),
        baseCursor: "s6t.room.2",
        restoreRevision: "0",
      },
    });
    expect(f.entries).toHaveLength(3);
    expect(f.closed).toEqual([]);
  } finally {
    release.resolve();
    source.destroy();
    await f.connection.close();
  }
});

for (const failure of ["queue", "leave"] as const)
  test(`failed ${failure} cleanup releases the base and resets the context; close can retry`, async () => {
    const f = fixture();
    const source = new Y.Doc();
    source.clientID = 7;
    let base: RoomWriterBase | undefined;
    const original = RoomWriterBase.prototype.commit;
    const commit = spyOn(RoomWriterBase.prototype, "commit").mockImplementation(function (this: RoomWriterBase, ...args) {
      base = this;
      original.apply(this, args);
    });
    try {
      await f.join();
      await f.ready;
      source.getText("codemirror").insert(0, "accepted");
      await f.room.handle(f.ctx, {
        type: "edit",
        payload: { docId: "public", payload: toBase64(Y.encodeStateAsUpdate(source)), baseCursor: "s6t.room.0", restoreRevision: "0" },
      });
      f.failQueue(failure === "queue");
      f.failLeave(failure === "leave");
      await expect(f.connection.close()).rejects.toThrow(`${failure} failed`);
      expect(f.leaveCalls()).toBe(1);
      expect(base?.writers).toBe(0);
      expect(base?.doc.isDestroyed).toBe(true);
      expect(f.ctx.docId).toBeNull();
      expect(f.ctx.restoreRevision).toBeNull();
      expect(f.ctx.canWrite).toBe(false);
      f.failQueue(false);
      f.failLeave(false);
      await f.connection.close();
      expect(f.snapshots()).toBe(failure === "queue" ? 2 : 1);
    } finally {
      f.failQueue(false);
      f.failLeave(false);
      commit.mockRestore();
      source.destroy();
      await f.connection.close();
    }
  });

test("admission reads its base lazily after acquiring ownership", async () => {
  const f = fixture();
  const source = new Y.Doc();
  source.clientID = 7;
  const release = Promise.withResolvers<void>();
  const snapshot = spyOn(RoomWriterBase.prototype, "snapshot");
  try {
    await f.join();
    await f.ready;
    source.getText("codemirror").insert(0, "pending");
    const entered = f.holdAdmission(release.promise);
    const admission = f.room.handle(f.ctx, {
      type: "edit",
      payload: { docId: "public", payload: toBase64(Y.encodeStateAsUpdate(source)), baseCursor: "s6t.room.0", restoreRevision: "0" },
    });
    await entered;
    expect(snapshot).not.toHaveBeenCalled();
    release.resolve();
    await admission;
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(f.entries).toHaveLength(1);
  } finally {
    release.resolve();
    snapshot.mockRestore();
    source.destroy();
    await f.connection.close();
  }
});

test("warm admissions encode once and apply only the accepted delta to the live base", async () => {
  const f = fixture();
  const source = new Y.Doc();
  source.clientID = 7;
  try {
    await f.join();
    await f.ready;
    const merge = spyOn(RoomWriterBase.prototype, "merge");
    const encode = spyOn(Y, "encodeStateAsUpdate");
    try {
      for (let index = 0; index < 3; index++) {
        const vector = Y.encodeStateVector(source);
        source.getText("codemirror").insert(index, "x");
        const payload = toBase64(Y.encodeStateAsUpdate(source, vector));
        encode.mockClear();
        await f.room.handle(f.ctx, {
          type: "edit",
          payload: { docId: "public", payload, baseCursor: `s6t.room.${index}`, restoreRevision: "0" },
        });
        expect(encode).toHaveBeenCalledTimes(1);
      }
      expect(merge).not.toHaveBeenCalled();
      expect(f.entries).toHaveLength(3);
    } finally {
      merge.mockRestore();
      encode.mockRestore();
    }
  } finally {
    source.destroy();
    await f.connection.close();
  }
});

test("a failed final snapshot enqueue still removes awareness for remote peers", async () => {
  const f = fixture();
  const source = new Y.Doc();
  source.clientID = 7;
  const awareness = new Awareness(source);
  const observerDoc = new Y.Doc();
  observerDoc.clientID = 8;
  const observer = new Awareness(observerDoc);
  observer.setLocalState(null);
  try {
    await f.join();
    await f.ready;
    source.getText("codemirror").insert(0, "accepted");
    await f.room.handle(f.ctx, {
      type: "edit",
      payload: { docId: "public", payload: toBase64(Y.encodeStateAsUpdate(source)), baseCursor: "s6t.room.0", restoreRevision: "0" },
    });
    await f.room.handle(f.ctx, {
      type: "cursor",
      payload: { docId: "public", payload: toBase64(encodeAwarenessUpdate(awareness, [source.clientID])) },
    });
    for (const entry of f.entries.filter((entry) => entry.data.kind === "awareness"))
      applyAwarenessUpdate(observer, Buffer.from(entry.data.payload, "base64"), "remote");
    expect(observer.getStates().size).toBe(1);
    const beforeClose = f.entries.length;
    f.failQueue(true);
    await expect(f.connection.close()).rejects.toThrow("queue failed");
    const removals = f.entries.slice(beforeClose).filter((entry) => entry.data.kind === "awareness");
    expect(removals).toHaveLength(1);
    applyAwarenessUpdate(observer, Buffer.from(removals[0]!.data.payload, "base64"), "remote");
    expect(observer.getStates().size).toBe(0);
    expect(f.ctx.docId).toBeNull();
    f.failQueue(false);
    await f.connection.close();
    expect(f.snapshots()).toBe(2);
    expect(f.entries).toHaveLength(beforeClose + 1);
  } finally {
    f.failQueue(false);
    await f.connection.close();
    awareness.destroy();
    observer.destroy();
    source.destroy();
    observerDoc.destroy();
  }
});

test("validation, wire encoding and terminal close encoding receive the connection context", async () => {
  const f = fixture();
  const source = new Y.Doc();
  source.clientID = 42;
  try {
    await f.join();
    await f.ready;
    source.getText("codemirror").insert(0, "scoped");
    await f.room.handle(f.ctx, {
      type: "edit",
      payload: { docId: "public", payload: toBase64(Y.encodeStateAsUpdate(source)), baseCursor: "s6t.room.0", restoreRevision: "0" },
    });
    expect(f.validatedContexts).toEqual([f.ctx]);
    const beforeClose = f.callbackContexts.length;
    f.revoke();
    await waitFor(() => f.closed.length > 0);
    expect(f.callbackContexts.length).toBeGreaterThanOrEqual(beforeClose + 2);
    expect(f.callbackContexts.every((ctx) => ctx === f.ctx)).toBe(true);
  } finally {
    source.destroy();
    await f.connection.close();
  }
});
