import { logger } from "@valentinkolb/cloud/services";
import { mutex, type QueueReceived, queue } from "@k2b/sync";
import * as Y from "yjs";
import * as notes from "./notes";
import {
  compareStreamCursor,
  createYjsTopic,
  fromBase64,
  NODE_ID,
  parseStreamCursor,
  TOPIC_RETENTION_MS,
  type YjsTopicEvent,
} from "./yjs-sync";

/**
 * Snapshot worker responsibilities:
 * - consume queued snapshot jobs (idempotent by noteId + cursor)
 * - lock per note (distributed mutex) so only one worker persists at once
 * - rebuild Y.Doc by replaying topic stream from DB cursor to target cursor
 * - persist snapshot through notes.save() which enforces stale-write guards
 *
 * The worker is intentionally independent from websocket nodes.
 */
const log = logger("yjs-snapshot-worker");

const QUEUE_LEASE_MS = 120_000;
const LEASE_TOUCH_INTERVAL_MS = 15_000;
const LOCK_EXTEND_INTERVAL_MS = 15_000;
const WORKER_RECV_TIMEOUT_MS = 30_000;
const LOCK_TTL_MS = 120_000;
const RETRY_DELAY_MS = 5_000;
const REPLAY_BASE_TIMEOUT_MS = 30_000;
const REPLAY_MAX_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Snapshot queue message shape. Queue is written and read only within this
 * service, so TS types suffice — no runtime schema needed.
 */
type SnapshotReason = "periodic" | "unload" | "shutdown";
type SnapshotSaveJob = {
  noteId: string;
  targetCursor: string;
  reason: SnapshotReason;
  requestedAt: number;
  sourceNodeId: string;
};
type PersistOutcome = "saved" | "stale" | "missing-note" | "locked";
type ReplayEvent = { cursor: string; data: YjsTopicEvent };

const snapshotQueue = queue<SnapshotSaveJob>({
  id: "notebooks.yjs.snapshot",
  prefix: "cloud:notebooks",
  delivery: {
    defaultLeaseMs: QUEUE_LEASE_MS,
    maxDeliveries: 20,
  },
  limits: {
    maxMessageAgeMs: TOPIC_RETENTION_MS,
    maxNackDelayMs: 5 * 60 * 1000,
    dlqRetentionMs: 30 * 24 * 60 * 60 * 1000,
  },
});

const snapshotMutex = mutex({
  id: "notebooks.yjs.snapshot",
  prefix: "cloud:notebooks",
  retryCount: 1,
  retryDelay: 100,
  defaultTtl: LOCK_TTL_MS,
});

const toErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const touchOrThrow = async (message: QueueReceived<SnapshotSaveJob>, errorMessage: string) => {
  const touched = await message.touch({ leaseMs: QUEUE_LEASE_MS });
  if (!touched) {
    throw new Error(errorMessage);
  }
};

const applyReplayEvent = (doc: Y.Doc, event: ReplayEvent, noteId: string) => {
  if (event.data.kind === "awareness") return;

  if (event.data.kind === "sync") {
    try {
      Y.applyUpdate(doc, fromBase64(event.data.payload), "snapshot-rebuild");
      return;
    } catch (error) {
      log.warn("Malformed stream entry during snapshot rebuild", {
        noteId,
        cursor: event.cursor,
        error: toErrorMessage(error),
      });
      throw new Error(`Malformed sync event at cursor ${event.cursor}`);
    }
  }
};

const queueSnapshotSave = async (config: { noteId: string; targetCursor: string; reason: SnapshotReason }): Promise<void> => {
  if (!parseStreamCursor(config.targetCursor)) {
    throw new Error(`Invalid snapshot cursor "${config.targetCursor}"`);
  }

  await snapshotQueue.send({
    data: {
      noteId: config.noteId,
      targetCursor: config.targetCursor,
      reason: config.reason,
      requestedAt: Date.now(),
      sourceNodeId: NODE_ID,
    },
    idempotencyKey: `snapshot:${config.noteId}:${config.targetCursor}`,
    idempotencyTtlMs: 24 * 60 * 60 * 1000,
  });
};

const computeReplayTimeoutMs = (after: string, target: string): number => {
  const from = parseStreamCursor(after);
  const to = parseStreamCursor(target);
  if (!from || !to) return REPLAY_BASE_TIMEOUT_MS;
  const diffMs = Math.max(0, to.ms - from.ms);
  return Math.min(REPLAY_MAX_TIMEOUT_MS, REPLAY_BASE_TIMEOUT_MS + Math.floor(diffMs / 2));
};

const waitUntilTargetCursor = async (config: {
  noteId: string;
  after: string;
  targetCursor: string;
  doc: Y.Doc;
  signal: AbortSignal;
  onProgress: () => Promise<void>;
}): Promise<notes.NoteVersionContributorInput[]> => {
  const replayAbort = new AbortController();
  const timeout = setTimeout(() => replayAbort.abort("replay-timeout"), computeReplayTimeoutMs(config.after, config.targetCursor));
  const onAbort = () => replayAbort.abort("worker-stopped");
  config.signal.addEventListener("abort", onAbort, { once: true });

  let reachedTarget = false;
  let processedEvents = 0;
  let lastProgressAt = Date.now();
  const contributors = new Map<string, notes.NoteVersionContributorInput>();

  try {
    const noteTopic = createYjsTopic(config.noteId);
    for await (const event of noteTopic.live({
      after: config.after,
      signal: replayAbort.signal,
      timeoutMs: 2_000,
    })) {
      const comparison = compareStreamCursor(event.cursor, config.targetCursor);
      if (comparison > 0) {
        break;
      }

      applyReplayEvent(config.doc, event, config.noteId);
      if (event.data.kind === "sync" && event.data.actor) {
        const cursor = parseStreamCursor(event.cursor);
        const contributor = event.data.actor;
        const key = `${contributor.kind}:${contributor.id}`;
        const occurredAt = new Date(cursor?.ms ?? Date.now());
        const current = contributors.get(key);
        if (!current || current.lastContributedAt < occurredAt) {
          contributors.set(key, { ...contributor, lastContributedAt: occurredAt });
        }
      }

      processedEvents++;
      const now = Date.now();
      if (processedEvents % 200 === 0 || now - lastProgressAt >= 2_000) {
        await config.onProgress();
        lastProgressAt = now;
      }

      if (comparison === 0) {
        reachedTarget = true;
        break;
      }
    }
  } finally {
    clearTimeout(timeout);
    config.signal.removeEventListener("abort", onAbort);
  }

  if (config.signal.aborted) {
    throw new Error("Snapshot replay aborted");
  }

  if (reachedTarget) return [...contributors.values()];
  throw new Error(`Target cursor "${config.targetCursor}" was not reached before replay timeout`);
};

const persistSnapshotFromDoc = async (config: {
  noteId: string;
  targetCursor: string;
  requestedAt: number;
  doc: Y.Doc;
  contributors: notes.NoteVersionContributorInput[];
}): Promise<PersistOutcome> => {
  const result = await notes.save({
    noteId: config.noteId,
    yjsState: Y.encodeStateAsUpdate(config.doc),
    contentMd: config.doc.getText("codemirror").toString(),
    createdBy: null,
    createVersion: true,
    streamCursor: config.targetCursor,
    requestedAt: config.requestedAt,
    contributors: config.contributors,
  });

  if (!result.ok) {
    if (result.status === 404) return "missing-note";
    if (result.status === 403) return "locked";
    throw new Error(result.error);
  }

  return "saved";
};

const persistSnapshotJob = async (
  job: SnapshotSaveJob,
  message: QueueReceived<SnapshotSaveJob>,
  signal: AbortSignal,
): Promise<PersistOutcome> => {
  const initialState = await notes.getYjsStateWithCursor({ noteId: job.noteId });
  if (!initialState) return "missing-note";

  if (initialState.streamCursor && compareStreamCursor(initialState.streamCursor, job.targetCursor) >= 0) {
    return "stale";
  }

  const doc = new Y.Doc({ gc: true });
  try {
    if (initialState.yjsState) {
      Y.applyUpdate(doc, initialState.yjsState, "snapshot");
    }

    const contributors = await waitUntilTargetCursor({
      noteId: job.noteId,
      after: initialState.streamCursor ?? "0-0",
      targetCursor: job.targetCursor,
      doc,
      signal,
      onProgress: async () => {
        await touchOrThrow(message, "Snapshot job lease expired while replaying stream");
      },
    });

    await touchOrThrow(message, "Snapshot job lease expired before persisting snapshot");

    return persistSnapshotFromDoc({
      noteId: job.noteId,
      targetCursor: job.targetCursor,
      requestedAt: job.requestedAt,
      doc,
      contributors,
    });
  } finally {
    doc.destroy();
  }
};

const safeNack = async (message: QueueReceived<SnapshotSaveJob>, reason: string, error?: string) => {
  try {
    const nacked = await message.nack({ delayMs: RETRY_DELAY_MS, reason, error });
    if (!nacked) {
      log.warn("Failed to nack snapshot job", { messageId: message.messageId, reason });
    }
  } catch (nackError) {
    log.error("Snapshot job nack threw", {
      messageId: message.messageId,
      reason,
      error: toErrorMessage(nackError),
    });
  }
};

const processMessage = async (message: QueueReceived<SnapshotSaveJob>, signal: AbortSignal): Promise<void> => {
  let keepAlive: ReturnType<typeof setInterval> | null = null;

  try {
    keepAlive = setInterval(() => {
      void message.touch({ leaseMs: QUEUE_LEASE_MS }).catch((error) => {
        log.warn("Snapshot lease keepalive failed", {
          messageId: message.messageId,
          error: toErrorMessage(error),
        });
      });
    }, LEASE_TOUCH_INTERVAL_MS);

    const outcome = await snapshotMutex.withLock(
      `note:${message.data.noteId}`,
      async (lock) => {
        const lockKeepAlive = setInterval(() => {
          void snapshotMutex
            .extend(lock, LOCK_TTL_MS)
            .then((extended) => {
              if (extended) return;
              log.warn("Snapshot lock keepalive lost ownership", {
                messageId: message.messageId,
                noteId: message.data.noteId,
              });
            })
            .catch((error) => {
              log.warn("Snapshot lock keepalive failed", {
                messageId: message.messageId,
                noteId: message.data.noteId,
                error: toErrorMessage(error),
              });
            });
        }, LOCK_EXTEND_INTERVAL_MS);
        try {
          return await persistSnapshotJob(message.data, message, signal);
        } finally {
          clearInterval(lockKeepAlive);
        }
      },
      LOCK_TTL_MS,
    );

    if (outcome === null) {
      await safeNack(message, "lock-busy");
      return;
    }

    if (signal.aborted) {
      await safeNack(message, "worker-shutdown");
      return;
    }

    const acked = await message.ack();
    if (!acked) {
      log.warn("Failed to ack snapshot job", {
        messageId: message.messageId,
        noteId: message.data.noteId,
      });
      return;
    }

    log.debug("Snapshot job completed", {
      noteId: message.data.noteId,
      cursor: message.data.targetCursor,
      outcome,
      reason: message.data.reason,
    });
  } catch (error) {
    await safeNack(message, "persist-failed", toErrorMessage(error));
    if (!signal.aborted) {
      log.error("Snapshot job failed", {
        noteId: message.data.noteId,
        cursor: message.data.targetCursor,
        error: toErrorMessage(error),
      });
    }
  } finally {
    if (keepAlive) {
      clearInterval(keepAlive);
    }
  }
};

const runWorker = async (abort: AbortController): Promise<void> => {
  while (!abort.signal.aborted) {
    let message: QueueReceived<SnapshotSaveJob> | null = null;
    try {
      message = await snapshotQueue.recv({
        wait: true,
        timeoutMs: WORKER_RECV_TIMEOUT_MS,
        leaseMs: QUEUE_LEASE_MS,
        signal: abort.signal,
        consumerId: NODE_ID,
      });
    } catch (error) {
      if (abort.signal.aborted) break;
      log.error("Snapshot worker receive failed", {
        error: toErrorMessage(error),
      });
      await Bun.sleep(500);
      continue;
    }

    if (!message) continue;
    await processMessage(message, abort.signal);
  }
};

let workerAbort: AbortController | null = null;
let workerTask: Promise<void> | null = null;

const start = (): void => {
  if (workerTask) return;

  const abort = new AbortController();
  workerAbort = abort;
  const task = runWorker(abort);
  const trackedTask = task.finally(() => {
    if (workerAbort === abort) {
      workerAbort = null;
    }
    if (workerTask === trackedTask) {
      workerTask = null;
    }
  });
  workerTask = trackedTask;

  log.debug("Snapshot worker started", { nodeId: NODE_ID });
};

const stop = async (): Promise<void> => {
  if (workerAbort) {
    workerAbort.abort();
  }
  const task = workerTask;
  workerAbort = null;
  workerTask = null;

  if (task) {
    await task;
  }

  log.debug("Snapshot worker stopped", { nodeId: NODE_ID });
};

export const yjsSnapshotWorker = {
  start,
  stop,
  queueSnapshotSave,
};
