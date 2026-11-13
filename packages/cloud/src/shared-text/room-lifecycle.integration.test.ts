import { expect, setSystemTime, spyOn } from "bun:test";
import { ConflictError, createSync, type Lock, type MutexConfig, type Sync, type TopicConfig } from "@k2b/sync";
import { jetstreamManager } from "@nats-io/jetstream";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import { z } from "zod";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { connectTestNats, testFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import { bindProcessSync, unbindProcessSync } from "../_internal/process-sync";
import { sql as platformSql } from "../runtime/clients";
import {
  compareStreamCursor,
  createSharedTextRoom,
  createSharedTextRoomContext,
  SHARED_TEXT_NAME,
  sharedText,
  sharedTextSnapshotJobConfig,
  toBase64,
} from "./index";
import type { SharedTextRoomMessages, SharedTextRoomSnapshot } from "./room";
import { RoomWriterBase } from "./room-base";
import { createRoomLifecycle } from "./room-lifecycle";

const NOW = new Date("2026-11-12T12:00:00Z");
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
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

testFor("nats")("a failed freeze save immediately admits remote edits and permits a new freeze", async () => {
  setSystemTime(NOW);
  const connection = await connectTestNats();
  const namespace = testSyncNamespace("text-freeze-save-failure");
  const sync = createSync({ connection, namespace, application: "test", defaults: { replicas: 1 } });
  bindProcessSync(sync, connection);
  const log = sharedText.define({
    id: "text",
    lifecycle: { maxBytes: 65536 },
    whenFull: "reject",
    retention: { maxBytes: 1024 * 1024 },
    maxPayloadBytes: 8192,
  });
  const remoteLog = sharedText.define({ ...log.topicConfig, lifecycle: { maxBytes: 65536 } });
  let stored: SharedTextRoomSnapshot = { state: new Uint8Array([0, 0]), text: "", restoreRevision: "0", cursor: log.topic().cursorAt(0) };
  let failSave = true;
  let saveAttempts = 0;
  const pipeline = sharedText.snapshots({
    log,
    logger: quiet,
    job: () => sync.job(sharedTextSnapshotJobConfig({ id: "snapshots", retention: { maxAgeMs: 86_400_000, maxBytes: 1024 * 1024 } })),
    store: {
      list: async () => [],
      load: async () => stored,
      save: async (_id, input) => {
        saveAttempts++;
        if (failSave) throw new Error("app save refused");
        stored = input;
      },
      recover: async () => {
        throw new Error("Unexpected gap");
      },
      advance: async () => false,
    },
  });
  const lifecycle = createRoomLifecycle({ log, load: async () => stored, flushNow: pipeline.flushNow });
  const documents = remoteLog.withStore({
    load: async () => {
      throw new Error("Admission must not load the store");
    },
    save: async () => {
      throw new Error("Admission must not save the store");
    },
  });
  const source = new Y.Doc();
  source.clientID = 42;
  const edit = async (text: string) => {
    const vector = Y.encodeStateVector(source);
    source.getText(SHARED_TEXT_NAME).insert(source.getText(SHARED_TEXT_NAME).length, text);
    return documents.accept("doc", {
      snapshot: stored,
      actor: { kind: "user", id: "editor" },
      update: Y.encodeStateAsUpdate(source, vector),
      baseCursor: stored.cursor,
      restoreRevision: "0",
      originNodeId: "remote",
      originPeerId: "editor",
    });
  };
  try {
    expect(await edit("before")).toMatchObject({ status: "accepted" });
    await expect(lifecycle.freeze("doc")).rejects.toThrow("app save refused");
    expect(saveAttempts).toBe(1);
    expect((await remoteLog.lifecycle!.get("doc"))?.value.state).toBe("open");
    expect(await edit(" after")).toMatchObject({ status: "accepted" });
    failSave = false;
    const frozen = await lifecycle.freeze("doc");
    expect(frozen?.text).toBe("before after");
    expect(frozen?.state).toEqual(stored.state!);
    expect(stored.cursor).toBe(frozen!.cursor);
    expect(saveAttempts).toBe(2);
  } finally {
    source.destroy();
    await pipeline.stop();
    setSystemTime();
    await sync.drain();
    unbindProcessSync();
    const manager = await jetstreamManager(connection);
    for await (const stream of manager.streams.list())
      if (stream.config.metadata?.["sync.namespace"] === namespace) await manager.streams.delete(stream.config.name);
    await connection.drain();
  }
});

testFor("database", "nats")(
  "three concurrent editors in two rooms serialize publication, freeze and drain exactly, thaw, recover a crashed freeze, and close",
  async () => {
    const meter = await meterSql();
    setSystemTime(NOW);
    const connection = await connectTestNats();
    const namespace = testSyncNamespace("text-room-lifecycle");
    const sync = createSync({ connection, namespace, application: "test", defaults: { replicas: 1 } });
    const attempts = new Map<string, number>();
    const measured: Sync = {
      ...sync,
      topic<T>(config: TopicConfig) {
        const topic = sync.topic<T>(config);
        return {
          ...topic,
          publish: async (input: Parameters<typeof topic.publish>[0]) => {
            const data = input.data;
            if (
              data &&
              typeof data === "object" &&
              "kind" in data &&
              data.kind === "sync" &&
              "payload" in data &&
              typeof data.payload === "string"
            )
              attempts.set(data.payload, (attempts.get(data.payload) ?? 0) + 1);
            return topic.publish(input);
          },
        };
      },
    };
    bindProcessSync(measured, connection);
    const log = sharedText.define({
      id: "text",
      lifecycle: { maxBytes: 65536 },
      whenFull: "reject",
      retention: { maxBytes: 1024 * 1024 },
      maxPayloadBytes: 8192,
      deadLetterRetention: { maxAgeMs: 86_400_000, maxBytes: 65536 },
    });
    let stored: SharedTextRoomSnapshot = { state: new Uint8Array([0, 0]), text: "", restoreRevision: "0", cursor: log.topic().cursorAt(0) };
    let sql = 0;
    const pipeline = sharedText.snapshots({
      log,
      logger: quiet,
      job: () => sync.job(sharedTextSnapshotJobConfig({ id: "snapshots", retention: { maxAgeMs: 86_400_000, maxBytes: 1024 * 1024 } })),
      store: {
        load: async () => {
          sql++;
          return stored;
        },
        save: async (_id, input) => {
          sql++;
          if (!stored.cursor || compareStreamCursor(input.cursor, stored.cursor) > 0) stored = input;
        },
        list: async () => [],
        recover: async () => {
          throw new Error("Unexpected gap");
        },
        advance: async () => false,
      },
    });
    const validatedContexts: unknown[] = [];
    const encodedContexts: unknown[] = [];
    let holdValidation: Promise<void> | undefined;
    const entered = Promise.withResolvers<void>();
    const makeRoom = (roomLog = log) =>
      createSharedTextRoom({
        logger: quiet,
        log: roomLog,
        snapshots: { queue: async () => {}, flushNow: pipeline.flushNow },
        awarenessTopic: () =>
          sync.topic({ id: "awareness", retention: { maxAgeMs: 60_000, maxBytes: 65536 }, dedupeWindowMs: 60_000, maxPayloadBytes: 8192 }),
        protocol: {
          wsType: {
            replayRequest: "replay",
            replayReady: "ready",
            syncPublish: "edit",
            syncPush: "push",
            awarenessPublish: "cursor",
            awarenessPush: "awareness",
            error: "error",
          },
          documentId: z.string(),
          maxSyncPayloadLength: 8192,
          streamCursorPattern: /^s6t\./,
          decode: (x) => x,
          encode: (type, payload, ctx) => {
            encodedContexts.push(ctx);
            return { type, payload };
          },
        },
        validateState: async (_state, ctx) => {
          validatedContexts.push(ctx);
          if (holdValidation) {
            entered.resolve();
            await holdValidation;
          }
          return true;
        },
        adapter: {
          authenticate: async () => {
            sql++;
            return { id: "user" };
          },
          authorize: async () => {
            sql++;
            return { ok: true, resolvedDocId: "doc", canWrite: true };
          },
          load: async () => {
            sql++;
            return stored;
          },
          actor: (user) => ({ kind: "user", id: user.id }),
          awarenessUser: (user) => ({ userId: user.id, name: "User", color: "#fff" }),
          revalidate: async () => ({ ok: true, canWrite: true }),
          recover: async () => {
            throw new Error("Unexpected gap");
          },
        },
      });
    const activity = new Set<() => void>();
    const until = async (check: () => boolean) => {
      const signal = AbortSignal.timeout(10_000);
      while (!check()) {
        signal.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const done = () => {
            activity.delete(wake);
            signal.removeEventListener("abort", abort);
          };
          const wake = () => {
            done();
            resolve();
          };
          const abort = () => {
            done();
            reject(signal.reason);
          };
          activity.add(wake);
          signal.addEventListener("abort", abort, { once: true });
          if (check()) wake();
        });
      }
    };
    const a = makeRoom(),
      b = makeRoom(sharedText.define({ ...log.topicConfig, lifecycle: { maxBytes: 65536 } }));
    const peers: Array<ReturnType<typeof peer>> = [];
    const peer = async (room: typeof a) => {
      const ready = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<string>();
      const packets: Array<{ type: string; payload?: { code?: string; updates?: Array<{ payload: string; cursor?: string }> } }> = [];
      const ctx = createSharedTextRoomContext<{ id: string }, SharedTextRoomMessages>(
        {
          send: (raw) => {
            const packet = JSON.parse(raw);
            packets.push(packet);
            if (packet.type === "ready") ready.resolve();
            for (const wake of activity) wake();
          },
          close: (_code, reason) => closed.resolve(reason),
        },
        "credential",
        messages,
      );
      const connection = room.connect(ctx);
      await room.handle(ctx, { type: "replay", payload: { docId: "doc", restoreRevision: "0" } });
      await Promise.race([ready.promise, closed.promise]);
      return { room, ctx, connection, packets, closed: closed.promise };
    };
    const doc = new Y.Doc();
    doc.clientID = 42;
    const update = (text: string) => {
      const vector = Y.encodeStateVector(doc);
      doc.getText(SHARED_TEXT_NAME).insert(doc.getText(SHARED_TEXT_NAME).length, text);
      return toBase64(Y.encodeStateAsUpdate(doc, vector));
    };
    const edit = async (p: Awaited<ReturnType<typeof peer>>, payload: string) =>
      p.room.handle(p.ctx, {
        type: "edit",
        payload: {
          docId: "doc",
          payload,
          baseCursor: (await log.topic().latestCursor({ tenantId: "doc" })) ?? stored.cursor,
          restoreRevision: "0",
        },
      });
    try {
      const remote = await peer(b);
      peers.push(Promise.resolve(remote));
      const other = await peer(a),
        third = await peer(b);
      peers.push(Promise.resolve(other), Promise.resolve(third));
      const writers = [remote, other, third];
      // Verify that the meter observes the platform SQL handle before measuring
      // the fake adapter's edit, receiving delivery, and awareness paths.
      expect(
        await meter.during(async () => {
          await platformSql`SELECT 1`;
        }),
      ).toHaveLength(1);
      const sources = writers.map((_, index) => {
        const doc = new Y.Doc();
        doc.clientID = index + 100;
        return doc;
      });
      const tokens: string[] = [];
      try {
        const editAndDeliveryStatements = await meter.during(async () => {
          for (let turn = 0; turn < 10; turn++)
            await Promise.all(
              writers.map(async (writer, index) => {
                const source = sources[index]!;
                const token = `[${index}:${turn}]`;
                tokens.push(token);
                const vector = Y.encodeStateVector(source);
                source.getText(SHARED_TEXT_NAME).insert(source.getText(SHARED_TEXT_NAME).length, token);
                await edit(writer, toBase64(Y.encodeStateAsUpdate(source, vector)));
              }),
            );
          const head = await log.topic().latestCursor({ tenantId: "doc" });
          await until(() =>
            writers.every((writer) =>
              writer.packets.some((packet) => packet.type === "push" && packet.payload?.updates?.some((update) => update.cursor === head)),
            ),
          );
        });
        expect(editAndDeliveryStatements).toEqual([]);
        const awarenessCount = (writer: typeof remote) =>
          writer.packets.filter(
            (packet) => packet.type === "awareness" && packet.payload?.updates?.some((update) => update.payload !== "AA=="),
          ).length;
        const awarenessStatements = await meter.during(async () => {
          for (let index = 0; index < 2; index++) {
            const counts = writers.map(awarenessCount);
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, 1);
            encoding.writeVarUint(encoder, 42);
            encoding.writeVarUint(encoder, index + 1);
            const at = Y.createRelativePositionFromTypeIndex(sources[0]!.getText(SHARED_TEXT_NAME), index);
            encoding.writeVarString(encoder, JSON.stringify({ cursor: { anchor: at, head: at } }));
            await a.handle(other.ctx, { type: "cursor", payload: { docId: "doc", payload: toBase64(encoding.toUint8Array(encoder)) } });
            await until(() => writers.every((writer, position) => awarenessCount(writer) > counts[position]!));
          }
        });
        expect(awarenessStatements).toEqual([]);
        expect(attempts.size).toBe(30);
        for (const writer of writers) {
          expect(validatedContexts).toContain(writer.ctx);
          expect(encodedContexts).toContain(writer.ctx);
        }
        expect(Math.max(...attempts.values())).toBe(1);
        const drained = await a.freeze("doc");
        for (const token of tokens) expect(drained!.text.split(token)).toHaveLength(2);
        Y.applyUpdate(doc, drained!.state);
        await a.thaw("doc", { freezeCursor: drained!.cursor });
      } finally {
        for (const source of sources) source.destroy();
      }
      const prefix = doc.getText(SHARED_TEXT_NAME).toString();
      const baseline = sql;
      await edit(remote, update("visible"));
      expect(sql).toBe(baseline);
      const accepted = await log.topic().latestCursor({ tenantId: "doc" });
      const release = Promise.withResolvers<void>();
      holdValidation = release.promise;
      const pendingInput = update(" pending");
      const inFlight = edit(remote, pendingInput);
      await entered.promise;
      const freezing = a.freeze("doc");
      release.resolve();
      holdValidation = undefined;
      await inFlight;
      const frozen = await freezing;
      expect(frozen?.text).toBe(`${prefix}visible pending`);
      const documents = log.withStore({
        load: async () => stored,
        save: async () => {
          throw new Error("Frozen document must not save");
        },
      });
      await expect(
        documents.freeze("doc", { actor: { kind: "user", id: "user" }, restoreRevision: "0", validate: async () => {} }),
      ).rejects.toThrow("DOCUMENT_FROZEN");
      expect(await documents.edit("doc", { actor: null }, () => "must not publish")).toMatchObject({
        status: "syncFailed",
        error: { code: "DOCUMENT_FROZEN" },
      });
      expect(frozen?.cursor).not.toBe(accepted);
      expect((await pipeline.flushNow("doc"))?.state).toEqual(frozen!.state);
      const persisted = new Y.Doc();
      try {
        Y.applyUpdate(persisted, frozen!.state);
        expect(persisted.getText(SHARED_TEXT_NAME).toString()).toBe(`${prefix}visible pending`);
      } finally {
        persisted.destroy();
      }
      expect(await log.topic().latestCursor({ tenantId: "doc" })).toBe(frozen!.cursor);
      await log.topic().prune({ through: frozen!.cursor });
      expect(await log.topic().latestCursor({ tenantId: "doc" })).toBeNull();
      const rejectedInput = update(" after");
      const later = await peer(b);
      peers.push(Promise.resolve(later));
      const unchanged = sql;
      await edit(later, rejectedInput);
      expect(await later.closed).toBe("DOCUMENT_FROZEN");
      expect(await log.topic().latestCursor({ tenantId: "doc" })).toBeNull();
      expect(sql).toBe(unchanged);
      await a.thaw("doc", { freezeCursor: frozen!.cursor });
      const resumed = await peer(b);
      peers.push(Promise.resolve(resumed));
      await edit(resumed, rejectedInput);
      expect(await log.topic().latestCursor({ tenantId: "doc" })).not.toBe(frozen!.cursor);
      const secondFreeze = await a.freeze("doc");
      expect(secondFreeze?.text).toBe(`${prefix}visible pending after`);
      await a.drain(); // Crash equivalent: no thaw or renewal; the marker remains broker-owned.
      setSystemTime(new Date(NOW.getTime() + 60_001));
      await edit(resumed, update(" recovered"));
      const recovered = await b.freeze("doc");
      expect(recovered?.text).toBe(`${prefix}visible pending after recovered`);
      await expect(b.thaw("doc", { freezeCursor: secondFreeze!.cursor })).rejects.toThrow();
      // App commit durably records this token. The submitting process then dies
      // before close; another process can retry after the lease without edits.
      setSystemTime(new Date(Date.now() + 60_001));
      const freshLog = sharedText.define({ ...log.topicConfig, lifecycle: { maxBytes: 65536 } });
      const restarted = makeRoom(freshLog);
      const closedCursor = await restarted.closeDocument("doc", { freezeCursor: recovered!.cursor });
      expect(await restarted.closeDocument("doc", { freezeCursor: recovered!.cursor })).toBe(closedCursor);
      await expect(restarted.closeDocument("doc", { freezeCursor: secondFreeze!.cursor })).rejects.toThrow();
      expect(await resumed.closed).toBe("DOCUMENT_CLOSED");
      // Persist the terminal marker too: the next join must close even when
      // replay starts at a snapshot that already covers that marker.
      await pipeline.flushNow("doc");
      await log.topic().prune({ through: closedCursor! });
      expect(await log.topic().latestCursor({ tenantId: "doc" })).toBeNull();
      expect((await freshLog.lifecycle!.get("doc"))?.value.state).toBe("closed");
      await expect(freshLog.lifecycle!.put("doc", null, { state: "open" })).rejects.toThrow("Shared text lifecycle changed");
      const manager = await jetstreamManager(connection);
      const authorityStreams = [];
      for await (const stream of manager.streams.list())
        if (stream.config.metadata?.["cloud.shared-text.lifecycle"] === log.id && stream.config.metadata?.["sync.namespace"] === namespace)
          authorityStreams.push(stream);
      expect(authorityStreams).toHaveLength(1);
      expect(authorityStreams[0]!.state.messages).toBe(1);
      expect(await restarted.closeDocument("doc", { freezeCursor: recovered!.cursor })).toBe(closedCursor);
      await expect(restarted.thaw("doc", { freezeCursor: recovered!.cursor })).rejects.toThrow("DOCUMENT_CLOSED");
      await restarted.drain();
      const rejected = await peer(b);
      peers.push(Promise.resolve(rejected));
      expect(await rejected.closed).toBe("DOCUMENT_CLOSED");
      await edit(rejected, update(" never"));
      expect(await rejected.closed).toBe("DOCUMENT_CLOSED");
      expect((await pipeline.flushNow("doc"))?.text).toBe(`${prefix}visible pending after recovered`);
    } finally {
      holdValidation = undefined;
      entered.resolve();
      await Promise.all((await Promise.all(peers)).map((p) => p.connection.close()));
      await Promise.all([a.drain(), b.drain(), pipeline.stop()]);
      doc.destroy();
      setSystemTime();
      await sync.drain();
      unbindProcessSync();
      const manager = await jetstreamManager(connection);
      for await (const stream of manager.streams.list())
        if (stream.config.metadata?.["sync.namespace"] === namespace) await manager.streams.delete(stream.config.name);
      await connection.drain();
      await meter.close();
    }
  },
  30_000,
);

for (const abandoned of [false, true])
  testFor("nats")(
    `a publication stalled across ${abandoned ? "abandoned admission" : "lease loss"}, freeze and prune is retained but never acknowledged`,
    async () => {
      setSystemTime(NOW);
      const connection = await connectTestNats();
      const namespace = testSyncNamespace("text-room-prune-aba");
      const sync = createSync({ connection, namespace, application: "test", defaults: { replicas: 1 } });
      const publishing = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const checking = Promise.withResolvers<void>();
      const offered = Promise.withResolvers<void>();
      const confirm = Promise.withResolvers<void>();
      const abandon = Promise.withResolvers<never>();
      const publicationFinished = Promise.withResolvers<void>();
      let stalled = false;
      let admission: { config: MutexConfig; lock: Lock } | undefined;
      const measured: Sync = {
        ...sync,
        mutex(config) {
          const mutex = sync.mutex(config);
          return {
            ...mutex,
            async withLock(input, run) {
              const lock = await mutex.acquire(input);
              if (!lock) return null;
              const first = config.id.endsWith(":admission") && !admission;
              if (config.id.endsWith(":admission")) admission = { config, lock };
              const running = run(lock);
              if (first) void running.finally(() => publicationFinished.resolve()).catch(() => {});
              try {
                return abandoned && first ? await Promise.race([running, abandon.promise]) : await running;
              } finally {
                await mutex.release(lock);
              }
            },
          };
        },
        topic<T>(config: TopicConfig) {
          const topic = sync.topic<T>(config);
          return {
            ...topic,
            hub(options) {
              const hub = topic.hub(options);
              return {
                ...hub,
                subscribe: async function* (input) {
                  for await (const event of hub.subscribe(input)) {
                    if (event.data && typeof event.data === "object" && "kind" in event.data && event.data.kind === "sync")
                      offered.resolve();
                    yield event;
                  }
                },
              };
            },
            async publish(input: Parameters<typeof topic.publish>[0]) {
              if (!stalled && input.data && typeof input.data === "object" && "kind" in input.data && input.data.kind === "sync") {
                stalled = true;
                publishing.resolve();
                await resume.promise;
              }
              return topic.publish(input);
            },
          };
        },
      };
      bindProcessSync(measured, connection);
      const declaration = {
        id: "text",
        lifecycle: { maxBytes: 65536 },
        whenFull: "reject",
        retention: { maxBytes: 4 * 1024 * 1024 },
        maxPayloadBytes: 1024 * 1024,
      } as const;
      const log = sharedText.define(declaration);
      const otherLog = sharedText.define(declaration);
      let stored: SharedTextRoomSnapshot = {
        state: new Uint8Array([0, 0]),
        text: "",
        cursor: log.topic().cursorAt(0),
        restoreRevision: "0",
      };
      const pipeline = sharedText.snapshots({
        log,
        logger: quiet,
        job: () => sync.job(sharedTextSnapshotJobConfig({ id: "snapshots", retention: { maxAgeMs: 86_400_000, maxBytes: 65536 } })),
        store: {
          load: async () => stored,
          save: async (_id, input) => {
            stored = input;
          },
          list: async () => [],
          advance: async () => false,
          recover: async () => {
            throw new Error("Unexpected gap");
          },
        },
      });
      let pausePostcheck = false;
      const get = log.lifecycle!.get;
      log.lifecycle!.get = async (id) => {
        const entry = await get(id);
        if (pausePostcheck && entry?.value.state === "frozen") {
          checking.resolve();
          await confirm.promise;
        }
        return entry;
      };
      const makeRoom = (roomLog: typeof log) =>
        createSharedTextRoom({
          logger: quiet,
          log: roomLog,
          snapshots: { queue: async () => {}, flushNow: pipeline.flushNow },
          awarenessTopic: () => sync.topic({ id: "awareness", retention: { maxAgeMs: 60000, maxBytes: 65536 }, dedupeWindowMs: 60000 }),
          protocol: {
            wsType: {
              replayRequest: "replay",
              replayReady: "ready",
              syncPublish: "edit",
              syncPush: "push",
              awarenessPublish: "cursor",
              awarenessPush: "awareness",
              error: "error",
            },
            documentId: z.string(),
            maxSyncPayloadLength: 1024 * 1024,
            streamCursorPattern: /^s6t\./,
            decode: (x) => x,
            encode: (type, payload) => ({ type, payload }),
          },
          adapter: {
            authenticate: async () => ({ id: "user" }),
            authorize: async () => ({ ok: true, resolvedDocId: "doc", canWrite: true }),
            load: async () => stored,
            actor: (user) => ({ kind: "user", id: user.id }),
            awarenessUser: (user) => ({ userId: user.id, name: "User", color: "#fff" }),
            revalidate: async () => ({ ok: true, canWrite: true }),
            recover: async () => {
              throw new Error("Unexpected gap");
            },
          },
        });
      const a = makeRoom(log),
        b = makeRoom(otherLog);
      const ready = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<void>();
      const packets: Array<{ type: string; payload?: { code?: string } }> = [];
      const ctx = createSharedTextRoomContext<{ id: string }, SharedTextRoomMessages>(
        {
          send: (raw) => {
            const packet = JSON.parse(raw);
            packets.push(packet);
            if (packet.type === "ready") ready.resolve();
          },
          close: () => closed.resolve(),
        },
        "credential",
        messages,
      );
      const peer = a.connect(ctx);
      const text = "late input".repeat(30000);
      const source = new Y.Doc();
      source.clientID = 99;
      let pending: Promise<unknown> | undefined;
      try {
        await a.handle(ctx, { type: "replay", payload: { docId: "doc", restoreRevision: "0" } });
        await Promise.race([
          ready.promise,
          closed.promise.then(() => {
            throw new Error("Room closed before ready");
          }),
        ]);
        source.getText(SHARED_TEXT_NAME).insert(0, text);
        pending = a.handle(ctx, {
          type: "edit",
          payload: { docId: "doc", restoreRevision: "0", baseCursor: stored.cursor, payload: toBase64(Y.encodeStateAsUpdate(source)) },
        });
        await publishing.promise;
        expect(admission).toBeDefined();
        // Expire this exact owner deterministically, without a wall-clock sleep.
        // The blocked publication is still in flight, just as after lease expiry.
        if (abandoned) {
          abandon.reject(new ConflictError("admission expired"));
          await pending;
          expect(packets.some((packet) => packet.payload?.code === "BUSY")).toBe(true);
        } else expect(await sync.mutex(admission!.config).release(admission!.lock)).toBe(true);
        const frozen = await b.freeze("doc");
        expect(frozen?.text).toBe("");
        await log.topic().prune({ through: frozen!.cursor });
        expect(await log.topic().latestCursor({ tenantId: "doc" })).toBeNull();
        pausePostcheck = true;
        resume.resolve();
        await checking.promise;
        await offered.promise;
        const late = await log.topic().latestCursor({ tenantId: "doc" });
        expect(late).not.toBeNull(); // NATS expected subject sequence zero matched again.
        // The broker may deliver before the post-check finishes; no echo can
        // acknowledge that event while admission is still unconfirmed.
        expect(packets.filter((packet) => packet.type === "push")).toHaveLength(1); // Initial snapshot only.
        confirm.resolve();
        await pending;
        await publicationFinished.promise;
        if (abandoned) {
          await a.handle(ctx, {
            type: "edit",
            payload: {
              docId: "doc",
              restoreRevision: "0",
              retry: true,
              baseCursor: stored.cursor,
              payload: toBase64(Y.encodeStateAsUpdate(source)),
            },
          });
        }
        await closed.promise;
        expect(packets.some((packet) => packet.type === "error" && packet.payload?.code === "DOCUMENT_FROZEN")).toBe(true);
        expect(packets.filter((packet) => packet.type === "push")).toHaveLength(1);
        pausePostcheck = false;
        expect((await pipeline.flushNow("doc"))?.text).toBe(text);
        await b.thaw("doc", { freezeCursor: frozen!.cursor });
        const drained = await b.freeze("doc");
        expect(drained!.text).toBe(text);
        expect(drained!.state).not.toEqual(frozen!.state);
      } finally {
        resume.resolve();
        confirm.resolve();
        await pending?.catch(() => {});
        await peer.close();
        await a.drain();
        await b.drain();
        await pipeline.stop();
        source.destroy();
        unbindProcessSync();
        await sync.drain();
        const manager = await jetstreamManager(connection);
        for await (const stream of manager.streams.list())
          if (stream.config.metadata?.["sync.namespace"] === namespace) await manager.streams.delete(stream.config.name);
        await connection.drain();
        setSystemTime();
      }
    },
    30_000,
  );

testFor("database", "nats")(
  "a publish finishing after admission timeout cannot replace another document's base with the same generation",
  async () => {
    setSystemTime(NOW);
    const connection = await connectTestNats();
    const namespace = testSyncNamespace("text-late-publish-owner");
    const sync = createSync({ connection, namespace, application: "test", defaults: { replicas: 1 } });
    const publishing = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    let operationA: Promise<unknown> | undefined;
    const measured: Sync = {
      ...sync,
      mutex(config) {
        const mutex = sync.mutex(config);
        return {
          ...mutex,
          async withLock(input, run) {
            const operation = mutex.withLock(input, run);
            if (!config.id.endsWith(":admission") || input.resource !== "A") return operation;
            // Retain the real lock/publication, but detach the waiting caller
            // when its real admission deadline expires, as in the stalled-owner harness.
            operationA = operation;
            const signal = input.signal!;
            const abandoned = Promise.withResolvers<never>();
            const abort = () => abandoned.reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
            void operation.finally(() => finished.resolve()).catch(() => {});
            try {
              return await Promise.race([operation, abandoned.promise]);
            } finally {
              signal.removeEventListener("abort", abort);
            }
          },
        };
      },
      topic<T>(config: TopicConfig) {
        const topic = sync.topic<T>(config);
        return {
          ...topic,
          async publish(input: Parameters<typeof topic.publish>[0]) {
            if (
              input.tenantId === "A" &&
              input.data &&
              typeof input.data === "object" &&
              "kind" in input.data &&
              input.data.kind === "sync"
            ) {
              publishing.resolve();
              await resume.promise;
            }
            return topic.publish(input);
          },
        };
      },
    };
    bindProcessSync(measured, connection);
    const log = sharedText.define({ id: "text", whenFull: "reject", retention: { maxBytes: 1_048_576 }, maxPayloadBytes: 8192 });
    const empty: SharedTextRoomSnapshot = {
      state: new Uint8Array([0, 0]),
      text: "",
      cursor: log.topic().cursorAt(0),
      restoreRevision: "0",
    };
    const room = createSharedTextRoom({
      logger: quiet,
      log,
      snapshots: { queue: async () => {}, flushNow: async () => empty },
      awarenessTopic: () => sync.topic({ id: "awareness", retention: { maxAgeMs: 60_000, maxBytes: 65536 }, dedupeWindowMs: 60_000 }),
      protocol: {
        wsType: {
          replayRequest: "replay",
          replayReady: "ready",
          syncPublish: "edit",
          syncPush: "push",
          awarenessPublish: "cursor",
          awarenessPush: "awareness",
          error: "error",
        },
        documentId: z.string(),
        maxSyncPayloadLength: 8192,
        streamCursorPattern: /^s6t\./,
        decode: (x) => x,
        encode: (type, payload) => ({ type, payload }),
      },
      adapter: {
        authenticate: async () => ({ id: "user" }),
        authorize: async (docId) => ({ ok: true, resolvedDocId: docId, canWrite: true }),
        load: async () => empty,
        actor: (user) => ({ kind: "user", id: user.id }),
        awarenessUser: (user) => ({ userId: user.id, name: "User", color: "#fff" }),
        revalidate: async () => ({ ok: true, canWrite: true }),
        recover: async () => {
          throw new Error("Unexpected gap");
        },
      },
    });
    let ready = Promise.withResolvers<void>();
    let pushed = Promise.withResolvers<void>();
    const packets: Array<{ type: string; payload?: { code?: string; docId?: string } }> = [];
    const ctx = createSharedTextRoomContext<{ id: string }, SharedTextRoomMessages>(
      {
        send(raw) {
          const packet = JSON.parse(raw);
          packets.push(packet);
          if (packet.type === "ready") ready.resolve();
          if (packet.type === "push" && packet.payload?.docId === "B") pushed.resolve();
        },
        close() {},
      },
      "credential",
      messages,
    );
    const peer = room.connect(ctx);
    let baseB: RoomWriterBase | undefined;
    const snapshot = RoomWriterBase.prototype.snapshot;
    const snapshots = spyOn(RoomWriterBase.prototype, "snapshot").mockImplementation(function (this: RoomWriterBase) {
      if (ctx.docId === "B") baseB = this;
      return snapshot.call(this);
    });
    const a = new Y.Doc(),
      b = new Y.Doc();
    a.clientID = 41;
    b.clientID = 42;
    const meter = await meterSql();
    let pending: Promise<unknown> | undefined;
    const edit = (docId: string, source: Y.Doc, text: string, baseCursor: string | null) => {
      const vector = Y.encodeStateVector(source);
      source.getText(SHARED_TEXT_NAME).insert(source.getText(SHARED_TEXT_NAME).length, text);
      return room.handle(ctx, {
        type: "edit",
        payload: { docId, restoreRevision: "0", baseCursor, payload: toBase64(Y.encodeStateAsUpdate(source, vector)) },
      });
    };
    try {
      await room.handle(ctx, { type: "replay", payload: { docId: "A", restoreRevision: "0" } });
      await ready.promise;
      pending = edit("A", a, "late A", empty.cursor);
      await publishing.promise;
      await pending; // The real five-second admission timeout leaves the publish in flight.
      expect(packets.some((packet) => packet.payload?.code === "BUSY")).toBe(true);
      ready = Promise.withResolvers<void>();
      await room.handle(ctx, { type: "replay", payload: { docId: "B", restoreRevision: "0" } });
      await ready.promise;
      pushed = Promise.withResolvers<void>();
      expect(await meter.during(() => edit("B", b, "B", empty.cursor))).toHaveLength(0);
      await pushed.promise;
      expect(baseB).toBeDefined();
      const before = baseB!.snapshot();
      expect(before.text).toBe("B");
      resume.resolve();
      await finished.promise;
      expect(await log.topic().latestCursor({ tenantId: "A" })).not.toBeNull();
      expect(baseB!.snapshot()).toEqual(before);
      // B can continue using its own cursor and state after the late A receipt.
      pushed = Promise.withResolvers<void>();
      expect(await meter.during(() => edit("B", b, " continues", before.cursor))).toHaveLength(0);
      await pushed.promise;
      expect(baseB!.snapshot().text).toBe("B continues");
    } finally {
      resume.resolve();
      await pending?.catch(() => {});
      await operationA?.catch(() => {});
      snapshots.mockRestore();
      await peer.close();
      await room.drain();
      a.destroy();
      b.destroy();
      await meter.close();
      unbindProcessSync();
      await sync.drain();
      const manager = await jetstreamManager(connection);
      for await (const stream of manager.streams.list())
        if (stream.config.metadata?.["sync.namespace"] === namespace) await manager.streams.delete(stream.config.name);
      await connection.drain();
      setSystemTime();
    }
  },
  30_000,
);
