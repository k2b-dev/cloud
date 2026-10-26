import { expect, mock, test } from "bun:test";
import { encoding } from "@k2b/stdlib";
import type { Context } from "hono";
import { WSContext, type WSEvents } from "hono/ws";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { getNotebookPresenceColor, notebooksYjs } from "./lib/yjs";

// Isolate module mocks from the real service suites, as in ws-lineage.test.ts.
if (process.env.NOTEBOOKS_WS_AWARENESS_CHILD !== "1") {
  test("WebSocket trusted awareness transport", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, NOTEBOOKS_WS_AWARENESS_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, output: code === 0 ? "passed" : `${stdout}\n${stderr}` }).toEqual({ code: 0, output: "passed" });
  }, 15_000);
} else {
  let events: WSEvents | undefined;
  let sequence = 0;
  let permission = "write";
  let authenticated = true;
  let reservationFailure: Error | null = null;
  const published: Array<{ payload: string; originPeerId: string }> = [];
  const listeners = new Set<(data: { payload: string; originPeerId: string }) => void>();
  const waitUntilAborted = async function* (config: { signal?: AbortSignal }) {
    if (!config.signal?.aborted)
      await new Promise<void>((resolve) => config.signal?.addEventListener("abort", () => resolve(), { once: true }));
  };
  mock.module("@k2b/cloud/server", () => ({
    guardAppAccessSocket: async (_c: Context, _appId: string, events: WSEvents) => events,
    getLocale: () => "en",
    auth: {
      session: {
        resolveToken: async () => "session",
        authenticate: async () => (authenticated ? { user: { id: "alice", displayName: "Alice", avatarHash: null } } : null),
      },
    },
  }));
  mock.module("@k2b/cloud/services", () => ({ logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));
  mock.module("hono/bun", () => ({
    upgradeWebSocket: (factory: (context: Context) => Promise<WSEvents>) => async (context: Context) => {
      events = await factory(context);
      return new Response("fixture");
    },
  }));
  const note = { id: "note", notebookId: "book", lockedAt: null };
  mock.module("./service", () => ({
    notebooksService: {
      note: {
        getByShortId: async () => note,
        get: async () => note,
        getAnchoredYjsState: async () => ({ yjsState: null, streamCursor: null, restoreRevision: "0", contentMd: null }),
        getYjsStateWithCursor: async () => ({ restoreRevision: "0" }),
        deliverAtRestoreRevision: async (input: { deliver: () => void }) => {
          input.deliver();
          return "delivered";
        },
      },
      notebook: { permission: { get: async () => permission } },
      workspaceEvents: { live: waitUntilAborted },
      presence: { snapshot: async () => ({ participants: [] }), watch: waitUntilAborted, join: async () => {}, leave: async () => {} },
    },
  }));
  mock.module("./service/yjs-snapshot-worker", () => ({ yjsSnapshotWorker: { queueSnapshotSave: async () => {} } }));
  mock.module("./service/yjs-sync", () => ({
    NODE_ID: "fixture",
    toBase64: encoding.toBase64,
    isStorageExhausted: () => false,
    isValidYjsUpdate: () => true,
    maxStreamCursor: (_old: string | null, next: string) => next,
    createYjsTopic: () => ({
      latestCursor: async () => null,
      cursorAt: () => "s6t.fixture.0",
      hub: () => ({ subscribe: waitUntilAborted, close() {} }),
      replay: async function* () {},
    }),
    createYjsAwarenessTopic: () => ({
      live: async function* (config: { signal: AbortSignal }) {
        const pending: Array<{ payload: string; originPeerId: string }> = [];
        let wake = () => {};
        const listener = (data: { payload: string; originPeerId: string }) => {
          pending.push(data);
          wake();
        };
        listeners.add(listener);
        config.signal.addEventListener("abort", () => wake(), { once: true });
        try {
          while (!config.signal.aborted) {
            if (!pending.length)
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
            while (pending.length) yield { data: pending.shift()!, tenantId: "note" };
          }
        } finally {
          listeners.delete(listener);
        }
      },
      publish: async (input: { data: { payload: string; originPeerId: string } }) => {
        if (reservationFailure) throw reservationFailure;
        published.push(input.data);
        for (const listener of listeners) listener(input.data);
        return { streamSequence: ++sequence, cursor: `s6t.fixture.${sequence}` };
      },
    }),
  }));
  const { default: app } = await import("./ws");
  type Wire = { type: string; payload: { peerId?: string; code?: string; updates?: Array<{ payload: string; originPeerId: string }> } };
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 2_000;
    while (!predicate() && Date.now() < deadline) await Bun.sleep(1);
    expect(predicate()).toBe(true);
  };
  const open = async () => {
    await app.request("/");
    const handlers = events!;
    const sent: Wire[] = [];
    const closed: number[] = [];
    const raw = {
      send: (data: string) => sent.push(JSON.parse(data)),
      close: (code: number) => {
        closed.push(code);
        void handlers.onClose?.(new CloseEvent("close"), socket);
      },
    };
    const socket = new WSContext({ raw, readyState: 1, send() {}, close() {} });
    handlers.onOpen?.(new Event("open"), socket);
    const message = (type: string, payload: object) =>
      handlers.onMessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({ type, payload: { noteId: "abcdef", ...payload } }),
        }),
        socket,
      );
    await message(notebooksYjs.wsType.replayRequest, { restoreRevision: null });
    await waitFor(() => sent.some((entry) => entry.type === notebooksYjs.wsType.replayReady));
    return {
      sent,
      closed,
      publish: (payload: string) => message(notebooksYjs.wsType.awarenessPublish, { payload }),
      close: async () => handlers.onClose?.(new CloseEvent("close"), socket),
    };
  };
  const payload = (state: Record<string, unknown> | null, clientId = 42) => {
    const doc = new Y.Doc();
    doc.clientID = clientId;
    const awareness = new Awareness(doc);
    try {
      awareness.setLocalState(state);
      return encoding.toBase64(encodeAwarenessUpdate(awareness, [clientId]));
    } finally {
      awareness.destroy();
      doc.destroy();
    }
  };
  const observerDoc = new Y.Doc();
  const observer = new Awareness(observerDoc);
  observer.setLocalState(null);
  const applyPublished = () => {
    for (const update of published) applyAwarenessUpdate(observer, encoding.fromBase64(update.payload), "remote");
  };

  test("server identity, isolated IDs, own removals, reconnect and read authorization at the socket seam", async () => {
    const first = await open();
    const second = await open();
    const sockets = [first, second];
    try {
      const peer = first.sent.find((entry) => entry.type === notebooksYjs.wsType.replayReady)?.payload.peerId;
      expect(typeof peer).toBe("string");
      const cursor = {
        anchor: { tname: "codemirror", item: { client: 99, clock: 1 }, assoc: 0 },
        head: { tname: "codemirror", assoc: -1 },
      };
      await first.publish(payload({ user: { name: "Forged", color: "red", userId: "victim" }, cursor }));
      await waitFor(() => published.length === 2);
      applyPublished();
      const victimId = [...observer.getStates().keys()][0]!;
      expect(victimId).toBe(2 ** 32 + 1);
      expect(observer.getStates().get(victimId)).toEqual({
        user: { userId: "alice", name: "Alice", color: getNotebookPresenceColor("alice") },
        writerId: 42,
        cursor,
      });
      await waitFor(() =>
        second.sent.some(
          (entry) =>
            entry.type === notebooksYjs.wsType.awarenessPush &&
            entry.payload.updates?.some((entry) => entry.originPeerId === peer && entry.payload !== "AA=="),
        ),
      );
      await second.publish(payload(null, victimId));
      await waitFor(() => published.length === 4);
      applyPublished();
      expect(observer.getStates().has(victimId)).toBe(true);
      await second.publish(payload({ cursor: null }, victimId));
      await waitFor(() => published.length === 5);
      applyPublished();
      const secondId = [...observer.getStates().keys()].find((id) => id !== victimId)!;
      expect(secondId).toBe(2 ** 32 + 3);
      await second.publish(payload(null, 42));
      await waitFor(() => second.sent.some((entry) => entry.payload.code === "INVALID_PAYLOAD"));
      expect(published).toHaveLength(5);
      await second.publish(payload(null, victimId));
      await waitFor(() => published.length === 6);
      applyPublished();
      expect(observer.getStates().has(secondId)).toBe(false);
      expect(observer.getStates().has(victimId)).toBe(true);
      await first.close();
      expect(published).toHaveLength(7);
      applyPublished();
      expect(observer.getStates().size).toBe(0);
      const reconnect = await open();
      sockets.push(reconnect);
      await reconnect.publish(payload({}));
      await waitFor(() => published.length === 9);
      applyPublished();
      expect([...observer.getStates().keys()]).toEqual([2 ** 32 + 8]);
      permission = "none";
      await reconnect.publish(payload({}));
      await waitFor(() => reconnect.closed.length > 0);
      expect(reconnect.sent.some((entry) => entry.payload.code === "ACCESS_REVOKED")).toBe(true);
      applyPublished();
      expect(observer.getStates().size).toBe(0);
    } finally {
      permission = "write";
      for (const socket of sockets) await socket.close();
      observer.destroy();
      observerDoc.destroy();
    }
  });

  test("malformed awareness is explicit and session expiry closes before publication", async () => {
    const socket = await open();
    try {
      const initialPublications = published.length;
      const original = encoding.fromBase64(payload({}));
      const multiple = new Uint8Array(original);
      multiple[0] = 2;
      for (const bytes of [
        multiple,
        original.slice(0, -1),
        new Uint8Array([...original, 0]),
        encoding.fromBase64(payload({ extra: "refused" })),
        ...["foreign-one", "foreign-two", "foreign-three"].map((tname) => {
          const at = { tname, type: null, item: null, assoc: 0 };
          return encoding.fromBase64(payload({ cursor: { anchor: at, head: at } }));
        }),
      ]) {
        const errors = socket.sent.filter((entry) => entry.payload.code === "INVALID_PAYLOAD").length;
        await socket.publish(encoding.toBase64(bytes));
        await waitFor(() => socket.sent.filter((entry) => entry.payload.code === "INVALID_PAYLOAD").length === errors + 1);
      }
      // Only the empty broker reservation was emitted, never invalid state.
      expect(published.slice(initialPublications).map((entry) => entry.payload)).toEqual(["AA=="]);
      const before = published.length;
      authenticated = false;
      await socket.publish(payload({}));
      await waitFor(() => socket.closed.length > 0);
      expect(published).toHaveLength(before);
      expect(socket.sent.some((entry) => entry.payload.code === "SESSION_EXPIRED")).toBe(true);
    } finally {
      authenticated = true;
      await socket.close();
    }
  });
  test("reservation failures stop visibly instead of accepting an unbound cursor", async () => {
    const socket = await open();
    try {
      const before = published.length;
      reservationFailure = new Error("Broker unavailable");
      await socket.publish(payload({}));
      await waitFor(() => socket.closed.length > 0);
      expect(socket.sent.some((entry) => entry.payload.code === "INTERNAL_ERROR")).toBe(true);
      expect(published).toHaveLength(before);
    } finally {
      reservationFailure = null;
      await socket.close();
    }
  });
}
