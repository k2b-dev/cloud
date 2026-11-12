import {
  ConflictError,
  CursorMismatchError,
  RetentionGapError,
  StoreFullError,
  type Topic,
  type TopicEvent,
  type TopicLiveEvent,
} from "@k2b/sync";
import { retry } from "@k2b/sync/retry";
import * as Y from "yjs";
import type { z } from "zod";
import { logger } from "../services/logging";
import { createTrustedTextAwareness, InvalidSharedTextAwarenessError } from "./awareness";
import { compareStreamCursor, maxStreamCursor } from "./cursor";
import { createDoc } from "./documents";
import { fromBase64, isValidSharedTextUpdate as isValidYjsUpdate, sharedTextNodeId as NODE_ID, toBase64 } from "./events";
import type { sharedText } from "./log";
import { createSharedTextRoomSchemas, SHARED_TEXT_ROOM_ERROR_CODE as ERROR_CODE, type SharedTextRoomProtocol } from "./room-protocol";
import type { SharedTextActor, SharedTextEvent, SharedTextStoredState } from "./types";

export type SharedTextRoomSocket = { send(data: string): unknown; close(code: number, reason: string): void };
export type SharedTextRoomSnapshot = SharedTextStoredState & { historyIncomplete?: boolean };
export type SharedTextRoomError = { code: string; message: string; docId?: string; reopen?: true };
export type SharedTextRoomAccess = {
  ok: boolean;
  code?: string;
  message?: string;
  docId?: string;
  resolvedDocId?: string;
  scope?: string;
  invalidationCursor?: string;
  canWrite?: boolean;
};
export type SharedTextRoomMessages = {
  notFound: string;
  sessionExpired: string;
  accessDenied: string;
  writeAccessRequired: string;
  accessRefreshFailed: string;
  liveSyncStorageExhausted: string;
  liveSyncStreamFailed: string;
  liveAwarenessStreamFailed: string;
  replayRequired: string;
  reopenRequired: string;
  loginRequired: string;
  invalidSyncUpdate: string;
  invalidBase64: string;
  invalidMessage: string;
  invalidJson: string;
  jsonTextOnly: string;
  messageTooLarge: string;
  tooManyMessages: string;
  handlingFailed: string;
  messageNotAllowed(input: { type: string; phase: string }): string;
};
export type SharedTextRoomPhase = "open" | "joined" | "closing";

export type SharedTextRoomContext<User, Messages> = {
  socket: SharedTextRoomSocket;
  phase: SharedTextRoomPhase;
  sessionToken: string | null;
  messages: Messages;
  user: User | null;
  accessScope: string | null;
  invalidationCursor: string | undefined;
  /** Canonical application document ID. */
  docId: string | null;
  /** Public document ID used on the WebSocket wire. */
  publicDocId: string | null;
  /** Null for workspace readers; collaboration pins a revision and must never relabel old bytes after a restore. */
  restoreRevision: string | null;
  canWrite: boolean;
  accessInvalidated: boolean;
  peerId: string;
  presencePeerId: string | undefined;
  trustedAwareness: ReturnType<typeof createTrustedTextAwareness> | null;
  awarenessUserId: string | null;
  streamAbort: AbortController | null;
  snapshotInterval: ReturnType<typeof setInterval> | null;
  leaveTask: Promise<void> | null;
  acceptTask: Promise<void> | null;
  accessWatchAbort: AbortController | null;
  dirty: boolean;
  lastPublishedCursor: string | null;
  snapshot: SharedTextRoomSnapshot | null;
};

/** Create session state without opening transport, broker resources, or durable storage. */
export const createSharedTextRoomContext = <User, Messages>(
  socket: SharedTextRoomSocket,
  credential: string | null,
  messages: Messages,
): SharedTextRoomContext<User, Messages> => ({
  socket,
  phase: "open",
  sessionToken: credential,
  messages,
  user: null,
  accessScope: null,
  invalidationCursor: undefined,
  docId: null,
  publicDocId: null,
  restoreRevision: null,
  canWrite: false,
  accessInvalidated: false,
  peerId: crypto.randomUUID(),
  presencePeerId: undefined,
  trustedAwareness: null,
  awarenessUserId: null,
  streamAbort: null,
  snapshotInterval: null,
  leaveTask: null,
  acceptTask: null,
  accessWatchAbort: null,
  dirty: false,
  lastPublishedCursor: null,
  snapshot: null,
});

export type SharedTextRoomAdapter<
  User,
  Messages extends SharedTextRoomMessages,
  Context extends SharedTextRoomContext<User, Messages> = SharedTextRoomContext<User, Messages>,
> = {
  authenticate(credential: string | null): Promise<User | null>;
  authorize(publicDocId: string, user: User, messages: Messages): Promise<SharedTextRoomAccess>;
  load(docId: string): Promise<SharedTextRoomSnapshot | null>;
  actor(user: User): SharedTextActor;
  awarenessUser(user: User): { userId: string; name: string; color: string };
  /** Event-only: the room never calls this on an edit or on a timer. */
  revalidate(context: Context): Promise<SharedTextRoomAccess>;
  /** Yield only invalidations affecting this document/principal; abort must release the subscription. */
  invalidations?(context: Context, signal: AbortSignal): AsyncIterable<unknown>;
  recover(docId: string, cause: RetentionGapError, signal: AbortSignal): Promise<unknown>;
  join?(context: Context): Promise<void>;
  leave?(context: Context): Promise<void>;
};

type PushUpdate = {
  cursor: string | null;
  payload: string;
  originPeerId: string | null;
  actionId?: string;
  retainedColumn?: boolean;
  restoreRevision?: string;
};
export const isSharedTextStorageExhausted = (error: unknown): boolean =>
  error instanceof StoreFullError ||
  /insufficient (storage )?resources|resource limits exceeded/i.test(error instanceof Error ? error.message : String(error));

/** Stateless document sessions: retained broker history owns fan-out and admission, the app owns durable snapshots. */
export function createSharedTextRoom<
  User,
  Messages extends SharedTextRoomMessages,
  Context extends SharedTextRoomContext<User, Messages> = SharedTextRoomContext<User, Messages>,
>(config: {
  protocol: SharedTextRoomProtocol;
  adapter: SharedTextRoomAdapter<User, Messages, Context>;
  log: ReturnType<typeof sharedText.define>;
  awarenessTopic(): Pick<Topic<SharedTextEvent & { kind: "awareness" }>, "live" | "publish">;
  snapshots: {
    queue(input: { docId: string; targetCursor: string; reason: string }): Promise<void>;
    /** Optional application debounce; synchronous and SQL-free. queue still runs on leave. */
    markDirty?(input: { docId: string; targetCursor: string }): void;
  };
  logger?: ReturnType<typeof logger>;
  maxLength?: number;
  validateState?: (state: Uint8Array) => boolean | Promise<boolean>;
  deliveryBudget?: { claim(bytes: number): boolean; release(bytes: number): void };
}) {
  const { adapter } = config;
  const log = config.logger ?? logger("shared-text-room");
  const WS_TYPE = config.protocol.wsType;
  const createYjsTopic = config.log.topic;
  const createYjsAwarenessTopic = config.awarenessTopic;
  const isStorageExhausted = isSharedTextStorageExhausted;
  const { ReplayRequestMessageSchema, SyncPublishMessageSchema, AwarenessPublishMessageSchema } = createSharedTextRoomSchemas(
    config.protocol,
  );
  const SNAPSHOT_INTERVAL_MS = 8_000;
  const NOTIFY_BATCH_SIZE = 100;
  const NOTIFY_BATCH_MAX_BYTES = 256_000;
  const NOTIFY_FLUSH_DELAY_MS = 25;
  const MAX_PENDING_MESSAGES = 200;
  const MAX_CLIENT_MESSAGE_LENGTH = config.protocol.maxSyncPayloadLength + 1_000;
  const BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  const send = (socket: SharedTextRoomSocket, type: string, payload?: unknown) => {
    try {
      socket.send(JSON.stringify(config.protocol.encode(type, payload)));
    } catch {
      // Ignore send failures on closed sockets.
    }
  };

  const warn = (socket: SharedTextRoomSocket, code: string, message: string, docId?: string, reopen?: true) => {
    const payload: SharedTextRoomError = docId ? { code, message, docId } : { code, message };
    if (reopen) payload.reopen = true;
    send(socket, WS_TYPE.error, payload);
  };

  const closeCodeForError = (code: string): number => {
    if (code === ERROR_CODE.resyncRequired || code === ERROR_CODE.streamFailed || code === ERROR_CODE.storageExhausted) return 1012;
    if (code === ERROR_CODE.internalError) return 1011;
    if (code === ERROR_CODE.backpressure) return 1013;
    return 1008;
  };

  const stopLiveStream = (ctx: Context) => {
    if (ctx.streamAbort) ctx.streamAbort.abort();
    ctx.streamAbort = null;
  };

  const stopSnapshotScheduler = (ctx: Context) => {
    if (ctx.snapshotInterval) clearInterval(ctx.snapshotInterval);
    ctx.snapshotInterval = null;
  };

  const stopAccessWatch = (ctx: Context) => {
    if (ctx.accessWatchAbort) ctx.accessWatchAbort.abort();
    ctx.accessWatchAbort = null;
  };

  const queueSnapshotIfNeeded = async (ctx: Context, reason: "periodic" | "unload") => {
    if (!ctx.docId || !ctx.dirty || !ctx.lastPublishedCursor) return;

    const queuedCursor = ctx.lastPublishedCursor;
    try {
      await config.snapshots.queue({
        docId: ctx.docId,
        targetCursor: queuedCursor,
        reason,
      });
      ctx.dirty = ctx.lastPublishedCursor !== queuedCursor;
      if (!ctx.dirty) stopSnapshotScheduler(ctx);
      log.debug("Queued snapshot save", {
        docId: ctx.docId,
        cursor: ctx.lastPublishedCursor,
        reason,
      });
    } catch (error) {
      log.error("Failed to queue snapshot save", {
        docId: ctx.docId,
        cursor: ctx.lastPublishedCursor,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      if (reason === "unload") throw error;
    }
  };

  const startSnapshotScheduler = (ctx: Context) => {
    if (ctx.snapshotInterval) return;
    ctx.snapshotInterval = setInterval(() => {
      void queueSnapshotIfNeeded(ctx, "periodic");
    }, SNAPSHOT_INTERVAL_MS);
  };

  const markDirty = (ctx: Context, cursor: string) => {
    ctx.lastPublishedCursor = maxStreamCursor(ctx.lastPublishedCursor, cursor);
    ctx.dirty = true;
    if (config.snapshots.markDirty) config.snapshots.markDirty({ docId: ctx.docId!, targetCursor: ctx.lastPublishedCursor! });
    else startSnapshotScheduler(ctx);
  };

  const toPushUpdate = (event: TopicEvent<SharedTextEvent> | TopicLiveEvent<SharedTextEvent>): PushUpdate => ({
    cursor: "cursor" in event ? event.cursor : null,
    payload: event.data.payload,
    originPeerId: event.data.originPeerId,
    ...(event.data.actionId ? { actionId: event.data.actionId } : {}),
    ...(event.data.history?.retained ? { retainedColumn: true } : {}),
    ...(event.data.restoreRevision !== undefined ? { restoreRevision: event.data.restoreRevision } : {}),
  });
  const advanceSnapshot = (ctx: Context, event: TopicEvent<SharedTextEvent>) => {
    if (
      event.data.kind !== "sync" ||
      !ctx.snapshot ||
      (event.data.restoreRevision !== undefined && event.data.restoreRevision !== ctx.restoreRevision)
    )
      return;
    let base = ctx.snapshot.state;
    if (!base) {
      const doc = createDoc(ctx.snapshot);
      try {
        base = Y.encodeStateAsUpdate(doc);
      } finally {
        doc.destroy();
      }
    }
    ctx.snapshot = {
      ...ctx.snapshot,
      state: Y.mergeUpdates([base, fromBase64(event.data.payload)]),
      cursor: maxStreamCursor(ctx.snapshot.cursor, event.cursor),
    };
  };

  /**
   * Stream failures are never terminal for the editor, but only a cursor the
   * broker cannot serve any more (`RetentionGapError`, `CursorMismatchError`)
   * needs `RESYNC_REQUIRED`, which makes the client drop its cursor and rebuild
   * from the stored snapshot. Everything else (broker failover, lost consumer,
   * an awareness stream error) closes with `STREAM_FAILED`: the client
   * reconnects with backoff and its last cursor, so an outage never turns into
   * a full-snapshot resend every few seconds.
   */
  const failLiveStream = async (ctx: Context, docId: string, publicDocId: string, stream: "sync" | "awareness", error: unknown) => {
    log.error(stream === "sync" ? "Yjs live stream failed" : "Yjs awareness stream failed", {
      docId,
      error: error instanceof Error ? error.message : String(error),
    });
    const resync = stream === "sync" && (error instanceof RetentionGapError || error instanceof CursorMismatchError);
    if (isStorageExhausted(error)) {
      await fatal(ctx, ERROR_CODE.storageExhausted, ctx.messages.liveSyncStorageExhausted, publicDocId);
      return;
    }
    await fatal(
      ctx,
      resync ? ERROR_CODE.resyncRequired : ERROR_CODE.streamFailed,
      stream === "sync" ? ctx.messages.liveSyncStreamFailed : ctx.messages.liveAwarenessStreamFailed,
      publicDocId,
    );
  };

  const deliverForJoinedRevision = async (ctx: Context, docId: string, _publicDocId: string, deliver: () => undefined) => {
    if (ctx.phase !== "joined" || ctx.docId !== docId || ctx.restoreRevision === null) return false;
    deliver();
    return true;
  };

  const startLiveStream = (
    ctx: Context,
    docId: string,
    publicDocId: string,
    replay: {
      after: string | null;
      /** True when `after` is the stored snapshot's cursor: the client holds that snapshot as its base. */
      storedBase: boolean;
    },
    // Fired only after deterministic replay to the captured head.
    onCaughtUp: (cursor: string) => void,
  ) => {
    stopLiveStream(ctx);
    const abort = new AbortController();
    ctx.streamAbort = abort;

    // Awareness is transient collaboration state. Keep it off the retained
    // document stream so cursor movement never bloats snapshot replay.
    void (async () => {
      const awarenessTopic = createYjsAwarenessTopic();
      try {
        for await (const event of awarenessTopic.live({ tenantId: docId, signal: abort.signal })) {
          if (ctx.phase !== "joined" || ctx.docId !== docId) break;
          send(ctx.socket, WS_TYPE.awarenessPush, {
            docId: publicDocId,
            updates: [toPushUpdate(event)],
          });
        }
      } catch (error) {
        if (!abort.signal.aborted) await failLiveStream(ctx, docId, publicDocId, "awareness", error);
      }
    })();

    void (async () => {
      const documentTopic = createYjsTopic();
      const pending: PushUpdate[] = [];
      let pendingBytes = 0;
      let reservedBytes = 0;
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      let stopped = false;
      let deliveryTail = Promise.resolve();
      const active = () => !stopped && !abort.signal.aborted && ctx.streamAbort === abort;
      const fail = async (error: unknown) => {
        if (!active()) return;
        stopped = true;
        await failLiveStream(ctx, docId, publicDocId, "sync", error);
      };
      const flush = () => {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        if (!active() || pending.length === 0) return deliveryTail;
        const batch = pending.splice(0, pending.length);
        const reservation = reservedBytes;
        reservedBytes = 0;
        pendingBytes = 0;
        // Capture batches in stream order and serialize timer/size flushes so
        // readiness never overtakes an earlier batch.
        deliveryTail = deliveryTail
          .then(async () => {
            if (!active()) return;
            const delivered = await deliverForJoinedRevision(ctx, docId, publicDocId, () => {
              if (active()) send(ctx.socket, WS_TYPE.syncPush, { docId: publicDocId, updates: batch });
            });
            if (!delivered) stopped = true;
          })
          .catch(fail)
          .finally(() => config.deliveryBudget?.release(reservation));
        return deliveryTail;
      };

      const scheduleFlush = () => {
        if (flushTimer) return;
        flushTimer = setTimeout(() => {
          void flush();
        }, NOTIFY_FLUSH_DELAY_MS);
      };

      try {
        const events = async function* () {
          const head = await documentTopic.latestCursor({ tenantId: docId });
          if (head) {
            let delivered = 0;
            try {
              for await (const event of documentTopic.replay({
                tenantId: docId,
                // The provider may already hold more than the SQL snapshot.
                // Rebuild the room base too, without redelivering that prefix.
                after:
                  ctx.snapshot?.cursor && replay.after && compareStreamCursor(ctx.snapshot.cursor, replay.after) >= 0
                    ? replay.after
                    : (ctx.snapshot?.cursor ?? documentTopic.cursorAt(0)),
                until: head,
                signal: abort.signal,
              })) {
                delivered++;
                advanceSnapshot(ctx, event);
                if (replay.after && compareStreamCursor(event.cursor, replay.after) <= 0) continue;
                yield event;
              }
            } catch (error) {
              // Recover the retained remainder, then reconnect from the newly
              // saved snapshot. The snapshot already sent to this client predates
              // recovery, so jumping straight to live events would omit those edits.
              if (!(error instanceof RetentionGapError) || !replay.storedBase || delivered > 0) throw error;
              await adapter.recover(docId, error, abort.signal);
              throw error;
            }
          }
          if (abort.signal.aborted || ctx.streamAbort !== abort) return;
          await flush();
          if (!active()) return;
          const delivered = await deliverForJoinedRevision(ctx, docId, publicDocId, () => {
            if (active()) onCaughtUp(head ?? replay.after ?? documentTopic.cursorAt(0));
          });
          if (!delivered || !active()) return;
          yield* documentTopic
            .hub({ tenantId: docId })
            .subscribe({ after: head ?? replay.after ?? documentTopic.cursorAt(0), signal: abort.signal });
        };
        for await (const event of events()) {
          if (!active() || ctx.phase !== "joined" || ctx.docId !== docId) break;
          if (event.data.restoreRevision !== undefined && event.data.restoreRevision !== ctx.restoreRevision) {
            await requireReopen(ctx, publicDocId);
            break;
          }
          // Keep the authorized in-memory base current before covered history is
          // pruned. This is broker fan-out, never another SQL load per delivery.
          advanceSnapshot(ctx, event);
          ctx.lastPublishedCursor = maxStreamCursor(ctx.lastPublishedCursor, event.cursor);
          if (event.data.kind !== "sync") continue;
          const update = toPushUpdate(event);
          const reservation = JSON.stringify(update).length * 2;
          if (config.deliveryBudget && !config.deliveryBudget.claim(reservation)) {
            await fatal(ctx, ERROR_CODE.backpressure, ctx.messages.tooManyMessages, publicDocId);
            break;
          }
          reservedBytes += reservation;
          pending.push(update);
          pendingBytes += update.payload.length;
          if (pending.length >= NOTIFY_BATCH_SIZE || pendingBytes >= NOTIFY_BATCH_MAX_BYTES) {
            await flush();
          } else {
            scheduleFlush();
          }
        }
        await flush();
      } catch (error) {
        await fail(error);
      } finally {
        if (flushTimer) clearTimeout(flushTimer);
        // A mismatch/failure is terminal. Never flush obsolete pending bytes
        // from finally (including a timer batch queued before the mismatch).
        stopped = true;
        pending.length = 0;
        config.deliveryBudget?.release(reservedBytes);
        await deliveryTail;
        if (ctx.streamAbort === abort) {
          ctx.streamAbort = null;
        }
      }
    })();
  };

  const ensureJoinedDocument = (ctx: Context, publicDocId: string): boolean => {
    if (ctx.phase !== "joined" || ctx.restoreRevision === null || !ctx.publicDocId || ctx.publicDocId !== publicDocId) {
      warn(ctx.socket, ERROR_CODE.invalidPayload, ctx.messages.replayRequired, publicDocId);
      return false;
    }
    return true;
  };

  const ensureWritableDocument = (ctx: Context, docId: string): boolean => {
    if (!ctx.canWrite) {
      warn(ctx.socket, ERROR_CODE.accessDenied, ctx.messages.writeAccessRequired, docId);
      return false;
    }
    return true;
  };

  const handleReplayRequest = async (ctx: Context, payload: z.infer<typeof ReplayRequestMessageSchema.shape.payload>) => {
    const closing = () => ctx.phase === "closing";
    await ctx.leaveTask;
    ctx.accessInvalidated = false;
    const user = await adapter.authenticate(ctx.sessionToken);
    if (closing()) return;
    if (!user) {
      await fatal(ctx, ERROR_CODE.loginRequired, ctx.messages.loginRequired, payload.docId);
      return;
    }

    const access = await adapter.authorize(payload.docId, user, ctx.messages);
    if (closing()) return;
    if (!access.ok) {
      await fatal(ctx, access.code ?? ERROR_CODE.accessDenied, access.message ?? ctx.messages.accessDenied, access.docId ?? payload.docId);
      return;
    }
    const dbDocId = access.resolvedDocId!;

    if (ctx.docId && (ctx.docId !== dbDocId || ctx.restoreRevision === null)) {
      await leave(ctx);
    }

    const snapshot = await adapter.load(dbDocId);
    if (closing()) return;
    if (!snapshot) {
      await fatal(ctx, ERROR_CODE.notFound, ctx.messages.notFound, payload.docId);
      return;
    }
    // Only a truly initial empty document may adopt the snapshot's revision.
    // A cursor (even an obsolete cursor format) proves the browser has a base.
    if (
      (payload.restoreRevision === null && payload.fromCursor != null) ||
      (payload.restoreRevision !== null && payload.restoreRevision !== snapshot.restoreRevision) ||
      (ctx.restoreRevision !== null && ctx.restoreRevision !== snapshot.restoreRevision)
    ) {
      await requireReopen(ctx, payload.docId);
      return;
    }

    ctx.phase = "joined";
    ctx.user = user;
    ctx.docId = dbDocId;
    ctx.publicDocId = payload.docId;
    ctx.restoreRevision = snapshot.restoreRevision;
    ctx.presencePeerId = payload.presencePeerId;
    ctx.accessScope = access.scope ?? null;
    ctx.invalidationCursor = access.invalidationCursor;
    ctx.snapshot = snapshot;
    ctx.canWrite = access.canWrite ?? false;

    startAccessWatch(ctx);
    if (ctx.accessInvalidated && !(await revalidate(ctx))) return;
    await adapter.join?.(ctx);
    if (ctx.phase !== "joined" || ctx.docId !== dbDocId) return;

    const clientCursor = payload.fromCursor && config.protocol.streamCursorPattern.test(payload.fromCursor) ? payload.fromCursor : null;
    let replayCursor = clientCursor;
    if (!clientCursor) {
      if (snapshot.state) {
        const delivered = await deliverForJoinedRevision(ctx, dbDocId, payload.docId, () => {
          send(ctx.socket, WS_TYPE.syncPush, {
            docId: payload.docId,
            historyIncomplete: snapshot.historyIncomplete,
            snapshot: true,
            restoreRevision: snapshot.restoreRevision,
            updates: [
              {
                cursor: snapshot.cursor,
                payload: toBase64(snapshot.state!),
                originPeerId: null,
              },
            ],
          });
        });
        if (!delivered) return;
      }
      replayCursor = snapshot.cursor;
    }

    // `replayReady` is deferred until retained history up to the captured head
    // has been delivered (see `startLiveStream`). Sending it earlier would let
    // the client publish edits while catch-up is still streaming.
    startLiveStream(ctx, dbDocId, payload.docId, { after: replayCursor, storedBase: !clientCursor }, (cursor) => {
      send(ctx.socket, WS_TYPE.replayReady, {
        docId: payload.docId,
        cursor,
        restoreRevision: snapshot.restoreRevision,
        peerId: ctx.peerId,
      });
    });
    log.debug("Replay stream started", {
      docId: dbDocId,
      peerId: ctx.peerId,
      fromCursor: replayCursor,
    });
  };

  const handleSyncPublish = async (ctx: Context, payload: z.infer<typeof SyncPublishMessageSchema.shape.payload>) => {
    if (!ensureJoinedDocument(ctx, payload.docId)) return;
    if (!ensureWritableDocument(ctx, payload.docId)) return;
    // Once retained, an undecodable update poisons every replay of this document.
    if (!isValidYjsUpdate(payload.payload)) {
      warn(ctx.socket, ERROR_CODE.invalidPayload, ctx.messages.invalidSyncUpdate, payload.docId);
      return;
    }

    const docId = ctx.docId!;
    if (payload.restoreRevision !== ctx.restoreRevision) {
      await requireReopen(ctx, payload.docId);
      return;
    }

    // Decode alone cannot validate the target of a delayed edit. Admission and
    // its CAS happen before the echo that acknowledges the person's bytes.
    const documents = config.log.withStore({
      load: async () => ctx.snapshot,
      save: async () => {
        throw new Error("Room admission never persists snapshots");
      },
    });
    const publication = (async () => {
      const deadline = AbortSignal.timeout(30_000);
      const signal = ctx.streamAbort ? AbortSignal.any([ctx.streamAbort.signal, deadline]) : deadline;
      for (;;) {
        signal.throwIfAborted();
        try {
          return await documents.accept(docId, {
            update: fromBase64(payload.payload),
            baseCursor: payload.baseCursor ?? null,
            restoreRevision: payload.restoreRevision,
            originNodeId: NODE_ID,
            originPeerId: ctx.peerId,
            actor: adapter.actor(ctx.user!),
            signal,
            maxLength: config.maxLength,
            validateState: config.validateState,
            validate: async () => ctx.phase === "joined" && ctx.docId === docId && ensureWritableDocument(ctx, payload.docId),
          });
        } catch (error) {
          if (!(error instanceof ConflictError)) throw error;
          // A concurrent editor advanced the tenant head. Rebuild and validate
          // these same Yjs identities; never turn ordinary contention into a reconnect.
        }
      }
    })();
    ctx.acceptTask = publication.then((result) => {
      if (result.status === "accepted") markDirty(ctx, result.cursor);
    });
    let published: Awaited<typeof publication>;
    try {
      await ctx.acceptTask;
      published = await publication;
    } finally {
      ctx.acceptTask = null;
    }
    if (published.status !== "accepted") {
      await requireReopen(ctx, payload.docId);
      return;
    }
  };

  const handleAwarenessPublish = async (ctx: Context, payload: z.infer<typeof AwarenessPublishMessageSchema.shape.payload>) => {
    if (!ensureJoinedDocument(ctx, payload.docId)) return;
    if (!ensureValidBase64(payload.payload)) {
      warn(ctx.socket, ERROR_CODE.invalidPayload, ctx.messages.invalidBase64, payload.docId);
      return;
    }

    if (!ensureJoinedDocument(ctx, payload.docId) || !ctx.user) return;
    if (ctx.awarenessUserId !== null && ctx.awarenessUserId !== adapter.actor(ctx.user).id) {
      await fatal(ctx, ERROR_CODE.sessionExpired, ctx.messages.sessionExpired, payload.docId);
      return;
    }
    const awarenessTopic = createYjsAwarenessTopic();
    if (!ctx.trustedAwareness) {
      // Reserve a broker sequence using an empty awareness update. Sequences are
      // unique across pods; the upper range cannot collide with Yjs uint32 IDs.
      const reservation = await awarenessTopic.publish({
        tenantId: ctx.docId!,
        data: { kind: "awareness", payload: "AA==", originNodeId: NODE_ID, originPeerId: ctx.peerId },
      });
      if (!ensureJoinedDocument(ctx, payload.docId) || ctx.phase !== "joined") return;
      ctx.trustedAwareness = createTrustedTextAwareness({
        clientId: 2 ** 32 + reservation.streamSequence,
        textName: "codemirror",
        user: adapter.awarenessUser(ctx.user),
      });
      ctx.awarenessUserId = adapter.actor(ctx.user).id;
    }
    let trusted: Uint8Array;
    try {
      trusted = ctx.trustedAwareness.publish(fromBase64(payload.payload));
    } catch (error) {
      if (!(error instanceof InvalidSharedTextAwarenessError)) throw error;
      warn(ctx.socket, ERROR_CODE.invalidPayload, ctx.messages.invalidMessage, payload.docId);
      return;
    }
    await awarenessTopic.publish({
      tenantId: ctx.docId!,
      data: {
        kind: "awareness",
        payload: toBase64(trusted),
        originNodeId: NODE_ID,
        originPeerId: ctx.peerId,
      },
    });
  };

  const leave = (ctx: Context): Promise<void> => {
    if (ctx.leaveTask) return ctx.leaveTask;
    ctx.leaveTask = (async () => {
      if (ctx.phase !== "closing") ctx.phase = "open";
      await ctx.acceptTask?.catch(() => undefined);
      await queueSnapshotIfNeeded(ctx, "unload");
      stopAccessWatch(ctx);
      stopSnapshotScheduler(ctx);
      stopLiveStream(ctx);
      const removal = ctx.trustedAwareness?.remove();
      ctx.trustedAwareness = null;
      ctx.awarenessUserId = null;
      if (removal && ctx.docId) {
        try {
          await createYjsAwarenessTopic().publish({
            tenantId: ctx.docId,
            data: { kind: "awareness", payload: toBase64(removal), originNodeId: NODE_ID, originPeerId: ctx.peerId },
          });
        } catch (error) {
          log.warn("Failed to leave cursor presence", { docId: ctx.docId, error: String(error) });
        }
      }
      await adapter.leave?.(ctx);
      ctx.docId = null;
      ctx.publicDocId = null;
      ctx.restoreRevision = null;
      ctx.accessScope = null;
      ctx.invalidationCursor = undefined;
      ctx.canWrite = false;
      ctx.dirty = false;
      ctx.lastPublishedCursor = null;
      ctx.snapshot = null;
    })().finally(() => {
      ctx.leaveTask = null;
    });
    return ctx.leaveTask;
  };
  const fatal = async (ctx: Context, code: string, message: string, docId?: string, reopen?: true) => {
    if (ctx.phase === "closing") return;
    ctx.phase = "closing";
    warn(ctx.socket, code, message, docId, reopen);
    try {
      await leave(ctx);
    } finally {
      ctx.socket.close(closeCodeForError(code), code);
    }
  };
  const requireReopen = (ctx: Context, docId?: string) => fatal(ctx, ERROR_CODE.resyncRequired, ctx.messages.reopenRequired, docId, true);
  const ensureValidBase64 = (payload: string) => payload.length > 0 && payload.length % 4 === 0 && BASE64_REGEX.test(payload);
  const revalidate = async (ctx: Context): Promise<boolean> => {
    if (ctx.phase !== "joined") {
      ctx.accessInvalidated = true;
      return false;
    }
    ctx.accessInvalidated = false;
    const docId = ctx.docId;
    const revision = ctx.restoreRevision;
    const couldWrite = ctx.canWrite;
    const current = () => ctx.phase === "joined" && ctx.docId === docId && ctx.restoreRevision === revision;
    try {
      const access = await adapter.revalidate(ctx);
      if (!current()) return false;
      if (access.ok && access.scope !== undefined && access.scope !== ctx.accessScope) {
        // Reconnect so the new scope's invalidations are observed too.
        await fatal(ctx, ERROR_CODE.streamFailed, ctx.messages.liveSyncStreamFailed, ctx.publicDocId ?? undefined);
        return false;
      }
      if (access.ok && !(couldWrite && access.canWrite === false)) {
        if (access.canWrite !== undefined) ctx.canWrite = access.canWrite;
        return true;
      }
      if (access.ok) {
        await fatal(ctx, ERROR_CODE.accessRevoked, ctx.messages.accessDenied, ctx.publicDocId ?? undefined);
        return false;
      }
      if (access.code === ERROR_CODE.resyncRequired) {
        await requireReopen(ctx, ctx.publicDocId ?? undefined);
        return false;
      }
      await fatal(
        ctx,
        access.code ?? ERROR_CODE.internalError,
        access.message ?? ctx.messages.accessRefreshFailed,
        access.docId ?? ctx.publicDocId ?? undefined,
      );
    } catch (error) {
      if (!current()) return false;
      log.error("Access invalidation failed", { docId, error: String(error) });
      await fatal(ctx, ERROR_CODE.internalError, ctx.messages.accessRefreshFailed, ctx.publicDocId ?? undefined);
    }
    return false;
  };
  const startAccessWatch = (ctx: Context) => {
    stopAccessWatch(ctx);
    if (!adapter.invalidations) return;
    const abort = new AbortController();
    ctx.accessWatchAbort = abort;
    void (async () => {
      try {
        for await (const _event of adapter.invalidations!(ctx, abort.signal)) {
          if (abort.signal.aborted || !(await revalidate(ctx))) break;
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          log.error("Access invalidation stream failed", { docId: ctx.docId, error: String(error) });
          await fatal(ctx, ERROR_CODE.streamFailed, ctx.messages.liveSyncStreamFailed, ctx.publicDocId ?? undefined);
        }
      }
    })();
  };
  const handle = async (ctx: Context, packet: unknown): Promise<boolean> => {
    const decoded = config.protocol.decode(packet);
    const kind = decoded && typeof decoded === "object" && "type" in decoded ? decoded.type : undefined;
    if (![WS_TYPE.replayRequest, WS_TYPE.syncPublish, WS_TYPE.awarenessPublish].includes(String(kind))) return false;
    const schema =
      kind === WS_TYPE.replayRequest
        ? ReplayRequestMessageSchema
        : kind === WS_TYPE.syncPublish
          ? SyncPublishMessageSchema
          : AwarenessPublishMessageSchema;
    const parsed = schema.safeParse(decoded);
    if (!parsed.success) {
      if (parsed.error.issues.some((issue) => issue.path[0] === "payload" && issue.path[1] === "restoreRevision"))
        await requireReopen(ctx, ctx.publicDocId ?? undefined);
      else warn(ctx.socket, ERROR_CODE.invalidMessage, ctx.messages.invalidMessage);
      return true;
    }
    if (ctx.phase === "closing") return true;
    if (parsed.data.type === WS_TYPE.replayRequest) await handleReplayRequest(ctx, ReplayRequestMessageSchema.parse(decoded).payload);
    else if (ctx.phase !== "joined")
      warn(ctx.socket, ERROR_CODE.invalidMessage, ctx.messages.messageNotAllowed({ type: String(kind), phase: ctx.phase }));
    else if (parsed.data.type === WS_TYPE.syncPublish) await handleSyncPublish(ctx, SyncPublishMessageSchema.parse(decoded).payload);
    else await handleAwarenessPublish(ctx, AwarenessPublishMessageSchema.parse(decoded).payload);
    return true;
  };
  const activeConnections = new Set<() => Promise<void>>();
  let stopping = false;
  const connect = (ctx: Context, extension?: { handle(packet: unknown): Promise<void>; leave(): Promise<void> }) => {
    let processing = Promise.resolve();
    let pendingMessages = 0;
    let awarenessSlot: { parsed: unknown } | null = null;
    let closing: Promise<void> | null = null;
    const close = (): Promise<void> => {
      closing ??= (async () => {
        await processing.catch(() => undefined);
        ctx.phase = "closing";
        await leave(ctx);
        await extension?.leave();
        ctx.socket.close(1012, "Restarting");
      })().then(
        () => {
          activeConnections.delete(close);
        },
        (error) => {
          closing = null;
          throw error;
        },
      );
      return closing;
    };
    const fail = async (error: unknown) => {
      log.error("Websocket message handling failed", { docId: ctx.docId, error: String(error) });
      if (isStorageExhausted(error))
        await fatal(ctx, ERROR_CODE.storageExhausted, ctx.messages.liveSyncStorageExhausted, ctx.publicDocId ?? undefined);
      else if (error instanceof ConflictError)
        await fatal(ctx, ERROR_CODE.streamFailed, ctx.messages.liveSyncStreamFailed, ctx.publicDocId ?? undefined);
      else await fatal(ctx, ERROR_CODE.internalError, ctx.messages.handlingFailed, ctx.publicDocId ?? undefined);
    };
    const dispatch = async (packet: unknown) => {
      if (!(await handle(ctx, packet))) {
        if (extension) await extension.handle(packet);
        else warn(ctx.socket, ERROR_CODE.invalidMessage, ctx.messages.invalidMessage);
      }
    };
    if (stopping) void close();
    else activeConnections.add(close);
    return {
      close,
      /** Settlement of input already queued, for transport byte accounting. */
      settled: () => processing,
      async receive(data: unknown) {
        if (stopping || closing || ctx.phase === "closing") return;
        if (typeof data !== "string") {
          warn(ctx.socket, ERROR_CODE.invalidMessage, ctx.messages.jsonTextOnly);
          return;
        }
        if (data.length > MAX_CLIENT_MESSAGE_LENGTH) {
          await fatal(ctx, ERROR_CODE.invalidPayload, ctx.messages.messageTooLarge, ctx.publicDocId ?? undefined);
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          warn(ctx.socket, ERROR_CODE.invalidJson, ctx.messages.invalidJson);
          return;
        }
        const awareness = typeof parsed === "object" && parsed !== null && "type" in parsed && parsed.type === WS_TYPE.awarenessPublish;
        let run: () => Promise<void>;
        if (awareness) {
          if (awarenessSlot) {
            awarenessSlot.parsed = parsed;
            return;
          }
          const slot = { parsed };
          awarenessSlot = slot;
          run = () => {
            if (awarenessSlot === slot) awarenessSlot = null;
            return dispatch(slot.parsed);
          };
        } else {
          awarenessSlot = null;
          if (pendingMessages >= MAX_PENDING_MESSAGES) {
            await fatal(ctx, ERROR_CODE.backpressure, ctx.messages.tooManyMessages, ctx.publicDocId ?? undefined);
            return;
          }
          pendingMessages++;
          run = () => dispatch(parsed);
        }
        processing = processing
          .then(run)
          .catch(fail)
          .finally(() => {
            if (!awareness) pendingMessages = Math.max(0, pendingMessages - 1);
          });
      },
    };
  };
  return {
    connect,
    handle,
    leave,
    fatal,
    warn,
    send,
    revalidate,
    async drain() {
      stopping = true;
      await retry({
        signal: AbortSignal.timeout(30_000),
        run: () => Promise.all([...activeConnections].map((close) => close())),
        after: ({ ctx }) => {
          if (ctx.error) ctx.reschedule({ delayMs: 5_000 });
        },
      });
    },
  };
}
