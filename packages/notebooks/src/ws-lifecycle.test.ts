import { expect, mock, test } from "bun:test";
import { RetentionGapError } from "@k2b/sync";
import type { Context } from "hono";
import { WSContext, type WSEvents } from "hono/ws";

// Keep the transport/module fixture inside its own process so package-wide
// test runs never replace the real application modules used by other suites.
if (process.env.NOTEBOOKS_WS_LIFECYCLE_CHILD !== "1") {
  test("WebSocket shutdown preserves accepted writes and retries failed final snapshots", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, NOTEBOOKS_WS_LIFECYCLE_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, output: code === 0 ? "passed" : `${stdout}\n${stderr}` }).toEqual({ code: 0, output: "passed" });
  }, 60_000);
} else {
  const published = Promise.withResolvers<{ cursor: string }>();
  const publishEntered = Promise.withResolvers<void>();
  const queued = Promise.withResolvers<void>();
  const queueEntered = Promise.withResolvers<void>();
  const replayReady = Promise.withResolvers<void>();
  const snapshots: unknown[] = [];
  const subscribedAfter: string[] = [];
  const adoptions: unknown[] = [];
  const replayGap = { head: null as string | null, gapBelow: null as string | null, failure: null as Error | null };
  let events: WSEvents | undefined;
  const waitUntilAborted = async function* (config: { signal?: AbortSignal }) {
    if (!config.signal?.aborted)
      await new Promise<void>((resolve) => config.signal?.addEventListener("abort", () => resolve(), { once: true }));
  };
  const note = { id: "test-note", notebookId: "test-notebook", lockedAt: null };
  mock.module("@valentinkolb/cloud/server", () => ({
    getLocale: () => "en",
    auth: {
      session: { getToken: () => "session", authenticate: async () => ({ user: { id: "user", displayName: "User", avatarHash: null } }) },
    },
  }));
  mock.module("@valentinkolb/cloud/services", () => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  }));
  mock.module("hono/bun", () => ({
    upgradeWebSocket: (factory: (context: Context) => WSEvents) => (context: Context) => {
      events = factory(context);
      return new Response("fixture");
    },
  }));
  mock.module("./service", () => ({
    notebooksService: {
      note: {
        getByShortId: async () => note,
        get: async () => note,
        getYjsStateWithCursor: async () => ({
          yjsState: new Uint8Array([0, 0]),
          streamCursor: "s6t.fixture.9",
          restoreRevision: "0",
          contentMd: null,
        }),
        adoptSnapshotAtHead: async (input: { noteId: string; cause: RetentionGapError }) => {
          adoptions.push({ noteId: input.noteId, requested: input.cause.requested });
          return { cursor: "s6t.fixture.20" };
        },
      },
      notebook: { permission: { get: async () => "write" } },
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
    toBase64: () => "",
    isValidYjsUpdate: () => true,
    maxStreamCursor: (_previous: string | null, next: string) => next,
    createYjsTopic: () => ({
      latestCursor: async () => replayGap.head,
      cursorAt: () => "s6t.fixture.0",
      replay: async function* (config: { after: string }) {
        if (replayGap.failure) throw replayGap.failure;
        if (config.after === replayGap.gapBelow) throw new RetentionGapError(config.after, "s6t.fixture.15", "s6t.fixture.14");
      },
      hub: () => ({
        subscribe: (config: { after: string; signal?: AbortSignal }) => {
          subscribedAfter.push(config.after);
          return waitUntilAborted(config);
        },
      }),
      publish: async () => {
        publishEntered.resolve();
        return published.promise;
      },
    }),
    createYjsAwarenessTopic: () => ({ live: waitUntilAborted }),
  }));
  mock.module("./service/yjs-snapshot-worker", () => ({
    yjsSnapshotWorker: {
      queueSnapshotSave: async (input: unknown) => {
        snapshots.push(input);
        queueEntered.resolve();
        await queued.promise;
        if (snapshots.length === 1) throw new Error("Snapshot enqueue unavailable");
      },
    },
  }));

  const { default: app, drainNotebookConnections } = await import("./ws");

  const openSocket = async () => {
    await app.request("/");
    const handlers = events!;
    const sent: Array<{ type: string; payload: { code?: string } }> = [];
    const closed = Promise.withResolvers<number>();
    const raw = {
      send: (data: string) => sent.push(JSON.parse(data)),
      close: (code: number) => {
        closed.resolve(code);
        void handlers.onClose?.(new CloseEvent("close"), socket);
      },
    };
    const socket = new WSContext({ raw, readyState: 1, send: () => {}, close: () => {} });
    handlers.onOpen?.(new Event("open"), socket);
    const request = (fromCursor?: string) =>
      handlers.onMessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "notes.yjs.replay.request", payload: { noteId: "abcdef", fromCursor } }),
        }),
        socket,
      );
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 5_000;
      while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
      expect(predicate()).toBe(true);
    };
    return { sent, closed, request, waitFor };
  };

  test("a recovered stored snapshot requires a fresh client base before live subscription", async () => {
    replayGap.head = "s6t.fixture.19";
    replayGap.gapBelow = "s6t.fixture.9";
    subscribedAfter.length = 0;
    const socket = await openSocket();
    socket.request();
    expect(await socket.closed.promise).toBe(1012);
    expect(adoptions).toEqual([{ noteId: "test-note", requested: "s6t.fixture.9" }]);
    expect(subscribedAfter).toEqual([]);
    expect(socket.sent.filter((message) => message.type === "notes.yjs.error").map((message) => message.payload.code)).toEqual([
      "RESYNC_REQUIRED",
    ]);
  }, 10_000);

  test("a client cursor below retention resyncs from the stored snapshot without re-anchoring", async () => {
    replayGap.head = "s6t.fixture.19";
    replayGap.gapBelow = "s6t.fixture.3";
    adoptions.length = 0;
    const socket = await openSocket();
    socket.request("s6t.fixture.3");
    expect(await socket.closed.promise).toBe(1012);
    expect(socket.sent.filter((message) => message.type === "notes.yjs.error").map((message) => message.payload.code)).toEqual([
      "RESYNC_REQUIRED",
    ]);
    expect(adoptions).toEqual([]);
  }, 10_000);

  test("a transient stream failure closes without demanding a resync so the client keeps its cursor", async () => {
    replayGap.head = "s6t.fixture.19";
    replayGap.gapBelow = null;
    replayGap.failure = new Error("broker unavailable");
    adoptions.length = 0;
    const socket = await openSocket();
    socket.request("s6t.fixture.12");
    expect(await socket.closed.promise).toBe(1012);
    expect(socket.sent.filter((message) => message.type === "notes.yjs.error").map((message) => message.payload.code)).toEqual([
      "STREAM_FAILED",
    ]);
    expect(adoptions).toEqual([]);
  }, 10_000);

  test("shutdown waits for accepted edits and unload snapshots even after remote close begins", async () => {
    replayGap.head = null;
    replayGap.gapBelow = null;
    replayGap.failure = null;
    subscribedAfter.length = 0;
    await app.request("/");
    const handlers = events!;
    let closes = 0;
    const raw = {
      send: (data: string) => {
        if (JSON.parse(data).type === "notes.yjs.replay.ready") replayReady.resolve();
      },
      close: () => {
        closes++;
        void handlers.onClose?.(new CloseEvent("close"), socket);
      },
    };
    const socket = new WSContext({ raw, readyState: 1, send: () => {}, close: () => {} });
    handlers.onOpen?.(new Event("open"), socket);
    handlers.onMessage?.(
      new MessageEvent("message", { data: JSON.stringify({ type: "notes.yjs.replay.request", payload: { noteId: "abcdef" } }) }),
      socket,
    );
    await replayReady.promise;
    expect(subscribedAfter).toEqual(["s6t.fixture.9"]);
    handlers.onMessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "notes.yjs.sync.publish", payload: { noteId: "abcdef", payload: "AAA=" } }),
      }),
      socket,
    );
    await publishEntered.promise;
    const remoteClose = Promise.resolve(handlers.onClose?.(new CloseEvent("close"), socket)).catch((error: unknown) => error);
    let drained = false;
    const drain = drainNotebookConnections().then(() => {
      drained = true;
    });
    await Bun.sleep(10);
    expect(drained).toBe(false);
    published.resolve({ cursor: "s6t.fixture.10" });
    await queueEntered.promise;
    expect(snapshots).toEqual([{ noteId: "test-note", targetCursor: "s6t.fixture.10", reason: "unload" }]);
    expect(drained).toBe(false);
    queued.resolve();
    expect(await remoteClose).toBeInstanceOf(Error);
    expect(drained).toBe(false);
    await drain;
    expect(snapshots).toHaveLength(2);
    expect(closes).toBe(1);
  }, 60_000);
}
