export const STREAM_CURSOR_PATTERN = /^s6t\.[A-Za-z0-9_-]+\.\d+$/;

export const NOTEBOOKS_YJS_WS_TYPE = {
  replayRequest: "notes.yjs.replay.request",
  replayReady: "notes.yjs.replay.ready",
  syncPublish: "notes.yjs.sync.publish",
  awarenessPublish: "notes.yjs.awareness.publish",
  syncPush: "notes.yjs.sync.push",
  awarenessPush: "notes.yjs.awareness.push",
  presenceSnapshot: "notes.presence.snapshot",
  presenceChanged: "notes.presence.changed",
  error: "notes.yjs.error",
} as const;

export type NotebooksYjsWsType = (typeof NOTEBOOKS_YJS_WS_TYPE)[keyof typeof NOTEBOOKS_YJS_WS_TYPE];

export const NOTEBOOKS_YJS_ERROR_CODE = {
  loginRequired: "LOGIN_REQUIRED",
  sessionExpired: "SESSION_EXPIRED",
  accessDenied: "ACCESS_DENIED",
  accessRevoked: "ACCESS_REVOKED",
  noteNotFound: "NOTE_NOT_FOUND",
  noteLocked: "NOTE_LOCKED",
  invalidJson: "INVALID_JSON",
  invalidMessage: "INVALID_MESSAGE",
  invalidPayload: "INVALID_PAYLOAD",
  backpressure: "BACKPRESSURE",
  internalError: "INTERNAL_ERROR",
  resyncRequired: "RESYNC_REQUIRED",
  /** A transient live-stream failure: reconnect with the last cursor, no resync. */
  streamFailed: "STREAM_FAILED",
} as const;

export type NotebooksYjsErrorCode = (typeof NOTEBOOKS_YJS_ERROR_CODE)[keyof typeof NOTEBOOKS_YJS_ERROR_CODE];

export type NotebooksYjsErrorPayload = {
  code: NotebooksYjsErrorCode;
  message: string;
  noteId?: string;
};

export const NOTEBOOKS_YJS_TERMINAL_ERROR_CODES = [
  NOTEBOOKS_YJS_ERROR_CODE.loginRequired,
  NOTEBOOKS_YJS_ERROR_CODE.sessionExpired,
  NOTEBOOKS_YJS_ERROR_CODE.accessDenied,
  NOTEBOOKS_YJS_ERROR_CODE.accessRevoked,
  NOTEBOOKS_YJS_ERROR_CODE.noteNotFound,
  NOTEBOOKS_YJS_ERROR_CODE.noteLocked,
  NOTEBOOKS_YJS_ERROR_CODE.backpressure,
  NOTEBOOKS_YJS_ERROR_CODE.internalError,
] as const;

const NOTEBOOKS_PRESENCE_COLORS = ["#e06c75", "#61afef", "#98c379", "#d19a66", "#c678dd", "#56b6c2", "#e5c07b"] as const;

const hashSeed = (seed: string): number => {
  let hash = 0;
  for (const char of seed) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash;
};

export const getNotebookPresenceColor = (seed: string): string =>
  NOTEBOOKS_PRESENCE_COLORS[hashSeed(seed) % NOTEBOOKS_PRESENCE_COLORS.length]!;

export const notebooksYjs = {
  wsType: NOTEBOOKS_YJS_WS_TYPE,
  streamCursorPattern: STREAM_CURSOR_PATTERN,
  errorCode: NOTEBOOKS_YJS_ERROR_CODE,
  terminalErrorCodes: NOTEBOOKS_YJS_TERMINAL_ERROR_CODES,
  presenceColors: NOTEBOOKS_PRESENCE_COLORS,
} as const;
