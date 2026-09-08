import { CursorMismatchError, RetentionGapError, type TopicEvent, type TopicLiveEvent } from "@k2b/sync";
import { retry } from "@k2b/sync/retry";
import type { NotebookPresenceParticipant, User } from "@valentinkolb/cloud/contracts";
import { auth, getLocale } from "@valentinkolb/cloud/server";
import { logger } from "@valentinkolb/cloud/services";
import type { ServerWebSocket } from "bun";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { z } from "zod";
import { SHORT_ID_REGEX } from "./lib/short-id";
import {
  isPermissionInvalidation,
  type NotebookWorkspaceEvent,
  notebooksWorkspace,
  type PublicNotebookWorkspaceEvent,
} from "./lib/workspace-events";
import { notebooksYjs } from "./lib/yjs";
import { notebooksService } from "./service";
import { PRESENCE_HEARTBEAT_INTERVAL_MS } from "./service/presence";
import { yjsSnapshotWorker } from "./service/yjs-snapshot-worker";
import type { YjsTopicEvent } from "./service/yjs-sync";
import { createYjsAwarenessTopic, createYjsTopic, isValidYjsUpdate, maxStreamCursor, NODE_ID, toBase64 } from "./service/yjs-sync";
import { type NotebooksWsMessages, notebooksWsMessages } from "./ws-messages";

/**
 * Notebooks realtime websocket (chat-style declarative flow):
 *
 * 1) Client opens socket and sends `notes.yjs.replay.request`.
 * 2) Server validates session + access, sends optional DB snapshot, starts topic stream.
 * 3) During `joined` phase, client may send sync/awareness publishes.
 * 4) Server periodically re-checks auth/access (10s). On terminal mismatch it sends
 *    `notes.yjs.error` with a code and closes the socket.
 *
 * The node is stateless across sockets and relies on the shared topic stream.
 */
const log = logger("yjs");
const WS_TYPE = notebooksYjs.wsType;
const WORKSPACE_WS_TYPE = notebooksWorkspace.wsType;
const ERROR_CODE = notebooksYjs.errorCode;
type NotebooksYjsErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];
type NotebooksYjsErrorPayload = {
  code: NotebooksYjsErrorCode;
  message: string;
  noteId?: string;
};

const SNAPSHOT_INTERVAL_MS = 8_000;
/**
 * Backstop only. Permission edits publish a `workspace.invalidated` event and
 * are acted on the moment it arrives; this timer exists for the changes that
 * publish nothing — FreeIPA group sync, account expiry, credential revocation.
 */
const ACCESS_REFRESH_INTERVAL_MS = 10_000;
const NOTIFY_BATCH_SIZE = 100;
const NOTIFY_BATCH_MAX_BYTES = 256_000;
const NOTIFY_FLUSH_DELAY_MS = 25;
const MAX_PENDING_MESSAGES = 200;
const MAX_SYNC_PAYLOAD_LENGTH = 8_000_000;
const MAX_AWARENESS_PAYLOAD_LENGTH = 256_000;
const MAX_CLIENT_MESSAGE_LENGTH = MAX_SYNC_PAYLOAD_LENGTH + 1_000;
const BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const ReplayRequestMessageSchema = z.object({
  type: z.literal(WS_TYPE.replayRequest),
  payload: z.object({
    noteId: z.string().regex(SHORT_ID_REGEX),
    // A bounded opaque cursor is validated by the owning topic; stale formats resync.
    fromCursor: z.string().max(256).nullable().optional(),
  }),
});

const SyncPublishMessageSchema = z.object({
  type: z.literal(WS_TYPE.syncPublish),
  payload: z.object({
    noteId: z.string().regex(SHORT_ID_REGEX),
    payload: z.string().min(1).max(MAX_SYNC_PAYLOAD_LENGTH),
  }),
});

const AwarenessPublishMessageSchema = z.object({
  type: z.literal(WS_TYPE.awarenessPublish),
  payload: z.object({
    noteId: z.string().regex(SHORT_ID_REGEX),
    payload: z.string().min(1).max(MAX_AWARENESS_PAYLOAD_LENGTH),
  }),
});

const WorkspaceSubscribeMessageSchema = z.object({
  type: z.literal(WORKSPACE_WS_TYPE.subscribe),
  payload: z.object({
    notebookId: z.string().regex(SHORT_ID_REGEX),
    fromCursor: z.string().max(256).nullable().optional(),
  }),
});

const ClientMessageSchema = z.discriminatedUnion("type", [
  ReplayRequestMessageSchema,
  SyncPublishMessageSchema,
  AwarenessPublishMessageSchema,
  WorkspaceSubscribeMessageSchema,
]);

type ClientMessage = z.infer<typeof ClientMessageSchema>;
type WsPhase = "open" | "joined" | "closing";

type WsContext = {
  socket: ServerWebSocket<unknown>;
  phase: WsPhase;
  sessionToken: string | null;
  messages: NotebooksWsMessages;
  user: User | null;
  /** Canonical UUID — what every DB call + presence channel uses. */
  noteId: string | null;
  /** Stable public short-id used on the websocket wire. */
  noteShortId: string | null;
  canWrite: boolean;
  peerId: string;
  streamAbort: AbortController | null;
  snapshotInterval: ReturnType<typeof setInterval> | null;
  presenceHeartbeatInterval: ReturnType<typeof setInterval> | null;
  accessRefreshTimeout: ReturnType<typeof setTimeout> | null;
  /** Notebook owning the joined note — the tenant of its permission events. */
  noteNotebookId: string | null;
  noteAccessWatchAbort: AbortController | null;
  workspaceNotebookId: string | null;
  workspaceNotebookShortId: string | null;
  workspaceAbort: AbortController | null;
  workspaceAccessRefreshTimeout: ReturnType<typeof setTimeout> | null;
  dirty: boolean;
  lastPublishedCursor: string | null;
};

type PresenceChannel = {
  noteId: string;
  members: Set<WsContext>;
  abort: AbortController;
  task: Promise<void>;
};

type AccessEvaluation = {
  ok: boolean;
  code?: NotebooksYjsErrorCode;
  message?: string;
  noteId?: string;
  /** Canonical UUID used below the websocket boundary. */
  resolvedNoteId?: string;
  /** Notebook the note belongs to; the tenant its permission events are published on. */
  notebookId?: string;
  canWrite?: boolean;
};

type PushUpdate = {
  cursor: string | null;
  payload: string;
  originPeerId: string | null;
};

const isWritablePermission = (permission: "none" | "read" | "write" | "admin"): boolean => permission === "write" || permission === "admin";

const createContext = (socket: ServerWebSocket<unknown>, sessionToken: string | null, locale: string): WsContext => ({
  socket,
  phase: "open",
  sessionToken,
  messages: notebooksWsMessages(locale),
  user: null,
  noteId: null,
  noteShortId: null,
  noteNotebookId: null,
  noteAccessWatchAbort: null,
  canWrite: false,
  peerId: crypto.randomUUID(),
  streamAbort: null,
  snapshotInterval: null,
  presenceHeartbeatInterval: null,
  accessRefreshTimeout: null,
  workspaceNotebookId: null,
  workspaceNotebookShortId: null,
  workspaceAbort: null,
  workspaceAccessRefreshTimeout: null,
  dirty: false,
  lastPublishedCursor: null,
});

const presenceChannels = new Map<string, PresenceChannel>();

const send = (socket: ServerWebSocket<unknown>, type: string, payload?: unknown) => {
  try {
    socket.send(JSON.stringify({ type, payload }));
  } catch {
    // Ignore send failures on closed sockets.
  }
};

const warn = (socket: ServerWebSocket<unknown>, code: NotebooksYjsErrorCode, message: string, noteId?: string) => {
  const payload: NotebooksYjsErrorPayload = noteId ? { code, message, noteId } : { code, message };
  send(socket, WS_TYPE.error, payload);
};

const closeCodeForError = (code: NotebooksYjsErrorCode): number => {
  if (code === ERROR_CODE.resyncRequired) return 1012;
  if (code === ERROR_CODE.internalError) return 1011;
  if (code === ERROR_CODE.backpressure) return 1013;
  return 1008;
};

const stopLiveStream = (ctx: WsContext) => {
  if (ctx.streamAbort) ctx.streamAbort.abort();
  ctx.streamAbort = null;
};

const stopSnapshotScheduler = (ctx: WsContext) => {
  if (ctx.snapshotInterval) clearInterval(ctx.snapshotInterval);
  ctx.snapshotInterval = null;
};

const stopPresenceHeartbeat = (ctx: WsContext) => {
  if (ctx.presenceHeartbeatInterval) clearInterval(ctx.presenceHeartbeatInterval);
  ctx.presenceHeartbeatInterval = null;
};

const stopAccessRefresh = (ctx: WsContext) => {
  if (ctx.accessRefreshTimeout) clearTimeout(ctx.accessRefreshTimeout);
  ctx.accessRefreshTimeout = null;
};

const stopNoteAccessWatch = (ctx: WsContext) => {
  if (ctx.noteAccessWatchAbort) ctx.noteAccessWatchAbort.abort();
  ctx.noteAccessWatchAbort = null;
};

const stopWorkspaceStream = (ctx: WsContext) => {
  if (ctx.workspaceAbort) ctx.workspaceAbort.abort();
  ctx.workspaceAbort = null;
};

const stopWorkspaceAccessRefresh = (ctx: WsContext) => {
  if (ctx.workspaceAccessRefreshTimeout) clearTimeout(ctx.workspaceAccessRefreshTimeout);
  ctx.workspaceAccessRefreshTimeout = null;
};

const sendPresenceMessage = (
  socket: ServerWebSocket<unknown>,
  type: typeof WS_TYPE.presenceSnapshot | typeof WS_TYPE.presenceChanged,
  noteId: string,
  participants: NotebookPresenceParticipant[],
) => {
  send(socket, type, {
    noteId,
    participants,
  });
};

const broadcastPresence = (
  channel: PresenceChannel,
  type: typeof WS_TYPE.presenceSnapshot | typeof WS_TYPE.presenceChanged,
  participants: NotebookPresenceParticipant[],
) => {
  for (const member of channel.members) {
    if (member.phase !== "joined" || member.noteId !== channel.noteId || !member.noteShortId) continue;
    sendPresenceMessage(member.socket, type, member.noteShortId, participants);
  }
};

const broadcastPresenceChanged = async (noteId: string) => {
  const channel = presenceChannels.get(noteId);
  if (!channel || channel.members.size === 0) return;

  const state = await notebooksService.presence.snapshot({ noteId });
  broadcastPresence(channel, WS_TYPE.presenceChanged, state.participants);
};

const runPresenceChannel = async (channel: PresenceChannel): Promise<void> => {
  while (!channel.abort.signal.aborted) {
    try {
      // Live-only watch: every change re-reads the bounded snapshot, so no cursor is tracked.
      for await (const _event of notebooksService.presence.watch({ noteId: channel.noteId, signal: channel.abort.signal })) {
        if (channel.abort.signal.aborted) break;
        await broadcastPresenceChanged(channel.noteId);
      }
    } catch (error) {
      if (channel.abort.signal.aborted) break;
      log.error("Presence stream failed", {
        noteId: channel.noteId,
        error: error instanceof Error ? error.message : String(error),
      });
      await Bun.sleep(500);
    }
  }
};

const ensurePresenceChannel = (noteId: string): PresenceChannel => {
  const existing = presenceChannels.get(noteId);
  if (existing) return existing;

  const channel: PresenceChannel = {
    noteId,
    members: new Set<WsContext>(),
    abort: new AbortController(),
    task: Promise.resolve(),
  };
  channel.task = runPresenceChannel(channel).finally(() => {
    const current = presenceChannels.get(noteId);
    if (current === channel && current.members.size === 0) {
      presenceChannels.delete(noteId);
    }
  });
  presenceChannels.set(noteId, channel);
  return channel;
};

const registerPresenceMember = (ctx: WsContext, noteId: string) => {
  ensurePresenceChannel(noteId).members.add(ctx);
};

const unregisterPresenceMember = (ctx: WsContext, noteId: string) => {
  const channel = presenceChannels.get(noteId);
  if (!channel) return;
  channel.members.delete(ctx);
  if (channel.members.size === 0) {
    channel.abort.abort();
    presenceChannels.delete(noteId);
  }
};

const sendPresenceSnapshot = async (ctx: WsContext, noteId: string) => {
  const state = await notebooksService.presence.snapshot({ noteId });
  if (ctx.noteShortId) sendPresenceMessage(ctx.socket, WS_TYPE.presenceSnapshot, ctx.noteShortId, state.participants);
};

const startPresenceHeartbeat = (ctx: WsContext) => {
  stopPresenceHeartbeat(ctx);
  if (ctx.phase !== "joined" || !ctx.noteId || !ctx.user) return;

  ctx.presenceHeartbeatInterval = setInterval(() => {
    const noteId = ctx.noteId;
    const user = ctx.user;
    if (!noteId || !user || ctx.phase !== "joined") return;

    void notebooksService.presence
      .heartbeat({
        noteId,
        peerId: ctx.peerId,
      })
      .then(async (result) => {
        if (result.ok) return;
        await notebooksService.presence.join({
          noteId,
          peerId: ctx.peerId,
          userId: user.id,
          displayName: user.displayName,
          avatarHash: user.avatarHash,
        });
      })
      .catch((error) => {
        log.warn("Presence heartbeat failed", {
          noteId,
          peerId: ctx.peerId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, PRESENCE_HEARTBEAT_INTERVAL_MS);
};

const queueSnapshotIfNeeded = async (ctx: WsContext, reason: "periodic" | "unload") => {
  if (!ctx.noteId || !ctx.dirty || !ctx.lastPublishedCursor) return;

  const queuedCursor = ctx.lastPublishedCursor;
  try {
    await yjsSnapshotWorker.queueSnapshotSave({
      noteId: ctx.noteId,
      targetCursor: queuedCursor,
      reason,
    });
    ctx.dirty = ctx.lastPublishedCursor !== queuedCursor;
    if (!ctx.dirty) stopSnapshotScheduler(ctx);
    log.debug("Queued snapshot save", {
      noteId: ctx.noteId,
      cursor: ctx.lastPublishedCursor,
      reason,
    });
  } catch (error) {
    log.error("Failed to queue snapshot save", {
      noteId: ctx.noteId,
      cursor: ctx.lastPublishedCursor,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
    if (reason === "unload") throw error;
  }
};

const startSnapshotScheduler = (ctx: WsContext) => {
  if (ctx.snapshotInterval) return;
  ctx.snapshotInterval = setInterval(() => {
    void queueSnapshotIfNeeded(ctx, "periodic");
  }, SNAPSHOT_INTERVAL_MS);
};

const leaveCurrentNote = async (ctx: WsContext) => {
  const noteId = ctx.noteId;
  await queueSnapshotIfNeeded(ctx, "unload");
  stopAccessRefresh(ctx);
  stopNoteAccessWatch(ctx);
  stopSnapshotScheduler(ctx);
  stopPresenceHeartbeat(ctx);
  stopLiveStream(ctx);
  if (noteId) {
    unregisterPresenceMember(ctx, noteId);
    try {
      await notebooksService.presence.leave({
        noteId,
        peerId: ctx.peerId,
        reason: ctx.phase === "closing" ? "socket-close" : "note-leave",
      });
      await broadcastPresenceChanged(noteId);
    } catch (error) {
      log.warn("Failed to leave presence", {
        noteId,
        peerId: ctx.peerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  ctx.noteId = null;
  ctx.noteShortId = null;
  ctx.noteNotebookId = null;
  ctx.canWrite = false;
  ctx.dirty = false;
  ctx.lastPublishedCursor = null;
  if (ctx.phase !== "closing") {
    ctx.phase = "open";
  }
};

const leaveCurrentWorkspace = (ctx: WsContext) => {
  stopWorkspaceAccessRefresh(ctx);
  stopWorkspaceStream(ctx);
  ctx.workspaceNotebookId = null;
  ctx.workspaceNotebookShortId = null;
};

const fatal = async (ctx: WsContext, code: NotebooksYjsErrorCode, message: string, noteId?: string) => {
  if (ctx.phase === "closing") return;
  ctx.phase = "closing";
  warn(ctx.socket, code, message, noteId);
  await leaveCurrentNote(ctx);
  leaveCurrentWorkspace(ctx);
  ctx.socket.close(closeCodeForError(code), code);
};

const ensureValidBase64 = (payload: string): boolean => payload.length > 0 && payload.length % 4 === 0 && BASE64_REGEX.test(payload);

const resolveSessionUser = async (sessionToken: string | null): Promise<User | null> => {
  if (!sessionToken) return null;
  return (await auth.session.authenticate(sessionToken))?.user ?? null;
};

type ResolvedNote = NonNullable<Awaited<ReturnType<typeof notebooksService.note.get>>>;
type ResolvedNotebook = NonNullable<Awaited<ReturnType<typeof notebooksService.notebook.get>>>;

const evaluateResolvedNoteAccess = async (
  note: ResolvedNote,
  noteShortId: string,
  user: User,
  mode: "read" | "write",
  deniedCode: NotebooksYjsErrorCode,
  messages: NotebooksWsMessages,
): Promise<AccessEvaluation> => {
  const permission = await notebooksService.notebook.permission.get({
    notebookId: note.notebookId,
    userId: user.id,
  });

  if (permission === "none") {
    return {
      ok: false,
      code: deniedCode,
      message: deniedCode === ERROR_CODE.accessRevoked ? messages.accessRevoked : messages.accessDenied,
      noteId: noteShortId,
    };
  }

  const canWrite = isWritablePermission(permission);
  if (mode === "write" && !canWrite) {
    return {
      ok: false,
      code: ERROR_CODE.accessDenied,
      message: messages.writeAccessRequired,
      noteId: noteShortId,
    };
  }

  if (note.lockedAt) {
    return {
      ok: false,
      code: ERROR_CODE.noteLocked,
      message: messages.noteLocked,
      noteId: noteShortId,
    };
  }

  return {
    ok: true,
    resolvedNoteId: note.id,
    notebookId: note.notebookId,
    canWrite,
  };
};

const evaluateAccess = async (
  noteShortId: string,
  user: User,
  mode: "read" | "write",
  deniedCode: NotebooksYjsErrorCode,
  messages: NotebooksWsMessages,
): Promise<AccessEvaluation> => {
  const note = await notebooksService.note.getByShortId({ shortId: noteShortId });
  if (!note) {
    return {
      ok: false,
      code: ERROR_CODE.noteNotFound,
      message: messages.noteNotFound,
      noteId: noteShortId,
    };
  }
  return evaluateResolvedNoteAccess(note, noteShortId, user, mode, deniedCode, messages);
};

const evaluateResolvedNotebookAccess = async (
  notebook: ResolvedNotebook,
  notebookShortId: string,
  user: User,
  deniedCode: NotebooksYjsErrorCode,
  messages: NotebooksWsMessages,
): Promise<AccessEvaluation & { notebookId?: string }> => {
  const permission = await notebooksService.notebook.permission.get({
    notebookId: notebook.id,
    userId: user.id,
  });

  if (permission === "none") {
    return {
      ok: false,
      code: deniedCode,
      message: deniedCode === ERROR_CODE.accessRevoked ? messages.accessRevoked : messages.accessDenied,
      noteId: notebookShortId,
    };
  }

  return {
    ok: true,
    notebookId: notebook.id,
    canWrite: isWritablePermission(permission),
  };
};

const evaluateNotebookAccess = async (
  notebookShortId: string,
  user: User,
  deniedCode: NotebooksYjsErrorCode,
  messages: NotebooksWsMessages,
): Promise<AccessEvaluation & { notebookId?: string }> => {
  const notebook = await notebooksService.notebook.getByShortId({ shortId: notebookShortId });
  if (!notebook) {
    return {
      ok: false,
      code: ERROR_CODE.noteNotFound,
      message: messages.notebookNotFound,
      noteId: notebookShortId,
    };
  }
  return evaluateResolvedNotebookAccess(notebook, notebookShortId, user, deniedCode, messages);
};

const refreshJoinedAccess = async (ctx: WsContext): Promise<AccessEvaluation> => {
  if (!ctx.noteId || !ctx.noteShortId) {
    return {
      ok: false,
      code: ERROR_CODE.noteNotFound,
      message: ctx.messages.noteNotFound,
    };
  }

  const user = await resolveSessionUser(ctx.sessionToken);
  if (!user) {
    return {
      ok: false,
      code: ERROR_CODE.sessionExpired,
      message: ctx.messages.sessionExpired,
      noteId: ctx.noteShortId,
    };
  }

  const note = await notebooksService.note.get({ id: ctx.noteId });
  if (!note) return { ok: false, code: ERROR_CODE.noteNotFound, message: ctx.messages.noteNotFound, noteId: ctx.noteShortId };
  const access = await evaluateResolvedNoteAccess(note, ctx.noteShortId, user, "read", ERROR_CODE.accessRevoked, ctx.messages);
  if (!access.ok) return access;
  ctx.user = user;
  ctx.canWrite = access.canWrite ?? false;
  return access;
};

const refreshWorkspaceAccess = async (ctx: WsContext): Promise<AccessEvaluation> => {
  if (!ctx.workspaceNotebookId || !ctx.workspaceNotebookShortId) {
    return {
      ok: false,
      code: ERROR_CODE.noteNotFound,
      message: ctx.messages.notebookNotFound,
    };
  }

  const user = await resolveSessionUser(ctx.sessionToken);
  if (!user) {
    return {
      ok: false,
      code: ERROR_CODE.sessionExpired,
      message: ctx.messages.sessionExpired,
      noteId: ctx.workspaceNotebookShortId,
    };
  }

  const notebook = await notebooksService.notebook.get({ id: ctx.workspaceNotebookId });
  if (!notebook) {
    return { ok: false, code: ERROR_CODE.noteNotFound, message: ctx.messages.notebookNotFound, noteId: ctx.workspaceNotebookShortId };
  }
  const access = await evaluateResolvedNotebookAccess(notebook, ctx.workspaceNotebookShortId, user, ERROR_CODE.accessRevoked, ctx.messages);
  if (!access.ok) return access;
  ctx.user = user;
  return access;
};

/** Re-evaluate the joined note's access. Returns false once the socket is done for. */
const revalidateNoteAccess = async (ctx: WsContext): Promise<boolean> => {
  if (ctx.phase !== "joined") return false;
  try {
    const access = await refreshJoinedAccess(ctx);
    if (access.ok) return true;
    await fatal(
      ctx,
      access.code ?? ERROR_CODE.internalError,
      access.message ?? ctx.messages.accessRefreshFailed,
      access.noteId ?? ctx.noteShortId ?? undefined,
    );
    return false;
  } catch (error) {
    log.error("Access refresh failed", {
      noteId: ctx.noteId,
      error: error instanceof Error ? error.message : String(error),
    });
    await fatal(ctx, ERROR_CODE.internalError, ctx.messages.accessRefreshFailed, ctx.noteShortId ?? undefined);
    return false;
  }
};

const startAccessRefresh = (ctx: WsContext) => {
  stopAccessRefresh(ctx);
  if (ctx.phase !== "joined" || !ctx.noteId) return;

  ctx.accessRefreshTimeout = setTimeout(async () => {
    if (await revalidateNoteAccess(ctx)) startAccessRefresh(ctx);
  }, ACCESS_REFRESH_INTERVAL_MS);
};

/** Re-evaluate the joined workspace's access. Returns false once it has been left. */
const revalidateWorkspaceAccess = async (ctx: WsContext): Promise<boolean> => {
  if (!ctx.workspaceNotebookId || !ctx.workspaceNotebookShortId) return false;
  try {
    const access = await refreshWorkspaceAccess(ctx);
    if (access.ok) return true;
    send(ctx.socket, WORKSPACE_WS_TYPE.revoked, {
      notebookId: ctx.workspaceNotebookShortId,
      code: access.code ?? ERROR_CODE.accessRevoked,
      message: access.message ?? ctx.messages.workspaceAccessRevoked,
    });
    leaveCurrentWorkspace(ctx);
    return false;
  } catch (error) {
    log.error("Workspace access refresh failed", {
      notebookId: ctx.workspaceNotebookId,
      error: error instanceof Error ? error.message : String(error),
    });
    send(ctx.socket, WORKSPACE_WS_TYPE.error, {
      notebookId: ctx.workspaceNotebookShortId,
      code: ERROR_CODE.internalError,
      message: ctx.messages.workspaceAccessRefreshFailed,
    });
    leaveCurrentWorkspace(ctx);
    return false;
  }
};

const startWorkspaceAccessRefresh = (ctx: WsContext) => {
  stopWorkspaceAccessRefresh(ctx);
  if (!ctx.workspaceNotebookId) return;

  ctx.workspaceAccessRefreshTimeout = setTimeout(async () => {
    if (await revalidateWorkspaceAccess(ctx)) startWorkspaceAccessRefresh(ctx);
  }, ACCESS_REFRESH_INTERVAL_MS);
};

const markDirty = (ctx: WsContext, cursor: string) => {
  ctx.lastPublishedCursor = maxStreamCursor(ctx.lastPublishedCursor, cursor);
  ctx.dirty = true;
  startSnapshotScheduler(ctx);
};

const toPushUpdate = (event: TopicEvent<YjsTopicEvent> | TopicLiveEvent<YjsTopicEvent>): PushUpdate => ({
  cursor: "cursor" in event ? event.cursor : null,
  payload: event.data.payload,
  originPeerId: event.data.originPeerId,
});

/**
 * Stream failures are never terminal for the editor. The client answers
 * `RESYNC_REQUIRED` by reconnecting with its last cursor, which is the right
 * recovery for a broker failover or a lost consumer as well as for a stale
 * cursor; `INTERNAL_ERROR` would leave the editor stuck until a reload.
 */
const failLiveStream = async (ctx: WsContext, noteId: string, noteShortId: string, stream: "sync" | "awareness", error: unknown) => {
  log.error(stream === "sync" ? "Yjs live stream failed" : "Yjs awareness stream failed", {
    noteId,
    error: error instanceof Error ? error.message : String(error),
  });
  await fatal(
    ctx,
    ERROR_CODE.resyncRequired,
    stream === "sync" ? ctx.messages.liveSyncStreamFailed : ctx.messages.liveAwarenessStreamFailed,
    noteShortId,
  );
};

const startLiveStream = (
  ctx: WsContext,
  noteId: string,
  noteShortId: string,
  replay: {
    after: string | null;
    /** True when `after` is the stored snapshot's cursor: the client holds that snapshot as its base. */
    storedBase: boolean;
  },
  // Fired only after deterministic replay to the captured head.
  onCaughtUp: () => void,
) => {
  stopLiveStream(ctx);
  const abort = new AbortController();
  ctx.streamAbort = abort;

  // Awareness is transient collaboration state. Keep it off the retained
  // document stream so cursor movement never bloats snapshot replay.
  void (async () => {
    const awarenessTopic = createYjsAwarenessTopic();
    try {
      for await (const event of awarenessTopic.live({ tenantId: noteId, signal: abort.signal })) {
        if (ctx.phase !== "joined" || ctx.noteId !== noteId) break;
        send(ctx.socket, WS_TYPE.awarenessPush, {
          noteId: noteShortId,
          updates: [toPushUpdate(event)],
        });
      }
    } catch (error) {
      if (!abort.signal.aborted) await failLiveStream(ctx, noteId, noteShortId, "awareness", error);
    }
  })();

  void (async () => {
    const noteTopic = createYjsTopic(noteId);
    const pending: PushUpdate[] = [];
    let pendingBytes = 0;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (pending.length === 0) return;
      send(ctx.socket, WS_TYPE.syncPush, { noteId: noteShortId, updates: pending.splice(0, pending.length) });
      pendingBytes = 0;
    };

    const scheduleFlush = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(flush, NOTIFY_FLUSH_DELAY_MS);
    };

    try {
      const events = async function* () {
        let head = await noteTopic.latestCursor();
        if (head) {
          let delivered = 0;
          try {
            for await (const event of noteTopic.replay({
              after: replay.after ?? noteTopic.cursorAt(0),
              until: head,
              signal: abort.signal,
            })) {
              delivered++;
              yield event;
            }
          } catch (error) {
            // The stored snapshot's own cursor fell below retention. Reconnecting
            // cannot help: the client would receive the same snapshot and gap
            // again. Re-anchor the snapshot at the head (loud, terminal) and
            // continue from there. A gap after partial delivery, or a client
            // cursor gap, still resyncs: the client then rebuilds from the store.
            if (!(error instanceof RetentionGapError) || !replay.storedBase || delivered > 0) throw error;
            const adopted = await notebooksService.note.adoptSnapshotAtHead({ noteId, gap: error });
            if (!adopted) throw error;
            head = adopted.cursor;
          }
        }
        if (abort.signal.aborted || ctx.streamAbort !== abort) return;
        flush();
        onCaughtUp();
        yield* noteTopic.hub().subscribe({ after: head ?? replay.after ?? noteTopic.cursorAt(0), signal: abort.signal });
      };
      for await (const event of events()) {
        if (ctx.phase !== "joined" || ctx.noteId !== noteId) break;
        ctx.lastPublishedCursor = maxStreamCursor(ctx.lastPublishedCursor, event.cursor);
        const update = toPushUpdate(event);
        pending.push(update);
        pendingBytes += update.payload.length;
        if (pending.length >= NOTIFY_BATCH_SIZE || pendingBytes >= NOTIFY_BATCH_MAX_BYTES) {
          flush();
        } else {
          scheduleFlush();
        }
      }
      flush();
    } catch (error) {
      if (!abort.signal.aborted) await failLiveStream(ctx, noteId, noteShortId, "sync", error);
    } finally {
      if (flushTimer) clearTimeout(flushTimer);
      flush();
      if (ctx.streamAbort === abort) {
        ctx.streamAbort = null;
      }
    }
  })();
};

/**
 * Watch the owning notebook's permission events for the joined note.
 *
 * Without this a withdrawn grant kept streaming document content, and kept
 * accepting edits, until the backstop timer next fired. The events are already
 * published by every notebook access mutation, so reacting to them costs one
 * subscription and closes the window to a round trip.
 */
const startNoteAccessWatch = (ctx: WsContext, notebookId: string) => {
  stopNoteAccessWatch(ctx);
  const abort = new AbortController();
  ctx.noteAccessWatchAbort = abort;

  void (async () => {
    try {
      for await (const event of notebooksService.workspaceEvents.live({ notebookId, signal: abort.signal })) {
        if (abort.signal.aborted || ctx.noteNotebookId !== notebookId) break;
        if (!isPermissionInvalidation(event.data)) continue;
        if (!(await revalidateNoteAccess(ctx))) break;
      }
    } catch (error) {
      if (abort.signal.aborted) return;
      // Losing the watch would silently drop back to timer-only revocation, so
      // it is reported rather than swallowed. The timer still covers the note.
      log.error("Note access watch failed", {
        noteId: ctx.noteId,
        notebookId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (ctx.noteAccessWatchAbort === abort) ctx.noteAccessWatchAbort = null;
    }
  })();
};

const toPublicWorkspaceEvent = async (event: NotebookWorkspaceEvent, notebookShortId: string): Promise<PublicNotebookWorkspaceEvent> => {
  if (event.type === "notebook.updated") {
    const { shortId, homepageNoteShortId, ...notebook } = event.notebook;
    return {
      ...event,
      notebookId: notebookShortId,
      notebook: { ...notebook, id: shortId, homepageNoteId: homepageNoteShortId },
    };
  }

  if (event.type === "note.created" || event.type === "note.updated") {
    const { shortId, parentShortId, ...note } = event.note;
    return {
      ...event,
      notebookId: notebookShortId,
      note: {
        ...note,
        id: shortId,
        notebookId: notebookShortId,
        parentId: parentShortId,
      },
    };
  }

  if (event.type === "note.deleted") {
    const { shortId, ...rest } = event;
    return { ...rest, notebookId: notebookShortId, noteId: shortId };
  }

  if (event.type === "note.favorite.changed") {
    const { shortId, ...rest } = event;
    if (!shortId) {
      return { v: 1, type: "workspace.invalidated", notebookId: notebookShortId, reason: "unknown", scopes: ["tree"] };
    }
    return { ...rest, notebookId: notebookShortId, noteId: shortId };
  }

  if (event.type === "note.comments.changed") {
    const { noteShortId, ...rest } = event;
    if (!noteShortId) {
      return { v: 1, type: "workspace.invalidated", notebookId: notebookShortId, reason: "unknown", scopes: ["tree"] };
    }
    return { ...rest, notebookId: notebookShortId, noteId: noteShortId };
  }

  return { ...event, notebookId: notebookShortId };
};

const startWorkspaceStream = (ctx: WsContext, notebookId: string, notebookShortId: string, afterCursor: string | null) => {
  stopWorkspaceStream(ctx);
  const abort = new AbortController();
  ctx.workspaceAbort = abort;

  void (async () => {
    try {
      send(ctx.socket, WORKSPACE_WS_TYPE.ready, { notebookId: notebookShortId });
      for await (const event of notebooksService.workspaceEvents.live({
        notebookId,
        after: afterCursor ?? undefined,
        signal: abort.signal,
      })) {
        if (abort.signal.aborted || ctx.workspaceNotebookId !== notebookId) break;
        send(ctx.socket, WORKSPACE_WS_TYPE.event, {
          notebookId: notebookShortId,
          cursor: event.cursor,
          event: await toPublicWorkspaceEvent(event.data, notebookShortId),
        });
        // The client was told; now re-check on the server, which is the side
        // that decides. Previously this event was forwarded and nothing else.
        if (isPermissionInvalidation(event.data) && !(await revalidateWorkspaceAccess(ctx))) break;
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        if (error instanceof CursorMismatchError || error instanceof RetentionGapError) {
          const head = await notebooksService.workspaceEvents.latestCursor({ notebookId });
          send(ctx.socket, WORKSPACE_WS_TYPE.event, {
            notebookId: notebookShortId,
            cursor: head,
            event: {
              v: 1,
              type: "workspace.invalidated",
              notebookId: notebookShortId,
              reason: "unknown",
              scopes: ["notebook", "tree", "tags", "references", "permissions"],
            },
          });
          startWorkspaceStream(ctx, notebookId, notebookShortId, head);
          return;
        }
        log.error("Workspace event stream failed", {
          notebookId,
          error: error instanceof Error ? error.message : String(error),
        });
        send(ctx.socket, WORKSPACE_WS_TYPE.error, {
          notebookId: notebookShortId,
          code: ERROR_CODE.internalError,
          message: ctx.messages.workspaceStreamFailed,
        });
      }
    } finally {
      if (ctx.workspaceAbort === abort) {
        ctx.workspaceAbort = null;
      }
    }
  })();
};

const ensurePhase = (ctx: WsContext, allowedTypes: readonly string[], attemptedType: string): boolean => {
  if (allowedTypes.includes(attemptedType)) return true;
  warn(ctx.socket, ERROR_CODE.invalidMessage, ctx.messages.messageNotAllowed({ type: attemptedType, phase: ctx.phase }));
  return false;
};

const ensureJoinedNote = (ctx: WsContext, noteShortId: string): boolean => {
  if (ctx.phase !== "joined" || !ctx.noteShortId || ctx.noteShortId !== noteShortId) {
    warn(ctx.socket, ERROR_CODE.invalidPayload, ctx.messages.replayRequired, noteShortId);
    return false;
  }
  return true;
};

const ensureWritableNote = (ctx: WsContext, noteId: string): boolean => {
  if (!ctx.canWrite) {
    warn(ctx.socket, ERROR_CODE.accessDenied, ctx.messages.writeAccessRequired, noteId);
    return false;
  }
  return true;
};

const handleReplayRequest = async (ctx: WsContext, payload: z.infer<typeof ReplayRequestMessageSchema.shape.payload>) => {
  const user = await resolveSessionUser(ctx.sessionToken);
  if (!user) {
    await fatal(ctx, ERROR_CODE.loginRequired, ctx.messages.loginRequired, payload.noteId);
    return;
  }

  const access = await evaluateAccess(payload.noteId, user, "read", ERROR_CODE.accessDenied, ctx.messages);
  if (!access.ok) {
    await fatal(ctx, access.code ?? ERROR_CODE.accessDenied, access.message ?? ctx.messages.accessDenied, access.noteId ?? payload.noteId);
    return;
  }
  const dbNoteId = access.resolvedNoteId!;

  if (ctx.noteId && ctx.noteId !== dbNoteId) {
    await leaveCurrentNote(ctx);
  }

  ctx.phase = "joined";
  ctx.user = user;
  ctx.noteId = dbNoteId;
  ctx.noteShortId = payload.noteId;
  ctx.noteNotebookId = access.notebookId ?? null;
  ctx.canWrite = access.canWrite ?? false;

  registerPresenceMember(ctx, dbNoteId);
  await notebooksService.presence.join({
    noteId: dbNoteId,
    peerId: ctx.peerId,
    userId: user.id,
    displayName: user.displayName,
    avatarHash: user.avatarHash,
  });
  await sendPresenceSnapshot(ctx, dbNoteId);
  await broadcastPresenceChanged(dbNoteId);
  startPresenceHeartbeat(ctx);

  const clientCursor = payload.fromCursor && notebooksYjs.streamCursorPattern.test(payload.fromCursor) ? payload.fromCursor : null;
  let replayCursor = clientCursor;
  if (!clientCursor) {
    const snapshot = await notebooksService.note.getYjsStateWithCursor({ noteId: dbNoteId });
    if (snapshot?.yjsState) {
      send(ctx.socket, WS_TYPE.syncPush, {
        noteId: payload.noteId,
        updates: [
          {
            cursor: snapshot.streamCursor,
            payload: toBase64(snapshot.yjsState),
            originPeerId: null,
          },
        ],
      });
    }
    replayCursor = snapshot?.streamCursor ?? null;
  }

  // `replayReady` is deferred until retained history up to the captured head
  // has been delivered (see `startLiveStream`). Sending it earlier would let
  // the client publish edits while catch-up is still streaming.
  startLiveStream(ctx, dbNoteId, payload.noteId, { after: replayCursor, storedBase: !clientCursor }, () => {
    send(ctx.socket, WS_TYPE.replayReady, { noteId: payload.noteId });
  });
  startAccessRefresh(ctx);
  if (ctx.noteNotebookId) startNoteAccessWatch(ctx, ctx.noteNotebookId);
  log.debug("Replay stream started", {
    noteId: dbNoteId,
    peerId: ctx.peerId,
    fromCursor: replayCursor,
  });
};

const handleSyncPublish = async (ctx: WsContext, payload: z.infer<typeof SyncPublishMessageSchema.shape.payload>) => {
  if (!ensureJoinedNote(ctx, payload.noteId)) return;
  if (!ensureWritableNote(ctx, payload.noteId)) return;
  // Once retained, an undecodable update poisons every replay of this note.
  if (!isValidYjsUpdate(payload.payload)) {
    warn(ctx.socket, ERROR_CODE.invalidPayload, ctx.messages.invalidSyncUpdate, payload.noteId);
    return;
  }

  // Topic keys stay UUID-backed below the public short-id boundary.
  const noteTopic = createYjsTopic(ctx.noteId!);
  const published = await noteTopic.publish({
    data: {
      kind: "sync",
      payload: payload.payload,
      originNodeId: NODE_ID,
      originPeerId: ctx.peerId,
      actor: { kind: "user", id: ctx.user!.id },
    },
  });

  markDirty(ctx, published.cursor);
};

const handleAwarenessPublish = async (ctx: WsContext, payload: z.infer<typeof AwarenessPublishMessageSchema.shape.payload>) => {
  if (!ensureJoinedNote(ctx, payload.noteId)) return;
  if (!ensureValidBase64(payload.payload)) {
    warn(ctx.socket, ERROR_CODE.invalidPayload, ctx.messages.invalidBase64, payload.noteId);
    return;
  }

  const awarenessTopic = createYjsAwarenessTopic();
  await awarenessTopic.publish({
    tenantId: ctx.noteId!,
    data: {
      kind: "awareness",
      payload: payload.payload,
      originNodeId: NODE_ID,
      originPeerId: ctx.peerId,
    },
  });
};

const handleWorkspaceSubscribe = async (ctx: WsContext, payload: z.infer<typeof WorkspaceSubscribeMessageSchema.shape.payload>) => {
  const user = await resolveSessionUser(ctx.sessionToken);
  if (!user) {
    send(ctx.socket, WORKSPACE_WS_TYPE.error, {
      notebookId: payload.notebookId,
      code: ERROR_CODE.loginRequired,
      message: ctx.messages.loginRequired,
    });
    return;
  }

  const access = await evaluateNotebookAccess(payload.notebookId, user, ERROR_CODE.accessDenied, ctx.messages);
  if (!access.ok || !access.notebookId) {
    send(ctx.socket, WORKSPACE_WS_TYPE.error, {
      notebookId: payload.notebookId,
      code: access.code ?? ERROR_CODE.accessDenied,
      message: access.message ?? ctx.messages.accessDenied,
    });
    return;
  }

  ctx.user = user;
  ctx.workspaceNotebookId = access.notebookId;
  ctx.workspaceNotebookShortId = payload.notebookId;
  startWorkspaceStream(ctx, access.notebookId, payload.notebookId, payload.fromCursor ?? null);
  startWorkspaceAccessRefresh(ctx);
};

const handlers = {
  [WS_TYPE.replayRequest]: handleReplayRequest,
  [WS_TYPE.syncPublish]: handleSyncPublish,
  [WS_TYPE.awarenessPublish]: handleAwarenessPublish,
  [WORKSPACE_WS_TYPE.subscribe]: handleWorkspaceSubscribe,
} satisfies {
  [K in ClientMessage["type"]]: (ctx: WsContext, payload: Extract<ClientMessage, { type: K }>["payload"]) => Promise<void>;
};

const allowedTypesByPhase: Record<WsPhase, readonly ClientMessage["type"][]> = {
  open: [WS_TYPE.replayRequest, WORKSPACE_WS_TYPE.subscribe],
  joined: [WS_TYPE.replayRequest, WS_TYPE.syncPublish, WS_TYPE.awarenessPublish, WORKSPACE_WS_TYPE.subscribe],
  closing: [],
};

const dispatchClientMessage = async (ctx: WsContext, message: ClientMessage) => {
  if (message.type === WS_TYPE.replayRequest) {
    await handlers[WS_TYPE.replayRequest](ctx, message.payload);
    return;
  }
  if (message.type === WS_TYPE.syncPublish) {
    await handlers[WS_TYPE.syncPublish](ctx, message.payload);
    return;
  }
  if (message.type === WORKSPACE_WS_TYPE.subscribe) {
    await handlers[WORKSPACE_WS_TYPE.subscribe](ctx, message.payload);
    return;
  }
  await handlers[WS_TYPE.awarenessPublish](ctx, message.payload);
};

const handleClientMessage = async (ctx: WsContext, raw: string): Promise<void> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warn(ctx.socket, ERROR_CODE.invalidJson, ctx.messages.invalidJson);
    return;
  }

  const message = ClientMessageSchema.safeParse(parsed);
  if (!message.success) {
    warn(ctx.socket, ERROR_CODE.invalidMessage, ctx.messages.invalidMessage);
    return;
  }

  if (!ensurePhase(ctx, allowedTypesByPhase[ctx.phase], message.data.type)) return;
  await dispatchClientMessage(ctx, message.data);
};

const activeConnections = new Set<() => Promise<void>>();
let stoppingConnections = false;

/** Flush accepted edits and enqueue their snapshots before Sync workers drain. */
export const drainNotebookConnections = async (): Promise<void> => {
  stoppingConnections = true;
  // Match Sync's default 30-second drain budget and snapshot job retry delay.
  await retry({
    signal: AbortSignal.timeout(30_000),
    run: () => Promise.all([...activeConnections].map((close) => close())),
    after: ({ ctx }) => {
      if (ctx.error) ctx.reschedule({ delayMs: 5_000 });
    },
  });
};

const app = new Hono().get(
  "/",
  upgradeWebSocket((c) => {
    // Read the session from the forwarded cookie. Never accept it from a
    // client message: that would require handing the httpOnly token to the
    // browser, which puts the full credential into the page HTML.
    const sessionToken = auth.session.getToken(c);
    const locale = getLocale(c);
    let ctx: WsContext | null = null;
    let processing: Promise<void> = Promise.resolve();
    let pendingMessages = 0;
    let closing: Promise<void> | null = null;
    const close = (): Promise<void> => {
      closing ??= (async () => {
        await processing.catch(() => undefined);
        if (!ctx) return;
        ctx.phase = "closing";
        await leaveCurrentNote(ctx);
        leaveCurrentWorkspace(ctx);
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

    return {
      onOpen(_, ws) {
        ctx = createContext(ws.raw as ServerWebSocket<unknown>, sessionToken, locale);
        if (stoppingConnections) {
          void close();
          return;
        }
        activeConnections.add(close);
      },

      async onMessage(event) {
        if (!ctx || stoppingConnections || closing) return;
        if (ctx.phase === "closing") return;
        if (typeof event.data !== "string") {
          warn(ctx.socket, ERROR_CODE.invalidMessage, ctx.messages.jsonTextOnly);
          return;
        }
        if (event.data.length > MAX_CLIENT_MESSAGE_LENGTH) {
          await fatal(ctx, ERROR_CODE.invalidPayload, ctx.messages.messageTooLarge, ctx.noteShortId ?? undefined);
          return;
        }

        if (pendingMessages >= MAX_PENDING_MESSAGES) {
          await fatal(ctx, ERROR_CODE.backpressure, ctx.messages.tooManyMessages, ctx.noteShortId ?? undefined);
          return;
        }

        pendingMessages++;
        const raw = event.data;
        const currentCtx = ctx;
        processing = processing
          .then(() => handleClientMessage(currentCtx, raw))
          .catch(async (error) => {
            log.error("Websocket message handling failed", {
              noteId: currentCtx.noteId,
              error: error instanceof Error ? error.message : String(error),
            });
            await fatal(currentCtx, ERROR_CODE.internalError, currentCtx.messages.handlingFailed, currentCtx.noteShortId ?? undefined);
          })
          .finally(() => {
            pendingMessages = Math.max(0, pendingMessages - 1);
          });
      },

      async onClose() {
        await close();
      },
    };
  }),
);

export default app;
