import type { ServerWebSocket } from "bun";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { type AuthContext, auth, getLocale } from "../server";
import { logger } from "../services/logging";
import {
  AI_LIVE_WS_TYPE,
  type AiInvalidation,
  AiInvalidationSchema,
  AiLiveClientMessageSchema,
  AiLiveCursorSchema,
  type AiLiveErrorCode,
  type AiLiveServerMessage,
  aiTurnEventMessage,
} from "./live-events";
import { type AiLiveMessages, aiLiveMessages } from "./live-messages";
import { latestAiInvalidationCursor, liveAiInvalidations } from "./live-outbox";
import type { AiStreamEvent } from "./protocol";
import { aiConversations } from "./store";
import { streamAiConversationEvents } from "./stream";
import type { AiConversation } from "./types";

const log = logger("ai:live-routes");
const AUTH_REFRESH_INTERVAL_MS = 5_000;
const MAX_CLIENT_MESSAGE_LENGTH = 8_000;
const MAX_PENDING_MESSAGES = 8;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export const isAiLiveClientMessageFrame = (data: unknown): data is string =>
  typeof data === "string" && data.length <= MAX_CLIENT_MESSAGE_LENGTH;

type LiveUser = { id: string };
type WsPhase = "open" | "subscribed" | "closing";

type WsContext = {
  socket: ServerWebSocket<unknown>;
  sessionToken: string | null;
  messages: AiLiveMessages;
  phase: WsPhase;
  userId: string | null;
  invalidationAbort: AbortController | null;
  turnAbort: AbortController | null;
  turnConversationId: string | null;
  authRefreshTimer: ReturnType<typeof setTimeout> | null;
  scopeVersion: string | null;
};

export type AiLiveRoutesConfig = {
  resolveLiveUser?: (sessionToken: string | null) => Promise<LiveUser | null>;
  resolveScopeVersion?: (userId: string) => Promise<string>;
  resolveConversation?: (conversationId: string, userId: string) => Promise<AiConversation | null>;
  streamConversation?: (input: { conversation: AiConversation; signal: AbortSignal }) => AsyncIterable<AiStreamEvent>;
};

export const resolveAiLiveSessionUser = async (
  sessionToken: string | null,
  authenticate: typeof auth.session.authenticate = auth.session.authenticate,
): Promise<LiveUser | null> => {
  if (!sessionToken) return null;
  const authenticated = await authenticate(sessionToken);
  return authenticated ? { id: authenticated.user.id } : null;
};

const isClosing = (ctx: WsContext): boolean => ctx.phase === "closing";

export const isAiLiveSubscriptionCurrent = (state: Pick<WsContext, "phase" | "userId">, userId: string, signal: AbortSignal): boolean =>
  !signal.aborted && state.phase === "subscribed" && state.userId === userId;

export const isAiTurnSubscriptionCurrent = (
  state: Pick<WsContext, "phase" | "turnConversationId">,
  conversationId: string,
  signal: AbortSignal,
): boolean => !signal.aborted && state.phase === "subscribed" && state.turnConversationId === conversationId;

export const sendAiLiveMessage = (socket: ServerWebSocket<unknown>, message: AiLiveServerMessage): boolean => {
  try {
    const payload = JSON.stringify(message);
    socket.send(payload);
    // Bun 1.3 can report 0 after a larger frame already reached the peer.
    // The bounded socket queue is the reliable overload signal here.
    return socket.getBufferedAmount() <= MAX_BUFFERED_BYTES;
  } catch {
    return false;
  }
};

const stopInvalidationSubscription = (ctx: WsContext) => {
  ctx.invalidationAbort?.abort();
  ctx.invalidationAbort = null;
};

const stopTurnSubscription = (ctx: WsContext) => {
  ctx.turnAbort?.abort();
  ctx.turnAbort = null;
  ctx.turnConversationId = null;
};

const stopSubscriptions = (ctx: WsContext) => {
  stopInvalidationSubscription(ctx);
  stopTurnSubscription(ctx);
  if (ctx.authRefreshTimer) clearTimeout(ctx.authRefreshTimer);
  ctx.authRefreshTimer = null;
  ctx.userId = null;
  ctx.scopeVersion = null;
};

const closeWithError = (ctx: WsContext, code: AiLiveErrorCode, message: string, closeCode: number) => {
  if (isClosing(ctx)) return;
  ctx.phase = "closing";
  stopSubscriptions(ctx);
  sendAiLiveMessage(ctx.socket, { type: AI_LIVE_WS_TYPE.error, payload: { code, message } });
  ctx.socket.close(closeCode, code);
};

const revoke = (ctx: WsContext, code: "login_required" | "access_denied", message: string) => {
  if (isClosing(ctx)) return;
  ctx.phase = "closing";
  stopSubscriptions(ctx);
  sendAiLiveMessage(ctx.socket, { type: AI_LIVE_WS_TYPE.revoked, payload: { code, message } });
  ctx.socket.close(1008, code);
};

export const resolveAiLiveCursor = async (
  userId: string,
  fromCursor: string | null,
  recover: boolean,
  latest: (userId: string) => Promise<string | null> = latestAiInvalidationCursor,
): Promise<string> => AiLiveCursorSchema.parse(recover || !fromCursor ? ((await latest(userId)) ?? "0-0") : fromCursor);

export const parseAiLiveReplayEvent = (item: { cursor: unknown; data: unknown }): { cursor: string; event: AiInvalidation } | null => {
  const cursor = AiLiveCursorSchema.safeParse(item.cursor);
  const event = AiInvalidationSchema.safeParse(item.data);
  return cursor.success && event.success ? { cursor: cursor.data, event: event.data } : null;
};

const buildAiLiveRoutes = (config: AiLiveRoutesConfig = {}) => {
  const resolveLiveUser = config.resolveLiveUser ?? resolveAiLiveSessionUser;
  const resolveConversation =
    config.resolveConversation ??
    ((conversationId: string, userId: string) =>
      aiConversations.getConversationByShortId({ shortId: conversationId, ownerUserId: userId }));
  const streamConversation = config.streamConversation ?? streamAiConversationEvents;

  const currentUser = async (ctx: WsContext): Promise<LiveUser | null> => {
    const user = await resolveLiveUser(ctx.sessionToken);
    return user && (!ctx.userId || user.id === ctx.userId) ? user : null;
  };

  const startAuthRefresh = (ctx: WsContext, userId: string) => {
    if (ctx.authRefreshTimer) clearTimeout(ctx.authRefreshTimer);
    ctx.authRefreshTimer = setTimeout(async () => {
      if (ctx.phase !== "subscribed" || ctx.userId !== userId) return;
      try {
        if (!(await currentUser(ctx))) {
          revoke(ctx, "login_required", ctx.messages.loginRequired);
          return;
        }
        const activeConversationId = ctx.turnConversationId;
        if (activeConversationId && !(await resolveConversation(activeConversationId, userId))) {
          if (ctx.turnConversationId !== activeConversationId) {
            startAuthRefresh(ctx, userId);
            return;
          }
          const conversationId = activeConversationId;
          stopTurnSubscription(ctx);
          if (
            !sendAiLiveMessage(ctx.socket, {
              type: AI_LIVE_WS_TYPE.turnError,
              payload: { conversationId, code: "access_denied", message: ctx.messages.conversationAccessChanged },
            })
          ) {
            closeWithError(ctx, "backpressure", ctx.messages.capacityExceeded, 1013);
            return;
          }
        }
        if (config.resolveScopeVersion) {
          const version = await config.resolveScopeVersion(userId);
          if (ctx.phase !== "subscribed" || ctx.userId !== userId) return;
          if (ctx.scopeVersion !== null && version !== ctx.scopeVersion) {
            if (!sendAiLiveMessage(ctx.socket, { type: AI_LIVE_WS_TYPE.scopeChanged, payload: { at: new Date().toISOString() } })) {
              closeWithError(ctx, "backpressure", ctx.messages.capacityExceeded, 1013);
              return;
            }
          }
          ctx.scopeVersion = version;
        }
        startAuthRefresh(ctx, userId);
      } catch (error) {
        log.error("AI live authorization refresh failed", {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
        closeWithError(ctx, "internal_error", ctx.messages.authorizationRefreshFailed, 1011);
      }
    }, AUTH_REFRESH_INTERVAL_MS);
  };

  const startInvalidationStream = (ctx: WsContext, userId: string, after: string) => {
    ctx.invalidationAbort?.abort();
    const abort = new AbortController();
    ctx.invalidationAbort = abort;
    void (async () => {
      try {
        for await (const item of liveAiInvalidations({ userId, after, signal: abort.signal })) {
          if (!isAiLiveSubscriptionCurrent(ctx, userId, abort.signal)) break;
          if (!(await currentUser(ctx))) {
            revoke(ctx, "login_required", ctx.messages.loginRequired);
            return;
          }
          if (!isAiLiveSubscriptionCurrent(ctx, userId, abort.signal)) break;
          const replay = parseAiLiveReplayEvent(item);
          if (!replay) {
            closeWithError(ctx, "stream_failed", ctx.messages.invalidStreamData, 1011);
            return;
          }
          if (!sendAiLiveMessage(ctx.socket, { type: AI_LIVE_WS_TYPE.event, payload: replay })) {
            closeWithError(ctx, "backpressure", ctx.messages.capacityExceeded, 1013);
            return;
          }
        }
        if (isAiLiveSubscriptionCurrent(ctx, userId, abort.signal))
          closeWithError(ctx, "stream_failed", ctx.messages.eventStreamEnded, 1012);
      } catch (error) {
        if (abort.signal.aborted || isClosing(ctx)) return;
        log.error("AI live event stream failed", {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
        closeWithError(ctx, "stream_failed", ctx.messages.eventStreamFailed, 1012);
      } finally {
        if (ctx.invalidationAbort === abort) ctx.invalidationAbort = null;
      }
    })();
  };

  const handleLiveSubscribe = async (ctx: WsContext, fromCursor: string | null, recover: boolean) => {
    if (isClosing(ctx)) return;
    const user = await currentUser(ctx);
    if (isClosing(ctx)) return;
    if (!user) {
      revoke(ctx, "login_required", ctx.messages.loginRequired);
      return;
    }
    let cursor: string;
    let scopeVersion: string | null;
    try {
      cursor = await resolveAiLiveCursor(user.id, fromCursor, recover);
      scopeVersion = config.resolveScopeVersion ? await config.resolveScopeVersion(user.id) : null;
    } catch (error) {
      log.error("AI live subscription setup failed", {
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      });
      closeWithError(ctx, "stream_failed", ctx.messages.subscriptionFailed, 1012);
      return;
    }
    if (isClosing(ctx)) return;
    stopInvalidationSubscription(ctx);
    ctx.phase = "subscribed";
    ctx.userId = user.id;
    ctx.scopeVersion = scopeVersion;
    if (!sendAiLiveMessage(ctx.socket, { type: AI_LIVE_WS_TYPE.ready, payload: { cursor, recovered: recover } })) {
      closeWithError(ctx, "backpressure", ctx.messages.capacityExceeded, 1013);
      return;
    }
    startInvalidationStream(ctx, user.id, cursor);
    startAuthRefresh(ctx, user.id);
  };

  const startTurnStream = (ctx: WsContext, conversation: AiConversation) => {
    stopTurnSubscription(ctx);
    const abort = new AbortController();
    const conversationId = conversation.shortId;
    ctx.turnAbort = abort;
    ctx.turnConversationId = conversationId;
    void (async () => {
      try {
        for await (const event of streamConversation({ conversation, signal: abort.signal })) {
          if (!isAiTurnSubscriptionCurrent(ctx, conversationId, abort.signal)) return;
          if (!sendAiLiveMessage(ctx.socket, aiTurnEventMessage(conversationId, event))) {
            closeWithError(ctx, "backpressure", ctx.messages.capacityExceeded, 1013);
            return;
          }
        }
        if (isAiTurnSubscriptionCurrent(ctx, conversationId, abort.signal)) {
          closeWithError(ctx, "stream_failed", ctx.messages.conversationStreamEnded, 1012);
        }
      } catch (error) {
        if (abort.signal.aborted || isClosing(ctx)) return;
        log.error("AI conversation stream failed", {
          conversationId: conversation.id,
          error: error instanceof Error ? error.message : String(error),
        });
        closeWithError(ctx, "stream_failed", ctx.messages.conversationStreamFailed, 1012);
      } finally {
        if (ctx.turnAbort === abort) {
          ctx.turnAbort = null;
          ctx.turnConversationId = null;
        }
      }
    })();
  };

  const handleTurnSubscribe = async (ctx: WsContext, conversationId: string) => {
    if (ctx.phase !== "subscribed" || !ctx.userId) {
      closeWithError(ctx, "invalid_message", ctx.messages.liveSubscriptionRequired, 1008);
      return;
    }
    const conversation = await resolveConversation(conversationId, ctx.userId);
    if (isClosing(ctx)) return;
    if (!conversation) {
      stopTurnSubscription(ctx);
      if (
        !sendAiLiveMessage(ctx.socket, {
          type: AI_LIVE_WS_TYPE.turnError,
          payload: { conversationId, code: "not_found", message: ctx.messages.conversationNotFound },
        })
      ) {
        closeWithError(ctx, "backpressure", ctx.messages.capacityExceeded, 1013);
      }
      return;
    }
    startTurnStream(ctx, conversation);
  };

  const handleTurnUnsubscribe = (ctx: WsContext, conversationId: string) => {
    if (ctx.turnConversationId === conversationId) stopTurnSubscription(ctx);
  };

  const handleMessage = async (ctx: WsContext, raw: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      closeWithError(ctx, "invalid_json", ctx.messages.invalidJson, 1008);
      return;
    }
    const message = AiLiveClientMessageSchema.safeParse(parsed);
    if (!message.success) {
      closeWithError(ctx, "invalid_message", ctx.messages.invalidSubscription, 1008);
      return;
    }
    if (message.data.type === AI_LIVE_WS_TYPE.subscribe) {
      await handleLiveSubscribe(ctx, message.data.payload.fromCursor, message.data.payload.recover);
      return;
    }
    if (message.data.type === AI_LIVE_WS_TYPE.turnSubscribe) {
      await handleTurnSubscribe(ctx, message.data.payload.conversationId);
      return;
    }
    handleTurnUnsubscribe(ctx, message.data.payload.conversationId);
  };

  return new Hono<AuthContext>().get(
    "/",
    upgradeWebSocket((c) => {
      const sessionToken = auth.session.getToken(c);
      const messages = aiLiveMessages(getLocale(c));
      let ctx: WsContext | null = null;
      let processing: Promise<void> = Promise.resolve();
      let pendingMessages = 0;
      return {
        onOpen(_, ws) {
          ctx = {
            socket: ws.raw as ServerWebSocket<unknown>,
            sessionToken,
            messages,
            phase: "open",
            userId: null,
            invalidationAbort: null,
            turnAbort: null,
            turnConversationId: null,
            authRefreshTimer: null,
            scopeVersion: null,
          };
        },
        onMessage(event) {
          if (!ctx || isClosing(ctx)) return;
          if (!isAiLiveClientMessageFrame(event.data)) {
            closeWithError(ctx, "invalid_message", ctx.messages.invalidSubscription, 1008);
            return;
          }
          if (pendingMessages >= MAX_PENDING_MESSAGES) {
            closeWithError(ctx, "backpressure", ctx.messages.tooManyMessages, 1013);
            return;
          }
          const current = ctx;
          const raw = event.data;
          pendingMessages++;
          processing = processing
            .then(() => handleMessage(current, raw))
            .catch((error) => {
              log.error("AI live message handling failed", { error: error instanceof Error ? error.message : String(error) });
              closeWithError(current, "internal_error", current.messages.subscriptionFailed, 1011);
            })
            .finally(() => {
              pendingMessages = Math.max(0, pendingMessages - 1);
            });
        },
        async onClose() {
          if (!ctx) return;
          ctx.phase = "closing";
          stopSubscriptions(ctx);
          await processing.catch(() => undefined);
        },
      };
    }),
  );
};

export const aiLiveRoutes = buildAiLiveRoutes();
export type AiLiveRoutes = typeof aiLiveRoutes;
