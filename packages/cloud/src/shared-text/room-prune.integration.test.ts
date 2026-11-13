import { expect } from "bun:test";
import { createSync } from "@k2b/sync";
import { jetstreamManager } from "@nats-io/jetstream";
import { z } from "zod";
import { connectTestNats, testFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import { bindProcessSync, unbindProcessSync } from "../_internal/process-sync";
import { createSharedTextRoom, createSharedTextRoomContext, type SharedTextRoomMessages, sharedText } from "./index";

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
  busy: "busy",
  handlingFailed: "handling",
  messageNotAllowed: () => "phase",
};

for (const mode of ["idle", "covered", "covered-other", "uncovered"] as const)
  testFor("nats")(
    mode === "idle"
      ? "a caught-up room stays open when a safe prefix prune removes another document's events"
      : `${mode} snapshot at a pruned reconnect cursor ${mode !== "uncovered" ? "rebases without closing" : "requires resync"}`,
    async () => {
      const connection = await connectTestNats();
      const created = Promise.withResolvers<void>();
      const idleChecked = Promise.withResolvers<void>();
      let stream = "";
      let pruned = false;
      const observed = new Proxy(connection, {
        get(target, property) {
          if (property === "request")
            return async (...args: Parameters<typeof connection.request>) => {
              const reply = await target.request(...args);
              if (stream && args[0].includes(`.CONSUMER.CREATE.${stream}`)) created.resolve();
              if (pruned && args[0].includes(`.CONSUMER.INFO.${stream}.`)) {
                // Resume after the watchdog has processed the consumer's proof.
                setImmediate(() => idleChecked.resolve());
              }
              return reply;
            };
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const sync = createSync({
        connection: observed,
        namespace: testSyncNamespace("room-prune"),
        application: "test",
        defaults: { replicas: 1 },
      });
      bindProcessSync(sync, observed);
      const log = sharedText.define({
        id: "documents",
        whenFull: "reject",
        retention: { maxBytes: 1024 * 1024 },
        deadLetterRetention: { maxBytes: 65536 },
        maxPayloadBytes: 8192,
      });
      let storedCursor = log.topic().cursorAt(0);
      const snapshots: string[] = [];
      const ready = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<never>();
      const deliveries = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
      const delivered = new Set<string>();
      const room = createSharedTextRoom({
        log,
        snapshots: { queue: async () => {} },
        awarenessTopic: () => sync.topic({ id: "awareness", dedupeWindowMs: 60_000, retention: { maxAgeMs: 60_000, maxBytes: 65536 } }),
        logger: { debug() {}, info() {}, warn() {}, error() {} },
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
          decode: (value) => value,
          encode: (type, payload) => ({ type, payload }),
        },
        adapter: {
          authenticate: async () => ({ id: "reader" }),
          authorize: async () => ({ ok: true, resolvedDocId: "b", canWrite: false }),
          load: async () => ({ state: new Uint8Array([0, 0]), text: "", restoreRevision: "0", cursor: storedCursor }),
          actor: (user) => ({ kind: "user", id: user.id }),
          awarenessUser: (user) => ({ userId: user.id, name: "Reader", color: "#fff" }),
          revalidate: async () => ({ ok: true, canWrite: false }),
          recover: async () => {
            throw new Error("Unexpected retention gap");
          },
        },
      });
      const ctx = createSharedTextRoomContext<{ id: string }, SharedTextRoomMessages>(
        {
          send(raw) {
            const packet = JSON.parse(raw);
            if (packet.type === "ready") ready.resolve();
            if (packet.type === "push")
              for (const update of packet.payload.updates) {
                if (packet.payload.snapshot) snapshots.push(update.cursor);
                else {
                  delivered.add(update.cursor);
                  deliveries.get(update.cursor)?.resolve();
                }
              }
          },
          close(code, reason) {
            closed.reject(new Error(`Room closed ${code}: ${reason}`));
          },
        },
        "credential",
        messages,
      );
      // Observe closure immediately, including while a broker request is pending.
      void closed.promise.catch(() => {});
      const until = (promise: Promise<unknown>) => Promise.race([promise, closed.promise]);
      const receive = (cursor: string) => {
        if (delivered.has(cursor)) return Promise.resolve();
        const signal = Promise.withResolvers<void>();
        deliveries.set(cursor, signal);
        return until(signal.promise);
      };
      const publish = (tenantId: string) =>
        log
          .topic()
          .publish({ tenantId, data: { kind: "sync", payload: "AAA=", originNodeId: "other", originPeerId: null, restoreRevision: "0" } });
      let peer: ReturnType<typeof room.connect> | undefined;
      try {
        await publish("a"); // A1
        const manager = await jetstreamManager(connection);
        for await (const info of manager.streams.list())
          if (info.config.metadata?.["sync.id"] === log.id && info.config.subjects.some((subject) => subject.endsWith(".event")))
            stream = info.config.name;
        expect(stream).not.toBe("");
        if (mode !== "idle") {
          const b2 = await publish("b");
          const a3 = await publish(mode === "covered-other" ? "a" : "b");
          const b4 = await publish("b");
          storedCursor = mode !== "uncovered" ? a3.cursor : b2.cursor;
          await log.topic().prune({ through: a3.cursor });
          peer = room.connect(ctx);
          await room.handle(ctx, { type: "replay", payload: { docId: "b", restoreRevision: "0", fromCursor: b2.cursor } });
          if (mode === "uncovered") {
            await expect(until(ready.promise)).rejects.toThrow("RESYNC_REQUIRED");
            expect(snapshots).toEqual([]);
            return;
          }
          await until(ready.promise);
          expect(snapshots).toEqual([a3.cursor]);
          const b5 = await publish("b");
          await receive(b5.cursor);
          expect(delivered).toEqual(new Set([b4.cursor, b5.cursor]));
          return;
        }
        peer = room.connect(ctx);
        await room.handle(ctx, { type: "replay", payload: { docId: "b", restoreRevision: "0" } });
        await until(ready.promise);
        await until(created.promise);
        const b2 = await publish("b");
        await receive(b2.cursor); // B is persisted through B2; no later B event exists.
        const a3 = await publish("a");
        await publish("a"); // A4 is uncovered; A is persisted through A3.
        expect(await log.topic().prune({ through: a3.cursor })).toEqual({ purged: 3 });
        pruned = true;
        await until(idleChecked.promise);
        const b5 = await publish("b");
        await receive(b5.cursor);
        expect(delivered).toEqual(new Set([b2.cursor, b5.cursor]));
      } finally {
        await peer?.close();
        await log.topic().destroy();
        await sync.topic({ id: "awareness", dedupeWindowMs: 60_000, retention: { maxAgeMs: 60_000, maxBytes: 65536 } }).destroy();
        await sync.drain({ timeoutMs: 5000 });
        unbindProcessSync();
        await connection.close();
      }
    },
    15_000,
  );
