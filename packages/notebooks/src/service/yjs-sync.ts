import { getProcessSync, lazySync } from "@k2b/cloud";
import { type SharedTextContributor, type SharedTextEvent, type SharedTextSyncEvent, sharedText } from "@k2b/cloud/shared-text";
import type { TopicInventoryEntry } from "@k2b/sync";
import type * as Y from "yjs";

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
export {
  applySharedTextEvent as applyYjsTopicEvent,
  compareStreamCursor,
  fromBase64,
  isValidSharedTextUpdate as isValidYjsUpdate,
  MalformedSharedTextEventError as MalformedSyncEventError,
  maxStreamCursor,
  parseStreamCursor,
  sharedTextNodeId as NODE_ID,
  toBase64,
} from "@k2b/cloud/shared-text";

export type YjsTopicEvent = SharedTextEvent;
export type YjsSyncEvent = SharedTextSyncEvent;
export type YjsAwarenessEvent = SharedTextEvent & { kind: "awareness" };

export const notebooksTextLog = sharedText.define({
  id: YJS_TOPIC_ID,
  retention: { maxAgeMs: TOPIC_RETENTION_MS, maxBytes: YJS_LOG_MAX_BYTES },
  deadLetterRetention: { maxBytes: YJS_DEAD_LETTER_MAX_BYTES },
  maxPayloadBytes: SYNC_TOPIC_ENVELOPE_BYTES,
});

// A fresh handle per call keeps per-connection hubs independent, as before.
export const createYjsTopic = () => notebooksTextLog.topic();

export const replayYjsTopicToCursor = (config: {
  noteId: string;
  after: string | null;
  targetCursor: string;
  doc: Y.Doc;
  signal?: AbortSignal;
}): Promise<SharedTextContributor[]> =>
  notebooksTextLog.replay({
    docId: config.noteId,
    after: config.after,
    until: config.targetCursor,
    doc: config.doc,
    signal: config.signal,
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
