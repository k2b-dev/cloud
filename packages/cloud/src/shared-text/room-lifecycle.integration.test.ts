import { expect, setSystemTime } from "bun:test";
import { createSync, type Sync, type TopicConfig } from "@k2b/sync";
import { jetstreamManager } from "@nats-io/jetstream";
import * as Y from "yjs";
import { z } from "zod";
import { connectTestNats, testFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import { bindProcessSync, unbindProcessSync } from "../_internal/process-sync";
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
  handlingFailed: "handling",
  messageNotAllowed: () => "phase",
};
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

testFor("nats")(
  "three concurrent editors in two rooms serialize publication, freeze and drain exactly, thaw, recover a crashed freeze, and close",
  async () => {
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
    bindProcessSync(measured);
    const log = sharedText.define({
      id: "text",
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
    let holdValidation: Promise<void> | undefined;
    const entered = Promise.withResolvers<void>();
    const makeRoom = () =>
      createSharedTextRoom({
        logger: quiet,
        log,
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
          encode: (type, payload) => ({ type, payload }),
        },
        validateState: async () => {
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
    const a = makeRoom(),
      b = makeRoom();
    const peers: Array<ReturnType<typeof peer>> = [];
    const peer = async (room: typeof a) => {
      const ready = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<string>();
      const packets: Array<{ type: string; payload?: { code?: string; updates?: Array<{ payload: string }> } }> = [];
      const ctx = createSharedTextRoomContext<{ id: string }, SharedTextRoomMessages>(
        {
          send: (raw) => {
            const packet = JSON.parse(raw);
            packets.push(packet);
            if (packet.type === "ready") ready.resolve();
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
      const sources = writers.map((_, index) => {
        const doc = new Y.Doc();
        doc.clientID = index + 100;
        return doc;
      });
      const tokens: string[] = [];
      try {
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
        expect(attempts.size).toBe(30);
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
      const rejectedInput = update(" after");
      const later = await peer(b);
      peers.push(Promise.resolve(later));
      const unchanged = sql;
      await edit(later, rejectedInput);
      expect(await later.closed).toBe("DOCUMENT_FROZEN");
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
      await b.closeDocument("doc", { freezeCursor: recovered!.cursor });
      expect(await resumed.closed).toBe("DOCUMENT_CLOSED");
      const rejected = await peer(b);
      peers.push(Promise.resolve(rejected));
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
    }
  },
  30_000,
);
