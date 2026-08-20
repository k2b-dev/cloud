import type { TopicLiveEvent } from "@k2b/sync";
import type { NotebookPresenceParticipant, User } from "@valentinkolb/cloud/contracts";
import { auth } from "@valentinkolb/cloud/server";
import { accounts, logger } from "@valentinkolb/cloud/services";
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
import { createYjsAwarenessTopic, createYjsTopic, maxStreamCursor, NODE_ID, toBase64 } from "./service/yjs-sync";

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
    fromCursor: z.string().regex(notebooksYjs.streamCursorPattern).nullable().optional(),
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
    fromCursor: z.string().regex(notebooksWorkspace.streamCursorPattern).nullable().optional(),
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

type PushMessage = {
  type: typeof WS_TYPE.syncPush | typeof WS_TYPE.awarenessPush;
  noteId: string;
  updates: PushUpdate[];
};

const isWritablePermission = (permission: "none" | "read" | "write" | "admin"): boolean => permission === "write" || permission === "admin";

const createContext = (socket: ServerWebSocket<unknown>, sessionToken: string | null): WsContext => ({
  socket,
  phase: "open",
  sessionToken,
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
      const state = await notebooksService.presence.snapshot({ noteId: channel.noteId });
      const reader = notebooksService.presence.reader({
        noteId: channel.noteId,
        after: state.cursor,
      });

      for await (const event of reader.stream({ signal: channel.abort.signal })) {
        if (channel.abort.signal.aborted) break;
        await broadcastPresenceChanged(channel.noteId);
        if (event.type === "overflow") break;
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

  try {
    await yjsSnapshotWorker.queueSnapshotSave({
      noteId: ctx.noteId,
      targetCursor: ctx.lastPublishedCursor,
      reason,
    });
    ctx.dirty = false;
    stopSnapshotScheduler(ctx);
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
  const session = await auth.session.getData(sessionToken);
  if (!session) return null;
  return accounts.users.get({ id: session.userId });
};

type ResolvedNote = NonNullable<Awaited<ReturnType<typeof notebooksService.note.get>>>;
type ResolvedNotebook = NonNullable<Awaited<ReturnType<typeof notebooksService.notebook.get>>>;

const evaluateResolvedNoteAccess = async (
  note: ResolvedNote,
  noteShortId: string,
  user: User,
  mode: "read" | "write",
  deniedCode: NotebooksYjsErrorCode,
): Promise<AccessEvaluation> => {
  const permission = await notebooksService.notebook.permission.get({
    notebookId: note.notebookId,
    userId: user.id,
  });

  if (permission === "none") {
    return {
      ok: false,
      code: deniedCode,
      message: deniedCode === ERROR_CODE.accessRevoked ? "Access was revoked" : "Access denied",
      noteId: noteShortId,
    };
  }

  const canWrite = isWritablePermission(permission);
  if (mode === "write" && !canWrite) {
    return {
      ok: false,
      code: ERROR_CODE.accessDenied,
      message: "Write access required",
      noteId: noteShortId,
    };
  }

  if (note.lockedAt) {
    return {
      ok: false,
      code: ERROR_CODE.noteLocked,
      message: "Note is locked",
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
): Promise<AccessEvaluation> => {
  const note = await notebooksService.note.getByShortId({ shortId: noteShortId });
  if (!note) {
    return {
      ok: false,
      code: ERROR_CODE.noteNotFound,
      message: "Note not found",
      noteId: noteShortId,
    };
  }
  return evaluateResolvedNoteAccess(note, noteShortId, user, mode, deniedCode);
};

const evaluateResolvedNotebookAccess = async (
  notebook: ResolvedNotebook,
  notebookShortId: string,
  user: User,
  deniedCode: NotebooksYjsErrorCode,
): Promise<AccessEvaluation & { notebookId?: string }> => {
  const permission = await notebooksService.notebook.permission.get({
    notebookId: notebook.id,
    userId: user.id,
  });

  if (permission === "none") {
    return {
      ok: false,
      code: deniedCode,
      message: deniedCode === ERROR_CODE.accessRevoked ? "Access was revoked" : "Access denied",
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
): Promise<AccessEvaluation & { notebookId?: string }> => {
  const notebook = await notebooksService.notebook.getByShortId({ shortId: notebookShortId });
  if (!notebook) {
    return {
      ok: false,
      code: ERROR_CODE.noteNotFound,
      message: "Notebook not found",
      noteId: notebookShortId,
    };
  }
  return evaluateResolvedNotebookAccess(notebook, notebookShortId, user, deniedCode);
};

const refreshJoinedAccess = async (ctx: WsContext): Promise<AccessEvaluation> => {
  if (!ctx.noteId || !ctx.noteShortId) {
    return {
      ok: false,
      code: ERROR_CODE.noteNotFound,
      message: "Note not found",
    };
  }

  const user = await resolveSessionUser(ctx.sessionToken);
  if (!user) {
    return {
      ok: false,
      code: ERROR_CODE.sessionExpired,
      message: "Session expired",
      noteId: ctx.noteShortId,
    };
  }

  const note = await notebooksService.note.get({ id: ctx.noteId });
  if (!note) return { ok: false, code: ERROR_CODE.noteNotFound, message: "Note not found", noteId: ctx.noteShortId };
  const access = await evaluateResolvedNoteAccess(note, ctx.noteShortId, user, "read", ERROR_CODE.accessRevoked);
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
      message: "Notebook not found",
    };
  }

  const user = await resolveSessionUser(ctx.sessionToken);
  if (!user) {
    return {
      ok: false,
      code: ERROR_CODE.sessionExpired,
      message: "Session expired",
      noteId: ctx.workspaceNotebookShortId,
    };
  }

  const notebook = await notebooksService.notebook.get({ id: ctx.workspaceNotebookId });
  if (!notebook) {
    return { ok: false, code: ERROR_CODE.noteNotFound, message: "Notebook not found", noteId: ctx.workspaceNotebookShortId };
  }
  const access = await evaluateResolvedNotebookAccess(notebook, ctx.workspaceNotebookShortId, user, ERROR_CODE.accessRevoked);
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
      access.message ?? "Access refresh failed",
      access.noteId ?? ctx.noteShortId ?? undefined,
    );
    return false;
  } catch (error) {
    log.error("Access refresh failed", {
      noteId: ctx.noteId,
      error: error instanceof Error ? error.message : String(error),
    });
    await fatal(ctx, ERROR_CODE.internalError, "Access refresh failed", ctx.noteShortId ?? undefined);
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
      message: access.message ?? "Workspace access revoked",
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
      message: "Workspace access refresh failed",
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

const toPushUpdate = (event: TopicLiveEvent<YjsTopicEvent>): PushUpdate => ({
  cursor: event.cursor,
  payload: event.data.payload,
  originPeerId: event.data.originPeerId,
});

const pushTypeForKind = (kind: YjsTopicEvent["kind"]): typeof WS_TYPE.syncPush | typeof WS_TYPE.awarenessPush =>
  kind === "sync" ? WS_TYPE.syncPush : WS_TYPE.awarenessPush;

/**
 * Catch-up "drain quiet" window. After every event we pull from
 * the topic (forwarded OR skipped), we arm a timer for this
 * duration; if no further event arrives before it fires, the
 * backlog has *very likely* drained.
 *
 * Caveat (codex review on commit 3a121e0, finding 1): this remains
 * a wall-clock silence heuristic, not a "stream is actually empty"
 * signal. `@k2b/sync`'s `topic.live()` swallows the
 * "XREAD BLOCK timed out" case internally (its impl's
 * `if (!entry) continue`) and never surfaces it to the consumer,
 * so we can't observe "no more retained entries" deterministically
 * from this side. If Redis latency or a transient retry pause
 * exceeds 150 ms between yields, the timer can fire while real
 * backlog is still queued. The proper fix is to either:
 *   1. Add a head-cursor query to `@k2b/sync` so we know
 *      a deterministic stop condition at subscribe time, or
 *   2. Surface the empty-read signal from `topic.live()` itself.
 * Both require library changes; deferred. In practice 150 ms is
 * comfortably above local Redis round-trip times (typically
 * sub-ms) and the impact of misfiring is one Y.js merge with
 * slightly out-of-order updates — correct under CRDT semantics,
 * just not perfectly ordered.
 *
 * Picked at 150 ms: long enough to absorb single-digit-ms jitter
 * between rapid-fire events, short enough that a fresh-note
 * connect with empty topic feels instant (~150 ms gate before
 * `replayReady`).
 */
const CATCH_UP_DRAIN_QUIET_MS = 150;

/**
 * Hard cap on the catch-up phase. Even with the drain-quiet timer,
 * a truly continuous stream (multi-tab session, bot writes) might
 * never go quiet — at which point we fall back to "we've replayed
 * 2 s worth of backlog, anything still arriving is live enough."
 */
const CATCH_UP_MAX_MS = 2000;

const startLiveStream = (
  ctx: WsContext,
  noteId: string,
  noteShortId: string,
  afterCursor: string | null,
  /**
   * Fired exactly once when the catch-up phase ends — either because
   * we hit a "live edge" event (within `CATCH_UP_LIVE_EDGE_MS` of
   * now) or the `CATCH_UP_MAX_MS` fallback timer expires. The caller
   * should send `replayReady` from this callback so the client only
   * opens its send gate AFTER all retained sync events have been
   * forwarded. Critical for the fresh-note path (`afterCursor === null`):
   * without this, the user could reload, type, and the resulting
   * publish would be merged on top of an incomplete document — see
   * codex review on commit d87df13.
   */
  onCaughtUp: () => void,
) => {
  stopLiveStream(ctx);
  const abort = new AbortController();
  ctx.streamAbort = abort;

  // Awareness is transient collaboration state. Keep it off the retained
  // document stream so cursor movement never bloats snapshot replay.
  void (async () => {
    const awarenessTopic = createYjsAwarenessTopic(noteId);
    try {
      for await (const event of awarenessTopic.live({ signal: abort.signal })) {
        if (ctx.phase !== "joined" || ctx.noteId !== noteId) break;
        send(ctx.socket, WS_TYPE.awarenessPush, {
          noteId: noteShortId,
          updates: [toPushUpdate(event)],
        });
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        log.error("Yjs awareness stream failed", {
          noteId,
          error: error instanceof Error ? error.message : String(error),
        });
        await fatal(ctx, ERROR_CODE.internalError, "Live awareness stream failed", noteShortId);
      }
    }
  })();

  void (async () => {
    const noteTopic = createYjsTopic(noteId);
    const pending: PushMessage[] = [];
    let pendingEvents = 0;
    let pendingBytes = 0;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let caughtUp = false;
    let drainQuietTimer: ReturnType<typeof setTimeout> | null = null;
    let hardCapTimer: ReturnType<typeof setTimeout> | null = null;

    const clearCatchUpTimers = () => {
      if (drainQuietTimer) {
        clearTimeout(drainQuietTimer);
        drainQuietTimer = null;
      }
      if (hardCapTimer) {
        clearTimeout(hardCapTimer);
        hardCapTimer = null;
      }
    };

    const markCaughtUp = () => {
      if (caughtUp) return;
      caughtUp = true;
      clearCatchUpTimers();
      // Stale-stream guard (codex review on 696680a, finding 3): if
      // this stream was already replaced (note switch, reconnect)
      // before we hit caught-up, the active stream now belongs to a
      // different `replayRequest`. Sending `replayReady` here would
      // race with the new replay and could open the client's send
      // gate against the wrong note.
      if (ctx.streamAbort !== abort) {
        log.debug("Suppressing replayReady for stopped stream", { noteId });
        return;
      }
      // Flush any sync events we accumulated during catch-up before
      // signalling ready, so the client's first applyUpdate sequence
      // is contiguous with the eventual replayReady.
      flush();
      try {
        onCaughtUp();
      } catch (error) {
        log.warn("onCaughtUp callback threw", {
          noteId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    /**
     * Reset the drain-quiet timer. Called after every forwarded
     * event during catch-up. If no further event arrives within
     * `CATCH_UP_DRAIN_QUIET_MS`, the topic backlog has drained
     * (XREAD BLOCK returned empty) and we're at head.
     */
    const armDrainQuietTimer = () => {
      if (drainQuietTimer) clearTimeout(drainQuietTimer);
      drainQuietTimer = setTimeout(markCaughtUp, CATCH_UP_DRAIN_QUIET_MS);
    };

    // Hard cap: continuous streams (multi-tab session, bots) might
    // never go quiet. At 2 s we've replayed plenty of backlog and
    // call it live.
    hardCapTimer = setTimeout(markCaughtUp, CATCH_UP_MAX_MS);
    // Initial arm — handles the empty-topic case where no events
    // ever arrive: the drain-quiet timer fires after 150 ms and we
    // mark caught-up immediately.
    armDrainQuietTimer();

    const flush = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (pending.length === 0) return;
      const batch = pending.splice(0, pending.length);
      for (const entry of batch) {
        send(ctx.socket, entry.type, { noteId: entry.noteId, updates: entry.updates });
      }
      pendingEvents = 0;
      pendingBytes = 0;
    };

    const scheduleFlush = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(flush, NOTIFY_FLUSH_DELAY_MS);
    };

    try {
      for await (const event of noteTopic.live({
        // `"0-0"` = Redis Streams "from the very beginning" sentinel —
        // when there's no DB cursor yet (fresh note, snapshot worker
        // hasn't fired) we still need to replay every topic event the
        // user produced before reconnecting. Passing `undefined` would
        // fall through to `@k2b/sync`'s default of `"$"`,
        // which means "deliver only NEW events from now on" and
        // silently drops the in-flight history. Mirrors the pattern
        // used by `yjs-snapshot-worker.ts:waitUntilTargetCursor`.
        after: afterCursor ?? "0-0",
        signal: abort.signal,
      })) {
        if (ctx.phase !== "joined" || ctx.noteId !== noteId) break;

        // Ignore awareness entries written by pre-split deployments. New
        // awareness updates use the short-lived awareness topic above.
        if ((event.data as YjsTopicEvent).kind !== "sync") {
          if (!caughtUp) armDrainQuietTimer();
          continue;
        }

        const update = toPushUpdate(event);
        const type = pushTypeForKind(event.data.kind);

        if (event.data.kind === "sync") {
          ctx.lastPublishedCursor = maxStreamCursor(ctx.lastPublishedCursor, event.cursor);
        }

        const lastPending = pending.at(-1);
        if (lastPending && lastPending.type === type && lastPending.noteId === noteShortId) {
          lastPending.updates.push(update);
        } else {
          pending.push({ type, noteId: noteShortId, updates: [update] });
        }

        pendingEvents++;
        pendingBytes += update.payload.length;
        if (pendingEvents >= NOTIFY_BATCH_SIZE || pendingBytes >= NOTIFY_BATCH_MAX_BYTES) {
          flush();
        } else {
          scheduleFlush();
        }

        if (!caughtUp) armDrainQuietTimer();
      }
      // Loop exited normally (signal aborted / topic ended). The
      // `finally` clause below handles `markCaughtUp` — but only
      // for the active stream. A stopped/replaced stream's gate
      // resolution is suppressed by the stale-stream guard.
      flush();
    } catch (error) {
      if (!abort.signal.aborted) {
        log.error("Yjs live stream failed", {
          noteId,
          error: error instanceof Error ? error.message : String(error),
        });
        await fatal(ctx, ERROR_CODE.internalError, "Live sync stream failed", noteShortId);
      }
    } finally {
      clearCatchUpTimers();
      // Last-ditch resolve — but `markCaughtUp` itself drops the
      // call when this stream isn't the active one anymore (note
      // switch, fatal error mid-replay), so a stopped/failed
      // stream doesn't fire a stale `replayReady` for the next
      // note's connection on the same socket.
      markCaughtUp();
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
        log.error("Workspace event stream failed", {
          notebookId,
          error: error instanceof Error ? error.message : String(error),
        });
        send(ctx.socket, WORKSPACE_WS_TYPE.error, {
          notebookId: notebookShortId,
          code: ERROR_CODE.internalError,
          message: "Workspace event stream failed",
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
  warn(ctx.socket, ERROR_CODE.invalidMessage, `Message "${attemptedType}" is not allowed in phase "${ctx.phase}"`);
  return false;
};

const ensureJoinedNote = (ctx: WsContext, noteShortId: string): boolean => {
  if (ctx.phase !== "joined" || !ctx.noteShortId || ctx.noteShortId !== noteShortId) {
    warn(ctx.socket, ERROR_CODE.invalidPayload, "Replay request required before publishing", noteShortId);
    return false;
  }
  return true;
};

const ensureWritableNote = (ctx: WsContext, noteId: string): boolean => {
  if (!ctx.canWrite) {
    warn(ctx.socket, ERROR_CODE.accessDenied, "Write access required", noteId);
    return false;
  }
  return true;
};

const handleReplayRequest = async (ctx: WsContext, payload: z.infer<typeof ReplayRequestMessageSchema.shape.payload>) => {
  const user = await resolveSessionUser(ctx.sessionToken);
  if (!user) {
    await fatal(ctx, ERROR_CODE.loginRequired, "Login required", payload.noteId);
    return;
  }

  const access = await evaluateAccess(payload.noteId, user, "read", ERROR_CODE.accessDenied);
  if (!access.ok) {
    await fatal(ctx, access.code ?? ERROR_CODE.accessDenied, access.message ?? "Access denied", access.noteId ?? payload.noteId);
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

  let replayCursor = payload.fromCursor ?? null;
  if (!replayCursor) {
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

  // `replayReady` is now deferred until the live-stream's catch-up
  // phase ends — see `startLiveStream` for the gate logic. Sending it
  // immediately would let the client publish edits while retained
  // history is still being delivered, producing wonky merge order
  // (codex review on commit d87df13). Catch-up usually resolves in
  // <100ms on a healthy local Redis; the hard cap is `CATCH_UP_MAX_MS`
  // (2 s) so dormant notes don't hang.
  startLiveStream(ctx, dbNoteId, payload.noteId, replayCursor, () => {
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
  if (!ensureValidBase64(payload.payload)) {
    warn(ctx.socket, ERROR_CODE.invalidPayload, "Invalid base64 payload", payload.noteId);
    return;
  }

  // Topic keys stay UUID-backed below the public short-id boundary.
  const noteTopic = createYjsTopic(ctx.noteId!);
  const published = await noteTopic.pub({
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
    warn(ctx.socket, ERROR_CODE.invalidPayload, "Invalid base64 payload", payload.noteId);
    return;
  }

  const awarenessTopic = createYjsAwarenessTopic(ctx.noteId!);
  await awarenessTopic.pub({
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
      message: "Login required",
    });
    return;
  }

  const access = await evaluateNotebookAccess(payload.notebookId, user, ERROR_CODE.accessDenied);
  if (!access.ok || !access.notebookId) {
    send(ctx.socket, WORKSPACE_WS_TYPE.error, {
      notebookId: payload.notebookId,
      code: access.code ?? ERROR_CODE.accessDenied,
      message: access.message ?? "Access denied",
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
    warn(ctx.socket, ERROR_CODE.invalidJson, "Invalid JSON payload");
    return;
  }

  const message = ClientMessageSchema.safeParse(parsed);
  if (!message.success) {
    warn(ctx.socket, ERROR_CODE.invalidMessage, "Invalid message payload");
    return;
  }

  if (!ensurePhase(ctx, allowedTypesByPhase[ctx.phase], message.data.type)) return;
  await dispatchClientMessage(ctx, message.data);
};

const app = new Hono().get(
  "/",
  upgradeWebSocket((c) => {
    // Read the session from the forwarded cookie. Never accept it from a
    // client message: that would require handing the httpOnly token to the
    // browser, which puts the full credential into the page HTML.
    const sessionToken = auth.session.getToken(c);
    let ctx: WsContext | null = null;
    let processing: Promise<void> = Promise.resolve();
    let pendingMessages = 0;

    return {
      onOpen(_, ws) {
        ctx = createContext(ws.raw as ServerWebSocket<unknown>, sessionToken);
      },

      async onMessage(event) {
        if (!ctx) return;
        if (ctx.phase === "closing") return;
        if (typeof event.data !== "string") {
          warn(ctx.socket, ERROR_CODE.invalidMessage, "Only JSON text messages are supported");
          return;
        }
        if (event.data.length > MAX_CLIENT_MESSAGE_LENGTH) {
          await fatal(ctx, ERROR_CODE.invalidPayload, "Websocket message is too large", ctx.noteShortId ?? undefined);
          return;
        }

        if (pendingMessages >= MAX_PENDING_MESSAGES) {
          await fatal(ctx, ERROR_CODE.backpressure, "Too many pending websocket messages", ctx.noteShortId ?? undefined);
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
            await fatal(currentCtx, ERROR_CODE.internalError, "Message handling failed", currentCtx.noteShortId ?? undefined);
          })
          .finally(() => {
            pendingMessages = Math.max(0, pendingMessages - 1);
          });
      },

      async onClose() {
        if (!ctx) return;
        await processing.catch(() => undefined);
        if (ctx.phase === "closing") return;
        ctx.phase = "closing";
        await leaveCurrentNote(ctx);
        leaveCurrentWorkspace(ctx);
      },
    };
  }),
);

export default app;
