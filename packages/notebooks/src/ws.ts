import type { NotebookPresenceParticipant, User } from "@k2b/cloud/contracts";
import { subscribeIdentityAccessChanged } from "@k2b/cloud/events";
import { type AuthContext, auth, getLocale, guardAppAccessSocket } from "@k2b/cloud/server";
import { logger } from "@k2b/cloud/services";
import {
  createSharedTextRoom,
  createSharedTextRoomContext,
  type SharedTextRoomAccess,
  type SharedTextRoomContext,
  type SharedTextRoomMessages,
  type SharedTextRoomSocket,
} from "@k2b/cloud/shared-text";
import { CursorMismatchError, RetentionGapError } from "@k2b/sync";
import { personColor } from "@k2b/ui";
import type { ServerWebSocket } from "bun";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { z } from "zod";
import { SHORT_ID_REGEX } from "./lib/short-id";
import { isPermissionInvalidation, notebooksWorkspace, toPublicWorkspaceEvent } from "./lib/workspace-events";
import { notebooksYjs } from "./lib/yjs";
import { notebooksService } from "./service";
import { PRESENCE_HEARTBEAT_INTERVAL_MS } from "./service/presence";
import { yjsSnapshotWorker } from "./service/yjs-snapshot-worker";
import { createYjsAwarenessTopic, notebooksTextLog } from "./service/yjs-sync";
import { type NotebooksWsMessages, notebooksWsMessages } from "./ws-messages";

const log = logger("yjs");
const WS_TYPE = notebooksYjs.wsType;
const WORKSPACE_WS_TYPE = notebooksWorkspace.wsType;
const ERROR_CODE = notebooksYjs.errorCode;
type NotebooksYjsErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];
type Messages = NotebooksWsMessages & SharedTextRoomMessages;
type WsContext = SharedTextRoomContext<User, Messages> & {
  presenceHeartbeatInterval: ReturnType<typeof setInterval> | null;
  presenceTask: Promise<void> | null;
  workspaceNotebookId: string | null;
  workspaceNotebookShortId: string | null;
  workspaceAbort: AbortController | null;
};
type AccessEvaluation = SharedTextRoomAccess & { notebookId?: string; noteId?: string };
type PresenceChannel = { noteId: string; members: Set<WsContext>; abort: AbortController; task: Promise<void> };
const presenceChannels = new Map<string, PresenceChannel>();
const isWritablePermission = (permission: "none" | "read" | "write" | "admin") => permission === "write" || permission === "admin";
const WorkspaceSubscribeMessageSchema = z.object({
  type: z.literal(WORKSPACE_WS_TYPE.subscribe),
  payload: z.object({
    notebookId: z.string().regex(SHORT_ID_REGEX),
    fromCursor: z.string().max(256).nullable().optional(),
  }),
});

const WorkspacePresenceWatchMessageSchema = z.object({
  type: z.literal(WORKSPACE_WS_TYPE.presenceWatch),
  payload: z.object({
    noteId: z.string().regex(SHORT_ID_REGEX).nullable(),
    presencePeerId: z.uuid(),
  }),
});

const ClientMessageSchema = z.discriminatedUnion("type", [WorkspaceSubscribeMessageSchema, WorkspacePresenceWatchMessageSchema]);
const createContext = (socket: ServerWebSocket<unknown>, credential: string | null, locale: string): WsContext => ({
  ...createSharedTextRoomContext<User, Messages>(socket, credential, {
    ...notebooksWsMessages(locale),
    notFound: notebooksWsMessages(locale).noteNotFound,
  }),
  presenceHeartbeatInterval: null,
  presenceTask: null,
  workspaceNotebookId: null,
  workspaceNotebookShortId: null,
  workspaceAbort: null,
});

const stopPresenceHeartbeat = (ctx: WsContext) => {
  if (ctx.presenceHeartbeatInterval) clearInterval(ctx.presenceHeartbeatInterval);
  ctx.presenceHeartbeatInterval = null;
};

const stopWorkspaceStream = (ctx: WsContext) => {
  if (ctx.workspaceAbort) ctx.workspaceAbort.abort();
  ctx.workspaceAbort = null;
};

const sendPresenceMessage = (
  socket: SharedTextRoomSocket,
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
    if (member.phase !== "joined" || member.docId !== channel.noteId || !member.publicDocId) continue;
    sendPresenceMessage(member.socket, type, member.publicDocId, participants);
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
  if (ctx.docId === noteId && ctx.phase === "joined" && ctx.publicDocId)
    sendPresenceMessage(ctx.socket, WS_TYPE.presenceSnapshot, ctx.publicDocId, state.participants);
};

const startPresenceHeartbeat = (ctx: WsContext) => {
  stopPresenceHeartbeat(ctx);
  if (ctx.phase !== "joined" || !ctx.docId || !ctx.user) return;

  ctx.presenceHeartbeatInterval = setInterval(() => {
    const noteId = ctx.docId;
    const user = ctx.user;
    if (!noteId || !user || ctx.phase !== "joined" || ctx.presenceTask) return;

    ctx.presenceTask = notebooksService.presence
      .heartbeat({
        noteId,
        peerId: ctx.peerId,
      })
      .then(async (result) => {
        if (result.ok) return;
        await notebooksService.presence.join({
          noteId,
          peerId: ctx.peerId,
          presencePeerId: ctx.presencePeerId,
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
      })
      .finally(() => {
        ctx.presenceTask = null;
      });
  }, PRESENCE_HEARTBEAT_INTERVAL_MS);
};

/** Workspace and collaboration sockets hold independent leases for the same logical tab. */
const joinPresence = async (ctx: WsContext) => {
  stopPresenceHeartbeat(ctx);
  await ctx.presenceTask;
  const noteId = ctx.docId;
  const user = ctx.user;
  if (!noteId || !user || ctx.phase !== "joined") return;
  registerPresenceMember(ctx, noteId);
  ctx.presenceTask = notebooksService.presence
    .join({
      noteId,
      peerId: ctx.peerId,
      presencePeerId: ctx.presencePeerId,
      userId: user.id,
      displayName: user.displayName,
      avatarHash: user.avatarHash,
    })
    .finally(() => {
      ctx.presenceTask = null;
    });
  await ctx.presenceTask;
  if (ctx.phase !== "joined" || ctx.docId !== noteId) return;
  await sendPresenceSnapshot(ctx, noteId);
  await broadcastPresenceChanged(noteId);
  if (ctx.phase === "joined" && ctx.docId === noteId) startPresenceHeartbeat(ctx);
};

const leaveCurrentWorkspace = async (ctx: WsContext) => {
  // Reader sessions have no document revision or collaboration streams.
  if (ctx.docId && ctx.restoreRevision === null) await leaveCurrentNote(ctx);
  stopWorkspaceStream(ctx);
  ctx.workspaceNotebookId = null;
  ctx.workspaceNotebookShortId = null;
};

const resolveSessionUser = async (sessionToken: string | null): Promise<User | null> => {
  if (!sessionToken) return null;
  return (await auth.session.authenticate(sessionToken))?.user ?? null;
};

type ResolvedNote = NonNullable<Awaited<ReturnType<typeof notebooksService.note.get>>>;
type ResolvedNotebook = NonNullable<Awaited<ReturnType<typeof notebooksService.notebook.get>>>;

const evaluateResolvedNoteAccess = async (
  note: ResolvedNote,
  publicDocId: string,
  user: User,
  mode: "read" | "write" | "presence",
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
      noteId: publicDocId,
    };
  }

  const canWrite = isWritablePermission(permission);
  if (mode === "write" && !canWrite) {
    return {
      ok: false,
      code: ERROR_CODE.accessDenied,
      message: messages.writeAccessRequired,
      noteId: publicDocId,
    };
  }

  if (note.lockedAt && mode !== "presence") {
    return {
      ok: false,
      code: ERROR_CODE.noteLocked,
      message: messages.noteLocked,
      noteId: publicDocId,
    };
  }

  return {
    ok: true,
    resolvedDocId: note.id,
    notebookId: note.notebookId,
    canWrite,
  };
};

const evaluateAccess = async (
  publicDocId: string,
  user: User,
  mode: "read" | "write" | "presence",
  deniedCode: NotebooksYjsErrorCode,
  messages: NotebooksWsMessages,
): Promise<AccessEvaluation> => {
  const note = await notebooksService.note.getByShortId({ shortId: publicDocId });
  if (!note) {
    return {
      ok: false,
      code: ERROR_CODE.noteNotFound,
      message: messages.noteNotFound,
      noteId: publicDocId,
    };
  }
  return evaluateResolvedNoteAccess(note, publicDocId, user, mode, deniedCode, messages);
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

const refreshJoinedAccess = async (ctx: WsContext): Promise<AccessEvaluation> => {
  if (!ctx.docId || !ctx.publicDocId) {
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
      noteId: ctx.publicDocId,
    };
  }

  const note = await notebooksService.note.get({ id: ctx.docId });
  if (!note) return { ok: false, code: ERROR_CODE.noteNotFound, message: ctx.messages.noteNotFound, noteId: ctx.publicDocId };
  const access = await evaluateResolvedNoteAccess(
    note,
    ctx.publicDocId,
    user,
    ctx.restoreRevision === null ? "presence" : "read",
    ERROR_CODE.accessRevoked,
    ctx.messages,
  );
  if (!access.ok) return access;
  if (ctx.restoreRevision === null && access.notebookId !== ctx.workspaceNotebookId)
    return { ok: false, code: ERROR_CODE.accessRevoked, message: ctx.messages.accessRevoked };
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

/** Losing a reader's note must not interrupt workspace updates or editor recovery. */
const leaveReaderPresence = async (ctx: WsContext) => {
  const publicDocId = ctx.publicDocId;
  await leaveCurrentNote(ctx);
  if (publicDocId) sendPresenceMessage(ctx.socket, WS_TYPE.presenceChanged, publicDocId, []);
};

/** Re-evaluate the joined note. Readers leave only that note; collaboration failures remain terminal. */
const revalidateReaderAccess = async (ctx: WsContext): Promise<boolean> => {
  if (ctx.restoreRevision !== null) return room.revalidate(ctx);
  if (ctx.phase !== "joined") return false;
  const noteId = ctx.docId;
  const revision = ctx.restoreRevision;
  const stillCurrent = () => ctx.phase === "joined" && ctx.docId === noteId && ctx.restoreRevision === revision;
  try {
    const access = await refreshJoinedAccess(ctx);
    if (!stillCurrent()) return false;
    if (access.ok) return true;
    if (ctx.restoreRevision === null) {
      await leaveReaderPresence(ctx);
      return false;
    }
    await fatal(
      ctx,
      access.code ?? ERROR_CODE.internalError,
      access.message ?? ctx.messages.accessRefreshFailed,
      access.noteId ?? ctx.publicDocId ?? undefined,
    );
    return false;
  } catch (error) {
    if (!stillCurrent()) return false;
    log.error("Access refresh failed", {
      noteId: ctx.docId,
      error: error instanceof Error ? error.message : String(error),
    });
    if (ctx.restoreRevision === null) await leaveReaderPresence(ctx);
    else await fatal(ctx, ERROR_CODE.internalError, ctx.messages.accessRefreshFailed, ctx.publicDocId ?? undefined);
    return false;
  }
};

/** Re-evaluate the joined workspace's access. Returns false once it has been left. */
const revalidateWorkspaceAccess = async (ctx: WsContext): Promise<boolean> => {
  if (!ctx.workspaceNotebookId || !ctx.workspaceNotebookShortId) return false;
  try {
    const access = await refreshWorkspaceAccess(ctx);
    if (access.ok) {
      if (ctx.docId && ctx.restoreRevision === null) await revalidateReaderAccess(ctx);
      return true;
    }
    send(ctx.socket, WORKSPACE_WS_TYPE.revoked, {
      notebookId: ctx.workspaceNotebookShortId,
      code: access.code ?? ERROR_CODE.accessRevoked,
      message: access.message ?? ctx.messages.workspaceAccessRevoked,
    });
    await leaveCurrentWorkspace(ctx);
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
    await leaveCurrentWorkspace(ctx);
    return false;
  }
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
        const publicEvent = toPublicWorkspaceEvent(event.data, { notebookShortId, userId: ctx.user?.id ?? null });
        if (!publicEvent) continue;
        send(ctx.socket, WORKSPACE_WS_TYPE.event, { notebookId: notebookShortId, cursor: event.cursor, event: publicEvent });
        // The client was told; now re-check on the server, which is the side
        // that decides. Previously this event was forwarded and nothing else.
        if (isPermissionInvalidation(event.data) && !(await revalidateWorkspaceAccess(ctx))) break;
        if (
          ctx.restoreRevision === null &&
          ctx.docId &&
          ((event.data.type === "note.deleted" && event.data.noteId === ctx.docId) ||
            (event.data.type === "note.updated" && event.data.note.id === ctx.docId))
        )
          await revalidateReaderAccess(ctx);
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

  const notebook = await notebooksService.notebook.getByShortId({ shortId: payload.notebookId });
  const baseline = notebook ? await notebooksService.workspaceEvents.latestCursor({ notebookId: notebook.id }) : null;
  const access = notebook
    ? await evaluateResolvedNotebookAccess(notebook, payload.notebookId, user, ERROR_CODE.accessDenied, ctx.messages)
    : { ok: false, notebookId: undefined };
  if (!access.ok || !access.notebookId) {
    send(ctx.socket, WORKSPACE_WS_TYPE.error, {
      notebookId: payload.notebookId,
      code: access.code ?? ERROR_CODE.accessDenied,
      message: access.message ?? ctx.messages.accessDenied,
    });
    return;
  }

  await leaveCurrentWorkspace(ctx);
  ctx.user = user;
  ctx.workspaceNotebookId = access.notebookId;
  ctx.workspaceNotebookShortId = payload.notebookId;
  if (ctx.accessInvalidated) {
    ctx.accessInvalidated = false;
    if (!(await revalidateWorkspaceAccess(ctx))) return;
  }
  startWorkspaceStream(ctx, access.notebookId, payload.notebookId, payload.fromCursor ?? baseline);
};

/** One opened note per workspace socket; replacing it never starts Yjs replay. */
const handleWorkspacePresenceWatch = async (ctx: WsContext, payload: z.infer<typeof WorkspacePresenceWatchMessageSchema.shape.payload>) => {
  if (!ctx.workspaceNotebookId || ctx.restoreRevision !== null) {
    send(ctx.socket, WORKSPACE_WS_TYPE.error, { code: ERROR_CODE.invalidMessage, message: ctx.messages.invalidMessage });
    return;
  }
  const workspaceNotebookId = ctx.workspaceNotebookId;
  await leaveCurrentNote(ctx);
  if (!payload.noteId) return;
  const user = await resolveSessionUser(ctx.sessionToken);
  const access = user ? await evaluateAccess(payload.noteId, user, "presence", ERROR_CODE.accessDenied, ctx.messages) : null;
  if (ctx.phase === "closing" || ctx.workspaceNotebookId !== workspaceNotebookId) return;
  if (!user || !access?.ok || access.notebookId !== workspaceNotebookId || !access.resolvedDocId) {
    send(ctx.socket, WORKSPACE_WS_TYPE.error, {
      noteId: payload.noteId,
      code: !user ? ERROR_CODE.loginRequired : ERROR_CODE.accessDenied,
      message: !user ? ctx.messages.loginRequired : ctx.messages.accessDenied,
    });
    return;
  }
  ctx.phase = "joined";
  ctx.user = user;
  ctx.docId = access.resolvedDocId;
  ctx.publicDocId = payload.noteId;
  ctx.accessScope = access.notebookId;
  ctx.presencePeerId = payload.presencePeerId;
  if (ctx.accessInvalidated && !(await revalidateReaderAccess(ctx))) return;
  await joinPresence(ctx);
};

const leavePresence = async (ctx: WsContext) => {
  stopPresenceHeartbeat(ctx);
  await ctx.presenceTask;
  const noteId = ctx.docId;
  if (!noteId) return;
  unregisterPresenceMember(ctx, noteId);
  try {
    await notebooksService.presence.leave({ noteId, peerId: ctx.peerId, reason: ctx.phase === "closing" ? "socket-close" : "note-leave" });
    await broadcastPresenceChanged(noteId);
  } catch (error) {
    log.warn("Failed to leave presence", { noteId, peerId: ctx.peerId, error: String(error) });
  }
};
const room = createSharedTextRoom<User, Messages, WsContext>({
  protocol: {
    ...notebooksYjs,
    documentId: z.string().regex(SHORT_ID_REGEX),
    decode: (packet) => {
      if (!packet || typeof packet !== "object" || !("payload" in packet) || !packet.payload || typeof packet.payload !== "object")
        return packet;
      const payload = packet.payload;
      return { ...packet, payload: { ...payload, docId: "noteId" in payload ? payload.noteId : undefined } };
    },
    encode: (type, payload) => {
      if (payload && typeof payload === "object" && "code" in payload && payload.code === "DOCUMENT_NOT_FOUND")
        payload = { ...payload, code: ERROR_CODE.noteNotFound };
      if (!payload || typeof payload !== "object" || !("docId" in payload)) return { type, payload };
      const { docId, ...rest } = payload;
      return { type, payload: { ...rest, noteId: docId } };
    },
  },
  log: notebooksTextLog,
  awarenessTopic: createYjsAwarenessTopic,
  snapshots: { queue: ({ docId, targetCursor, reason }) => yjsSnapshotWorker.queueSnapshotSave({ noteId: docId, targetCursor, reason }) },
  logger: log,
  maxLength: 2_097_152,
  adapter: {
    authenticate: resolveSessionUser,
    authorize: async (id, user, messages) => {
      const note = await notebooksService.note.getByShortId({ shortId: id });
      if (!note) return { ok: false, code: ERROR_CODE.noteNotFound, message: messages.noteNotFound };
      const invalidationCursor = await notebooksService.workspaceEvents.latestCursor({ notebookId: note.notebookId });
      const access = await evaluateResolvedNoteAccess(note, id, user, "read", ERROR_CODE.accessDenied, messages);
      return { ...access, docId: access.noteId, scope: access.notebookId, invalidationCursor };
    },
    actor: (user) => ({ kind: "user", id: user.id }),
    awarenessUser: (user) => ({ userId: user.id, name: user.displayName, color: personColor(user.displayName) }),
    load: async (docId) => {
      const snapshot = await notebooksService.note.getAnchoredYjsState({ noteId: docId });
      return snapshot
        ? {
            state: snapshot.yjsState,
            text: snapshot.contentMd,
            cursor: snapshot.streamCursor,
            restoreRevision: snapshot.restoreRevision,
            historyIncomplete: snapshot.historyIncomplete,
          }
        : null;
    },
    revalidate: async (ctx) => {
      const access = await refreshJoinedAccess(ctx);
      if (!access.ok) return { ...access, docId: access.noteId };
      const snapshot = await notebooksService.note.getYjsStateWithCursor({ noteId: ctx.docId! });
      if (snapshot && snapshot.restoreRevision !== ctx.restoreRevision)
        return { ok: false, code: ERROR_CODE.resyncRequired, message: ctx.messages.reopenRequired };
      return { ...access, scope: access.notebookId };
    },
    invalidations: async function* (ctx, signal) {
      if (!ctx.accessScope) return;
      for await (const event of notebooksService.workspaceEvents.live({
        notebookId: ctx.accessScope,
        after: ctx.invalidationCursor,
        signal,
      })) {
        const data = event.data;
        if (
          isPermissionInvalidation(data) ||
          (data.type === "note.updated" && data.note.id === ctx.docId) ||
          (data.type === "note.deleted" && data.noteId === ctx.docId)
        )
          yield event;
      }
    },
    recover: (docId, cause, signal) => notebooksService.note.adoptSnapshotAtHead({ noteId: docId, cause, signal }),
    join: joinPresence,
    leave: leavePresence,
  },
});
const { send, warn, fatal } = room;
const leaveCurrentNote = room.leave;
export const drainNotebookConnections = room.drain;
const app = new Hono<AuthContext>().get(
  "/",
  auth.requireRole("*"),
  upgradeWebSocket(async (c) => {
    const sessionToken = await auth.session.resolveToken(c);
    const locale = getLocale(c);
    const expected = c.req.queries("expectedUserId");
    const actor = c.get("actor");
    const accountChanged = expected && (expected.length !== 1 || actor?.kind !== "user" || actor.user.id !== expected[0]);
    let connection: ReturnType<typeof room.connect> | undefined;
    let stopIdentity = () => {};
    return guardAppAccessSocket(
      c,
      "notebooks",
      {
        onOpen(_, ws) {
          const ctx = createContext(ws.raw as ServerWebSocket<unknown>, sessionToken, locale);
          connection = room.connect(ctx, {
            leave: () => leaveCurrentWorkspace(ctx),
            handle: async (packet) => {
              const message = ClientMessageSchema.safeParse(packet);
              if (!message.success) {
                warn(ctx.socket, ERROR_CODE.invalidMessage, ctx.messages.invalidMessage);
                return;
              }
              if (ctx.phase === "closing") return;
              if (message.data.type === WORKSPACE_WS_TYPE.subscribe) await handleWorkspaceSubscribe(ctx, message.data.payload);
              else await handleWorkspacePresenceWatch(ctx, message.data.payload);
            },
          });
          stopIdentity = subscribeIdentityAccessChanged(() => {
            if (ctx.workspaceNotebookId) void revalidateWorkspaceAccess(ctx);
            if (ctx.docId) void revalidateReaderAccess(ctx);
            else void room.revalidate(ctx);
          });
          if (accountChanged) void fatal(ctx, ERROR_CODE.accessDenied, ctx.messages.accessDenied);
        },
        onMessage: (event) => connection?.receive(event.data),
        onClose: () => {
          stopIdentity();
          return connection?.close();
        },
        onError: () => {
          stopIdentity();
          return connection?.close();
        },
      },
      { eventOnly: true },
    );
  }),
);
export default app;
