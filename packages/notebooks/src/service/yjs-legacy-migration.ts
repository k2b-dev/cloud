/**
 * Retire the per-note Yjs topics of releases up to 0.10.
 *
 * Each legacy note topic reserved two 1 GiB streams. For every one that still
 * exists on the broker, a run:
 *
 * 1. anchors the note on the shared log (its stored snapshot already covers
 *    the legacy topic up to the legacy cursor, recorded as `yjs_legacy_seq`);
 * 2. republishes every newer legacy update onto the shared log, merged into a
 *    few Yjs updates, then records the captured legacy sequence and queues a
 *    snapshot. Yjs updates are idempotent, so a crash between the publish and
 *    the record only repeats the publish;
 * 3. deletes the legacy streams only once everything they hold is captured and
 *    the topic has been quiet for `LEGACY_QUIET_MS`, so nodes of the previous
 *    release that still write during a rolling deploy are not cut off.
 *
 * Runs never overlap (one Sync schedule), handle at most
 * `LEGACY_MIGRATION_BATCH` topics each, and back off per topic after a failure.
 * A topic an old node recreates after deletion is simply found again: with no
 * recorded sequence, all of its events are republished.
 */
import { getProcessSync } from "@k2b/cloud";
import { logger } from "@k2b/cloud/services";
import { RetentionGapError } from "@k2b/sync";
import { sql } from "bun";
import * as Y from "yjs";
import * as notes from "./notes";
import { yjsSnapshotWorker } from "./yjs-snapshot-worker";
import { createYjsTopic, fromBase64, LEGACY_TOPIC_PREFIX, legacyYjsTopic, legacyYjsTopicInfo, NODE_ID, toBase64 } from "./yjs-sync";

const log = logger("notebooks:yjs-legacy-migration");

export const LEGACY_MIGRATION_BATCH = 50;
/** Longer than a rolling deploy: an old node may still write to a legacy topic until then. */
export const LEGACY_QUIET_MS = 60 * 60 * 1000;
/** Merged republish chunks stay well below the 8.1 MB update limit. */
const REPUBLISH_CHUNK_BYTES = 4_000_000;
const BACKOFF_BASE_MS = 5 * 60 * 1000;
const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Outcome = "republished" | "deleted" | "waiting" | "failed" | "skipped";
export type LegacyMigrationResult = Record<Outcome, number> & { remaining: number };

const backoff = new Map<string, { failures: number; until: number }>();

const legacyState = async (noteId: string): Promise<{ legacySeq: number } | null> => {
  const [row] = await sql<{ legacy_seq: string | null }[]>`
    SELECT yjs_legacy_seq::text AS legacy_seq FROM notebooks.notes WHERE id = ${noteId}::uuid`;
  return row ? { legacySeq: Number(row.legacy_seq ?? 0) } : null;
};

/** Republish legacy updates after `captured` onto the shared log; returns the last captured sequence. */
const republish = async (noteId: string, captured: number, last: number, signal?: AbortSignal): Promise<number> => {
  const legacy = legacyYjsTopic(noteId);
  const updates: Uint8Array[] = [];
  let reached = captured;
  let gap = false;
  let malformed = 0;
  let after = legacy.cursorAt(captured);
  while (reached < last) {
    try {
      for await (const event of legacy.replay({ after, until: legacy.cursorAt(last), signal })) {
        reached = event.sequence;
        after = event.cursor;
        if (event.data.kind !== "sync") continue;
        try {
          const update = fromBase64(event.data.payload);
          Y.decodeUpdate(update);
          updates.push(update);
        } catch {
          malformed++;
        }
      }
      reached = last;
    } catch (error) {
      if (!(error instanceof RetentionGapError) || !error.resumeAfter) throw error;
      // The per-note topic lost unsnapshotted updates to its own retention.
      gap = true;
      after = error.resumeAfter;
      reached = Math.max(reached, legacy.cursorSequence(error.resumeAfter));
    }
  }
  const shared = createYjsTopic();
  let lastCursor: string | null = null;
  for (let start = 0; start < updates.length; ) {
    let end = start;
    let bytes = 0;
    while (end < updates.length && (end === start || bytes + updates[end]!.length <= REPUBLISH_CHUNK_BYTES)) {
      bytes += updates[end]!.length;
      end++;
    }
    const published = await shared.publish({
      tenantId: noteId,
      idempotencyKey: `legacy-${captured}-${start}`,
      data: { kind: "sync", payload: toBase64(Y.mergeUpdates(updates.slice(start, end))), originNodeId: NODE_ID, originPeerId: null },
    });
    lastCursor = published.cursor;
    start = end;
  }
  if (gap || malformed > 0) {
    await sql`UPDATE notebooks.notes SET yjs_history_incomplete = TRUE WHERE id = ${noteId}::uuid`;
    log.error("Legacy Yjs topic had lost or malformed updates; retained updates were migrated", { noteId, gap, malformed });
  }
  const recorded = await sql`
    UPDATE notebooks.notes SET yjs_legacy_seq = ${last}
    WHERE id = ${noteId}::uuid AND COALESCE(yjs_legacy_seq, 0) = ${captured}`;
  if (recorded.count === 0) throw new Error("Legacy progress changed concurrently; retrying later");
  if (lastCursor) await yjsSnapshotWorker.queueSnapshotSave({ noteId, targetCursor: lastCursor, reason: "legacy" });
  log.info("Republished legacy Yjs updates onto the shared log", { noteId, from: captured, to: last, updates: updates.length });
  return last;
};

const migrateTopic = async (
  entry: { id: string; lastSequence: number; lastPublishedAt: Date | null },
  now: number,
  signal?: AbortSignal,
): Promise<Outcome> => {
  const noteId = entry.id.slice(LEGACY_TOPIC_PREFIX.length);
  if (!UUID.test(noteId)) return "skipped";
  let state = await legacyState(noteId);
  if (state) {
    await notes.getAnchoredYjsState({ noteId, signal });
    state = await legacyState(noteId);
  }
  let outcome: Outcome = "waiting";
  // A deleted note has nothing left to capture its updates into.
  if (state && entry.lastSequence > state.legacySeq) {
    state.legacySeq = await republish(noteId, state.legacySeq, entry.lastSequence, signal);
    outcome = "republished";
  }
  const quiet = (at: Date | null) => at === null || now - at.getTime() >= LEGACY_QUIET_MS;
  if (!quiet(entry.lastPublishedAt)) return outcome;
  // Re-read right before deleting: a write after the listing must be captured first.
  const current = await legacyYjsTopicInfo(noteId);
  if (!current) return "deleted";
  if (current.lastSequence !== entry.lastSequence || !quiet(current.lastPublishedAt)) return "waiting";
  // Clear the record first: if deletion fails, a later run republishes the
  // (idempotent) updates again instead of trusting a stale sequence.
  if (state) {
    const cleared = await sql`
      UPDATE notebooks.notes SET yjs_legacy_seq = NULL
      WHERE id = ${noteId}::uuid AND COALESCE(yjs_legacy_seq, 0) = ${state.legacySeq}`;
    if (cleared.count === 0) return "waiting";
  }
  await legacyYjsTopic(noteId).destroy();
  log.info("Deleted legacy per-note Yjs topic", { noteId, lastSequence: entry.lastSequence });
  return "deleted";
};

/** One bounded migration run. Returns what happened and how many legacy topics remain. */
export const migrateLegacyYjsTopics = async (
  config: { signal?: AbortSignal; heartbeat?: () => Promise<void>; now?: () => number } = {},
): Promise<LegacyMigrationResult> => {
  const now = config.now ?? Date.now;
  const result: LegacyMigrationResult = { republished: 0, deleted: 0, waiting: 0, failed: 0, skipped: 0, remaining: 0 };
  let handled = 0;
  for await (const entry of getProcessSync().listTopics({ idPrefix: LEGACY_TOPIC_PREFIX, signal: config.signal })) {
    result.remaining++;
    const delay = backoff.get(entry.id);
    if (handled >= LEGACY_MIGRATION_BATCH || (delay && delay.until > now())) continue;
    handled++;
    config.signal?.throwIfAborted();
    try {
      const outcome = await migrateTopic(entry, now(), config.signal);
      result[outcome]++;
      if (outcome === "deleted") result.remaining--;
      backoff.delete(entry.id);
    } catch (error) {
      if (config.signal?.aborted) throw error;
      const failures = (delay?.failures ?? 0) + 1;
      backoff.set(entry.id, { failures, until: now() + Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS) });
      result.failed++;
      log.warn("Legacy Yjs topic migration failed; retrying with backoff", {
        topic: entry.id,
        failures,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await config.heartbeat?.();
  }
  if (result.remaining > 0 || handled > 0) log.info("Legacy Yjs topic migration run finished", result);
  return result;
};
