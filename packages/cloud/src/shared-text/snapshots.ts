import { type Job, type JobConfig, type Mutex, RetentionGapError, type Topic, type Worker } from "@k2b/sync";
import * as Y from "yjs";
import { logger } from "../services/logging";
import type { SharedTextAdmission } from "./admission";
import { SharedTextBoundaryError } from "./boundary";
import { validateChanges } from "./changes";
import { compareStreamCursor } from "./cursor";
import { createDoc } from "./documents";
import { applySharedTextEvent, MalformedSharedTextEventError, SHARED_TEXT_NAME, sharedTextNodeId, toBase64 } from "./events";
import { checkLifecycleAdmission, type SharedTextLifecycleStore } from "./lifecycle-store";
import type { SharedTextChange, SharedTextContributor, SharedTextSaveInput, SharedTextStoredState, SharedTextSyncEvent } from "./types";

const ACK_WAIT_MS = 120_000;
const RECONCILE_LIMIT = 5_000;
// Each lookup is a short-lived tenant replay stopped after its first event; 16 is far below 5,000 latestCursor lookups per scan page.
// In steady state, only documents edited within the last snapshot delay or stalled documents remain behind.
const BACKLOG_LOOKUPS = 16;

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
  oldest: null | {
    docId: string;
    sequence: number;
    ageMs: number | null;
    sequenceDistance: number;
    historyGap?: boolean;
    /** The lookup budget left documents that may contain an older update. */
    partial?: true;
  };
};
type SnapshotLog = {
  lifecycle?: SharedTextLifecycleStore;
  admit?: SharedTextAdmission;
  id: string;
  /** Custom ordered transports may omit a writer; synchronous flush requires one. */
  writer?(): Pick<Mutex, "withLock" | "extend">;
  topic(): Pick<Topic<SharedTextSyncEvent>, "head" | "latestCursor" | "cursorSequence" | "cursorAt" | "replay" | "publish">;
  firstSequence(): Promise<number>;
};
export type SharedTextSnapshotRepair = {
  /** Application-owned, insertion-only repair in original UTF-16 coordinates. */
  plan(text: string): readonly SharedTextChange[];
  maxLength: number;
};
type SnapshotOptions = {
  log: SnapshotLog;
  store: SharedTextSnapshotStore;
  logger?: ReturnType<typeof logger>;
  repair?: SharedTextSnapshotRepair;
};
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
  { log, store, repair, logger: suppliedLogger }: SnapshotOptions,
  job: SnapshotJob<Input>,
  input: InputCodec<Input>,
) => {
  if (repair && (!Number.isSafeInteger(repair.maxLength) || repair.maxLength < 0))
    throw new RangeError("Repair maxLength must be a nonnegative safe integer");
  const output = suppliedLogger ?? logger("shared-text-snapshots");
  let worker: Promise<Worker> | null = null;
  let lastBacklog: SharedTextSnapshotBacklog | null = null;
  const queue = async (request: SharedTextSnapshotRequest): Promise<void> => {
    const sequence = log.topic().cursorSequence(request.targetCursor);
    // A final unload at a newer cursor must not coalesce with an already settling snapshot.
    await job().submit({ key: `${request.docId}:${sequence}`, coalesce: true, orderingKey: request.docId, input: input.encode(request) });
  };
  const persist = async (request: SharedTextSnapshotRequest, signal: AbortSignal, heartbeat: () => Promise<void>) => {
    const { docId } = request;
    let heartbeatError: unknown;
    const timer = setInterval(() => {
      void heartbeat().catch((error) => {
        heartbeatError = error;
      });
    }, 15_000);
    try {
      const topic = log.topic();
      const initial = await store.load(docId, { signal: signal });
      // Head BEFORE the document's latest event: once it is applied up to
      // that event, the head is a valid (fresher) cursor for the snapshot.
      const head = await topic.head();
      // Cover queued older cursors in one replay; later jobs skip already saved state.
      const target = await topic.latestCursor({ tenantId: docId });
      if (!target && !repair) {
        output.warn("Snapshot skipped: no retained events for the note", { docId, requestedCursor: request.targetCursor });
        return;
      }
      const requestedAt = Date.now();
      if (!initial) return;
      const covered = !target || !!(initial.cursor && compareStreamCursor(initial.cursor, target) >= 0);
      if (covered && !repair) return;
      const doc = createDoc(initial);
      const contributors = new Map<string, SharedTextContributor>();
      try {
        let reachedTarget = covered;
        let fenced = false;
        if (covered && target && repair) {
          for await (const event of topic.replay({
            tenantId: docId,
            after: topic.cursorAt(topic.cursorSequence(target) - 1),
            until: target,
            signal,
          }))
            fenced = event.data.room?.state === "closed" || (event.data.room?.state === "frozen" && event.data.room.expiresAt > Date.now());
        }
        try {
          if (!covered && target)
            for await (const event of topic.replay({
              tenantId: docId,
              after: initial.cursor ?? topic.cursorAt(0),
              until: target,
              signal: signal,
            })) {
              if (
                event.data.kind === "freeze" &&
                event.data.restoreRevision !== undefined &&
                event.data.restoreRevision !== initial.restoreRevision
              )
                throw new SharedTextBoundaryError("GENERATION_CHANGED");
              fenced =
                event.data.room?.state === "closed" || (event.data.room?.state === "frozen" && event.data.room.expiresAt > Date.now());
              const applied = applySharedTextEvent(doc, event, docId, initial.restoreRevision);
              if (applied && event.data.actor)
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
            await store.recover(docId, error, { signal: signal });
          throw error;
        }
        signal.throwIfAborted();
        if (heartbeatError) throw heartbeatError;
        if (!reachedTarget) throw new Error("Snapshot replay did not reach its target");
        await heartbeat();
        signal.throwIfAborted();
        let cursor = target && compareStreamCursor(target, head) > 0 ? target : head;
        if (repair && !fenced && !doc.store.pendingStructs && !doc.store.pendingDs) {
          const repairCurrent = async (signal: AbortSignal) => {
            const text = doc.getText(SHARED_TEXT_NAME);
            const planned = repair.plan(text.toString());
            if (planned.some((change) => change.from !== change.to)) throw new RangeError("Snapshot repair may only insert text");
            const changes = planned.length ? validateChanges(text.toString(), planned, repair.maxLength) : [];
            if (changes.length) {
              let confirm: (() => Promise<void>) | undefined;
              if (log.lifecycle) {
                try {
                  confirm = await checkLifecycleAdmission(log.lifecycle, docId);
                } catch (error) {
                  if (error instanceof SharedTextBoundaryError) return false;
                  throw error;
                }
                signal.throwIfAborted();
              }
              // Stage the repair separately: a rejected post-check must not
              // leak its tentative state into the snapshot saved below.
              const staged = new Y.Doc();
              let update: Uint8Array;
              try {
                Y.applyUpdate(staged, Y.encodeStateAsUpdate(doc));
                const before = Y.encodeStateVector(staged);
                const text = staged.getText(SHARED_TEXT_NAME);
                staged.transact(() => {
                  for (const change of [...changes].reverse()) text.insert(change.from, change.insert);
                }, "snapshot-repair");
                update = Y.encodeStateAsUpdate(staged, before);
              } finally {
                staged.destroy();
              }
              signal.throwIfAborted();
              if (heartbeatError) throw heartbeatError;
              // A conflict retries the whole ordered job from the current store
              // and tenant head; never publish a plan over a newer document.
              const published = await topic.publish({
                tenantId: docId,
                expectedAfter: target,
                data: {
                  kind: "sync",
                  payload: toBase64(update),
                  originNodeId: sharedTextNodeId,
                  originPeerId: null,
                  restoreRevision: initial.restoreRevision,
                },
              });
              try {
                await confirm?.();
              } catch (error) {
                if (error instanceof SharedTextBoundaryError) return false;
                // An unavailable authority has an unknown outcome; retry the
                // job rather than treating an infrastructure failure as a fence.
                throw error;
              }
              Y.applyUpdate(doc, update, "snapshot-repair");
              cursor = published.cursor;
              return true;
            }
            return false;
          };
          if (log.lifecycle && !log.admit) throw new Error("Lifecycle snapshot repair requires document admission");
          const repaired = log.lifecycle && log.admit ? await log.admit(docId, signal, repairCurrent) : await repairCurrent(signal);
          if (!repaired && covered) return;
        } else if (covered) return;
        signal.throwIfAborted();
        await store.save(docId, {
          state: Y.encodeStateAsUpdate(doc),
          text: doc.getText(SHARED_TEXT_NAME).toString(),
          cursor,
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
  };
  const write = async (request: SharedTextSnapshotRequest, signal: AbortSignal, heartbeat: () => Promise<void>) => {
    // A custom ordered transport remains independent of the process runtime.
    if (!log.writer) return persist(request, signal, heartbeat);
    const lease = log.writer();
    // A flush and a queued job share the same document lease on every node.
    const result = await lease.withLock({ resource: request.docId, signal }, async (lock) => {
      let leaseLost = false;
      const renew = async () => {
        await heartbeat();
        if (!(await lease.extend(lock, { ttlMs: ACK_WAIT_MS }))) leaseLost = true;
        if (leaseLost) throw new Error("Shared text snapshot writer lease was lost");
      };
      await persist(request, signal, renew);
      return true;
    });
    if (!result) throw new Error("Shared text snapshot writer is busy; retry the flush");
  };
  const flushNow = async (docId: string, options: { signal?: AbortSignal; restoreRevision?: string; targetCursor?: string } = {}) => {
    if (!log.writer) throw new Error("Synchronous flush requires the log snapshot writer lease");
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(ACK_WAIT_MS)]) : AbortSignal.timeout(ACK_WAIT_MS);
    signal.throwIfAborted();
    const initial = await store.load(docId, { signal });
    if (!initial) return null;
    if (options.restoreRevision !== undefined && initial.restoreRevision !== options.restoreRevision)
      throw new Error("Shared text generation changed before flush");
    const topic = log.topic();
    const latest = await topic.latestCursor({ tenantId: docId });
    const target =
      options.targetCursor && (!latest || compareStreamCursor(options.targetCursor, latest) > 0) ? options.targetCursor : latest;
    if (target && (!initial.cursor || compareStreamCursor(initial.cursor, target) < 0))
      await write({ docId, targetCursor: target, reason: "flush" }, signal, async () => {});
    const persisted = await store.load(docId, { signal });
    signal.throwIfAborted();
    if (
      !persisted ||
      persisted.restoreRevision !== initial.restoreRevision ||
      (target && (!persisted.cursor || compareStreamCursor(persisted.cursor, target) < 0))
    )
      throw new Error("Shared text flush did not persist the accepted cursor");
    return persisted;
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
      async (context) => write(input.decode(context.input), context.signal, () => context.heartbeat()),
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
    const backlogCandidates: Array<{ docId: string; stored: string; storedSeq: number; latest: string }> = [];
    let unretainedMinSeq: number | null = null;
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
        if (!shared) {
          const loaded = await store.load(candidate.docId, { signal: config.signal });
          if (!loaded) continue;
          stored = loaded.cursor;
        }
        const latest = await topic.latestCursor({ tenantId: candidate.docId });
        // A document without a stored cursor replays from the log's start, like the job does.
        if (latest && (!stored || compareStreamCursor(latest, stored) > 0)) {
          await queue({ docId: candidate.docId, targetCursor: latest, reason: "reconcile" });
          queued++;
          const from = stored ?? topic.cursorAt(0);
          const storedSeq = topic.cursorSequence(from);
          const index = backlogCandidates.findIndex((entry) => entry.storedSeq > storedSeq);
          if (backlogCandidates.length === BACKLOG_LOOKUPS && index === -1) {
            unretainedMinSeq = Math.min(unretainedMinSeq ?? storedSeq, storedSeq);
          } else {
            if (backlogCandidates.length === BACKLOG_LOOKUPS) {
              const evicted = backlogCandidates.pop()!;
              unretainedMinSeq = Math.min(unretainedMinSeq ?? evicted.storedSeq, evicted.storedSeq);
            }
            backlogCandidates.splice(index === -1 ? backlogCandidates.length : index, 0, {
              docId: candidate.docId,
              stored: from,
              storedSeq,
              latest,
            });
          }
          continue;
        }
        if (!stored) continue;
        if (topic.cursorSequence(stored) < refreshBelow && (await store.advance(candidate.docId, { from: stored, to: head, latest })))
          advanced++;
      }
      if (candidates.length < RECONCILE_LIMIT) break;
      after = candidates.at(-1)!.docId;
    }
    const report: SharedTextSnapshotBacklog = { log: log.id, measuredAt: new Date(), documents: queued, oldest: null };
    for (const [index, candidate] of backlogCandidates.entries()) {
      if (report.oldest && candidate.storedSeq + 1 >= report.oldest.sequence) break;
      // The first lookup runs in the scan's last heartbeat interval, each later one
      // renews it. A lost lease ends the run; only the lookup itself fails softly.
      if (index > 0) await config.heartbeat?.();
      const lookup = new AbortController();
      const signal = config.signal ? AbortSignal.any([lookup.signal, config.signal]) : lookup.signal;
      try {
        let found = false;
        for await (const event of topic.replay({ tenantId: candidate.docId, after: candidate.stored, until: candidate.latest, signal })) {
          found = true;
          if (!report.oldest || event.sequence < report.oldest.sequence)
            report.oldest = {
              docId: candidate.docId,
              sequence: event.sequence,
              ageMs: report.measuredAt.getTime() - event.publishedAt.getTime(),
              sequenceDistance: lastHeadSeq - event.sequence,
            };
          break;
        }
        if (!found) throw new Error("Snapshot backlog replay returned no retained event");
      } catch (error) {
        config.signal?.throwIfAborted();
        output.warn("Could not read shared text snapshot backlog history", {
          docId: candidate.docId,
          error: error instanceof Error ? error.message : String(error),
        });
        report.oldest = {
          docId: candidate.docId,
          sequence: candidate.storedSeq + 1,
          ageMs: null,
          sequenceDistance: lastHeadSeq - candidate.storedSeq,
          historyGap: error instanceof RetentionGapError,
        };
        break;
      } finally {
        lookup.abort();
      }
      if (
        candidate === backlogCandidates.at(-1) &&
        report.oldest &&
        unretainedMinSeq !== null &&
        unretainedMinSeq + 1 < report.oldest.sequence
      )
        report.oldest.partial = true;
    }
    config.signal?.throwIfAborted();
    output.info("Snapshot reconcile finished", { checked, queued, advanced });
    output.info("Shared text snapshot backlog", report);
    lastBacklog = report;
    return { checked, queued, advanced };
  };
  return { queue, flushNow, start, stop, reconcile, backlog: () => lastBacklog };
};
