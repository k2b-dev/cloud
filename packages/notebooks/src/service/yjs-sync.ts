import { fromBase64Strict } from "@k2b/stdlib";
import { getProcessSync, lazySync } from "@valentinkolb/cloud";
import * as Y from "yjs";
import { notebooksYjs } from "../lib/yjs";

export const TOPIC_PREFIX = "cloud:notebooks:yjs";
export const TOPIC_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const AWARENESS_TOPIC_PREFIX = "cloud:notebooks:yjs-awareness";
const AWARENESS_RETENTION_MS = 60_000;
const MAX_SYNC_TOPIC_PAYLOAD_BYTES = 8_100_000;
const MAX_AWARENESS_TOPIC_PAYLOAD_BYTES = 300_000;
export const NODE_ID = crypto.randomUUID();

/**
 * Yjs realtime event shape — internal data produced and consumed by our own
 * code; no runtime validation needed (generics give us type safety).
 */
export type YjsTopicEvent = {
  kind: "sync" | "awareness";
  payload: string;
  originNodeId: string;
  originPeerId: string | null;
  /** Optional for compatibility with retained events from older deployments. */
  actor?: { kind: "user" | "service_account"; id: string };
};

export type YjsSyncEvent = YjsTopicEvent & { kind: "sync" };
export type YjsAwarenessEvent = YjsTopicEvent & { kind: "awareness" };

const STREAM_CURSOR_REGEX = new RegExp(notebooksYjs.streamCursorPattern);

export const createYjsTopic = (noteId: string) =>
  getProcessSync().topic<YjsSyncEvent>({
    id: `${TOPIC_PREFIX}:${noteId}`,
    retention: { maxAgeMs: TOPIC_RETENTION_MS, maxBytes: 1024 * 1024 * 1024 },
    maxPayloadBytes: MAX_SYNC_TOPIC_PAYLOAD_BYTES + 4096,
  });

// Awareness is transient and filtered by note on the server, unlike the retained document log.
export const createYjsAwarenessTopic = lazySync((sync) =>
  sync.topic<YjsAwarenessEvent>({
    id: AWARENESS_TOPIC_PREFIX,
    retention: { maxAgeMs: AWARENESS_RETENTION_MS, maxBytes: 64 * 1024 * 1024 },
    maxPayloadBytes: MAX_AWARENESS_TOPIC_PAYLOAD_BYTES + 4096,
  }),
);

export const toBase64 = (data: Uint8Array): string => Buffer.from(data).toString("base64");
export const fromBase64 = fromBase64Strict;

export const parseStreamCursor = (cursor: string | null | undefined): { resource: string; seq: number } | null => {
  if (!cursor || !STREAM_CURSOR_REGEX.test(cursor)) return null;
  const [, resource, sequence] = cursor.split(".");
  const seq = Number(sequence);
  if (!resource || !Number.isSafeInteger(seq) || seq < 0) return null;
  return { resource, seq };
};

export const compareStreamCursor = (left: string, right: string): number => {
  const l = parseStreamCursor(left);
  const r = parseStreamCursor(right);
  if (!l || !r || l.resource !== r.resource) throw new Error(`Invalid stream cursor comparison: "${left}" vs "${right}"`);
  return l.seq - r.seq;
};

export const maxStreamCursor = (a: string | null, b: string | null): string | null => {
  if (!a) return b;
  if (!b) return a;
  return compareStreamCursor(a, b) >= 0 ? a : b;
};

/** A retained event cannot be decoded as a Yjs update: retrying never helps, no replay can pass it. */
export class MalformedSyncEventError extends Error {
  constructor(
    readonly noteId: string,
    readonly cursor: string,
    cause: unknown,
  ) {
    super(`Malformed sync event for note ${noteId} at cursor ${cursor}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "MalformedSyncEventError";
  }
}

/** Ingress check: a publish is accepted only when it is base64 of a decodable Yjs update. */
export const isValidYjsUpdate = (payload: string): boolean => {
  try {
    Y.decodeUpdate(fromBase64(payload));
    return true;
  } catch {
    return false;
  }
};

export const applyYjsTopicEvent = (doc: Y.Doc, event: { cursor: string; data: YjsTopicEvent }, noteId: string): void => {
  if (event.data.kind !== "sync") return;
  try {
    Y.applyUpdate(doc, fromBase64(event.data.payload), `replay:${event.cursor}`);
  } catch (error) {
    throw new MalformedSyncEventError(noteId, event.cursor, error);
  }
};

export const replayYjsTopicToCursor = async (config: {
  noteId: string;
  after: string | null;
  targetCursor: string;
  doc: Y.Doc;
  signal?: AbortSignal;
}): Promise<void> => {
  const topic = createYjsTopic(config.noteId);
  const after = config.after ?? topic.cursorAt(0);
  if (compareStreamCursor(after, config.targetCursor) >= 0) return;
  let reachedTarget = false;
  for await (const event of topic.replay({ after, until: config.targetCursor, signal: config.signal })) {
    applyYjsTopicEvent(config.doc, event, config.noteId);
    reachedTarget = event.cursor === config.targetCursor;
  }
  if (!reachedTarget) throw new Error(`Target cursor "${config.targetCursor}" was not reached during replay`);
};
