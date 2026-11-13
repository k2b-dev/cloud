import { subscribeIdentityAccessChanged } from "@k2b/cloud/events";
import { auth, getLocale, guardAppAccessSocket } from "@k2b/cloud/server";
import { logger } from "@k2b/cloud/services";
import { createSharedTextRoomContext } from "@k2b/cloud/shared-text";
import type { Context } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { mailDraftDocumentMessages, mailDraftDocumentRequestSchema } from "../lib/draft-document-protocol";
import { DRAFT_SOCKET_LIMITS, draftDocumentBudget } from "../service/draft-document-budget";
import { draftTrace, draftTraceContext, draftTraceSocketSend, withDraftTrace } from "../service/draft-document-diagnostics";
import { type MailDraftRoomContext, type MailDraftRoomMessages, mailDraftRoom } from "../service/draft-document-room";
import { draftDocumentAccountRejection } from "./draft-document-identity";
import type { MailApiContext } from "./public-resource-boundary";

const log = logger("mail:draft-document-socket");
const connections = new Set<() => Promise<void>>();
export const mailDraftConnectionStats = () => draftDocumentBudget.snapshot();
export const stopMailDraftConnections = async () => {
  await Promise.all([...connections].map((stop) => stop()));
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
  const lifetime = new AbortController();
  const joinSignal = AbortSignal.any([lifetime.signal, c.req.raw.signal]);
  let ctx: MailDraftRoomContext | undefined;
  let outboundBytes = 0;
  const messages: MailDraftRoomMessages = {
    document: {
      mailboxId,
      draftId,
      publicId,
      userId: actor.user.id,
      requestId: c.req.header("x-request-id") ?? null,
      signal: joinSignal,
      senders: new Set(),
      signatures: new Set(),
      seededSignature: null,
      generation: null,
    },
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
    busy: t.busy,
    handlingFailed: t.network,
    messageNotAllowed: () => t.reopen,
  };
  let connection: ReturnType<typeof mailDraftRoom.connect> | undefined;
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
          connection = mailDraftRoom.connect(ctx);
          connections.add(stop);
          const proof = c.get("credentialProof");
          stopIdentity = subscribeIdentityAccessChanged(
            () => {
              if (ctx) void mailDraftRoom.revalidate(ctx);
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
            if (ctx) return mailDraftRoom.fatal(ctx, "BACKPRESSURE", t.busy, publicId);
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
