import { createSharedTextActionHistory, type SharedTextInverseRequest } from "@k2b/cloud/browser/shared-text";
import { type NotebookPresenceParticipant, NotebookPresenceParticipantSchema } from "@k2b/cloud/contracts";
import { encoding } from "@k2b/stdlib";
import * as awarenessProtocol from "y-protocols/awareness";
import * as Y from "yjs";
import { notebooksWorkspace, type PublicNotebookWorkspaceEvent } from "../../../lib/workspace-events";
import { notebooksYjs } from "../../../lib/yjs";
import { reconnectDelayMs } from "../reconnect";

type YjsErrorCode = (typeof notebooksYjs.errorCode)[keyof typeof notebooksYjs.errorCode];

type ProviderMessage = {
  type?: unknown;
  payload?: unknown;
};

export type YjsProviderError = {
  code: YjsErrorCode;
  message: string;
  noteId?: string;
};

export type YjsProviderOptions = {
  doc: Y.Doc;
  undoManager?: Y.UndoManager;
  awareness: awarenessProtocol.Awareness;
  noteId: string;
  appUrl: string;
  initialCursor?: string | null;
  /** Revision belonging to the initial Y.Doc, including its historical deletes. */
  initialRestoreRevision?: string;
  onConnectionChange?: (connected: boolean) => void;
  onPresenceChange?: (participants: NotebookPresenceParticipant[]) => void;
  workspace?: {
    notebookId: string;
    initialCursor?: string | null;
    onEvent: (event: PublicNotebookWorkspaceEvent, cursor: string | null) => void | Promise<void>;
    onCursorChange?: (cursor: string) => void;
    onError?: (error: YjsProviderError) => void;
  };
  onError?: (error: YjsProviderError) => void;
  onFatal?: (error: YjsProviderError) => void;
  onHistoryIncomplete?: () => void;
  /** Replay reached the live tail: the note is fully connected again. */
  onReady?: () => void;
  /** Called when hasUnsentChanges() may have changed. */
  onUnsentChange?: () => void;
  /** Undo kept an inserted column because another participant depends on it. */
  onRetainedColumn?: () => void;
};

const WS_TYPE = notebooksYjs.wsType;
const WORKSPACE_WS_TYPE = notebooksWorkspace.wsType;
const TERMINAL_ERROR_CODES = new Set<string>(notebooksYjs.terminalErrorCodes);
const WORKSPACE_TERMINAL_ERROR_CODES = new Set<string>([
  "LOGIN_REQUIRED",
  "SESSION_EXPIRED",
  "ACCESS_DENIED",
  "ACCESS_REVOKED",
  "NOTE_NOT_FOUND",
]);
const KNOWN_ERROR_CODES = new Set<string>(Object.values(notebooksYjs.errorCode));
/**
 * Consecutive STORAGE_EXHAUSTED closes before the provider gives up. With the
 * reconnect backoff this spans about a minute: long enough to ride out a
 * broker that frees space, short enough not to hammer a full one.
 */
export const MAX_STORAGE_RETRIES = 5;

const SHORT_ID_REGEX = /^[0-9A-Za-z]{6}$/;

const resolveHttpBaseUrl = (raw: string): URL => {
  const value = raw.trim();
  const browserOrigin = typeof window !== "undefined" && window.location?.origin ? window.location.origin : "http://localhost:3000";

  if (!value) return new URL(browserOrigin);
  if (/^https?:\/\//i.test(value)) return new URL(value);
  if (value.startsWith("/")) return new URL(value, browserOrigin);
  return new URL(`${new URL(browserOrigin).protocol}//${value}`);
};

/**
 * Client-side Yjs provider:
 * - connect and send `notes.yjs.replay.request`
 * - wait for replay to become ready before sending local writes
 * - apply pushed sync/awareness updates
 * - stop reconnecting on terminal `notes.yjs.error` codes
 */
export function createYjsProvider(opts: YjsProviderOptions) {
  const { doc, awareness, appUrl } = opts;
  if (!SHORT_ID_REGEX.test(opts.noteId)) throw new Error("noteId must be a 6-character short id");
  if (opts.workspace && !SHORT_ID_REGEX.test(opts.workspace.notebookId)) {
    throw new Error("workspace.notebookId must be a 6-character short id");
  }
  if (opts.initialCursor && opts.initialRestoreRevision === undefined) throw new TypeError("initialCursor requires initialRestoreRevision");
  if (opts.initialRestoreRevision !== undefined && !/^(0|[1-9]\d{0,18})$/.test(opts.initialRestoreRevision))
    throw new TypeError("Invalid initialRestoreRevision");
  if (doc.store.clients.size > 0 && opts.initialRestoreRevision === undefined)
    throw new TypeError("An initial document requires initialRestoreRevision");
  const activeNoteId = opts.noteId;
  let ws: WebSocket | null = null;
  let isDisposed = false;
  let isTerminated = false;
  let needsReopen = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let failedConnects = 0;
  let storageFailures = 0;
  let lastCursor = opts.initialCursor ?? null;
  let lastWorkspaceCursor = opts.workspace?.initialCursor ?? null;
  let workspaceEventQueue = Promise.resolve();
  let workspaceGeneration = 0;
  const activeWorkspaceId = opts.workspace?.notebookId ?? null;
  let replayReady = false;
  let awarenessPeerId: string | null = null;
  let restoreRevision: string | null = opts.initialRestoreRevision ?? null;
  let localStateSent = false;
  let needsFullResync = false;
  const unconfirmed = new Map<string, string | null>();
  let unconfirmedBytes = 0;
  const forgetPending = (payload: string) => {
    if (unconfirmed.delete(payload)) unconfirmedBytes -= payload.length;
  };
  let unsentBase: string | null | undefined;
  let recoveryText: string | undefined;
  // Current resend groups reference original pending bytes. Rebuilding a
  // generation releases old groups; only an echo releases the covered input.
  const covering = new Map<string, string[]>();
  let notifyingPending = false;
  const pendingChanged = () => {
    if (notifyingPending || isDisposed) return;
    notifyingPending = true;
    queueMicrotask(() => {
      notifyingPending = false;
      if (!isDisposed) opts.onUnsentChange?.();
    });
  };
  const actionHistory = opts.undoManager
    ? createSharedTextActionHistory(doc, opts.undoManager, pendingChanged, opts.onRetainedColumn)
    : null;

  const errorMessageByCode: Record<YjsErrorCode, string> = {
    LOGIN_REQUIRED: "Login required",
    SESSION_EXPIRED: "Session expired",
    ACCESS_DENIED: "Access denied",
    ACCESS_REVOKED: "Access was revoked",
    NOTE_NOT_FOUND: "Note not found",
    NOTE_LOCKED: "Note is locked",
    INVALID_JSON: "Invalid JSON payload",
    INVALID_MESSAGE: "Invalid websocket message",
    INVALID_PAYLOAD: "Invalid websocket payload",
    BACKPRESSURE: "Websocket backpressure",
    INTERNAL_ERROR: "Internal websocket error",
    RESYNC_REQUIRED: "Reload collaborative state",
    STREAM_FAILED: "Live connection interrupted",
    STORAGE_EXHAUSTED: "Server storage for live editing is exhausted",
  };

  const sendJson = (type: string, payload?: unknown): boolean => {
    if (isDisposed || isTerminated) return false;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, payload }));
      return true;
    }
    return false;
  };

  const sendSyncPublish = (
    data: Uint8Array,
    baseCursor = unsentBase === undefined ? (unconfirmed.size ? unconfirmed.values().next().value! : lastCursor) : unsentBase,
  ): boolean => {
    if (restoreRevision === null) return false;
    const payload = encoding.toBase64(data);
    if (payload.length > notebooksYjs.maxSyncPayloadLength) {
      // The exact unsent state remains in recoveryInput().state; sending an
      // oversized update would only loop on the server's existing limit.
      unsentBase = baseCursor;
      needsFullResync = true;
      needsReopen = true;
      pendingChanged();
      // Stop collecting immediately; notify/reconfigure the host only after
      // the native edit which exceeded the budget has left EditorView.update.
      replayReady = false;
      queueMicrotask(() => {
        if (!isDisposed)
          terminate({ code: notebooksYjs.errorCode.backpressure, message: errorMessageByCode.BACKPRESSURE!, noteId: activeNoteId });
      });
      return false;
    }
    // Budget for an original transport envelope plus its covering reconnect
    // envelope. Preserve the triggering update too, then stop through existing
    // recovery. Echo delays cannot grow an unbounded original-payload queue.
    if (!unconfirmed.has(payload) && unconfirmedBytes + payload.length > 2 * notebooksYjs.maxSyncPayloadLength) {
      unconfirmed.set(payload, baseCursor);
      unconfirmedBytes += payload.length;
      unsentBase = baseCursor;
      needsFullResync = true;
      needsReopen = true;
      pendingChanged();
      // Stop collecting immediately; notify/reconfigure the host only after
      // the native edit which exceeded the budget has left EditorView.update.
      replayReady = false;
      queueMicrotask(() => {
        if (!isDisposed)
          terminate({ code: notebooksYjs.errorCode.backpressure, message: errorMessageByCode.BACKPRESSURE!, noteId: activeNoteId });
      });
      return false;
    }
    if (!sendJson(WS_TYPE.syncPublish, { noteId: activeNoteId, payload, restoreRevision, baseCursor })) return false;
    if (!unconfirmed.has(payload)) unconfirmedBytes += payload.length;
    unconfirmed.set(payload, baseCursor);
    pendingChanged();
    return true;
  };

  const sendAwarenessPublish = (data: Uint8Array): boolean =>
    sendJson(WS_TYPE.awarenessPublish, { noteId: activeNoteId, payload: encoding.toBase64(data) });

  const sendReplayRequest = (fromCursor: string | null): boolean =>
    sendJson(WS_TYPE.replayRequest, {
      noteId: activeNoteId,
      fromCursor,
      restoreRevision,
    });

  const sendWorkspaceSubscribe = (): boolean => {
    if (!opts.workspace) return false;
    return sendJson(WORKSPACE_WS_TYPE.subscribe, {
      notebookId: opts.workspace.notebookId,
      fromCursor: lastWorkspaceCursor,
    });
  };

  const sendLocalStateIfNeeded = () => {
    if (!replayReady || localStateSent) return;
    if (needsFullResync) {
      // The full state keeps its original base; replay must never relabel stale
      // unconfirmed input with the server's newly delivered cursor.
      const localState = Y.encodeStateAsUpdate(doc);
      if (localState.length > 0 && !sendSyncPublish(localState)) return;
      covering.clear();
      covering.set(encoding.toBase64(localState), [...unconfirmed.keys()]);
    } else {
      // Preserve the existing payload-sized resend batches and original bytes.
      const groups: { payloads: string[]; size: number; baseCursor: string | null }[] = [];
      for (const [payload, baseCursor] of unconfirmed) {
        if (!groups.length || groups.at(-1)!.size + payload.length > notebooksYjs.maxSyncPayloadLength)
          groups.push({ payloads: [], size: 0, baseCursor });
        const group = groups.at(-1)!;
        group.payloads.push(payload);
        group.size += payload.length;
      }
      covering.clear();
      for (const group of groups) {
        const payload =
          group.payloads.length === 1 ? group.payloads[0]! : encoding.toBase64(Y.mergeUpdates(group.payloads.map(encoding.fromBase64)));
        covering.set(payload, group.payloads);
        if (
          restoreRevision === null ||
          !sendJson(WS_TYPE.syncPublish, { noteId: activeNoteId, payload, restoreRevision, baseCursor: group.baseCursor })
        )
          return;
      }
    }
    localStateSent = true;
    if (needsFullResync) {
      needsFullResync = false;
      pendingChanged();
    }
  };

  const terminate = (error: YjsProviderError) => {
    if (isTerminated) return;
    isTerminated = true;
    actionHistory?.cancelPending(new Error(error.message));
    replayReady = false;
    localStateSent = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws && ws.readyState <= WebSocket.OPEN) {
      try {
        ws.close();
      } catch {
        // Ignore close failures. Terminal flow is already enforced via isTerminated.
      }
    }
    opts.onFatal?.(error);
  };

  const onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (isDisposed) return;
    if (origin === "remote" || actionHistory?.isRemoteOrigin(origin)) return;
    recoveryText = doc.getText("codemirror").toString();
    if (isTerminated || !replayReady) {
      if (unsentBase === undefined) unsentBase = unconfirmed.size ? unconfirmed.values().next().value : lastCursor;
      needsFullResync = true;
      pendingChanged();
      return;
    }
    if (!sendSyncPublish(update)) {
      if (unsentBase === undefined) unsentBase = unconfirmed.size ? unconfirmed.values().next().value : lastCursor;
      needsFullResync = true;
      pendingChanged();
    }
  };

  const onAwarenessUpdate = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (isDisposed || isTerminated) return;
    if (origin === "remote") return;
    if (!replayReady) return;
    if (!added.includes(doc.clientID) && !updated.includes(doc.clientID) && !removed.includes(doc.clientID)) return;
    sendAwarenessPublish(awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID]));
  };

  const normalizeError = (payload: unknown): YjsProviderError => {
    if (!payload || typeof payload !== "object") {
      return {
        code: notebooksYjs.errorCode.internalError,
        message: "Unknown websocket error",
      };
    }
    const value = payload as { code?: unknown; message?: unknown; noteId?: unknown };
    return {
      code: typeof value.code === "string" ? (value.code as YjsErrorCode) : notebooksYjs.errorCode.internalError,
      message: typeof value.message === "string" ? value.message : "Unknown websocket error",
      noteId: typeof value.noteId === "string" ? value.noteId : undefined,
    };
  };

  const normalizeTerminalCloseReason = (reason: string): YjsProviderError | null => {
    const value = reason.trim();
    if (!KNOWN_ERROR_CODES.has(value) || !TERMINAL_ERROR_CODES.has(value)) {
      return null;
    }
    const code = value as YjsErrorCode;
    return {
      code,
      message: errorMessageByCode[code] ?? "Connection closed",
    };
  };

  const normalizeTerminalCloseCode = (code: number): YjsProviderError | null => {
    if (code === 1008) {
      return {
        code: notebooksYjs.errorCode.accessRevoked,
        message: "Access changed or note became unavailable",
      };
    }

    if (code === 1013) {
      return {
        code: notebooksYjs.errorCode.backpressure,
        message: "Websocket backpressure",
      };
    }

    return null;
  };

  const parseJsonMessage = (raw: string): ProviderMessage | null => {
    try {
      const message = JSON.parse(raw) as unknown;
      return message && typeof message === "object" ? (message as ProviderMessage) : null;
    } catch {
      return null;
    }
  };

  const handleProviderErrorMessage = (msg: ProviderMessage): boolean => {
    if (msg.type !== WS_TYPE.error) return false;
    const error = normalizeError(msg.payload);
    opts.onError?.(error);
    if (
      error.code === notebooksYjs.errorCode.resyncRequired &&
      msg.payload &&
      typeof msg.payload === "object" &&
      "reopen" in msg.payload &&
      msg.payload.reopen === true
    ) {
      needsReopen = true;
      terminate(error);
      return true;
    }
    if (error.code === notebooksYjs.errorCode.storageExhausted) {
      storageFailures += 1;
      if (storageFailures >= MAX_STORAGE_RETRIES) terminate(error);
      return true;
    }
    if (error.code === notebooksYjs.errorCode.resyncRequired) {
      lastCursor = null;
      replayReady = false;
    }
    if (TERMINAL_ERROR_CODES.has(error.code)) {
      terminate(error);
    }
    return true;
  };

  const handleWorkspaceErrorMessage = (msg: ProviderMessage): boolean => {
    if (msg.type === WORKSPACE_WS_TYPE.error || msg.type === WORKSPACE_WS_TYPE.revoked) {
      const error =
        msg.type === WORKSPACE_WS_TYPE.revoked
          ? {
              code: notebooksYjs.errorCode.accessRevoked,
              message: "Workspace access was revoked",
            }
          : normalizeError(msg.payload);
      if (error.code === notebooksYjs.errorCode.resyncRequired) {
        lastWorkspaceCursor = null;
      }
      opts.workspace?.onError?.(error);
      if (WORKSPACE_TERMINAL_ERROR_CODES.has(error.code)) {
        terminate(error);
      } else {
        ws?.close();
      }
      return true;
    }
    return false;
  };

  const handleWorkspaceReadyMessage = (msg: ProviderMessage): boolean => {
    if (msg.type !== WORKSPACE_WS_TYPE.ready) return false;
    return true;
  };

  const handleWorkspaceEventMessage = (msg: ProviderMessage): boolean => {
    if (msg.type !== WORKSPACE_WS_TYPE.event) return false;
    const payload = (msg.payload ?? {}) as {
      notebookId?: unknown;
      cursor?: unknown;
      event?: unknown;
    };
    if (!opts.workspace || payload.notebookId !== activeWorkspaceId) return true;
    const event = payload.event as PublicNotebookWorkspaceEvent | undefined;
    if (!event || event.v !== 1 || event.notebookId !== activeWorkspaceId) return true;
    if (event.type === "note.updated" && event.note.id === activeNoteId && event.note.historyIncomplete === true) {
      opts.onHistoryIncomplete?.();
    }
    const cursor = typeof payload.cursor === "string" ? payload.cursor : null;
    const generation = workspaceGeneration;
    workspaceEventQueue = workspaceEventQueue
      .then(async () => {
        if (generation !== workspaceGeneration || isDisposed || isTerminated) return;
        if (!opts.workspace?.onEvent) throw new Error("Workspace event handler missing");
        await opts.workspace.onEvent(event, cursor);
        if (generation === workspaceGeneration && cursor) {
          lastWorkspaceCursor = cursor;
          opts.workspace.onCursorChange?.(cursor);
        }
      })
      .catch(() => {
        if (generation !== workspaceGeneration || isDisposed || isTerminated) return;
        ws?.close();
      });
    return true;
  };

  const handleReplayReadyMessage = (msg: ProviderMessage): boolean => {
    if (msg.type !== WS_TYPE.replayReady) return false;
    const payload = (msg.payload ?? {}) as { noteId?: unknown; cursor?: unknown; restoreRevision?: unknown; peerId?: unknown };
    // A socket can still deliver queued messages after a terminal error; the editor must stay stopped.
    if (payload.noteId !== activeNoteId || isTerminated) return true;
    if (
      typeof payload.restoreRevision !== "string" ||
      !/^(0|[1-9]\d{0,18})$/.test(payload.restoreRevision) ||
      (restoreRevision !== null && restoreRevision !== payload.restoreRevision)
    ) {
      needsReopen = true;
      terminate({
        code: notebooksYjs.errorCode.resyncRequired,
        message: "The note changed. Copy unsent text before reopening it",
        noteId: activeNoteId,
      });
      return true;
    }
    restoreRevision = payload.restoreRevision;
    awarenessPeerId = typeof payload.peerId === "string" ? payload.peerId : null;
    replayReady = true;
    if (typeof payload.cursor === "string") lastCursor = payload.cursor;
    // Reading works again, but with edits still unsent only their echo proves that storage accepts writes,
    // so backoff and storage budget keep counting until then.
    if (!needsFullResync && unconfirmed.size === 0) {
      failedConnects = 0;
      storageFailures = 0;
    }
    opts.onReady?.();
    sendLocalStateIfNeeded();
    sendAwarenessPublish(awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID]));
    return true;
  };

  const handlePresenceMessage = (msg: ProviderMessage): boolean => {
    if (msg.type === WS_TYPE.presenceSnapshot || msg.type === WS_TYPE.presenceChanged) {
      const payload = (msg.payload ?? {}) as {
        noteId?: unknown;
        participants?: unknown;
      };

      if (payload.noteId !== activeNoteId) return true;
      const participants = NotebookPresenceParticipantSchema.array().safeParse(payload.participants);
      if (!participants.success) return true;
      opts.onPresenceChange?.(participants.data);
      return true;
    }
    return false;
  };

  const handlePushMessage = (msg: ProviderMessage): boolean => {
    const isPushType = msg.type === WS_TYPE.syncPush || msg.type === WS_TYPE.awarenessPush;
    if (!isPushType) return false;

    const payload = msg.payload as {
      noteId?: unknown;
      historyIncomplete?: unknown;
      snapshot?: unknown;
      restoreRevision?: unknown;
      updates?: Array<{
        cursor?: unknown;
        payload?: unknown;
        originPeerId?: unknown;
        actionId?: unknown;
        retainedColumn?: unknown;
        restoreRevision?: unknown;
      }>;
    };

    if (isTerminated || payload.noteId !== activeNoteId || !Array.isArray(payload.updates)) return true;
    if (payload.snapshot === true && typeof payload.restoreRevision === "string") {
      if (restoreRevision !== null && restoreRevision !== payload.restoreRevision) {
        needsReopen = true;
        terminate({
          code: notebooksYjs.errorCode.resyncRequired,
          message: "The note was restored. Copy unsent text before reopening it",
          noteId: activeNoteId,
        });
        return true;
      }
      restoreRevision = payload.restoreRevision;
    }
    if (msg.type === WS_TYPE.syncPush && payload.historyIncomplete === true) opts.onHistoryIncomplete?.();
    for (const update of payload.updates) {
      if (typeof update.payload !== "string") continue;
      try {
        if (msg.type === WS_TYPE.syncPush) {
          if (typeof update.restoreRevision === "string" && update.restoreRevision !== restoreRevision) {
            if (
              restoreRevision !== null &&
              /^\d+$/.test(restoreRevision) &&
              /^\d+$/.test(update.restoreRevision) &&
              BigInt(update.restoreRevision) < BigInt(restoreRevision)
            ) {
              // A server action from before a restore must never touch its replacement.
              if (typeof update.cursor === "string") lastCursor = update.cursor;
              continue;
            }
            needsReopen = true;
            terminate({
              code: notebooksYjs.errorCode.resyncRequired,
              message: "The note was restored. Copy unsent text before reopening it",
              noteId: activeNoteId,
            });
            return true;
          }
          if (payload.snapshot === true && actionHistory?.hasPending())
            throw new Error("The table action could not be confirmed before reloading its history");
          const bytes = encoding.fromBase64(update.payload);
          if (actionHistory)
            actionHistory.apply(
              bytes,
              typeof update.actionId === "string" ? update.actionId : undefined,
              typeof update.cursor === "string" ? update.cursor : undefined,
              update.retainedColumn === true,
            );
          else {
            Y.decodeUpdate(bytes);
            Y.applyUpdate(doc, bytes, "remote");
          }
          const covered = covering.get(update.payload);
          const echoed = unconfirmed.has(update.payload) || covered !== undefined;
          if (covered) {
            for (const payload of covered) forgetPending(payload);
            covering.delete(update.payload);
          } else forgetPending(update.payload);
          if (echoed) {
            if (!unconfirmed.size) covering.clear();
            failedConnects = 0;
            storageFailures = 0;
            if (!unconfirmed.size && !needsFullResync) {
              unsentBase = undefined;
              recoveryText = undefined;
            }
            pendingChanged();
          }
        } else {
          if (awarenessPeerId !== null && update.originPeerId === awarenessPeerId) continue;
          awarenessProtocol.applyAwarenessUpdate(awareness, encoding.fromBase64(update.payload), "remote");
        }
      } catch {
        if (msg.type === WS_TYPE.syncPush) {
          const error = {
            code: notebooksYjs.errorCode.invalidPayload,
            message: "Shared editing stopped because an update could not be applied",
            noteId: activeNoteId,
          };
          opts.onError?.(error);
          terminate(error);
          return true;
        }
        // Awareness does not advance document history.
      }

      if (msg.type === WS_TYPE.syncPush && typeof update.cursor === "string") {
        lastCursor = update.cursor;
      }
    }

    return true;
  };

  const handleJsonMessage = (raw: string) => {
    const msg = parseJsonMessage(raw);
    if (!msg) return;

    if (handleProviderErrorMessage(msg)) return;
    if (handleWorkspaceErrorMessage(msg)) return;
    if (handleWorkspaceReadyMessage(msg)) return;
    if (handleWorkspaceEventMessage(msg)) return;
    if (handleReplayReadyMessage(msg)) return;
    if (handlePresenceMessage(msg)) return;
    handlePushMessage(msg);
  };

  const connect = () => {
    if (isDisposed || isTerminated) return;

    workspaceGeneration += 1;
    workspaceEventQueue = Promise.resolve();
    const wsUrl = new URL("/api/notebooks/ws", resolveHttpBaseUrl(appUrl));
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(wsUrl.href);
    ws = socket;

    socket.onopen = () => {
      if (ws !== socket) return;
      opts.onConnectionChange?.(true);
      replayReady = false;
      localStateSent = false;
      sendWorkspaceSubscribe();
      sendReplayRequest(lastCursor);
    };

    socket.onmessage = (event) => {
      if (ws !== socket) return;
      if (typeof event.data === "string") handleJsonMessage(event.data);
    };

    socket.onclose = (event) => {
      if (ws !== socket) return;
      opts.onConnectionChange?.(false);
      replayReady = false;
      localStateSent = false;

      const closeError = normalizeTerminalCloseReason(event.reason ?? "") ?? normalizeTerminalCloseCode(event.code);
      if (closeError) {
        opts.onError?.(closeError);
        terminate(closeError);
        return;
      }

      // `STREAM_FAILED` and plain drops keep `lastCursor`: the next replay
      // resumes after it instead of resending the stored snapshot. Only
      // `RESYNC_REQUIRED` cleared the cursor above.
      if (!isDisposed && !isTerminated) {
        reconnectTimer = setTimeout(connect, reconnectDelayMs(failedConnects));
        failedConnects += 1;
      }
    };

    socket.onerror = () => {
      if (ws !== socket) return;
      socket.close();
    };
  };

  doc.on("update", onDocUpdate);
  awareness.on("update", onAwarenessUpdate);

  return {
    connect,
    /** Retry a dropped connection immediately, without reviving terminal sessions. */
    reconnectNow: (): void => {
      if (isDisposed || isTerminated || (ws && ws.readyState <= WebSocket.OPEN)) return;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      failedConnects = 0;
      connect();
    },
    undo: () => {
      if (actionHistory?.nextStructural("undo") && (isDisposed || isTerminated || !replayReady || needsFullResync || unconfirmed.size))
        return Promise.reject(new Error("The editor must finish synchronizing before changing the table structure"));
      return actionHistory?.undo() ?? Promise.resolve(null);
    },
    redo: () => {
      if (actionHistory?.nextStructural("redo") && (isDisposed || isTerminated || !replayReady || needsFullResync || unconfirmed.size))
        return Promise.reject(new Error("The editor must finish synchronizing before changing the table structure"));
      return actionHistory?.redo() ?? Promise.resolve(null);
    },
    canUndo: () => actionHistory?.canUndo() ?? false,
    canRedo: () => actionHistory?.canRedo() ?? false,
    setInverseHandler: (handler: (request: SharedTextInverseRequest) => Promise<void>) => actionHistory?.setInverseHandler(handler),
    recoveryInput: () => ({
      state: Y.encodeStateAsUpdate(doc),
      text: recoveryText ?? doc.getText("codemirror").toString(),
      pending: [...unconfirmed].map(([payload, baseCursor]) => ({ payload, baseCursor })),
      baseCursor: unsentBase,
    }),
    /** Server actions wait for replay coverage and all local updates to be echoed. */
    canStructure: (): boolean =>
      !isDisposed &&
      !isTerminated &&
      replayReady &&
      restoreRevision !== null &&
      !needsFullResync &&
      unconfirmed.size === 0 &&
      !!actionHistory &&
      !actionHistory.hasPending(),
    restoreRevision: (): string | null => restoreRevision,
    beginAction: (actionId: string) => {
      if (isDisposed || isTerminated || !replayReady || restoreRevision === null || needsFullResync || unconfirmed.size || !actionHistory)
        throw new Error("The editor must finish synchronizing before changing the table structure");
      return actionHistory.begin(actionId);
    },
    /** Local edits the server has not echoed yet. */
    hasUnsentChanges: (): boolean => needsFullResync || unconfirmed.size > 0,
    /** Reconnect after a terminal error, used after the person signs in again. */
    resume: (): void => {
      if (!isTerminated || isDisposed || needsReopen) return;
      isTerminated = false;
      failedConnects = 0;
      connect();
    },
    dispose: () => {
      isDisposed = true;
      actionHistory?.dispose();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      awarenessProtocol.removeAwarenessStates(awareness, [doc.clientID], "disconnect");
      doc.off("update", onDocUpdate);
      awareness.off("update", onAwarenessUpdate);
      if (ws) {
        ws.close();
        ws = null;
      }
    },
  };
}
