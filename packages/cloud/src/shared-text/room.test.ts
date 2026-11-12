import { afterEach, expect, jest, setSystemTime, spyOn, test } from "bun:test";
import type { Sync, Topic, TopicEvent } from "@k2b/sync";
import { CursorMismatchError, RetentionGapError } from "@k2b/sync";
import * as Y from "yjs";
import { z } from "zod";
import { bindProcessSync, unbindProcessSync } from "../_internal/process-sync";
import { toBase64 } from "./events";
import { sharedText } from "./log";
import { createSharedTextRoom, createSharedTextRoomContext, type SharedTextRoomMessages } from "./room";
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
  const live = stream<TopicEvent<SharedTextEvent>>();
  let authenticateWait: Promise<void> | undefined;
  let revalidateWait: Promise<void> | undefined;
  let denied = false,
    revoked = false;
  let sql = 0,
    snapshots = 0;
  let failure: Error | undefined;
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
      live.push(entry);
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
    hub: () => ({ subscribe: ({ signal }: { signal: AbortSignal }) => live.read(signal) }),
    live: ({ signal }: { signal: AbortSignal }) => stream<TopicEvent<SharedTextEvent>>().read(signal),
  };
  bindProcessSync({
    topic: () => topic,
    mutex: () => ({ withLock: async (_input: unknown, run: () => Promise<unknown>) => run() }),
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
    handlingFailed: "handling",
    messageNotAllowed: () => "phase",
  };
  const sent: Array<{ type: string; payload: { code?: string; updates?: unknown[] } }> = [];
  const closed: number[] = [];
  const ready = Promise.withResolvers<void>();
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
      encode: (type, payload) => ({ type, payload }),
    },
    log: sharedText.define({ id: "room", retention: { maxAgeMs: 60_000, maxBytes: 1_000_000 } }),
    awarenessTopic: () => topic as unknown as Topic<SharedTextEvent & { kind: "awareness" }>,
    snapshots: {
      queue: async () => {
        snapshots++;
      },
    },
    adapter: {
      authenticate: async () => {
        sql++;
        await authenticateWait;
        return { id: "user" };
      },
      authorize: async () => {
        sql++;
        return { ok: !denied, resolvedDocId: "doc", canWrite: true };
      },
      load: async () => {
        sql++;
        return { state: new Uint8Array([0, 0]), text: "", cursor: "s6t.room.0", restoreRevision: "0" };
      },
      actor: (user) => ({ kind: "user", id: user.id }),
      awarenessUser: (user) => ({ userId: user.id, name: "User", color: "#fff" }),
      revalidate: async () => {
        sql++;
        const ok = !revoked;
        await revalidateWait;
        return { ok, code: "ACCESS_REVOKED" };
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
    ready: ready.promise,
    ctx,
    connection,
    sent,
    closed,
    invalidations,
    entries,
    replays,
    sql: () => sql,
    snapshots: () => snapshots,
    holdAuthentication: (wait: Promise<void>) => {
      authenticateWait = wait;
    },
    holdRevalidation: (wait: Promise<void>) => {
      revalidateWait = wait;
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
