import { CursorMismatchError, RetentionGapError } from "@k2b/sync";
import { hasRole } from "@valentinkolb/cloud/contracts";
import { type AuthContext, auth, getLocale, rateLimit } from "@valentinkolb/cloud/server";
import { logger } from "@valentinkolb/cloud/services";
import type { ServerWebSocket } from "bun";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import {
  CONTACTS_LIVE_WS_TYPE,
  ContactLiveClientMessageSchema,
  type ContactLiveEvent,
  ContactLiveEventSchema,
  type ContactLiveScope,
  type ContactLiveServerMessage,
  type ContactServiceEvent,
  ContactServiceEventSchema,
  classifyContactScopeChange,
  contactEventBookIds,
  projectContactEvent,
} from "./live-events";
import { contactsService } from "./service";
import { latestContactEventCursor, liveContactEvents } from "./service/events";
import { type ContactsMessages, contactsMessages } from "./service/messages";
import { resolvePublicId } from "./service/public-resources";

const log = logger("contacts:websocket");
const ACCESS_REFRESH_INTERVAL_MS = 8_000;
const MAX_CLIENT_MESSAGE_LENGTH = 16_000;
const MAX_PENDING_MESSAGES = 8;

type AccessFailure = {
  ok: false;
  code: "login_required" | "not_found" | "access_denied";
  message: string;
};
type AccessResult = { ok: true; userId: string; readableBookIds: Set<string> } | AccessFailure;
type InternalLiveScope = { kind: "all" } | { kind: "book"; bookId: string };
type WsPhase = "open" | "subscribed" | "closing";
type WsContext = {
  socket: ServerWebSocket<unknown>;
  sessionToken: string | null;
  messages: ContactsMessages;
  phase: WsPhase;
  scope: InternalLiveScope | null;
  userId: string | null;
  readableBookIds: Set<string>;
  streamAbort: AbortController | null;
  accessRefreshTimer: ReturnType<typeof setTimeout> | null;
};

const createContext = (socket: ServerWebSocket<unknown>, sessionToken: string | null, locale: string): WsContext => ({
  socket,
  sessionToken,
  messages: contactsMessages(locale),
  phase: "open",
  scope: null,
  userId: null,
  readableBookIds: new Set(),
  streamAbort: null,
  accessRefreshTimer: null,
});

const isClosing = (ctx: WsContext): boolean => ctx.phase === "closing";

const send = (socket: ServerWebSocket<unknown>, message: ContactLiveServerMessage): boolean => {
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
  ctx.scope = null;
  ctx.userId = null;
  ctx.readableBookIds = new Set();
};

const closeWithError = (ctx: WsContext, code: string, message: string, closeCode: number) => {
  if (isClosing(ctx)) return;
  ctx.phase = "closing";
  stopSubscription(ctx);
  send(ctx.socket, { type: CONTACTS_LIVE_WS_TYPE.error, payload: { code, message } });
  ctx.socket.close(closeCode, code);
};

const revoke = (ctx: WsContext, access: AccessFailure) => {
  if (isClosing(ctx)) return;
  ctx.phase = "closing";
  stopSubscription(ctx);
  send(ctx.socket, {
    type: CONTACTS_LIVE_WS_TYPE.revoked,
    payload: { code: access.code, message: access.message },
  });
  ctx.socket.close(1008, access.code);
};

const sameIds = (left: Set<string>, right: Set<string>): boolean => left.size === right.size && [...left].every((id) => right.has(id));

const evaluateAccess = async (ctx: WsContext, scope: InternalLiveScope): Promise<AccessResult> => {
  if (!ctx.sessionToken) return { ok: false, code: "login_required", message: ctx.messages.loginRequired };
  const authenticated = await auth.session.authenticate(ctx.sessionToken);
  const user = authenticated?.user;
  if (!user || !hasRole(user, "user")) return { ok: false, code: "access_denied", message: ctx.messages.accessDenied };

  const subject = { type: "user" as const, userId: user.id };
  if (scope.kind === "book") {
    const book = await contactsService.book.get({ id: scope.bookId });
    if (!book) return { ok: false, code: "not_found", message: ctx.messages.contactBookNotFound };
    const canRead = await contactsService.book.permission.canAccess({ bookId: scope.bookId, subject, requiredLevel: "read" });
    if (!canRead) return { ok: false, code: "access_denied", message: ctx.messages.accessDenied };
    return { ok: true, userId: user.id, readableBookIds: new Set([scope.bookId]) };
  }

  const readableBookIds = new Set(await contactsService.book.readableIds({ subject }));
  return { ok: true, userId: user.id, readableBookIds };
};

const updateAccess = async (ctx: WsContext, scope: InternalLiveScope): Promise<boolean> => {
  const access = await evaluateAccess(ctx, scope);
  if (ctx.phase !== "subscribed" || ctx.scope !== scope) return false;
  if (!access.ok) {
    revoke(ctx, access);
    return false;
  }
  if (scope.kind === "all" && !sameIds(ctx.readableBookIds, access.readableBookIds)) {
    const change = classifyContactScopeChange(ctx.readableBookIds, access.readableBookIds);
    ctx.readableBookIds = access.readableBookIds;
    if (!send(ctx.socket, { type: CONTACTS_LIVE_WS_TYPE.scopeChanged, payload: { change } })) {
      closeWithError(ctx, "backpressure", ctx.messages.liveBackpressure, 1013);
      return false;
    }
  } else {
    ctx.readableBookIds = access.readableBookIds;
  }
  ctx.userId = access.userId;
  return true;
};

const refreshAllEventAccess = async (ctx: WsContext, event: ContactServiceEvent): Promise<ContactServiceEvent | null> => {
  const affectedBookIds = [...new Set(contactEventBookIds(event))];
  const mayExpandScope = event.type === "book.created" || event.type === "access.changed";
  if (!mayExpandScope && !affectedBookIds.some((bookId) => ctx.readableBookIds.has(bookId))) return null;
  if (!ctx.sessionToken || !ctx.userId) return null;
  const authenticated = await auth.session.authenticate(ctx.sessionToken);
  if (!authenticated || authenticated.user.id !== ctx.userId) {
    revoke(ctx, { ok: false, code: "login_required", message: ctx.messages.loginRequired });
    return null;
  }

  const subject = { type: "user" as const, userId: ctx.userId };
  const before = new Set(ctx.readableBookIds);
  for (const bookId of affectedBookIds) {
    const canRead = await contactsService.book.permission.canAccess({ bookId, subject, requiredLevel: "read" });
    if (canRead === ctx.readableBookIds.has(bookId)) continue;
    if (canRead) ctx.readableBookIds.add(bookId);
    else ctx.readableBookIds.delete(bookId);
  }

  if (!sameIds(before, ctx.readableBookIds)) {
    if (
      !send(ctx.socket, {
        type: CONTACTS_LIVE_WS_TYPE.scopeChanged,
        payload: { change: classifyContactScopeChange(before, ctx.readableBookIds) },
      })
    ) {
      closeWithError(ctx, "backpressure", ctx.messages.liveBackpressure, 1013);
    }
    // The replacement SSR snapshot includes both the new scope and this event.
    return null;
  }
  return projectContactEvent(event, ctx.readableBookIds);
};

const refreshEventAccess = async (
  ctx: WsContext,
  scope: InternalLiveScope,
  event: ContactServiceEvent,
): Promise<ContactServiceEvent | null> => {
  if (event.type === "book.deleted") {
    const wasReadable = ctx.readableBookIds.delete(event.bookId);
    return wasReadable && (scope.kind === "all" || scope.bookId === event.bookId) ? event : null;
  }
  if (scope.kind === "all") return refreshAllEventAccess(ctx, event);
  if (!contactEventBookIds(event).includes(scope.bookId)) return null;
  if (!(await updateAccess(ctx, scope))) return null;
  return projectContactEvent(event, ctx.readableBookIds);
};

const startAccessRefresh = (ctx: WsContext, scope: InternalLiveScope) => {
  if (ctx.accessRefreshTimer) clearTimeout(ctx.accessRefreshTimer);
  ctx.accessRefreshTimer = setTimeout(async () => {
    if (ctx.phase !== "subscribed" || ctx.scope !== scope) return;
    try {
      if (await updateAccess(ctx, scope)) startAccessRefresh(ctx, scope);
    } catch (error) {
      if (ctx.phase !== "subscribed" || ctx.scope !== scope) return;
      log.error("Contacts WebSocket access refresh failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      closeWithError(ctx, "internal_error", ctx.messages.liveAccessRefreshFailed, 1011);
    }
  }, ACCESS_REFRESH_INTERVAL_MS);
};

const toVisiblePublicEvent = (
  original: ContactServiceEvent,
  publicEvent: ContactLiveEvent,
  visible: ContactServiceEvent,
): ContactLiveEvent => {
  if (original.type !== "contact.moved" || publicEvent.type !== "contact.moved" || visible.type === "contact.moved") return publicEvent;
  if (visible.type === "contact.deleted") {
    return { type: "contact.deleted", bookId: publicEvent.sourceBookId, contactId: publicEvent.contactId, at: publicEvent.at };
  }
  return { type: "contact.created", bookId: publicEvent.targetBookId, contactId: publicEvent.contactId, at: publicEvent.at };
};

const startStream = (ctx: WsContext, scope: InternalLiveScope, after: string) => {
  ctx.streamAbort?.abort();
  const abort = new AbortController();
  ctx.streamAbort = abort;

  void (async () => {
    try {
      for await (const envelope of liveContactEvents({ after, signal: abort.signal })) {
        if (abort.signal.aborted || ctx.phase !== "subscribed" || ctx.scope !== scope) break;
        const parsed = ContactServiceEventSchema.safeParse(envelope.data.internal);
        const parsedPublic = ContactLiveEventSchema.safeParse(envelope.data.public);
        if (!parsed.success || !parsedPublic.success) continue;
        const event = await refreshEventAccess(ctx, scope, parsed.data);
        if (!event || ctx.phase !== "subscribed") continue;
        const publicEvent = toVisiblePublicEvent(parsed.data, parsedPublic.data, event);
        if (!send(ctx.socket, { type: CONTACTS_LIVE_WS_TYPE.event, payload: { cursor: envelope.cursor, event: publicEvent } })) {
          closeWithError(ctx, "backpressure", ctx.messages.liveBackpressure, 1013);
          break;
        }
      }
    } catch (error) {
      if (abort.signal.aborted || ctx.phase === "closing") return;
      if (error instanceof RetentionGapError || error instanceof CursorMismatchError) {
        closeWithError(ctx, "resync_required", ctx.messages.liveStreamFailed, 1012);
        return;
      }
      log.error("Contacts WebSocket event stream failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      closeWithError(ctx, "stream_failed", ctx.messages.liveStreamFailed, 1012);
    } finally {
      if (ctx.streamAbort === abort) ctx.streamAbort = null;
    }
  })();
};

/**
 * `null` means the page rendered without a cursor (SSR could not reach the
 * transport); the head is resolved now instead of replaying from sequence 0.
 */
export const resolveContactLiveCursor = async (
  fromCursor: string | null,
  latestCursor: () => Promise<string> = latestContactEventCursor,
): Promise<string> => fromCursor ?? (await latestCursor());

const handleSubscribe = async (ctx: WsContext, publicScope: ContactLiveScope, fromCursor: string | null) => {
  if (isClosing(ctx)) return;
  if (fromCursor !== null && !/^s6t\.[A-Za-z0-9_-]+\.\d+$/.test(fromCursor)) {
    closeWithError(ctx, "resync_required", ctx.messages.liveStreamFailed, 1012);
    return;
  }
  if (ctx.phase === "subscribed") {
    closeWithError(ctx, "already_subscribed", ctx.messages.liveSubscriptionActive, 1008);
    return;
  }
  const scope: InternalLiveScope =
    publicScope.kind === "all" ? publicScope : { kind: "book", bookId: (await resolvePublicId("books", publicScope.bookId)) ?? "" };
  if (scope.kind === "book" && !scope.bookId) {
    revoke(ctx, { ok: false, code: "not_found", message: ctx.messages.contactBookNotFound });
    return;
  }
  const access = await evaluateAccess(ctx, scope);
  if (isClosing(ctx)) return;
  if (!access.ok) {
    revoke(ctx, access);
    return;
  }

  let cursor: string;
  try {
    cursor = await resolveContactLiveCursor(fromCursor);
  } catch (error) {
    // The transport is slow or down: the client reconnects with backoff instead of reloading.
    log.warn("Contacts WebSocket could not resolve the live cursor", {
      error: error instanceof Error ? error.message : String(error),
    });
    closeWithError(ctx, "stream_failed", ctx.messages.liveStreamFailed, 1012);
    return;
  }
  if (ctx.phase === "closing") return;
  stopSubscription(ctx);
  ctx.phase = "subscribed";
  ctx.scope = scope;
  ctx.userId = access.userId;
  ctx.readableBookIds = access.readableBookIds;
  if (!send(ctx.socket, { type: CONTACTS_LIVE_WS_TYPE.ready, payload: { cursor } })) {
    closeWithError(ctx, "backpressure", ctx.messages.liveBackpressure, 1013);
    return;
  }
  startStream(ctx, scope, cursor);
  startAccessRefresh(ctx, scope);
};

const handleMessage = async (ctx: WsContext, raw: string) => {
  if (ctx.phase === "closing") return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    closeWithError(ctx, "invalid_json", ctx.messages.invalidJson, 1008);
    return;
  }
  const message = ContactLiveClientMessageSchema.safeParse(parsed);
  if (!message.success) {
    closeWithError(ctx, "invalid_message", ctx.messages.invalidLiveSubscription, 1008);
    return;
  }
  await handleSubscribe(ctx, message.data.payload.scope, message.data.payload.fromCursor);
};

const app = new Hono<AuthContext>().use("*", rateLimit({ keyBy: "auto", limitPerSecond: 5 })).get(
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
        if (!ctx || ctx.phase === "closing") return;
        if (typeof event.data !== "string" || event.data.length > MAX_CLIENT_MESSAGE_LENGTH) {
          closeWithError(ctx, "invalid_message", ctx.messages.invalidLiveSubscription, 1008);
          return;
        }
        if (pendingMessages >= MAX_PENDING_MESSAGES) {
          closeWithError(ctx, "backpressure", ctx.messages.tooManyLiveMessages, 1013);
          return;
        }
        pendingMessages++;
        const current = ctx;
        processing = processing
          .then(() => handleMessage(current, event.data as string))
          .catch((error) => {
            log.error("Contacts WebSocket message handling failed", {
              error: error instanceof Error ? error.message : String(error),
            });
            closeWithError(current, "internal_error", current.messages.liveSubscriptionFailed, 1011);
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
