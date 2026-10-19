import { type Job, type JobConfig, RetentionGapError, type Topic, type Worker } from "@k2b/sync";
import * as Y from "yjs";
import { logger } from "../services/logging";
import { compareStreamCursor } from "./cursor";
import { createDoc } from "./documents";
import { applySharedTextEvent, MalformedSharedTextEventError, SHARED_TEXT_NAME, sharedTextNodeId } from "./events";
import type { SharedTextContributor, SharedTextSaveInput, SharedTextStoredState, SharedTextSyncEvent } from "./types";

const ACK_WAIT_MS = 120_000;
const RECONCILE_LIMIT = 5_000;

export const sharedTextSnapshotJobConfig = (
  config: Pick<JobConfig, "id" | "deadLetterRetention" | "terminalRetentionMs" | "dedupeWindowMs"> & {
    retention: NonNullable<JobConfig["retention"]>;
  },
) =>
  ({
    id: config.id,
    delivery: { ackWaitMs: ACK_WAIT_MS, maxAttempts: 20, backoffMs: [5_000] },
    // Ordered by document across 8 partitions. Each process reconstructs one
    // document at a time, keeping its memory budget fixed while a fleet can
    // save up to 8 documents concurrently. Changing the count is a resource change.
    ordering: { mode: "partitioned" as const, partitions: 8 },
    retention: config.retention,
    terminalRetentionMs: config.terminalRetentionMs ?? 30 * 24 * 60 * 60 * 1000,
    // 256 dead letters at Sync's 128 KiB payload limit plus its 4 KiB of
    // dead-letter headroom, the depth Sync gives a job by default. A snapshot is
    // dead-lettered only for incomplete or malformed history or after 20 failed
    // attempts; each one carries a document ID and a cursor of a few hundred bytes.
    deadLetterRetention: config.deadLetterRetention ?? { maxBytes: 256 * (128 * 1024 + 4096) },
    ...(config.dedupeWindowMs === undefined ? {} : { dedupeWindowMs: config.dedupeWindowMs }),
  }) satisfies JobConfig;

export type SharedTextSnapshotRequest = { docId: string; targetCursor: string; reason: string };
export type SharedTextSnapshotStore = {
  /** Stable keyset order by docId; include only documents that take snapshots. */
  list(options: { limit: number; after?: string; signal?: AbortSignal }): Promise<Array<{ docId: string; cursor: string | null }>>;
  /** Anchor legacy cursors to this log before returning. */
  load(docId: string, options: { signal?: AbortSignal }): Promise<SharedTextStoredState | null>;
  /**
   * Atomically fence restoreRevision and non-newer cursors. Apply projections
   * only when the write was accepted, never when overtaken. Return normally
   * when covered, gone or locked; throw after a restore if not already covered
   * so the job retries from the current snapshot.
   */
  save(docId: string, input: SharedTextSaveInput): Promise<void>;
  /** Preserve every valid retained update, including pending structs/deletes;
   * save at a captured head with history incomplete. Lost bytes remain lost. */
  recover(docId: string, cause: RetentionGapError | MalformedSharedTextEventError, options: { signal?: AbortSignal }): Promise<unknown>;
  /** Move an idle cursor only while from is still stored and no newer event exists. */
  advance(docId: string, input: { from: string; to: string; latest: string | null }): Promise<boolean>;
};
export type SharedTextSnapshotBacklog = {
  log: string;
  measuredAt: Date;
  documents: number;
  oldest: null | { docId: string; sequence: number; ageMs: number | null; sequenceDistance: number; historyGap?: boolean };
};
type SnapshotLog = {
  id: string;
  topic(): Pick<Topic<SharedTextSyncEvent>, "head" | "latestCursor" | "cursorSequence" | "cursorAt" | "replay">;
  firstSequence(): Promise<number>;
};
type SnapshotOptions = { log: SnapshotLog; store: SharedTextSnapshotStore; logger?: ReturnType<typeof logger> };
type InputCodec<Input> = { encode(request: SharedTextSnapshotRequest): Input; decode(input: Input): SharedTextSnapshotRequest };
type SnapshotJob<Input> = () => Pick<Job<Input>, "submit" | "process">;

export function snapshots(
  options: SnapshotOptions & { job: SnapshotJob<SharedTextSnapshotRequest>; input?: undefined },
): ReturnType<typeof createSnapshots>;
export function snapshots<Input>(
  options: SnapshotOptions & { job: SnapshotJob<Input>; input: InputCodec<Input> },
): ReturnType<typeof createSnapshots>;
export function snapshots<Input>(
  options: SnapshotOptions &
    ({ job: SnapshotJob<SharedTextSnapshotRequest>; input?: undefined } | { job: SnapshotJob<Input>; input: InputCodec<Input> }),
) {
  if (options.input) return createSnapshots(options, options.job, options.input);
  return createSnapshots(options, options.job, { encode: (request) => request, decode: (input) => input });
}

const createSnapshots = <Input>(
  { log, store, logger: suppliedLogger }: SnapshotOptions,
  job: SnapshotJob<Input>,
  input: InputCodec<Input>,
) => {
  const output = suppliedLogger ?? logger("shared-text-snapshots");
  let worker: Promise<Worker> | null = null;
  let lastBacklog: SharedTextSnapshotBacklog | null = null;
  const queue = async (request: SharedTextSnapshotRequest): Promise<void> => {
    const sequence = log.topic().cursorSequence(request.targetCursor);
    // A final unload at a newer cursor must not coalesce with an already settling snapshot.
    await job().submit({ key: `${request.docId}:${sequence}`, coalesce: true, orderingKey: request.docId, input: input.encode(request) });
  };
  const start = async (): Promise<void> => {
    if (worker) {
      await worker;
      return;
    }
    worker = job().process(
      {
        concurrency: 1,
        onError: async ({ error, context }) => {
          output.error("Snapshot job failed; missing or malformed history requires attention", {
            docId: input.decode(context.input).docId,
            error: error instanceof Error ? error.message : String(error),
            attempt: context.attempt,
          });
          if (error instanceof RetentionGapError)
            return {
              action: "dead_letter",
              reason: "Document history is incomplete; retained updates and pending dependencies were recovered",
            };
          if (error instanceof MalformedSharedTextEventError)
            return {
              action: "dead_letter",
              reason: `Retained event cannot be applied; valid updates and pending dependencies were recovered: ${error.message}`,
            };
          return { action: "retry" };
        },
      },
      async (context) => {
        const request = input.decode(context.input);
        const { docId } = request;
        let heartbeatError: unknown;
        const timer = setInterval(() => {
          void context.heartbeat().catch((error) => {
            heartbeatError = error;
          });
        }, 15_000);
        try {
          const topic = log.topic();
          const initial = await store.load(docId, { signal: context.signal });
          // Head BEFORE the document's latest event: once it is applied up to
          // that event, the head is a valid (fresher) cursor for the snapshot.
          const head = await topic.head();
          // Cover queued older cursors in one replay; later jobs skip already saved state.
          const target = await topic.latestCursor({ tenantId: docId });
          if (!target) {
            output.warn("Snapshot skipped: no retained events for the note", { docId, requestedCursor: request.targetCursor });
            return;
          }
          const requestedAt = Date.now();
          if (!initial || (initial.cursor && compareStreamCursor(initial.cursor, target) >= 0)) return;
          const doc = createDoc(initial);
          const contributors = new Map<string, SharedTextContributor>();
          try {
            let reachedTarget = false;
            try {
              for await (const event of topic.replay({
                tenantId: docId,
                after: initial.cursor ?? topic.cursorAt(0),
                until: target,
                signal: context.signal,
              })) {
                applySharedTextEvent(doc, event, docId);
                if (event.data.actor)
                  contributors.set(`${event.data.actor.kind}:${event.data.actor.id}`, {
                    ...event.data.actor,
                    lastContributedAt: event.publishedAt,
                  });
                reachedTarget = event.cursor === target;
              }
            } catch (error) {
              // Preserve all valid retained updates and unresolved dependencies;
              // record the missing/invalid history once in the DLQ after recovery.
              if (error instanceof RetentionGapError || error instanceof MalformedSharedTextEventError)
                await store.recover(docId, error, { signal: context.signal });
              throw error;
            }
            context.signal.throwIfAborted();
            if (heartbeatError) throw heartbeatError;
            if (!reachedTarget) throw new Error("Snapshot replay did not reach its target");
            await context.heartbeat();
            context.signal.throwIfAborted();
            await store.save(docId, {
              state: Y.encodeStateAsUpdate(doc),
              text: doc.getText(SHARED_TEXT_NAME).toString(),
              cursor: compareStreamCursor(head, target) > 0 ? head : target,
              restoreRevision: initial.restoreRevision,
              requestedAt,
              actor: null,
              contributors: [...contributors.values()],
            });
          } finally {
            doc.destroy();
          }
        } finally {
          clearInterval(timer);
        }
      },
    );
    try {
      await worker;
      output.debug("Snapshot worker started", { nodeId: sharedTextNodeId });
    } catch (error) {
      worker = null;
      throw error;
    }
  };
  const stop = async (): Promise<void> => {
    const active = await worker;
    worker = null;
    active?.stop();
    await active?.drain({ timeoutMs: ACK_WAIT_MS });
  };
  const reconcile = async (config: { signal?: AbortSignal; heartbeat?: () => Promise<void> } = {}) => {
    const topic = log.topic();
    let after: string | undefined;
    let checked = 0;
    let queued = 0;
    let advanced = 0;
    let lastHeadSeq = 0;
    let oldest: { docId: string; stored: string; storedSeq: number; latest: string } | null = null;
    while (true) {
      config.signal?.throwIfAborted();
      const candidates = await store.list({ limit: RECONCILE_LIMIT, after, signal: config.signal });
      // Head BEFORE each document's latest event: an idle document is covered up to it.
      const head = await topic.head();
      const headSeq = topic.cursorSequence(head);
      lastHeadSeq = headSeq;
      const firstSeq = await log.firstSequence();
      const refreshBelow = firstSeq + Math.floor((headSeq - firstSeq) / 2);
      for (const candidate of candidates) {
        config.signal?.throwIfAborted();
        if (checked % 200 === 0) await config.heartbeat?.();
        checked++;
        let stored = candidate.cursor;
        let shared = false;
        if (stored) {
          try {
            topic.cursorSequence(stored);
            shared = true;
          } catch {
            /* Legacy cursor: load anchors it. */
          }
        }
        if (!shared) stored = (await store.load(candidate.docId, { signal: config.signal }))?.cursor ?? null;
        if (!stored) continue;
        const latest = await topic.latestCursor({ tenantId: candidate.docId });
        if (latest && compareStreamCursor(latest, stored) > 0) {
          await queue({ docId: candidate.docId, targetCursor: latest, reason: "reconcile" });
          queued++;
          const storedSeq = topic.cursorSequence(stored);
          if (!oldest || storedSeq < oldest.storedSeq) oldest = { docId: candidate.docId, stored, storedSeq, latest };
          continue;
        }
        if (topic.cursorSequence(stored) < refreshBelow && (await store.advance(candidate.docId, { from: stored, to: head, latest })))
          advanced++;
      }
      if (candidates.length < RECONCILE_LIMIT) break;
      after = candidates.at(-1)!.docId;
    }
    const report: SharedTextSnapshotBacklog = { log: log.id, measuredAt: new Date(), documents: queued, oldest: null };
    if (oldest) {
      const lookup = new AbortController();
      const signal = config.signal ? AbortSignal.any([lookup.signal, config.signal]) : lookup.signal;
      try {
        // One bounded tenant replay per run; stop after the first unsnapshotted update.
        for await (const event of topic.replay({ tenantId: oldest.docId, after: oldest.stored, until: oldest.latest, signal })) {
          report.oldest = {
            docId: oldest.docId,
            sequence: event.sequence,
            ageMs: report.measuredAt.getTime() - event.publishedAt.getTime(),
            sequenceDistance: lastHeadSeq - event.sequence,
          };
          break;
        }
        if (!report.oldest) throw new Error("Snapshot backlog replay returned no retained event");
      } catch (error) {
        config.signal?.throwIfAborted();
        output.warn("Could not read shared text snapshot backlog history", {
          docId: oldest.docId,
          error: error instanceof Error ? error.message : String(error),
        });
        report.oldest = {
          docId: oldest.docId,
          sequence: oldest.storedSeq + 1,
          ageMs: null,
          sequenceDistance: lastHeadSeq - oldest.storedSeq,
          historyGap: error instanceof RetentionGapError,
        };
      } finally {
        lookup.abort();
      }
    }
    config.signal?.throwIfAborted();
    output.info("Snapshot reconcile finished", { checked, queued, advanced });
    output.info("Shared text snapshot backlog", report);
    lastBacklog = report;
    return { checked, queued, advanced };
  };
  return { queue, start, stop, reconcile, backlog: () => lastBacklog };
};
