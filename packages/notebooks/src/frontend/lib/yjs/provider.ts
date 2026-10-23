import {
  createSharedTextProvider,
  MAX_SHARED_TEXT_STORAGE_RETRIES,
  type SharedTextProviderError,
  type SharedTextProviderMessage,
  type SharedTextProviderRequest,
  type SharedTextProviderUpdate,
} from "@k2b/cloud/browser/shared-text";
import { type NotebookPresenceParticipant, NotebookPresenceParticipantSchema } from "@k2b/cloud/contracts";
import type * as awarenessProtocol from "y-protocols/awareness";
import type * as Y from "yjs";
import { notebooksWorkspace, type PublicNotebookWorkspaceEvent } from "../../../lib/workspace-events";
import { notebooksYjs } from "../../../lib/yjs";
import { reconnectDelayMs } from "../reconnect";

type YjsErrorCode = (typeof notebooksYjs.errorCode)[keyof typeof notebooksYjs.errorCode];

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
export const MAX_STORAGE_RETRIES = MAX_SHARED_TEXT_STORAGE_RETRIES;

const SHORT_ID_REGEX = /^[0-9A-Za-z]{6}$/;

const resolveHttpBaseUrl = (raw: string): URL => {
  const value = raw.trim();
  const browserOrigin = typeof window !== "undefined" && window.location?.origin ? window.location.origin : "http://localhost:3000";

  if (!value) return new URL(browserOrigin);
  if (/^https?:\/\//i.test(value)) return new URL(value);
  if (value.startsWith("/")) return new URL(value, browserOrigin);
  return new URL(`${new URL(browserOrigin).protocol}//${value}`);
};

/** Notebook wire adapter; the shared provider owns connection, replay, pending input and history. */
export function createYjsProvider(opts: YjsProviderOptions) {
  if (!SHORT_ID_REGEX.test(opts.noteId)) throw new Error("noteId must be a 6-character short id");
  if (opts.workspace && !SHORT_ID_REGEX.test(opts.workspace.notebookId))
    throw new Error("workspace.notebookId must be a 6-character short id");
  if (opts.initialCursor && opts.initialRestoreRevision === undefined) throw new TypeError("initialCursor requires initialRestoreRevision");
  if (opts.initialRestoreRevision !== undefined && !/^(0|[1-9]\d{0,18})$/.test(opts.initialRestoreRevision))
    throw new TypeError("Invalid initialRestoreRevision");
  if (opts.doc.store.clients.size > 0 && opts.initialRestoreRevision === undefined)
    throw new TypeError("An initial document requires initialRestoreRevision");

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

  const fromError = (error: SharedTextProviderError): YjsProviderError => ({
    code: error.code as YjsErrorCode,
    message: error.message,
    ...(error.docId === undefined ? {} : { noteId: error.docId }),
  });
  const toError = (error: YjsProviderError): SharedTextProviderError => ({
    code: error.code,
    message: error.message,
    ...(error.noteId === undefined ? {} : { docId: error.noteId }),
  });
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const string = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
  const decode = (packet: unknown): SharedTextProviderMessage<PublicNotebookWorkspaceEvent, NotebookPresenceParticipant> | null => {
    const msg = record(packet);
    const payload = record(msg.payload);
    if (msg.type === WS_TYPE.error)
      return { type: "error", payload: { ...toError(normalizeError(msg.payload)), reopen: payload.reopen === true } };
    if (msg.type === WORKSPACE_WS_TYPE.error || msg.type === WORKSPACE_WS_TYPE.revoked) {
      const error =
        msg.type === WORKSPACE_WS_TYPE.revoked
          ? { code: notebooksYjs.errorCode.accessRevoked, message: "Workspace access was revoked" }
          : normalizeError(msg.payload);
      return { type: "eventError", payload: toError(error), terminal: WORKSPACE_TERMINAL_ERROR_CODES.has(error.code) };
    }
    if (msg.type === WORKSPACE_WS_TYPE.ready) return { type: "eventReady", payload: {} };
    if (msg.type === WORKSPACE_WS_TYPE.event) {
      if (!opts.workspace || payload.notebookId !== opts.workspace.notebookId) return null;
      const event = payload.event as PublicNotebookWorkspaceEvent | undefined;
      if (!event || event.v !== 1 || event.notebookId !== opts.workspace.notebookId) return null;
      return {
        type: "event",
        payload: {
          event,
          cursor: string(payload.cursor) ?? null,
          historyIncomplete: event.type === "note.updated" && event.note.id === opts.noteId && event.note.historyIncomplete === true,
        },
      };
    }
    if (typeof payload.noteId !== "string") return null;
    const docId = payload.noteId;
    if (msg.type === WS_TYPE.replayReady)
      return {
        type: "replayReady",
        payload: {
          docId,
          generation:
            typeof payload.restoreRevision === "string" && /^(0|[1-9]\d{0,18})$/.test(payload.restoreRevision)
              ? payload.restoreRevision
              : null,
          cursor: string(payload.cursor),
          peerId: string(payload.peerId),
        },
      };
    if (msg.type === WS_TYPE.presenceSnapshot || msg.type === WS_TYPE.presenceChanged) {
      const participants = NotebookPresenceParticipantSchema.array().safeParse(payload.participants);
      return participants.success ? { type: "presence", payload: { docId, participants: participants.data } } : null;
    }
    if (msg.type !== WS_TYPE.syncPush && msg.type !== WS_TYPE.awarenessPush) return null;
    if (!Array.isArray(payload.updates)) return null;
    const updates: SharedTextProviderUpdate[] = [];
    for (const entry of payload.updates) {
      const update = record(entry);
      if (typeof update.payload !== "string") continue;
      updates.push({
        payload: update.payload,
        cursor: string(update.cursor),
        originPeerId: string(update.originPeerId),
        actionId: string(update.actionId),
        retainedColumn: update.retainedColumn === true,
        generation: msg.type === WS_TYPE.syncPush ? string(update.restoreRevision) : undefined,
      });
    }
    return {
      type: msg.type === WS_TYPE.syncPush ? "syncPush" : "awarenessPush",
      payload: {
        docId,
        updates,
        snapshot: payload.snapshot === true,
        historyIncomplete: payload.historyIncomplete === true,
        // Notebook only versions the envelope for snapshots; live updates carry their own revision.
        generation: payload.snapshot === true ? string(payload.restoreRevision) : undefined,
      },
    };
  };
  const encode = (request: SharedTextProviderRequest): unknown => {
    switch (request.type) {
      case "subscribe":
        return {
          type: WORKSPACE_WS_TYPE.subscribe,
          payload: { notebookId: opts.workspace!.notebookId, fromCursor: request.payload.fromCursor },
        };
      case "replayRequest":
        return {
          type: WS_TYPE.replayRequest,
          payload: { noteId: request.payload.docId, fromCursor: request.payload.fromCursor, restoreRevision: request.payload.generation },
        };
      case "syncPublish":
        return {
          type: WS_TYPE.syncPublish,
          payload: {
            noteId: request.payload.docId,
            payload: request.payload.payload,
            restoreRevision: request.payload.generation,
            baseCursor: request.payload.baseCursor,
          },
        };
      case "awarenessPublish":
        return { type: WS_TYPE.awarenessPublish, payload: { noteId: request.payload.docId, payload: request.payload.payload } };
    }
  };
  const wsUrl = new URL("/api/notebooks/ws", resolveHttpBaseUrl(opts.appUrl));
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  const provider = createSharedTextProvider({
    doc: opts.doc,
    awareness: opts.awareness,
    undoManager: opts.undoManager,
    docId: opts.noteId,
    initialCursor: opts.initialCursor,
    initialGeneration: opts.initialRestoreRevision,
    maxSyncPayloadLength: notebooksYjs.maxSyncPayloadLength,
    terminalErrorCodes: notebooksYjs.terminalErrorCodes,
    allowUnversionedUpdates: true,
    reconnectDelayMs,
    generationMessages: {
      changed: "The note changed. Copy unsent text before reopening it",
      restored: "The note was restored. Copy unsent text before reopening it",
    },
    isEarlierGeneration: (incoming, current) => /^\d+$/.test(incoming) && /^\d+$/.test(current) && BigInt(incoming) < BigInt(current),
    transport: {
      url: wsUrl.href,
      encode,
      decode,
      closeError: (code, reason) => {
        const error = normalizeTerminalCloseReason(reason) ?? normalizeTerminalCloseCode(code);
        return error && toError(error);
      },
    },
    events: opts.workspace && {
      initialCursor: opts.workspace.initialCursor,
      onEvent: opts.workspace.onEvent,
      onCursorChange: opts.workspace.onCursorChange,
      onError: (error) => opts.workspace?.onError?.(fromError(error)),
    },
    onConnectionChange: opts.onConnectionChange,
    onPresenceChange: opts.onPresenceChange,
    onError: (error) => opts.onError?.(fromError(error)),
    onFatal: (error) => opts.onFatal?.(fromError(error)),
    onHistoryIncomplete: opts.onHistoryIncomplete,
    onReady: opts.onReady,
    onUnsentChange: opts.onUnsentChange,
    onRetainedColumn: opts.onRetainedColumn,
  });
  // Existing Notebook callers retain the revision-named accessor and recovery shape.
  const { generation: restoreRevision, pendingState: _pendingState, ...notebookProvider } = provider;
  return { ...notebookProvider, restoreRevision };
}
