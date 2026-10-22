import { expect, mock, test } from "bun:test";
import { applySharedTextEvent, isValidSharedTextUpdate, type SharedTextSyncEvent, toBase64 } from "@k2b/cloud/shared-text";
import type { Context } from "hono";
import { WSContext, type WSEvents } from "hono/ws";
import * as Y from "yjs";

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
        return null;
      },
      cursorAt: () => "s6t.fixture.0",
      hub: () => ({ subscribe: waitUntilAborted }),
      publish: async (input: { tenantId: string; data: SharedTextSyncEvent }) => {
        published.push(input);
        return { cursor: "s6t.fixture.10" };
      },
    }),
    createYjsAwarenessTopic: () => ({ live: waitUntilAborted }),
  }));
  mock.module("./service/yjs-snapshot-worker", () => ({
    yjsSnapshotWorker: { queueSnapshotSave: async (input: unknown) => snapshots.push(input) },
  }));

  const { default: app } = await import("./ws");
  type WireMessage = { type: string; payload: { code?: string; reopen?: boolean; restoreRevision?: string } };
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5_000;
    while (!predicate() && Date.now() < deadline) await Bun.sleep(1);
    expect(predicate()).toBe(true);
  };
  const openSocket = async () => {
    await app.request("/");
    const handlers = events!;
    const sent: WireMessage[] = [];
    const closed: number[] = [];
    const raw = {
      send: (data: string) => sent.push(JSON.parse(data)),
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
