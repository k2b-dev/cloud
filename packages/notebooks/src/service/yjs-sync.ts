import { getProcessSync, lazySync } from "@k2b/cloud";
import { fromBase64Strict } from "@k2b/stdlib";
import type { TopicInventoryEntry } from "@k2b/sync";
import * as Y from "yjs";
import { notebooksYjs } from "../lib/yjs";

/** One document log for every note; the note id is the Sync tenant. */
export const YJS_TOPIC_ID = "cloud:notebooks:yjs";
/** Releases up to 0.10 kept one topic per note: `cloud:notebooks:yjs:<noteId>`. */
export const LEGACY_TOPIC_PREFIX = `${YJS_TOPIC_ID}:`;
export const TOPIC_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const AWARENESS_TOPIC_PREFIX = "cloud:notebooks:yjs-awareness";
const AWARENESS_RETENTION_MS = 60_000;
const MAX_SYNC_TOPIC_PAYLOAD_BYTES = 8_100_000;
/** Sync's envelope limit: the Yjs payload plus room for the event metadata. */
const SYNC_TOPIC_ENVELOPE_BYTES = MAX_SYNC_TOPIC_PAYLOAD_BYTES + 4096;
const MAX_AWARENESS_TOPIC_PAYLOAD_BYTES = 300_000;
/**
 * Byte budget of the shared log. Updates stay in the log until a snapshot
 * covers them, so the budget must hold the peak ingest over the longest
 * unsnapshotted window (see the Notebooks operations guide): 1 GiB covers
 * about 149 KiB/s for two hours of a stalled snapshot pipeline, or 132
 * maximum-size updates between two snapshots.
 */
export const YJS_LOG_MAX_BYTES = 1024 * 1024 * 1024;
/**
 * No consumer processes the document log, so its dead-letter stream stays
 * empty; Sync still provisions it. Two maximum-size dead letters fit.
 */
export const YJS_DEAD_LETTER_MAX_BYTES = 16 * 1024 * 1024;
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

// A fresh handle per call keeps per-connection hubs independent, as before.
export const createYjsTopic = () =>
  getProcessSync().topic<YjsSyncEvent>({
    id: YJS_TOPIC_ID,
    retention: { maxAgeMs: TOPIC_RETENTION_MS, maxBytes: YJS_LOG_MAX_BYTES },
    deadLetterRetention: { maxBytes: YJS_DEAD_LETTER_MAX_BYTES },
    maxPayloadBytes: SYNC_TOPIC_ENVELOPE_BYTES,
  });

/**
 * The exact declaration of a pre-0.11 per-note topic. Only the legacy
 * migration opens it, and only for topics listed on the broker: declaring it
 * for a missing topic would provision a new 1 GiB stream pair.
 */
export const legacyYjsTopic = (noteId: string) =>
  getProcessSync().topic<YjsSyncEvent>({
    id: `${LEGACY_TOPIC_PREFIX}${noteId}`,
    retention: { maxAgeMs: TOPIC_RETENTION_MS, maxBytes: 1024 * 1024 * 1024 },
    maxPayloadBytes: SYNC_TOPIC_ENVELOPE_BYTES,
  });

/** Broker state of a note's retired per-note topic, or null when none exists. Never provisions. */
export const legacyYjsTopicInfo = async (noteId: string): Promise<TopicInventoryEntry | null> => {
  const id = `${LEGACY_TOPIC_PREFIX}${noteId}`;
  for await (const entry of getProcessSync().listTopics({ idPrefix: id })) {
    if (entry.id === id) return entry;
  }
  return null;
};

/** True when a stored cursor belongs to the shared log (not a legacy per-note topic). */
export const isSharedCursor = (cursor: string | null | undefined): cursor is string => {
  if (!cursor) return false;
  try {
    createYjsTopic().cursorSequence(cursor);
    return true;
  } catch {
    return false;
  }
};

/** JetStream refused to reserve storage for a stream or accept a message. */
export const isStorageExhausted = (error: unknown): boolean =>
  /insufficient (storage )?resources|resource limits exceeded/i.test(error instanceof Error ? error.message : String(error));

// Awareness is transient and filtered by note on the server, unlike the retained document log.
export const createYjsAwarenessTopic = lazySync((sync) =>
  sync.topic<YjsAwarenessEvent>({
    id: AWARENESS_TOPIC_PREFIX,
    retention: { maxAgeMs: AWARENESS_RETENTION_MS, maxBytes: 64 * 1024 * 1024 },
    // JetStream rejects a duplicate window longer than max_age; Sync's default (120 s) exceeds this retention (#70).
    dedupeWindowMs: AWARENESS_RETENTION_MS,
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
    const update = fromBase64(event.data.payload);
    // Decode completely before mutating the document: malformed bytes must not
    // partially integrate state before recovery skips the invalid event.
    Y.decodeUpdate(update);
    Y.applyUpdate(doc, update, `replay:${event.cursor}`);
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
  const topic = createYjsTopic();
  const after = config.after ?? topic.cursorAt(0);
  if (compareStreamCursor(after, config.targetCursor) >= 0) return;
  let reachedTarget = false;
  for await (const event of topic.replay({ tenantId: config.noteId, after, until: config.targetCursor, signal: config.signal })) {
    applyYjsTopicEvent(config.doc, event, config.noteId);
    reachedTarget = event.cursor === config.targetCursor;
  }
  if (!reachedTarget) throw new Error(`Target cursor "${config.targetCursor}" was not reached during replay`);
};
