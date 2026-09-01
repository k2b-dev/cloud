import type { Result } from "@k2b/stdlib";
import type { PermissionLevel } from "@valentinkolb/cloud/server";
import { type AuthContext, auth, getLocale } from "@valentinkolb/cloud/server";
import { logger } from "@valentinkolb/cloud/services";
import type { ServerWebSocket } from "bun";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { getCookie } from "hono/cookie";
import {
  MAIL_LIVE_WS_TYPE,
  MailInvalidationSchema,
  MailLiveClientMessageSchema,
  MailLiveCursorSchema,
  type MailLiveErrorCode,
  type MailLiveRevocationCode,
  type MailLiveServerMessage,
} from "./live-events";
import type { MailRequestContext } from "./service/auth";
import * as collaboration from "./service/collaboration";
import { latestMailInvalidationCursor, liveMailInvalidations } from "./service/events";
import { resolvePublicId } from "./service/public-resources";
import { type MailWsMessages, mailWsMessages } from "./ws-messages";

const log = logger("mail:websocket");
const ACCESS_REFRESH_INTERVAL_MS = 8_000;
const MAX_CLIENT_MESSAGE_LENGTH = 16_000;
const MAX_PENDING_MESSAGES = 8;

type WsPhase = "open" | "subscribed" | "closing";

type WsContext = {
  socket: ServerWebSocket<unknown>;
  sessionToken: string | null;
  requestId: string | null;
  locale: string;
  messages: MailWsMessages;
  phase: WsPhase;
  mailboxId: string | null;
  internalMailboxId: string | null;
  streamAbort: AbortController | null;
  accessRefreshTimer: ReturnType<typeof setTimeout> | null;
};

type MailLiveAccessResult = { ok: true } | { ok: false; code: MailLiveRevocationCode; message: string };

export type MailLiveAccessDependencies = {
  resolveContext: (sessionToken: string | null, requestId: string | null) => Promise<MailRequestContext | null>;
  requireRead: (context: MailRequestContext, mailboxId: string) => Promise<Result<PermissionLevel>>;
};

const resolveCurrentContext = async (sessionToken: string | null, requestId: string | null): Promise<MailRequestContext | null> => {
  if (!sessionToken) return null;
  const authenticated = await auth.session.authenticate(sessionToken);
  if (!authenticated) return null;
  const { user } = authenticated;
  return {
    actor: { kind: "user", user },
    accessSubject: { type: "user", userId: user.id },
    requestId,
  };
};

const accessDependencies: MailLiveAccessDependencies = {
  resolveContext: resolveCurrentContext,
  requireRead: (context, mailboxId) => collaboration.requireMailboxCollaborationPermission(context, mailboxId, "read"),
};

export const evaluateMailLiveAccess = async (
  input: { sessionToken: string | null; requestId: string | null; mailboxId: string; locale?: string | null },
  dependencies: MailLiveAccessDependencies = accessDependencies,
): Promise<MailLiveAccessResult> => {
  const context = await dependencies.resolveContext(input.sessionToken, input.requestId);
  const messages = mailWsMessages(input.locale);
  if (!context) return { ok: false, code: "login_required", message: messages.loginRequired };
  const allowed = await dependencies.requireRead(context, input.mailboxId);
  if (allowed.ok) return { ok: true };
  return {
    ok: false,
    code: allowed.error.status === 404 ? "not_found" : "access_denied",
    message: allowed.error.status === 404 ? messages.mailboxNotFound : messages.accessDenied,
  };
};

export const resolveMailLiveCursor = async (
  mailboxId: string,
  fromCursor: string | null,
  latestCursor: (mailboxId: string) => Promise<string | null> = latestMailInvalidationCursor,
): Promise<string> => MailLiveCursorSchema.parse(fromCursor ?? (await latestCursor(mailboxId)) ?? "0-0");

export const parseMailLiveReplayEvent = (mailboxId: string, event: { cursor: string; data: unknown }) => {
  const cursor = MailLiveCursorSchema.safeParse(event.cursor);
  const payload = MailInvalidationSchema.safeParse(event.data);
  if (!cursor.success || !payload.success || payload.data.mailboxId !== mailboxId) return null;
  return { cursor: cursor.data, event: payload.data };
};

const createContext = (
  socket: ServerWebSocket<unknown>,
  sessionToken: string | null,
  requestId: string | null,
  locale: string,
): WsContext => ({
  socket,
  sessionToken,
  requestId,
  locale,
  messages: mailWsMessages(locale),
  phase: "open",
  mailboxId: null,
  internalMailboxId: null,
  streamAbort: null,
  accessRefreshTimer: null,
});

const isClosing = (ctx: WsContext): boolean => ctx.phase === "closing";

const send = (socket: ServerWebSocket<unknown>, message: MailLiveServerMessage): boolean => {
  try {
    return socket.send(JSON.stringify(message)) > 0;
  } catch {
    return false;
  }
};

const stopStream = (ctx: WsContext) => {
  ctx.streamAbort?.abort();
  ctx.streamAbort = null;
};

const stopAccessRefresh = (ctx: WsContext) => {
  if (ctx.accessRefreshTimer) clearTimeout(ctx.accessRefreshTimer);
  ctx.accessRefreshTimer = null;
};

const stopSubscription = (ctx: WsContext) => {
  stopAccessRefresh(ctx);
  stopStream(ctx);
  ctx.mailboxId = null;
  ctx.internalMailboxId = null;
};

const closeWithError = (ctx: WsContext, code: MailLiveErrorCode, message: string, closeCode: number) => {
  if (isClosing(ctx)) return;
  const mailboxId = ctx.mailboxId ?? undefined;
  ctx.phase = "closing";
  stopSubscription(ctx);
  send(ctx.socket, { type: MAIL_LIVE_WS_TYPE.error, payload: { mailboxId, code, message } });
  ctx.socket.close(closeCode, code);
};

const revoke = (ctx: WsContext, mailboxId: string, access: Exclude<MailLiveAccessResult, { ok: true }>) => {
  if (isClosing(ctx)) return;
  ctx.phase = "closing";
  stopSubscription(ctx);
  send(ctx.socket, {
    type: MAIL_LIVE_WS_TYPE.revoked,
    payload: { mailboxId, code: access.code, message: access.message },
  });
  ctx.socket.close(1008, access.code);
};

const currentAccess = (ctx: WsContext, internalMailboxId: string) =>
  evaluateMailLiveAccess({ sessionToken: ctx.sessionToken, requestId: ctx.requestId, mailboxId: internalMailboxId, locale: ctx.locale });

const subscriptionIsCurrent = (ctx: WsContext, mailboxId: string, internalMailboxId: string, abort: AbortController): boolean =>
  !abort.signal.aborted && ctx.phase === "subscribed" && ctx.mailboxId === mailboxId && ctx.internalMailboxId === internalMailboxId;

const startAccessRefresh = (ctx: WsContext, mailboxId: string, internalMailboxId: string) => {
  stopAccessRefresh(ctx);
  ctx.accessRefreshTimer = setTimeout(async () => {
    if (ctx.phase !== "subscribed" || ctx.mailboxId !== mailboxId || ctx.internalMailboxId !== internalMailboxId) return;
    try {
      const access = await currentAccess(ctx, internalMailboxId);
      if (ctx.phase !== "subscribed" || ctx.mailboxId !== mailboxId || ctx.internalMailboxId !== internalMailboxId) return;
      if (!access.ok) {
        revoke(ctx, mailboxId, access);
        return;
      }
      startAccessRefresh(ctx, mailboxId, internalMailboxId);
    } catch (error) {
      if (ctx.phase !== "subscribed" || ctx.mailboxId !== mailboxId || ctx.internalMailboxId !== internalMailboxId) return;
      log.error("Mail WebSocket access refresh failed", {
        mailboxId,
        error: error instanceof Error ? error.message : String(error),
      });
      closeWithError(ctx, "internal_error", ctx.messages.accessRefreshFailed, 1011);
    }
  }, ACCESS_REFRESH_INTERVAL_MS);
};

const deliverReplayEvent = async (
  ctx: WsContext,
  mailboxId: string,
  internalMailboxId: string,
  abort: AbortController,
  event: { cursor: string; data: unknown },
): Promise<boolean> => {
  if (!subscriptionIsCurrent(ctx, mailboxId, internalMailboxId, abort)) return false;
  const access = await currentAccess(ctx, internalMailboxId);
  if (!subscriptionIsCurrent(ctx, mailboxId, internalMailboxId, abort)) return false;
  if (!access.ok) {
    revoke(ctx, mailboxId, access);
    return false;
  }

  const replay = parseMailLiveReplayEvent(mailboxId, event);
  if (!replay) {
    log.error("Mail WebSocket received an invalid replay event", { mailboxId, cursor: event.cursor });
    closeWithError(ctx, "internal_error", ctx.messages.invalidStreamData, 1011);
    return false;
  }
  if (send(ctx.socket, { type: MAIL_LIVE_WS_TYPE.event, payload: { mailboxId, ...replay } })) return true;
  closeWithError(ctx, "backpressure", ctx.messages.capacityExceeded, 1013);
  return false;
};

const startStream = (ctx: WsContext, mailboxId: string, internalMailboxId: string, after: string) => {
  stopStream(ctx);
  const abort = new AbortController();
  ctx.streamAbort = abort;

  void (async () => {
    try {
      for await (const event of liveMailInvalidations({ mailboxId: internalMailboxId, after, signal: abort.signal })) {
        if (!(await deliverReplayEvent(ctx, mailboxId, internalMailboxId, abort, event))) break;
      }
      if (subscriptionIsCurrent(ctx, mailboxId, internalMailboxId, abort)) {
        log.warn("Mail WebSocket event stream ended unexpectedly", { mailboxId });
        closeWithError(ctx, "stream_failed", ctx.messages.streamEnded, 1012);
      }
    } catch (error) {
      if (abort.signal.aborted || isClosing(ctx)) return;
      log.error("Mail WebSocket event stream failed", {
        mailboxId,
        error: error instanceof Error ? error.message : String(error),
      });
      closeWithError(ctx, "stream_failed", ctx.messages.streamFailed, 1012);
    } finally {
      if (ctx.streamAbort === abort) ctx.streamAbort = null;
    }
  })();
};

const handleSubscribe = async (ctx: WsContext, mailboxId: string, fromCursor: string | null) => {
  if (isClosing(ctx)) return;
  const internalMailboxId = await resolvePublicId("mailboxes", mailboxId);
  if (!internalMailboxId) {
    ctx.mailboxId = mailboxId;
    revoke(ctx, mailboxId, { ok: false, code: "not_found", message: ctx.messages.mailboxNotFound });
    return;
  }
  const access = await currentAccess(ctx, internalMailboxId);
  if (isClosing(ctx)) return;
  if (!access.ok) {
    ctx.mailboxId = mailboxId;
    revoke(ctx, mailboxId, access);
    return;
  }

  let cursor: string;
  try {
    cursor = await resolveMailLiveCursor(internalMailboxId, fromCursor);
  } catch (error) {
    log.error("Mail WebSocket cursor resolution failed", {
      mailboxId,
      error: error instanceof Error ? error.message : String(error),
    });
    ctx.mailboxId = mailboxId;
    closeWithError(ctx, "stream_failed", ctx.messages.streamFailed, 1012);
    return;
  }
  if (isClosing(ctx)) return;
  stopSubscription(ctx);
  ctx.phase = "subscribed";
  ctx.mailboxId = mailboxId;
  ctx.internalMailboxId = internalMailboxId;
  if (!send(ctx.socket, { type: MAIL_LIVE_WS_TYPE.ready, payload: { mailboxId, cursor } })) {
    closeWithError(ctx, "backpressure", ctx.messages.capacityExceeded, 1013);
    return;
  }
  startStream(ctx, mailboxId, internalMailboxId, cursor);
  startAccessRefresh(ctx, mailboxId, internalMailboxId);
};

const handleMessage = async (ctx: WsContext, raw: string) => {
  if (isClosing(ctx)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    closeWithError(ctx, "invalid_json", ctx.messages.invalidJson, 1008);
    return;
  }
  const message = MailLiveClientMessageSchema.safeParse(parsed);
  if (!message.success) {
    closeWithError(ctx, "invalid_message", ctx.messages.invalidSubscription, 1008);
    return;
  }
  await handleSubscribe(ctx, message.data.payload.mailboxId, message.data.payload.fromCursor);
};

const app = new Hono<AuthContext>().get(
  "/",
  upgradeWebSocket((c) => {
    const sessionToken = getCookie(c, "session_token") ?? null;
    const requestId = c.req.header("x-request-id") ?? null;
    const locale = getLocale(c);
    let ctx: WsContext | null = null;
    let processing: Promise<void> = Promise.resolve();
    let pendingMessages = 0;

    return {
      onOpen(_, ws) {
        ctx = createContext(ws.raw as ServerWebSocket<unknown>, sessionToken, requestId, locale);
      },
      onMessage(event) {
        if (!ctx || isClosing(ctx)) return;
        if (typeof event.data !== "string" || event.data.length > MAX_CLIENT_MESSAGE_LENGTH) {
          closeWithError(ctx, "invalid_message", ctx.messages.invalidSubscription, 1008);
          return;
        }
        if (pendingMessages >= MAX_PENDING_MESSAGES) {
          closeWithError(ctx, "backpressure", ctx.messages.tooManyMessages, 1013);
          return;
        }

        pendingMessages++;
        const current = ctx;
        const raw = event.data;
        processing = processing
          .then(() => handleMessage(current, raw))
          .catch((error) => {
            log.error("Mail WebSocket message handling failed", {
              mailboxId: current.mailboxId,
              error: error instanceof Error ? error.message : String(error),
            });
            closeWithError(current, "internal_error", current.messages.subscriptionFailed, 1011);
          })
          .finally(() => {
            pendingMessages = Math.max(0, pendingMessages - 1);
          });
      },
      async onClose() {
        if (!ctx) return;
        ctx.phase = "closing";
        stopSubscription(ctx);
        await processing.catch(() => undefined);
      },
    };
  }),
);

export default app;
