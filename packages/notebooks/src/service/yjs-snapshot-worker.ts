import { type JobConfig, RetentionGapError, type Worker } from "@k2b/sync";
import { lazySync } from "@k2b/cloud";
import { logger } from "@k2b/cloud/services";
import * as Y from "yjs";
import * as notes from "./notes";
import { applyYjsTopicEvent, compareStreamCursor, createYjsTopic, MalformedSyncEventError, NODE_ID, TOPIC_RETENTION_MS } from "./yjs-sync";

const log = logger("yjs-snapshot-worker");
const ACK_WAIT_MS = 120_000;
// Snapshots are ordered per note (orderingKey = noteId) across 8 partitions.
// Each process still reconstructs one document at a time (concurrency 1), so
// the per-process memory budget is unchanged while a fleet can save up to 8
// notes concurrently. Changing the count later is a resource migration.
const SNAPSHOT_PARTITIONS = 8;
const RECONCILE_NOTE_LIMIT = 5_000;
export const SNAPSHOT_JOB_ID = "notebooks.yjs.snapshot.ordered";
type SnapshotReason = "periodic" | "unload" | "shutdown" | "reconcile";
type SnapshotSaveJob = { noteId: string; targetCursor: string; reason: SnapshotReason };
export const SNAPSHOT_JOB_CONFIG = {
  id: SNAPSHOT_JOB_ID,
  delivery: { ackWaitMs: ACK_WAIT_MS, maxAttempts: 20, backoffMs: [5_000] },
  ordering: { mode: "partitioned", partitions: SNAPSHOT_PARTITIONS },
  retention: { maxAgeMs: TOPIC_RETENTION_MS, maxBytes: 1024 * 1024 * 1024 },
  terminalRetentionMs: 30 * 24 * 60 * 60 * 1000,
  // Inert for coalesced submits, but part of the provisioned stream: dropping
  // it would drift `duplicate_window` on every existing installation.
  dedupeWindowMs: 24 * 60 * 60 * 1000,
} satisfies JobConfig;
const snapshotJob = lazySync((sync) => sync.job<SnapshotSaveJob>(SNAPSHOT_JOB_CONFIG));
const queueSnapshotSave = async (config: { noteId: string; targetCursor: string; reason: SnapshotReason }): Promise<void> => {
  const sequence = createYjsTopic(config.noteId).cursorSequence(config.targetCursor);
  // A final unload at a newer cursor must not coalesce with an already settling snapshot.
  await snapshotJob().submit({ key: `${config.noteId}:${sequence}`, coalesce: true, orderingKey: config.noteId, input: config });
};

/** Reconcile all unlocked notes in bounded keyset pages, with cancellation and lease heartbeats. */
const reconcile = async (
  config: { signal?: AbortSignal; heartbeat?: () => Promise<void> } = {},
): Promise<{ checked: number; queued: number }> => {
  let after: string | undefined;
  let checked = 0;
  let queued = 0;
  while (true) {
    config.signal?.throwIfAborted();
    const candidates = await notes.listSnapshotCursors({ limit: RECONCILE_NOTE_LIMIT, after });
    for (const candidate of candidates) {
      config.signal?.throwIfAborted();
      if (checked % 200 === 0) await config.heartbeat?.();
      const head = await createYjsTopic(candidate.noteId).latestCursor();
      checked++;
      if (!head || (candidate.streamCursor && compareStreamCursor(head, candidate.streamCursor) <= 0)) continue;
      await queueSnapshotSave({ noteId: candidate.noteId, targetCursor: head, reason: "reconcile" });
      queued++;
    }
    if (candidates.length < RECONCILE_NOTE_LIMIT) break;
    after = candidates.at(-1)!.noteId;
  }
  log.info("Snapshot reconcile finished", { checked, queued });
  return { checked, queued };
};

let worker: Worker | null = null;
const start = async (): Promise<void> => {
  if (worker) return;
  worker = await snapshotJob().process(
    {
      concurrency: 1,
      onError: async ({ error, context }) => {
        log.error("Snapshot job failed; missing or malformed history requires attention", {
          noteId: context.input.noteId,
          error: error instanceof Error ? error.message : String(error),
          attempt: context.attempt,
        });
        if (error instanceof RetentionGapError) {
          return {
            action: "dead_letter",
            reason: "Document history is incomplete; retained updates and pending dependencies were recovered",
          };
        }
        if (error instanceof MalformedSyncEventError) {
          return {
            action: "dead_letter",
            reason: `Retained event cannot be applied; valid updates and pending dependencies were recovered: ${error.message}`,
          };
        }
        return { action: "retry" };
      },
    },
    async (context) => {
      const { noteId } = context.input;
      let heartbeatError: unknown;
      const timer = setInterval(() => {
        void context.heartbeat().catch((error) => {
          heartbeatError = error;
        });
      }, 15_000);
      const topic = createYjsTopic(noteId);
      try {
        // Cover queued older cursors in one replay; later jobs skip already saved state.
        const targetCursor = await topic.latestCursor();
        if (!targetCursor) {
          log.warn("Snapshot skipped: no retained events for the note", { noteId, requestedCursor: context.input.targetCursor });
          return;
        }
        const requestedAt = Date.now();
        const initial = await notes.getYjsStateWithCursor({ noteId });
        if (!initial || (initial.streamCursor && compareStreamCursor(initial.streamCursor, targetCursor) >= 0)) return;
        const doc = new Y.Doc({ gc: true });
        const contributors = new Map<string, notes.NoteVersionContributorInput>();
        try {
          if (initial.yjsState) Y.applyUpdate(doc, initial.yjsState, "snapshot");
          let reachedTarget = false;
          try {
            for await (const event of topic.replay({
              after: initial.streamCursor ?? topic.cursorAt(0),
              until: targetCursor,
              signal: context.signal,
            })) {
              applyYjsTopicEvent(doc, event, noteId);
              if (event.data.actor)
                contributors.set(`${event.data.actor.kind}:${event.data.actor.id}`, {
                  ...event.data.actor,
                  lastContributedAt: event.publishedAt,
                });
              reachedTarget = event.cursor === targetCursor;
            }
          } catch (error) {
            // Preserve all valid retained updates and unresolved dependencies;
            // record the missing/invalid history once in the DLQ after recovery.
            if (error instanceof RetentionGapError || error instanceof MalformedSyncEventError) {
              await notes.adoptSnapshotAtHead({ noteId, cause: error, signal: context.signal });
            }
            throw error;
          }
          context.signal.throwIfAborted();
          if (heartbeatError) throw heartbeatError;
          if (!reachedTarget) throw new Error("Snapshot replay did not reach its target");
          await context.heartbeat();
          const result = await notes.save({
            noteId,
            yjsState: Y.encodeStateAsUpdate(doc),
            contentMd: doc.getText("codemirror").toString(),
            createdBy: null,
            createVersion: true,
            streamCursor: targetCursor,
            restoreRevision: initial.restoreRevision,
            requestedAt,
            contributors: [...contributors.values()],
          });
          if (!result.ok && result.status !== 404 && result.status !== 403) throw new Error(result.error);
        } finally {
          doc.destroy();
        }
      } finally {
        clearInterval(timer);
      }
    },
  );
  log.debug("Snapshot worker started", { nodeId: NODE_ID });
};
const stop = async (): Promise<void> => {
  const active = worker;
  worker = null;
  active?.stop();
  await active?.drain({ timeoutMs: ACK_WAIT_MS });
};
export const yjsSnapshotWorker = { start, stop, queueSnapshotSave, reconcile };
