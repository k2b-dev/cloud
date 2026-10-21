import { getProcessSync, lazySync } from "@k2b/cloud";
import { logger } from "@k2b/cloud/services";
import { sharedText, sharedTextSnapshotJobConfig } from "@k2b/cloud/shared-text";
import * as notes from "./notes";
import { createYjsTopic, TOPIC_RETENTION_MS, YJS_TOPIC_ID } from "./yjs-sync";

const log = logger("yjs-snapshot-worker");
export const SNAPSHOT_JOB_ID = "notebooks.yjs.snapshot.ordered";
type SnapshotReason = "periodic" | "unload" | "shutdown" | "reconcile" | "legacy";
type SnapshotSaveJob = { noteId: string; targetCursor: string; reason: string };
export const SNAPSHOT_JOB_CONFIG = sharedTextSnapshotJobConfig({
  id: SNAPSHOT_JOB_ID,
  retention: { maxAgeMs: TOPIC_RETENTION_MS, maxBytes: 1024 * 1024 * 1024 },
  // Inert for coalesced submits, but part of the provisioned stream: dropping
  // it would drift `duplicate_window` on every existing installation.
  dedupeWindowMs: 24 * 60 * 60 * 1000,
});

/** First retained sequence of the shared log, for deciding when an idle cursor needs to move. */
const sharedLogFirstSequence = async (): Promise<number> => {
  for await (const entry of getProcessSync().listTopics({ idPrefix: YJS_TOPIC_ID })) {
    if (entry.id === YJS_TOPIC_ID) return entry.firstSequence;
  }
  return 0;
};

const pipeline = sharedText.snapshots({
  log: { id: YJS_TOPIC_ID, topic: createYjsTopic, firstSequence: sharedLogFirstSequence },
  job: lazySync((sync) => sync.job<SnapshotSaveJob>(SNAPSHOT_JOB_CONFIG)),
  logger: log,
  // Preserve the payload consumed by older pods during rolling deployments.
  input: {
    encode: ({ docId, targetCursor, reason }) => ({ noteId: docId, targetCursor, reason }),
    decode: ({ noteId, targetCursor, reason }) => ({ docId: noteId, targetCursor, reason }),
  },
  store: {
    list: async ({ limit, after }) =>
      (await notes.listSnapshotCursors({ limit, after })).map(({ noteId, streamCursor }) => ({ docId: noteId, cursor: streamCursor })),
    load: async (noteId, { signal }) => {
      const stored = await notes.getAnchoredYjsState({ noteId, signal });
      return stored
        ? { state: stored.yjsState, cursor: stored.streamCursor, restoreRevision: stored.restoreRevision, text: stored.contentMd }
        : null;
    },
    save: async (noteId, input) => {
      const result = await notes.save({
        noteId,
        yjsState: input.state,
        contentMd: input.text,
        createdBy: null,
        createVersion: true,
        streamCursor: input.cursor,
        restoreRevision: input.restoreRevision,
        requestedAt: input.requestedAt,
        contributors: input.contributors,
      });
      if (!result.ok && result.status !== 404 && result.status !== 403) throw new Error(result.error);
    },
    recover: (noteId, cause, { signal }) => notes.adoptSnapshotAtHead({ noteId, cause, signal }),
    advance: (noteId, { from, to, latest }) => notes.advanceYjsWatermark({ noteId, storedCursor: from, head: to, latest }),
  },
});

const queueSnapshotSave = ({ noteId, targetCursor, reason }: { noteId: string; targetCursor: string; reason: SnapshotReason }) =>
  pipeline.queue({ docId: noteId, targetCursor, reason });
export const yjsSnapshotWorker = {
  start: pipeline.start,
  stop: pipeline.stop,
  queueSnapshotSave,
  reconcile: pipeline.reconcile,
  backlog: pipeline.backlog,
};
