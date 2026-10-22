import { expect, mock, test } from "bun:test";
import { applySharedTextEvent, isValidSharedTextUpdate, type SharedTextSyncEvent, toBase64 } from "@k2b/cloud/shared-text";
import type { Context } from "hono";
import { WSContext, type WSEvents } from "hono/ws";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { createYjsProvider } from "./frontend/lib/yjs/provider";

// Module mocks belong to a subprocess, never to another suite's module graph.
if (process.env.NOTEBOOKS_WS_LINEAGE_CHILD !== "1") {
  test("WebSocket publications and reconnects preserve their document restore revision", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, NOTEBOOKS_WS_LINEAGE_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, output: code === 0 ? "passed" : `${stdout}\n${stderr}` }).toEqual({ code: 0, output: "passed" });
  }, 60_000);
} else {
  let events: WSEvents | undefined;
  let revision = "0";
  let state = new Uint8Array([0, 0]);
  let exists = true;
  let permission = "write";
  let restoreAfterRead: (() => void) | null = null;
  let streamStarts = 0;
  type Entry = { cursor: string; data: SharedTextSyncEvent };
  let replayEntries: Entry[] = [];
  let liveEntries: Entry[] = [];
  let echoPublications = false;
  let beforeDelivery: (() => Promise<void>) | null = null;
  const liveWaiters = new Set<() => void>();
  const appendLive = (entry: Entry) => {
    liveEntries.push(entry);
    for (const wake of liveWaiters) wake();
  };
  const liveStream = async function* (config: { signal?: AbortSignal }) {
    let index = 0;
    while (!config.signal?.aborted) {
      if (index < liveEntries.length) yield liveEntries[index++]!;
      else
        await new Promise<void>((resolve) => {
          const wake = () => {
            liveWaiters.delete(wake);
            config.signal?.removeEventListener("abort", wake);
            resolve();
          };
          liveWaiters.add(wake);
          config.signal?.addEventListener("abort", wake, { once: true });
        });
    }
  };
  const published: Array<{ tenantId: string; data: SharedTextSyncEvent }> = [];
  const snapshots: unknown[] = [];
  const waitUntilAborted = async function* (config: { signal?: AbortSignal }) {
    if (!config.signal?.aborted)
      await new Promise<void>((resolve) => config.signal?.addEventListener("abort", () => resolve(), { once: true }));
  };
  const note = { id: "test-note", notebookId: "test-notebook", lockedAt: null };
  const stored = () => ({
    restoreRevision: revision,
    yjsState: state,
    streamCursor: "s6t.fixture.9",
    historyIncomplete: false,
    contentMd: null,
  });
  mock.module("@k2b/cloud/server", () => ({
    getLocale: () => "en",
    auth: {
      session: {
        resolveToken: async () => "session",
        authenticate: async () => ({ user: { id: "user", displayName: "User", avatarHash: null } }),
      },
    },
  }));
  mock.module("@k2b/cloud/services", () => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  }));
  mock.module("hono/bun", () => ({
    upgradeWebSocket: (factory: (context: Context) => Promise<WSEvents>) => async (context: Context) => {
      events = await factory(context);
      return new Response("fixture");
    },
  }));
  mock.module("./service", () => ({
    notebooksService: {
      note: {
        getByShortId: async () => note,
        get: async () => note,
        getAnchoredYjsState: async () => stored(),
        deliverAtRestoreRevision: async (input: { restoreRevision: string; deliver: () => undefined }) => {
          await beforeDelivery?.();
          if (!exists) return "notFound";
          if (input.restoreRevision !== revision) return "stale";
          input.deliver();
          return "delivered";
        },
        getYjsStateWithCursor: async () => {
          const result = exists ? stored() : null;
          restoreAfterRead?.();
          restoreAfterRead = null;
          return result;
        },
      },
      notebook: { permission: { get: async () => permission } },
      workspaceEvents: { live: waitUntilAborted },
      presence: {
        snapshot: async () => ({ participants: [], cursor: "0" }),
        watch: waitUntilAborted,
        join: async () => {},
        leave: async () => {},
      },
    },
  }));
  mock.module("./service/presence", () => ({ PRESENCE_HEARTBEAT_INTERVAL_MS: 10_000 }));
  mock.module("./service/yjs-sync", () => ({
    NODE_ID: "fixture-node",
    toBase64,
    isValidYjsUpdate: isValidSharedTextUpdate,
    isStorageExhausted: () => false,
    maxStreamCursor: (_previous: string | null, next: string) => next,
    createYjsTopic: () => ({
      latestCursor: async () => {
        streamStarts++;
        return replayEntries.at(-1)?.cursor ?? null;
      },
      replay: async function* () {
        yield* replayEntries;
      },
      cursorAt: () => "s6t.fixture.0",
      hub: () => ({ subscribe: liveStream }),
      publish: async (input: { tenantId: string; data: SharedTextSyncEvent }) => {
        published.push(input);
        if (echoPublications) appendLive({ cursor: "s6t.fixture.10", data: input.data });
        return { cursor: "s6t.fixture.10" };
      },
    }),
    createYjsAwarenessTopic: () => ({ live: waitUntilAborted }),
  }));
  mock.module("./service/yjs-snapshot-worker", () => ({
    yjsSnapshotWorker: { queueSnapshotSave: async (input: unknown) => snapshots.push(input) },
  }));

  const { default: app } = await import("./ws");
  type WireMessage = {
    type: string;
    payload: {
      code?: string;
      reopen?: boolean;
      restoreRevision?: string;
      updates?: Array<{ cursor: string; payload: string; actionId?: string }>;
    };
  };
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5_000;
    while (!predicate() && Date.now() < deadline) await Bun.sleep(1);
    expect(predicate()).toBe(true);
  };
  const openSocket = async (onWire?: (data: string) => void) => {
    await app.request("/");
    const handlers = events!;
    const sent: WireMessage[] = [];
    const closed: number[] = [];
    const raw = {
      send: (data: string) => {
        sent.push(JSON.parse(data));
        onWire?.(data);
      },
      close: (code: number) => {
        closed.push(code);
        void handlers.onClose?.(new CloseEvent("close"), socket);
      },
    };
    const socket = new WSContext({ raw, readyState: 1, send: () => {}, close: () => {} });
    handlers.onOpen?.(new Event("open"), socket);
    const message = (type: string, payload: object) =>
      handlers.onMessage?.(
        new MessageEvent("message", { data: JSON.stringify({ type, payload: { noteId: "abcdef", ...payload } }) }),
        socket,
      );
    return {
      sent,
      closed,
      message,
      replay: (restoreRevision: string | null, fromCursor?: string) => message("notes.yjs.replay.request", { restoreRevision, fromCursor }),
      publish: (restoreRevision: string, payload = "AAA=") => message("notes.yjs.sync.publish", { restoreRevision, payload }),
      ready: () => waitFor(() => sent.some((message) => message.type === "notes.yjs.replay.ready")),
      close: async () => handlers.onClose?.(new CloseEvent("close"), socket),
    };
  };
  const reset = () => {
    revision = "0";
    state = new Uint8Array([0, 0]);
    exists = true;
    permission = "write";
    restoreAfterRead = null;
    streamStarts = 0;
    replayEntries = [];
    liveEntries = [];
    echoPublications = false;
    beforeDelivery = null;
    published.length = 0;
    snapshots.length = 0;
  };
  const expectReopen = async (socket: Awaited<ReturnType<typeof openSocket>>) => {
    await waitFor(() => socket.closed.length > 0);
    expect(socket.closed[0]).toBe(1012);
    expect(socket.sent.filter((message) => message.type === "notes.yjs.error").map((message) => message.payload)).toEqual([
      expect.objectContaining({ code: "RESYNC_REQUIRED", reopen: true }),
    ]);
  };

  test("an initial empty document establishes the snapshot revision and tags accepted publications without an optimistic echo", async () => {
    reset();
    revision = "7";
    const socket = await openSocket();
    try {
      socket.replay(null);
      await socket.ready();
      expect(socket.sent.find((message) => message.type === "notes.yjs.sync.push")?.payload.restoreRevision).toBe("7");
      expect(socket.sent.find((message) => message.type === "notes.yjs.replay.ready")?.payload.restoreRevision).toBe("7");
      const pushesBefore = socket.sent.filter((message) => message.type === "notes.yjs.sync.push").length;
      socket.publish("7");
      await waitFor(() => published.length === 1);
      expect(published[0]?.data.restoreRevision).toBe("7");
      expect(socket.sent.filter((message) => message.type === "notes.yjs.sync.push")).toHaveLength(pushesBefore);
    } finally {
      await socket.close();
    }
    expect(snapshots).toEqual([{ noteId: "test-note", targetCursor: "s6t.fixture.10", reason: "unload" }]);
  });

  test("a connected writer cannot publish after a store-only restore", async () => {
    reset();
    const socket = await openSocket();
    try {
      socket.replay(null);
      await socket.ready();
      revision = "1";
      socket.publish("0");
      await expectReopen(socket);
      expect(published).toEqual([]);
      expect(snapshots).toEqual([]);
    } finally {
      await socket.close();
    }
  });

  test("a writer cannot adopt the store's new revision on its existing socket", async () => {
    reset();
    const socket = await openSocket();
    try {
      socket.replay(null);
      await socket.ready();
      revision = "1";
      socket.publish("1");
      await expectReopen(socket);
      expect(published).toEqual([]);
    } finally {
      await socket.close();
    }
  });

  test("a restore after the store check leaves old deletes tagged with their original revision", async () => {
    reset();
    const original = new Y.Doc();
    const replacement = new Y.Doc();
    original.clientID = 11;
    replacement.clientID = 12;
    original.getText("codemirror").insert(0, "TOKEN");
    const restoredState = Y.encodeStateAsUpdate(original);
    original.getText("codemirror").delete(0, 5);
    state = Y.encodeStateAsUpdate(original);
    const socket = await openSocket();
    try {
      socket.replay(null);
      await socket.ready();
      restoreAfterRead = () => {
        revision = "1";
        state = restoredState;
      };
      socket.publish("0", toBase64(Y.encodeStateAsUpdate(original)));
      await waitFor(() => published.length === 1);
      expect(revision).toBe("1");
      const data = published[0]!.data;
      expect(data.restoreRevision).toBe("0");
      Y.applyUpdate(replacement, state);
      expect(applySharedTextEvent(replacement, { cursor: "s6t.fixture.10", data }, "test-note", revision)).toBe(false);
      expect(replacement.getText("codemirror").toString()).toBe("TOKEN");
      // The bytes really do contain the historical deletion; only the revision fence rejects it.
      Y.applyUpdate(replacement, Buffer.from(data.payload, "base64"));
      expect(replacement.getText("codemirror").toString()).toBe("");
    } finally {
      await socket.close();
      original.destroy();
      replacement.destroy();
    }
  });

  test("store check -> restore -> publish -> live delivery preserves TOKEN and the provider's unsent AFTER", async () => {
    reset();
    const originalWebSocket = globalThis.WebSocket;
    class BrowserSocket {
      static OPEN = 1;
      static latest: BrowserSocket;
      readyState = 1;
      sent: string[] = [];
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: ((event: { code: number; reason: string }) => void) | null = null;
      constructor(_url: string) {
        BrowserSocket.latest = this;
      }
      send(data: string) {
        this.sent.push(data);
      }
      close() {
        this.readyState = 3;
      }
    }
    Object.assign(globalThis, { WebSocket: BrowserSocket });
    const doc = new Y.Doc();
    const replacement = new Y.Doc();
    doc.clientID = 101;
    doc.getText("codemirror").insert(0, "TOKEN");
    const historical = Y.encodeStateAsUpdate(doc);
    doc.getText("codemirror").delete(0, 5);
    state = Y.encodeStateAsUpdate(doc);
    const awareness = new Awareness(doc);
    const fatals: string[] = [];
    const provider = createYjsProvider({
      doc,
      awareness,
      noteId: "abcdef",
      appUrl: "http://localhost",
      initialCursor: "s6t.fixture.9",
      initialRestoreRevision: "0",
      onFatal: (error) => fatals.push(error.code),
    });
    const socket = await openSocket((data) => BrowserSocket.latest.onmessage?.({ data }));
    try {
      provider.connect();
      BrowserSocket.latest.onopen?.();
      socket.replay("0", "s6t.fixture.9");
      await socket.ready();
      doc.getText("codemirror").insert(0, "AFTER");
      expect(provider.hasUnsentChanges()).toBe(true);
      const publication = BrowserSocket.latest.sent.map((raw) => JSON.parse(raw)).find((msg) => msg.type === "notes.yjs.sync.publish");
      restoreAfterRead = () => {
        revision = "1";
        state = historical;
      };
      echoPublications = true;
      socket.message(publication.type, publication.payload);
      await expectReopen(socket);
      expect(published).toHaveLength(1);
      const data = published[0]!.data;
      expect(data.restoreRevision).toBe("0");
      Y.applyUpdate(replacement, state);
      expect(applySharedTextEvent(replacement, { cursor: "s6t.fixture.10", data }, "test-note", "1")).toBe(false);
      expect(replacement.getText("codemirror").toString()).toBe("TOKEN");
      expect(doc.getText("codemirror").toString()).toBe("AFTER");
      expect(provider.hasUnsentChanges()).toBe(true);
      expect(fatals).toEqual(["RESYNC_REQUIRED"]);
      expect(socket.sent.filter((msg) => msg.type === "notes.yjs.sync.push")).toEqual([]);
      expect(socket.sent.filter((msg) => msg.type === "notes.yjs.replay.ready")).toHaveLength(1);
      provider.resume();
      expect(provider.hasUnsentChanges()).toBe(true);
    } finally {
      await socket.close();
      provider.dispose();
      awareness.destroy();
      doc.destroy();
      replacement.destroy();
      Object.assign(globalThis, { WebSocket: originalWebSocket });
    }
  });

  const entry = (seq: number): Entry => ({
    cursor: `s6t.fixture.${seq}`,
    data: { kind: "sync", payload: "AAA=", restoreRevision: "0", actionId: `action-${seq}`, originNodeId: "peer", originPeerId: "peer" },
  });

  test("a restore while a replay batch waits suppresses stale batches and readiness, including finally", async () => {
    reset();
    replayEntries = [entry(10), entry(11)];
    const socket = await openSocket();
    try {
      // Cursor reconnect skips the initial snapshot; race the first replay send.
      beforeDelivery = async () => {
        revision = "1";
      };
      socket.replay("0", "s6t.fixture.9");
      await expectReopen(socket);
      expect(socket.sent.some((msg) => msg.type === "notes.yjs.sync.push" || msg.type === "notes.yjs.replay.ready")).toBe(false);
    } finally {
      await socket.close();
    }
  });

  test("a mismatch drops queued timer and size batches without a finally echo", async () => {
    reset();
    const socket = await openSocket();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
      socket.replay("0", "s6t.fixture.9");
      await socket.ready();
      beforeDelivery = async () => {
        entered.resolve();
        await release.promise;
      };
      appendLive(entry(10));
      await entered.promise;
      for (let i = 11; i <= 110; i++) appendLive(entry(i));
      revision = "1";
      release.resolve();
      await expectReopen(socket);
      expect(socket.sent.filter((msg) => msg.type === "notes.yjs.sync.push")).toEqual([]);
      expect(socket.sent.filter((msg) => msg.type === "notes.yjs.replay.ready")).toHaveLength(1);
    } finally {
      release.resolve();
      await socket.close();
    }
  });

  test("timer and size flushes serialize peer receipts before replay readiness without duplicate batches", async () => {
    reset();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let deliveries = 0;
    beforeDelivery = async () => {
      deliveries++;
      if (deliveries === 1) {
        entered.resolve();
        await release.promise;
      }
    };
    replayEntries = Array.from({ length: 205 }, (_, i) => entry(i + 10));
    const socket = await openSocket();
    try {
      socket.replay("0", "s6t.fixture.9");
      await entered.promise;
      expect(socket.sent.some((msg) => msg.type === "notes.yjs.replay.ready")).toBe(false);
      release.resolve();
      await socket.ready();
      const pushes = socket.sent.filter((msg) => msg.type === "notes.yjs.sync.push");
      expect(pushes.map((msg) => msg.payload.updates?.length)).toEqual([100, 100, 5]);
      expect(pushes.flatMap((msg) => msg.payload.updates?.map((update) => update.actionId))).toEqual(
        replayEntries.map((e) => e.data.actionId),
      );
      expect(socket.sent.at(-1)?.type).toBe("notes.yjs.replay.ready");
      // Force a timer flush to wait, then fill the next size-triggered batch.
      const timerEntered = Promise.withResolvers<void>();
      const timerRelease = Promise.withResolvers<void>();
      const prior = deliveries;
      beforeDelivery = async () => {
        deliveries++;
        if (deliveries === prior + 1) {
          timerEntered.resolve();
          await timerRelease.promise;
        }
      };
      appendLive(entry(215));
      await timerEntered.promise;
      for (let i = 216; i < 316; i++) appendLive(entry(i));
      expect(deliveries).toBe(prior + 1);
      timerRelease.resolve();
      await waitFor(() => socket.sent.filter((msg) => msg.type === "notes.yjs.sync.push").length === 5);
      const all = socket.sent.filter((msg) => msg.type === "notes.yjs.sync.push").flatMap((msg) => msg.payload.updates ?? []);
      expect(all.map((update) => update.cursor)).toEqual(Array.from({ length: 306 }, (_, i) => `s6t.fixture.${i + 10}`));
    } finally {
      release.resolve();
      await socket.close();
    }
  });

  for (const invalid of [undefined, null, "", "01", "-1", "1.5", "1\n", 0, "9223372036854775808", "0".repeat(100)]) {
    test(`a publication with missing or invalid revision ${JSON.stringify(invalid)} requires reopening`, async () => {
      reset();
      const socket = await openSocket();
      try {
        socket.replay(null);
        await socket.ready();
        socket.message("notes.yjs.sync.publish", { restoreRevision: invalid, payload: "AAA=" });
        await expectReopen(socket);
        expect(published).toEqual([]);
      } finally {
        await socket.close();
      }
    });
  }

  for (const cursor of ["s6t.fixture.9", "legacy-cursor", ""]) {
    for (const restoreRevision of ["0", null, undefined, "", "01", "9223372036854775808"]) {
      test(`reconnect with cursor ${cursor} and revision ${JSON.stringify(restoreRevision)} fails before starting a stream`, async () => {
        reset();
        revision = "1";
        const socket = await openSocket();
        try {
          socket.message("notes.yjs.replay.request", { restoreRevision, fromCursor: cursor });
          await expectReopen(socket);
          expect(streamStarts).toBe(0);
          expect(socket.sent.some((message) => message.type === "notes.yjs.sync.push" || message.type === "notes.yjs.replay.ready")).toBe(
            false,
          );
        } finally {
          await socket.close();
        }
      });
    }
  }

  test("repeating replay on a joined socket cannot silently rebind its revision", async () => {
    reset();
    const socket = await openSocket();
    try {
      socket.replay(null);
      await socket.ready();
      revision = "1";
      socket.replay(null);
      await expectReopen(socket);
      expect(streamStarts).toBe(1);
    } finally {
      await socket.close();
    }
  });

  test("an existing document without a cursor still cannot adopt a restored snapshot", async () => {
    reset();
    revision = "1";
    const socket = await openSocket();
    try {
      socket.replay("0");
      await expectReopen(socket);
      expect(streamStarts).toBe(0);
      expect(socket.sent.some((message) => message.type === "notes.yjs.sync.push" || message.type === "notes.yjs.replay.ready")).toBe(
        false,
      );
    } finally {
      await socket.close();
    }
  });

  test("a matching cursor revision reconnects without replacing the document", async () => {
    reset();
    const socket = await openSocket();
    try {
      socket.replay("0", "s6t.fixture.9");
      await socket.ready();
      expect(streamStarts).toBe(1);
      expect(socket.sent.some((message) => message.type === "notes.yjs.sync.push")).toBe(false);
      socket.publish("0");
      await waitFor(() => published.length === 1);
      expect(published[0]?.data.restoreRevision).toBe("0");
    } finally {
      await socket.close();
    }
  });

  test("a read-only joined socket still cannot publish", async () => {
    reset();
    permission = "read";
    const socket = await openSocket();
    try {
      socket.replay(null);
      await socket.ready();
      socket.publish("0");
      await waitFor(() => socket.sent.some((message) => message.payload.code === "ACCESS_DENIED"));
      expect(published).toEqual([]);
    } finally {
      await socket.close();
    }
  });

  test("a note removed before publication still fails visibly", async () => {
    reset();
    const socket = await openSocket();
    try {
      socket.replay(null);
      await socket.ready();
      exists = false;
      socket.publish("0");
      await waitFor(() => socket.closed.length > 0);
      expect(socket.sent.find((message) => message.type === "notes.yjs.error")?.payload.code).toBe("NOTE_NOT_FOUND");
      expect(published).toEqual([]);
    } finally {
      await socket.close();
    }
  });
}
