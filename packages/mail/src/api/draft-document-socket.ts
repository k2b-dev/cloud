import { lazySync, sql } from "@k2b/cloud";
import { subscribeIdentityAccessChanged } from "@k2b/cloud/events";
import { auth, getLocale, guardAppAccessSocket } from "@k2b/cloud/server";
import { logger } from "@k2b/cloud/services";
import {
  createSharedTextRoom,
  createSharedTextRoomContext,
  type SharedTextEvent,
  type SharedTextRoomContext,
  type SharedTextRoomMessages,
  type SharedTextRoomSnapshot,
} from "@k2b/cloud/shared-text";
import type { Context } from "hono";
import { upgradeWebSocket } from "hono/bun";
import * as Y from "yjs";
import { z } from "zod";
import { ResourceShortIdSchema } from "../contracts";
import { MAX_DRAFT_DOCUMENT_PAYLOAD } from "../draft-document-contracts";
import { readDraftDocument as projectDocument } from "../lib/draft-document";
import { mailDraftDocumentMessages, mailDraftDocumentRequestSchema } from "../lib/draft-document-protocol";
import { requireDraftAccess } from "../service/access";
import type { MailRequestContext } from "../service/auth";
import { removeOrphanComposeSegmentMarks } from "../service/compose-renderer";
import { DRAFT_SOCKET_LIMITS, draftDocumentBudget } from "../service/draft-document-budget";
import { draftTrace, draftTraceContext, draftTraceSocketSend, withDraftTrace } from "../service/draft-document-diagnostics";
import { mailDraftDocumentLog } from "../service/draft-document-log";
import {
  draftDocumentSnapshotStore,
  draftDocumentSnapshots,
  flushDraftDocumentSnapshot,
  markDraftDocumentDirty,
} from "../service/draft-document-snapshots";
import { readDraftDocument } from "../service/draft-documents";
import { requireDraftLeaseAvailable } from "../service/draft-leases";
import { mailLive } from "../service/live";
import { draftDocumentAccountRejection } from "./draft-document-identity";
import type { MailApiContext } from "./public-resource-boundary";

const log = logger("mail:draft-document-socket");
const awarenessTopic = lazySync((sync) =>
  sync.topic<SharedTextEvent & { kind: "awareness" }>({
    id: "cloud:mail:draft-document-awareness",
    retention: { maxAgeMs: 60_000, maxBytes: 64 * 1024 * 1024 },
    dedupeWindowMs: 60_000,
    maxPayloadBytes: 300_000 + 4096,
  }),
);
const connections = new Set<() => Promise<void>>();
export const mailDraftConnectionStats = () => draftDocumentBudget.snapshot();
export const stopMailDraftConnections = async () => {
  await Promise.all([...connections].map((stop) => stop()));
};
type Session = NonNullable<Awaited<ReturnType<typeof auth.session.authenticate>>>;
type RoomContext = SharedTextRoomContext<Session, SharedTextRoomMessages>;
const color = (id: string) => {
  const colors = ["#e06c75", "#61afef", "#98c379", "#d19a66", "#c678dd", "#56b6c2", "#e5c07b"];
  let hash = 0;
  for (const character of id) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length]!;
};

/** The route owns identity/transport; the platform room owns admission, replay and fan-out. */
export const upgradeMailDraftDocumentSocket = async (c: Context<MailApiContext>): Promise<Response> => {
  const rejection = draftDocumentAccountRejection(c);
  if (rejection) return rejection;
  const actor = c.get("actor"),
    mailboxId = c.get("internalMailboxId"),
    draftId = c.get("internalDraftId"),
    publicId = c.req.param("draftId");
  const t = mailDraftDocumentMessages.resolve([getLocale(c)]).t;
  if (actor?.kind !== "user" || c.get("credentialKind") !== "session") return c.json({ message: t.session }, 401);
  if (!mailboxId || !draftId || !publicId) return c.json({ message: t.missing }, 404);
  const credential = await auth.session.resolveToken(c);
  if (!credential) return c.json({ message: t.session }, 401);
  const contextFor = (session: Session): MailRequestContext => ({
    actor: { kind: "user", user: session.user, ...(session.data.kind === "app" ? { sessionKind: "app" as const } : {}) },
    accessSubject: { type: "user", userId: session.user.id },
    requestId: c.req.header("x-request-id") ?? null,
  });
  const lifetime = new AbortController();
  const joinSignal = AbortSignal.any([lifetime.signal, c.req.raw.signal]);
  let snapshot: SharedTextRoomSnapshot | null = null;
  let ctx: RoomContext | undefined;
  let senders = new Set<string>(),
    signatures = new Set<string>();
  let outboundBytes = 0;
  let seededSignature: string | null = null;
  const authorize = async (id: string, session: Session) => {
    if (id !== publicId || session.user.id !== actor.user.id) return { ok: false, code: "ACCESS_DENIED" };
    // Capture the retained access stream before SQL so a concurrent revocation cannot fall between join and watch.
    const invalidationCursor = await mailLive.cursor();
    const context = contextFor(session);
    const access = await requireDraftAccess(context, mailboxId, draftId, "write");
    if (!access.ok) return { ok: false, code: "ACCESS_DENIED", message: t.access };
    const lease = await requireDraftLeaseAvailable({ context, mailboxId, draftId });
    if (!lease.ok) return { ok: false, code: "ACCESS_DENIED", message: lease.error.message };
    const read = await readDraftDocument({ context, mailboxId, draftId, signal: joinSignal });
    if (!read.ok) return { ok: false, code: "RESYNC_REQUIRED", message: t.reopen };
    if (read.data.lifecycle !== "draft" || read.data.frozen || !read.data.historyComplete)
      return { ok: false, code: "RESYNC_REQUIRED", message: t.reopen };
    if (ctx?.restoreRevision && ctx.restoreRevision !== read.data.generation)
      return { ok: false, code: "RESYNC_REQUIRED", message: t.reopen };
    snapshot = {
      state: read.data.durable.state,
      cursor: read.data.durable.cursor,
      text: read.data.durable.content.body,
      restoreRevision: read.data.generation,
    };
    seededSignature = read.data.durable.content.signatureTemplateId ?? null;
    const identities = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.sender_identities
      WHERE mailbox_id = ${mailboxId}::uuid AND status = 'verified'`;
    const templates = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.compose_templates
      WHERE mailbox_id = ${mailboxId}::uuid AND kind = 'signature' AND archived_at IS NULL
        AND (scope = 'mailbox' OR owner_user_id = ${session.user.id}::uuid)`;
    senders = new Set(identities.map((row) => row.short_id));
    signatures = new Set(templates.map((row) => row.short_id));
    return { ok: true, resolvedDocId: draftId, scope: mailboxId, invalidationCursor, canWrite: true };
  };
  const messages: SharedTextRoomMessages = {
    notFound: t.missing,
    sessionExpired: t.session,
    accessDenied: t.access,
    writeAccessRequired: t.access,
    accessRefreshFailed: t.access,
    liveSyncStorageExhausted: t.streamFull,
    liveSyncStreamFailed: t.network,
    liveAwarenessStreamFailed: t.network,
    replayRequired: t.reopen,
    reopenRequired: t.reopen,
    loginRequired: t.session,
    invalidSyncUpdate: t.invalid,
    invalidBase64: t.invalid,
    invalidMessage: t.invalid,
    invalidJson: t.invalid,
    jsonTextOnly: t.invalid,
    messageTooLarge: t.busy,
    tooManyMessages: t.busy,
    handlingFailed: t.network,
    messageNotAllowed: () => t.reopen,
  };
  const room = createSharedTextRoom<Session, SharedTextRoomMessages>({
    log: mailDraftDocumentLog,
    awarenessTopic,
    logger: log,
    maxLength: 2_097_152,
    deliveryBudget: {
      claim: (bytes) => draftDocumentBudget.claim("delivery", bytes),
      release: (bytes) => draftDocumentBudget.release("delivery", bytes),
    },
    protocol: {
      wsType: {
        replayRequest: "replayRequest",
        replayReady: "replayReady",
        syncPublish: "syncPublish",
        syncPush: "syncPush",
        awarenessPublish: "awarenessPublish",
        awarenessPush: "awarenessPush",
        error: "error",
      },
      documentId: ResourceShortIdSchema,
      maxSyncPayloadLength: MAX_DRAFT_DOCUMENT_PAYLOAD,
      streamCursorPattern: /^s6t\./,
      decode: (packet) => {
        if (!packet || typeof packet !== "object" || !("payload" in packet) || !packet.payload || typeof packet.payload !== "object")
          return packet;
        return {
          ...packet,
          payload: { ...packet.payload, restoreRevision: "generation" in packet.payload ? packet.payload.generation : undefined },
        };
      },
      encode: (type, payload) => {
        if (!payload || typeof payload !== "object") return { type, payload };
        const { restoreRevision, ...rest } = z.record(z.string(), z.unknown()).parse(payload);
        const generation = restoreRevision ?? ctx?.restoreRevision;
        if (Array.isArray(rest.updates))
          rest.updates = rest.updates.map((update: unknown) => {
            const { restoreRevision: revision, cursor, ...fields } = z.record(z.string(), z.unknown()).parse(update);
            return { ...fields, generation: revision ?? generation, ...(cursor ? { cursor } : {}) };
          });
        return { type, payload: { ...rest, ...(type === "error" ? {} : { generation }) } };
      },
    },
    validateState: (state) => {
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, state);
        const content = projectDocument(doc);
        return (
          senders.has(content.senderIdentityId) &&
          (content.signatureTemplateId === null ||
            content.signatureTemplateId === seededSignature ||
            (typeof content.signatureTemplateId === "string" && signatures.has(content.signatureTemplateId))) &&
          removeOrphanComposeSegmentMarks(content.body) === content.body
        );
      } catch {
        return false;
      } finally {
        doc.destroy();
      }
    },
    snapshots: {
      markDirty: markDraftDocumentDirty,
      queue: async ({ docId, targetCursor, reason }) => {
        if (reason === "unload") await flushDraftDocumentSnapshot(docId);
        else await draftDocumentSnapshots.queue({ docId, targetCursor, reason });
      },
    },
    adapter: {
      authenticate: async (token) => {
        const session = token ? await auth.session.authenticate(token) : null;
        return session?.user.id === actor.user.id ? session : null;
      },
      authorize,
      load: async () => snapshot,
      actor: (session) => ({ kind: "user", id: session.user.id }),
      awarenessUser: (session) => ({ userId: session.user.id, name: session.user.displayName, color: color(session.user.id) }),
      revalidate: async (current) => {
        const session = credential ? await auth.session.authenticate(credential) : null;
        if (!session || session.user.id !== actor.user.id) return { ok: false, code: "SESSION_EXPIRED", message: t.session };
        return authorize(publicId, session);
      },
      invalidations: async function* (current, signal) {
        if (!current.invalidationCursor) return;
        for await (const event of mailLive.accessChanges({ after: current.invalidationCursor, signal }))
          if (event.key === mailboxId) yield event;
      },
      recover: (docId, cause, signal) => draftDocumentSnapshotStore.recover(docId, cause, { signal }),
    },
  });
  let connection: ReturnType<typeof room.connect> | undefined;
  let stopIdentity = () => {};
  let release: (() => boolean) | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      lifetime.abort();
      c.req.raw.signal.removeEventListener("abort", onAbort);
      stopIdentity();
      try {
        await connection?.close();
      } finally {
        release?.();
        draftDocumentBudget.release("outbound", outboundBytes);
        outboundBytes = 0;
        connections.delete(stop);
      }
    })());
  const onAbort = () => {
    void stop().catch((error) => log.error("Draft cleanup failed", { error }));
  };
  const response = await upgradeWebSocket(() =>
    guardAppAccessSocket(
      c,
      "mail",
      {
        onOpen(_, ws) {
          const slot = draftDocumentBudget.acquire(draftId);
          if (!slot) {
            ws.close(1013, "BACKPRESSURE");
            return;
          }
          release = slot;
          ctx = createSharedTextRoomContext(
            {
              send(data) {
                const raw = ws.raw;
                const buffered =
                  raw && typeof raw === "object" && "getBufferedAmount" in raw && typeof raw.getBufferedAmount === "function"
                    ? Number(raw.getBufferedAmount())
                    : 0;
                draftDocumentBudget.release("outbound", outboundBytes);
                outboundBytes = 0;
                const bytes = buffered + Buffer.byteLength(data);
                if (bytes > DRAFT_SOCKET_LIMITS.connectionBytes || !draftDocumentBudget.claim("outbound", bytes)) {
                  ws.close(1013, "BACKPRESSURE");
                  return;
                }
                outboundBytes = bytes;
                draftTraceSocketSend(data, ctx?.peerId ?? "");
                ws.send(data);
              },
              close(code, reason) {
                ws.close(code, reason);
              },
            },
            credential,
            messages,
          );
          connection = room.connect(ctx);
          connections.add(stop);
          const proof = c.get("credentialProof");
          stopIdentity = subscribeIdentityAccessChanged(
            () => {
              if (ctx) void room.revalidate(ctx);
            },
            { userId: actor.user.id, ...(proof?.kind === "session" ? { sid: proof.sid } : {}) },
          );
          c.req.raw.signal.addEventListener("abort", onAbort, { once: true });
          if (c.req.raw.signal.aborted) onAbort();
        },
        onMessage(event) {
          if (!connection || typeof event.data !== "string") return connection?.receive(event.data);
          const bytes = Buffer.byteLength(event.data) * 2;
          if (!draftDocumentBudget.claim("ingress", bytes)) {
            if (ctx) return room.fatal(ctx, "BACKPRESSURE", t.busy, publicId);
            return;
          }
          let decoded: unknown;
          try {
            decoded = JSON.parse(event.data);
          } catch {
            /* Room reports invalid JSON. */
          }
          const packet = mailDraftDocumentRequestSchema.safeParse(decoded);
          const scope =
            packet.success && packet.data.type === "syncPublish"
              ? draftTraceContext(packet.data.payload.payload, ctx?.peerId ?? "", "ingress")
              : undefined;
          withDraftTrace(scope, () => {
            draftTrace("socket_receive");
            void connection?.receive(event.data);
          });
          return connection.settled().finally(() => draftDocumentBudget.release("ingress", bytes));
        },
        onClose(event) {
          if (event.code === 1008 || event.code === 1009 || event.code === 1012 || event.code === 1013)
            draftDocumentBudget.recordClose(event.code);
          return stop();
        },
        onError: stop,
      },
      { eventOnly: true },
    ),
  )(c, async () => {});
  if (!response) throw new Error("WebSocket upgrade did not return a response");
  return response;
};
