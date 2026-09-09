import { CursorMismatchError, RetentionGapError } from "@k2b/sync";
import {
  NOTIFICATION_LIVE_WS_TYPE,
  NotificationLiveClientMessageSchema,
  type NotificationLiveServerMessage,
} from "@k2b/cloud/contracts";
import { auth, getLocale } from "@k2b/cloud/server";
import { logger, notifications } from "@k2b/cloud/services";
import type { ServerWebSocket } from "bun";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { type NotificationWsMessages, notificationWsMessages } from "./notifications-ws-messages";

const log = logger("core:notification-websocket");
const ACCESS_REFRESH_INTERVAL_MS = 8_000;
const MAX_CLIENT_MESSAGE_LENGTH = 4_000;
const MAX_PENDING_MESSAGES = 4;

type WsPhase = "open" | "subscribed" | "closing";

type WsContext = {
  socket: ServerWebSocket<unknown>;
  sessionToken: string | null;
  messages: NotificationWsMessages;
  phase: WsPhase;
  userId: string | null;
  streamAbort: AbortController | null;
  accessRefreshTimer: ReturnType<typeof setTimeout> | null;
};

const createContext = (socket: ServerWebSocket<unknown>, sessionToken: string | null, locale: string): WsContext => ({
  socket,
  sessionToken,
  messages: notificationWsMessages(locale),
  phase: "open",
  userId: null,
  streamAbort: null,
  accessRefreshTimer: null,
});

const isClosing = (ctx: WsContext): boolean => ctx.phase === "closing";

const send = (socket: ServerWebSocket<unknown>, message: NotificationLiveServerMessage): boolean => {
  try {
    return socket.send(JSON.stringify(message)) > 0;
  } catch {
    return false;
  }
};

const stopSubscription = (ctx: WsContext) => {
  if (ctx.accessRefreshTimer) clearTimeout(ctx.accessRefreshTimer);
  ctx.accessRefreshTimer = null;
  ctx.streamAbort?.abort();
  ctx.streamAbort = null;
  ctx.userId = null;
};

const closeWithError = (ctx: WsContext, code: string, message: string, closeCode: number) => {
  if (isClosing(ctx)) return;
  ctx.phase = "closing";
  stopSubscription(ctx);
  send(ctx.socket, { type: NOTIFICATION_LIVE_WS_TYPE.error, payload: { code, message } });
  ctx.socket.close(closeCode, code);
};

const revoke = (ctx: WsContext, code = "login_required", message = ctx.messages.loginRequired) => {
  if (isClosing(ctx)) return;
  ctx.phase = "closing";
  stopSubscription(ctx);
  send(ctx.socket, { type: NOTIFICATION_LIVE_WS_TYPE.revoked, payload: { code, message } });
  ctx.socket.close(1008, code);
};

const resolveUserId = async (sessionToken: string | null): Promise<string | null> => {
  if (!sessionToken) return null;
  return (await auth.session.authenticate(sessionToken))?.user.id ?? null;
};

const startAccessRefresh = (ctx: WsContext, userId: string) => {
  if (ctx.accessRefreshTimer) clearTimeout(ctx.accessRefreshTimer);
  ctx.accessRefreshTimer = setTimeout(async () => {
    if (ctx.phase !== "subscribed" || ctx.userId !== userId) return;
    try {
      const currentUserId = await resolveUserId(ctx.sessionToken);
      if (ctx.phase !== "subscribed" || ctx.userId !== userId) return;
      if (currentUserId !== userId) {
        revoke(ctx);
        return;
      }
      startAccessRefresh(ctx, userId);
    } catch (error) {
      if (ctx.phase !== "subscribed" || ctx.userId !== userId) return;
      log.error("Notification WebSocket access refresh failed", {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      closeWithError(ctx, "access_check_failed", ctx.messages.accessRefreshFailed, 1012);
    }
  }, ACCESS_REFRESH_INTERVAL_MS);
};

const startStream = (ctx: WsContext, userId: string, after: string | undefined) => {
  ctx.streamAbort?.abort();
  const abort = new AbortController();
  ctx.streamAbort = abort;

  void (async () => {
    try {
      for await (const event of notifications.live.events({ userId, after, signal: abort.signal })) {
        if (abort.signal.aborted || ctx.phase !== "subscribed" || ctx.userId !== userId) break;
        const currentUserId = await resolveUserId(ctx.sessionToken);
        if (abort.signal.aborted || ctx.phase !== "subscribed" || ctx.userId !== userId) break;
        if (currentUserId !== userId) {
          revoke(ctx);
          break;
        }
        if (!send(ctx.socket, { type: NOTIFICATION_LIVE_WS_TYPE.event, payload: { cursor: event.cursor, event: event.data } })) {
          closeWithError(ctx, "backpressure", ctx.messages.capacityExceeded, 1013);
          break;
        }
      }
      if (!abort.signal.aborted && ctx.phase === "subscribed" && ctx.userId === userId) {
        closeWithError(ctx, "stream_ended", ctx.messages.streamEnded, 1012);
      }
    } catch (error) {
      if (abort.signal.aborted || isClosing(ctx)) return;
      if (error instanceof RetentionGapError || error instanceof CursorMismatchError) {
        await handleSubscribe(ctx, null);
        return;
      }
      log.error("Notification WebSocket stream failed", {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      closeWithError(ctx, "stream_failed", ctx.messages.streamFailed, 1012);
    } finally {
      if (ctx.streamAbort === abort) ctx.streamAbort = null;
    }
  })();
};

const handleSubscribe = async (ctx: WsContext, fromCursor: string | null) => {
  if (isClosing(ctx)) return;
  const userId = await resolveUserId(ctx.sessionToken);
  if (isClosing(ctx)) return;
  if (!userId) {
    revoke(ctx);
    return;
  }

  const requested = fromCursor === notifications.live.emptyCursor() ? null : fromCursor;
  const after = requested ?? (await notifications.live.latestCursor(userId)) ?? undefined;
  const cursor = after ?? notifications.live.emptyCursor();
  if (isClosing(ctx)) return;
  stopSubscription(ctx);
  ctx.phase = "subscribed";
  ctx.userId = userId;
  if (!send(ctx.socket, { type: NOTIFICATION_LIVE_WS_TYPE.ready, payload: { cursor } })) {
    closeWithError(ctx, "backpressure", ctx.messages.capacityExceeded, 1013);
    return;
  }
  startStream(ctx, userId, after);
  startAccessRefresh(ctx, userId);
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
  const message = NotificationLiveClientMessageSchema.safeParse(parsed);
  if (!message.success) {
    closeWithError(ctx, "invalid_message", ctx.messages.invalidSubscription, 1008);
    return;
  }
  await handleSubscribe(ctx, message.data.payload.fromCursor);
};

const app = new Hono().get(
  "/",
  upgradeWebSocket((c) => {
    const sessionToken = auth.session.getToken(c);
    const locale = getLocale(c);
    let ctx: WsContext | null = null;
    let processing: Promise<void> = Promise.resolve();
    let pendingMessages = 0;

    return {
      onOpen(_, ws) {
        ctx = createContext(ws.raw as ServerWebSocket<unknown>, sessionToken, locale);
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
            log.error("Notification WebSocket message handling failed", {
              userId: current.userId,
              error: error instanceof Error ? error.message : String(error),
            });
            closeWithError(current, "subscription_failed", current.messages.subscriptionFailed, 1012);
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
