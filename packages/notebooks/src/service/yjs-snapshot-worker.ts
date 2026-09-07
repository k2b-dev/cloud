import type { Worker } from "@k2b/sync";
import { lazySync } from "@valentinkolb/cloud";
import { logger, syncOps } from "@valentinkolb/cloud/services";
import * as Y from "yjs";
import * as notes from "./notes";
import { applyYjsTopicEvent, compareStreamCursor, createYjsTopic, NODE_ID, TOPIC_RETENTION_MS } from "./yjs-sync";

const log = logger("yjs-snapshot-worker");
const LEASE_MS = 120_000;
type SnapshotReason = "periodic" | "unload" | "shutdown";
type SnapshotSaveJob = { noteId: string; targetCursor: string; reason: SnapshotReason };
const snapshotJob = lazySync((sync) =>
  sync.job<SnapshotSaveJob>({
    id: "notebooks.yjs.snapshot",
    delivery: { ackWaitMs: LEASE_MS, maxAttempts: 20, backoffMs: [5_000] },
    retention: { maxAgeMs: TOPIC_RETENTION_MS, maxBytes: 1024 * 1024 * 1024 },
    terminalRetentionMs: 30 * 24 * 60 * 60 * 1000,
    dedupeWindowMs: 24 * 60 * 60 * 1000,
  }),
);
const snapshotMutex = lazySync((sync) =>
  sync.mutex({
    id: "notebooks.yjs.snapshot",
    ttlMs: LEASE_MS,
    retry: { maxAttempts: 1 },
  }),
);

const queueSnapshotSave = async (config: { noteId: string; targetCursor: string; reason: SnapshotReason }): Promise<void> => {
  const sequence = createYjsTopic(config.noteId).cursorSequence(config.targetCursor);
  // A final unload at a newer cursor must not coalesce with an already settling snapshot.
  await snapshotJob().submit({ key: `${config.noteId}:${sequence}`, coalesce: true, input: config });
};

let worker: Worker | null = null;
let unregister: (() => void) | undefined;
const start = async (): Promise<void> => {
  if (worker) return;
  unregister ??= syncOps.registerDeadLetters({ name: "notebooks.yjs.snapshot", kind: "job", store: snapshotJob().deadLetters });
  worker = await snapshotJob().process(
    {
      concurrency: 1,
      onError: async ({ error, context }) => {
        log.error("Snapshot failed; document was not advanced past an incomplete replay", {
          noteId: context.input.noteId,
          error: error instanceof Error ? error.message : String(error),
          attempt: context.attempt,
        });
        return { action: "retry" };
      },
    },
    async (context) => {
      const { noteId } = context.input;
      const mutex = snapshotMutex();
      // A busy lock is normal coordination, not a failed snapshot attempt.
      let lock = await mutex.acquire({ resource: noteId, signal: context.signal });
      while (!lock) {
        context.signal.throwIfAborted();
        await context.heartbeat();
        await Bun.sleep(200);
        lock = await mutex.acquire({ resource: noteId, signal: context.signal });
      }
      const heldLock = lock;
      let leaseError: unknown;
      const heartbeat = async () => {
        await context.heartbeat();
        if (!(await mutex.extend(heldLock, { ttlMs: LEASE_MS }))) throw new Error("Snapshot lock ownership lost");
      };
      const timer = setInterval(() => {
        void heartbeat().catch((error) => {
          leaseError = error;
        });
      }, 15_000);
      const topic = createYjsTopic(noteId);
      try {
        // Cover queued older cursors in one replay; later jobs skip already saved state.
        const targetCursor = await topic.latestCursor();
        if (!targetCursor) return;
        const requestedAt = Date.now();
        const initial = await notes.getYjsStateWithCursor({ noteId });
        if (!initial || (initial.streamCursor && compareStreamCursor(initial.streamCursor, targetCursor) >= 0)) return;
        const doc = new Y.Doc({ gc: true });
        const contributors = new Map<string, notes.NoteVersionContributorInput>();
        try {
          if (initial.yjsState) Y.applyUpdate(doc, initial.yjsState, "snapshot");
          let reachedTarget = false;
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
          context.signal.throwIfAborted();
          if (leaseError) throw leaseError;
          if (!reachedTarget) throw new Error("Snapshot replay did not reach its target");
          await heartbeat();
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
        await mutex.release(heldLock);
      }
    },
  );
  log.debug("Snapshot worker started", { nodeId: NODE_ID });
};
const stop = async (): Promise<void> => {
  const active = worker;
  worker = null;
  active?.stop();
  await active?.drain({ timeoutMs: LEASE_MS });
  unregister?.();
  unregister = undefined;
};
export const yjsSnapshotWorker = { start, stop, queueSnapshotSave };
