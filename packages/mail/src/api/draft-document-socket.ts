import { lazySync } from "@k2b/cloud";
import { auth, getLocale } from "@k2b/cloud/server";
import { logger } from "@k2b/cloud/services";
import {
  compareStreamCursor,
  createTrustedTextAwareness,
  fromBase64,
  InvalidSharedTextAwarenessError,
  isValidSharedTextUpdate,
  type SharedTextSyncEvent,
  sharedTextNodeId,
  toBase64,
} from "@k2b/cloud/shared-text";
import { CursorMismatchError, RetentionGapError, type TopicEvent } from "@k2b/sync";
import type { Context } from "hono";
import { upgradeWebSocket } from "hono/bun";
import type { WSContext, WSEvents } from "hono/ws";
import { MAX_DRAFT_DOCUMENT_PAYLOAD } from "../lib/draft-document-contract";
import { draftDocumentAccountRejection } from "../lib/draft-document-identity";
import {
  MAX_DRAFT_AWARENESS_PAYLOAD,
  type MailDraftDocumentMessage,
  type MailDraftDocumentRequest,
  mailDraftDocumentMessages,
  mailDraftDocumentRequestSchema,
} from "../lib/draft-document-protocol";
import { requireDraftAccess } from "../service/access";
import type { MailRequestContext } from "../service/auth";
import {
  awaitDraftDocumentQuery,
  DRAFT_DOCUMENT_ACCESS_REFRESH_MS,
  withDraftDocumentTransaction,
} from "../service/draft-document-socket-sql";
import { acceptDraftDocumentUpdate, type DraftDocumentSnapshot, mailDraftDocumentLog, readDraftDocument } from "../service/draft-documents";
import type { MailApiContext } from "./public-resource-boundary";

const log = logger("mail:draft-document-socket");
const MAX_PENDING_MESSAGES = 200;
// Two maximum envelopes allow one send and one queued successor, like the provider's pending budget.
const MAX_BUFFER_BYTES = 2 * (MAX_DRAFT_DOCUMENT_PAYLOAD + 1000);
const MAX_MESSAGE_LENGTH = MAX_DRAFT_DOCUMENT_PAYLOAD + 1000;
const colors = ["#e06c75", "#61afef", "#98c379", "#d19a66", "#c678dd", "#56b6c2", "#e5c07b"] as const;
const userColor = (id: string): string => {
  let hash = 0;
  for (const char of id) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length]!;
};
type AwarenessEvent = { kind: "awareness"; payload: string; generation: string; originNodeId: string; originPeerId: string };
// Same app-wide transient budget as Notebooks: 60 s of awareness, 64 MiB total,
// 300 KB envelopes plus metadata. Never reserve a stream per document.
const awarenessTopic = lazySync((sync) =>
  sync.topic<AwarenessEvent>({
    id: "cloud:mail:draft-document-awareness",
    retention: { maxAgeMs: 60_000, maxBytes: 64 * 1024 * 1024 },
    dedupeWindowMs: 60_000,
    maxPayloadBytes: 300_000 + 4096,
  }),
);
const connections = new Set<() => Promise<void>>();

/** Parent calls this before stopping the process Sync runtime. */
export const stopMailDraftConnections = async (): Promise<void> => {
  const results = await Promise.allSettled([...connections].map((stop) => stop()));
  for (const result of results) if (result.status === "rejected") log.error("Draft socket shutdown failed", { error: result.reason });
};

type FenceRow = {
  state: string;
  edit_mode: string;
  author_kind: string;
  doc_generation: string | number;
  doc_history_complete: boolean;
  doc_frozen_cursor: string | null;
};

/** Mount inside mailOperationsApi, after its existing public-ID resolution and auth. */
export const upgradeMailDraftDocumentSocket = async (c: Context<MailApiContext>): Promise<Response> => {
  // Validate on every handshake, including a reconnect after the browser cookie changed.
  const accountRejection = draftDocumentAccountRejection(c);
  if (accountRejection) return accountRejection;
  const initialActor = c.get("actor");
  const mailboxId = c.get("internalMailboxId");
  const draftId = c.get("internalDraftId");
  const docId = c.req.param("draftId");
  const t = mailDraftDocumentMessages.resolve([getLocale(c)]).t;
  // OAuth and delegated API keys must not borrow an unrelated browser cookie.
  if (initialActor?.kind !== "user" || c.get("credentialKind") !== "session") return c.json({ message: t.session }, 401);
  if (!mailboxId || !draftId || !docId) return c.json({ message: t.missing }, 404);
  const token = await auth.session.resolveToken(c);
  const initialSession = token ? await auth.session.authenticate(token) : null;
  if (!token || !initialSession || initialSession.user.id !== initialActor.user.id) return c.json({ message: t.session }, 401);
  const requestId = c.req.header("x-request-id") ?? null;
  const contextFor = (session: NonNullable<typeof initialSession>): MailRequestContext => ({
    actor: { kind: "user", user: session.user, ...(session.data.kind === "app" ? { sessionKind: "app" as const } : {}) },
    accessSubject: { type: "user", userId: session.user.id },
    requestId,
  });
  let context = contextFor(initialSession);
  const access = await requireDraftAccess(context, mailboxId, draftId, "write");
  if (!access.ok) return c.json({ message: t.access }, access.error.status === 404 ? 404 : 403);

  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, c.req.raw.signal]);
  let socket: WSContext | undefined;
  let closed = false;
  let joined = false;
  let generation: string | null = null;
  const peerId = crypto.randomUUID();
  let trusted: ReturnType<typeof createTrustedTextAwareness> | null = null;
  let messageTail = Promise.resolve();
  let deliveryTail = Promise.resolve();
  let pendingMessages = 0;
  let pendingBytes = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let cleanup: Promise<void> | undefined;
  const tasks = new Set<Promise<void>>();
  let deliveredCursor: string | null = null;
  let committedSnapshot: DraftDocumentSnapshot | null = null;

  const track = (task: Promise<void>) => {
    tasks.add(task);
    void task.finally(() => tasks.delete(task)).catch((error: unknown) => log.error("Draft socket task failed", { error }));
  };
  const send = (packet: MailDraftDocumentMessage): boolean => {
    if (closed || !socket || socket.readyState !== 1) return false;
    const raw: unknown = socket.raw;
    const amount: unknown =
      raw && typeof raw === "object" && "getBufferedAmount" in raw && typeof raw.getBufferedAmount === "function"
        ? raw.getBufferedAmount()
        : raw && typeof raw === "object" && "bufferedAmount" in raw
          ? raw.bufferedAmount
          : undefined;
    const buffered = typeof amount === "number" && Number.isFinite(amount) && amount >= 0 ? amount : MAX_BUFFER_BYTES;
    const text = JSON.stringify(packet);
    if (buffered + new TextEncoder().encode(text).byteLength > MAX_BUFFER_BYTES) {
      close("BACKPRESSURE", t.busy, 1013);
      return false;
    }
    try {
      socket.send(text);
      return true;
    } catch {
      close("STREAM_FAILED", t.network, 1012);
      return false;
    }
  };
  const stop = (): Promise<void> => {
    if (cleanup) return cleanup;
    closed = true;
    abort.abort();
    if (refreshTimer) clearTimeout(refreshTimer);
    c.req.raw.signal.removeEventListener("abort", onAbort);
    cleanup = (async () => {
      await messageTail;
      await Promise.allSettled([...tasks]);
      await deliveryTail;
      const removal = trusted?.remove();
      if (removal && generation) {
        try {
          await awarenessTopic().publish({
            tenantId: draftId,
            data: { kind: "awareness", payload: toBase64(removal), generation, originNodeId: sharedTextNodeId, originPeerId: peerId },
          });
        } catch (error) {
          log.warn("Draft awareness removal failed; protocol expiry remains active", { error });
        }
      }
    })().finally(() => connections.delete(stop));
    try {
      socket?.close(1012, "STREAM_FAILED");
    } catch {
      /* Already disconnected. */
    }
    return cleanup;
  };
  function close(code: string, message: string, closeCode = 1008, reopen?: true): void {
    if (closed) return;
    // Error delivery is deliberately bounded and never recursively calls send().
    try {
      socket?.send(JSON.stringify({ type: "error", payload: { docId, code, message, ...(reopen ? { reopen } : {}) } }));
    } catch {
      /* Close still exposes a terminal reason. */
    }
    try {
      socket?.close(closeCode, code);
    } catch {
      /* Stop cleans up even on a broken socket. */
    }
    void stop().catch((error: unknown) => log.error("Draft socket cleanup failed", { error }));
  }
  const onAbort = () => close("STREAM_FAILED", t.network, 1012);
  const reopen = () => close("RESYNC_REQUIRED", t.reopen, 1012, true);
  const failure = (error: unknown) => {
    if (closed || signal.aborted) return;
    log.error("Draft document connection failed", { draftId, error });
    if (error instanceof RetentionGapError || error instanceof CursorMismatchError) close("RESYNC_REQUIRED", t.network, 1012);
    else close("STREAM_FAILED", t.network, 1012);
  };

  const refresh = async (): Promise<boolean> => {
    const current = await auth.session.authenticate(token);
    if (closed || signal.aborted) return false;
    if (!current || current.user.id !== initialActor.user.id) {
      close("SESSION_EXPIRED", t.session);
      return false;
    }
    context = contextFor(current);
    const allowed = await requireDraftAccess(context, mailboxId, draftId, "write");
    if (!allowed.ok) {
      close("ACCESS_DENIED", t.access);
      return false;
    }
    return true;
  };

  /** No await between checking the locked row and sending bytes. The send/send-cancel transaction uses this same row. */
  const deliver = (emit: () => void | Promise<void>): Promise<void> => {
    const work = deliveryTail.then(async () => {
      if (closed || signal.aborted) return;
      await withDraftDocumentTransaction(signal, async (db) => {
        const [row] = await awaitDraftDocumentQuery(
          db<FenceRow[]>`
          SELECT state, edit_mode, author_kind, doc_generation, doc_history_complete, doc_frozen_cursor
          FROM mail.drafts WHERE id = ${draftId}::uuid AND mailbox_id = ${mailboxId}::uuid AND origin = 'user'
          FOR UPDATE
        `,
          signal,
        );
        const allowed = await requireDraftAccess(context, mailboxId, draftId, "write", db);
        if (closed || signal.aborted) return;
        if (!allowed.ok) {
          close("ACCESS_DENIED", t.access);
          return;
        }
        if (!row) {
          close("DOCUMENT_NOT_FOUND", t.missing);
          return;
        }
        if (
          row.edit_mode !== "shared" ||
          row.author_kind === "workflow" ||
          row.state !== "draft" ||
          !row.doc_history_complete ||
          row.doc_frozen_cursor !== null ||
          (generation !== null && String(row.doc_generation) !== generation)
        ) {
          reopen();
          return;
        }
        await emit();
      });
    });
    deliveryTail = work.catch(failure);
    return deliveryTail;
  };

  const sendSnapshot = (snapshot: DraftDocumentSnapshot) => {
    if (!generation) return;
    const payload = toBase64(snapshot.state);
    if (payload.length > MAX_DRAFT_DOCUMENT_PAYLOAD) {
      close("BACKPRESSURE", t.busy, 1009);
      return;
    }
    send({
      type: "syncPush",
      payload: {
        docId,
        generation,
        snapshot: true,
        updates: [{ payload, generation, ...(snapshot.cursor ? { cursor: snapshot.cursor } : {}) }],
      },
    });
  };
  const flushCommittedSnapshot = () => {
    if (committedSnapshot?.cursor && deliveredCursor && compareStreamCursor(deliveredCursor, committedSnapshot.cursor) >= 0) {
      sendSnapshot(committedSnapshot);
      committedSnapshot = null;
    }
  };
  const deliverEvent = async (event: TopicEvent<SharedTextSyncEvent>): Promise<void> => {
    await deliver(() => {
      // Rolled-back sends may leave a retained marker. Only the locked row's
      // committed frozen metadata above closes the connection; an orphan is inert.
      if (event.data.kind === "freeze") {
        deliveredCursor = event.cursor;
        flushCommittedSnapshot();
        return;
      }
      if (event.data.restoreRevision !== generation) {
        if (event.data.restoreRevision && generation && BigInt(event.data.restoreRevision) < BigInt(generation)) return;
        reopen();
        return;
      }
      if (!isValidSharedTextUpdate(event.data.payload) || !generation) {
        close("INVALID_PAYLOAD", t.invalid);
        return;
      }
      send({
        type: "syncPush",
        payload: {
          docId,
          generation,
          updates: [
            {
              payload: event.data.payload,
              cursor: event.cursor,
              generation,
              originPeerId: event.data.originPeerId,
              ...(event.data.actionId ? { actionId: event.data.actionId } : {}),
              ...(event.data.history?.retained ? { retainedColumn: true } : {}),
            },
          ],
        },
      });
      deliveredCursor = event.cursor;
      flushCommittedSnapshot();
    });
  };
  const runDocumentStream = async (after: string | null): Promise<void> => {
    try {
      const topic = mailDraftDocumentLog.topic();
      const head = await topic.latestCursor({ tenantId: draftId });
      if (head && compareStreamCursor(after ?? topic.cursorAt(0), head) > 0) {
        close("RESYNC_REQUIRED", t.network, 1012);
        return;
      }
      if (head)
        for await (const event of topic.replay({ tenantId: draftId, after: after ?? topic.cursorAt(0), until: head, signal })) {
          await deliverEvent(event);
          if (closed) return;
        }
      const cursor = head ?? after ?? topic.cursorAt(0);
      await deliver(() => {
        if (!generation) return;
        joined = true;
        deliveredCursor = cursor;
        send({ type: "replayReady", payload: { docId, generation, cursor, peerId } });
      });
      if (closed) return;
      for await (const event of topic.hub({ tenantId: draftId }).subscribe({ after: cursor, signal, bufferLimit: MAX_PENDING_MESSAGES })) {
        await deliverEvent(event);
        if (closed) return;
      }
      if (!closed) close("STREAM_FAILED", t.network, 1012);
    } catch (error) {
      failure(error);
    }
  };
  const runAwarenessStream = async (): Promise<void> => {
    try {
      for await (const event of awarenessTopic().live({ tenantId: draftId, signal })) {
        if (closed) return;
        if (event.data.generation !== generation) continue;
        await deliver(() => {
          if (generation)
            send({
              type: "awarenessPush",
              payload: { docId, generation, updates: [{ payload: event.data.payload, generation, originPeerId: event.data.originPeerId }] },
            });
        });
      }
      if (!closed) close("STREAM_FAILED", t.network, 1012);
    } catch (error) {
      failure(error);
    }
  };

  const handle = async (message: MailDraftDocumentRequest): Promise<void> => {
    if (closed || signal.aborted) return;
    if (message.payload.docId !== docId) {
      close("INVALID_PAYLOAD", t.invalid);
      return;
    }
    if (!(await refresh())) return;
    if (message.type === "replayRequest") {
      if (generation !== null) {
        close("INVALID_PAYLOAD", t.invalid);
        return;
      }
      await deliver(() => undefined);
      if (closed) return;
      const session = await readDraftDocument({ context, mailboxId, draftId, signal });
      if (closed) return;
      if (!session.ok) {
        if (session.error.status === 401 || session.error.status === 403) close("ACCESS_DENIED", t.access);
        else if (session.error.status === 404) close("DOCUMENT_NOT_FOUND", t.missing);
        else close("STREAM_FAILED", t.network, 1012);
        return;
      }
      const state = session.data;
      if (
        (message.payload.generation !== null && message.payload.generation !== state.generation) ||
        state.lifecycle !== "draft" ||
        state.frozen ||
        !state.historyComplete
      ) {
        reopen();
        return;
      }
      generation = state.generation;
      const after = message.payload.fromCursor;
      // A null base always starts from the SQL snapshot. Fresh replay bytes are never marked durable.
      if (after === null) await deliver(() => sendSnapshot(state.durable));
      if (closed) return;
      track(runAwarenessStream());
      track(runDocumentStream(after ?? state.durable.cursor));
      return;
    }
    if (!joined || generation === null) {
      close("INVALID_PAYLOAD", t.invalid);
      return;
    }
    if (message.payload.generation !== generation) {
      reopen();
      return;
    }
    if (message.type === "syncPublish") {
      if (!isValidSharedTextUpdate(message.payload.payload)) {
        close("INVALID_PAYLOAD", t.invalid);
        return;
      }
      const result = await acceptDraftDocumentUpdate({
        context,
        mailboxId,
        draftId,
        generation,
        baseCursor: message.payload.baseCursor,
        update: fromBase64(message.payload.payload),
        originNodeId: sharedTextNodeId,
        originPeerId: peerId,
        signal,
      });
      if (closed) return;
      if (!result.ok) {
        if (result.error.status === 403 || result.error.status === 401) close("ACCESS_DENIED", t.access);
        else reopen();
        return;
      }
      if (result.data.status === "recoveryRequired") {
        reopen();
        return;
      }
      if (result.data.status === "pendingPersistence") {
        send({ type: "error", payload: { docId, code: "PENDING_PERSISTENCE", message: t.pending } });
        return;
      }
      // Only committed service success may notify offline storage of durable coverage.
      // The retained event, never the client packet, supplies the update echo.
      committedSnapshot = result.data.durable;
      await deliver(flushCommittedSnapshot);
      return;
    }
    if (!trusted) {
      const reservation = await awarenessTopic().publish({
        tenantId: draftId,
        data: { kind: "awareness", payload: "AA==", generation, originNodeId: sharedTextNodeId, originPeerId: peerId },
      });
      if (closed) return;
      if (context.actor.kind !== "user") {
        close("SESSION_EXPIRED", t.session);
        return;
      }
      trusted = createTrustedTextAwareness({
        clientId: 2 ** 32 + reservation.streamSequence,
        textName: "codemirror",
        user: {
          userId: context.actor.user.id,
          name: context.actor.user.displayName,
          color: userColor(context.actor.user.id),
        },
      });
    }
    let payload: string;
    try {
      payload = toBase64(trusted.publish(fromBase64(message.payload.payload)));
    } catch (error) {
      if (!(error instanceof InvalidSharedTextAwarenessError)) throw error;
      close("INVALID_PAYLOAD", t.invalid);
      return;
    }
    if (payload.length > MAX_DRAFT_AWARENESS_PAYLOAD) {
      close("INVALID_PAYLOAD", t.invalid, 1009);
      return;
    }
    // Fence awareness writes with the same row lock too; no stale generation can publish after send/cancel.
    await deliver(async () => {
      if (generation)
        await awarenessTopic().publish({
          tenantId: draftId,
          data: { kind: "awareness", payload, generation, originNodeId: sharedTextNodeId, originPeerId: peerId },
        });
    });
  };
  const scheduleRefresh = () => {
    if (closed) return;
    refreshTimer = setTimeout(() => {
      const task = (async () => {
        try {
          if (await refresh()) {
            if (generation !== null) await deliver(() => undefined);
            scheduleRefresh();
          }
        } catch (error) {
          failure(error);
        }
      })();
      track(task);
    }, DRAFT_DOCUMENT_ACCESS_REFRESH_MS);
  };
  const events: WSEvents = {
    onOpen: (_event, ws) => {
      socket = ws;
      connections.add(stop);
      c.req.raw.signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      scheduleRefresh();
    },
    onMessage: (event) => {
      if (closed) return;
      if (typeof event.data !== "string" || event.data.length > MAX_MESSAGE_LENGTH) {
        close("INVALID_PAYLOAD", t.invalid, 1009);
        return;
      }
      const raw = event.data;
      const size = new TextEncoder().encode(raw).byteLength;
      if (pendingMessages >= MAX_PENDING_MESSAGES || pendingBytes + size > MAX_BUFFER_BYTES) {
        close("BACKPRESSURE", t.busy, 1013);
        return;
      }
      pendingMessages++;
      pendingBytes += size;
      messageTail = messageTail
        .then(async () => {
          if (closed) return;
          let packet: unknown;
          try {
            packet = JSON.parse(raw);
          } catch {
            close("INVALID_PAYLOAD", t.invalid);
            return;
          }
          const parsed = mailDraftDocumentRequestSchema.safeParse(packet);
          if (!parsed.success) {
            close("INVALID_PAYLOAD", t.invalid);
            return;
          }
          await handle(parsed.data);
        })
        .catch(failure)
        .finally(() => {
          pendingMessages--;
          pendingBytes -= size;
        });
    },
    onClose: () => {
      void stop().catch((error: unknown) => log.error("Draft socket cleanup failed", { error }));
    },
    onError: () => close("STREAM_FAILED", t.network, 1012),
  };
  return upgradeWebSocket(c, events);
};
