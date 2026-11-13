import { ConflictError } from "@k2b/sync";
import * as Y from "yjs";
import { checkSharedTextBoundary, SHARED_TEXT_FREEZE_SAFETY_MS, SharedTextBoundaryError } from "./boundary";
import { createDoc } from "./documents";
import { SHARED_TEXT_NAME, sharedTextNodeId } from "./events";
import type { sharedText } from "./log";
import type { SharedTextStoredState, SharedTextSyncEvent } from "./types";

export type SharedTextRoomFreeze = { state: Uint8Array; text: string; cursor: string; restoreRevision: string; expiresAt: number };
export type SharedTextRoomLifecycleOptions = { signal?: AbortSignal; freezeCursor?: string };

/** One retained marker orders lifecycle changes with every CAS publication. No local lock is authority. */
export const createRoomLifecycle = (config: {
  log: ReturnType<typeof sharedText.define>;
  load(docId: string): Promise<SharedTextStoredState | null>;
  flushNow?(
    docId: string,
    options: { signal: AbortSignal; restoreRevision: string; targetCursor: string },
  ): Promise<SharedTextStoredState | null>;
}) => {
  // Covers a bounded request, including waiting for a concurrent snapshot writer.
  const LEASE_MS = 60_000;
  const requireRetention = () => {
    if (config.log.topicConfig.whenFull !== "reject" || config.log.topicConfig.retention.maxAgeMs !== undefined)
      throw new Error("Room lifecycle requires a non-expiring document log with whenFull: reject; retain lifecycle markers when pruning");
  };
  const inspect = async (docId: string, signal: AbortSignal) => {
    const stored = await config.load(docId);
    if (!stored) return null;
    const topic = config.log.topic();
    const target = await topic.latestCursor({ tenantId: docId });
    let tail: SharedTextSyncEvent | undefined;
    if (target)
      for await (const event of topic.replay({
        tenantId: docId,
        after: topic.cursorAt(topic.cursorSequence(target) - 1),
        until: target,
        signal,
      }))
        tail = event.data;
    signal.throwIfAborted();
    return { stored, topic, target, tail };
  };
  const signalFor = (options: { signal?: AbortSignal }) =>
    options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(LEASE_MS)]) : AbortSignal.timeout(LEASE_MS);
  const publish = async (docId: string, state: "open" | "closed", options: SharedTextRoomLifecycleOptions = {}) => {
    requireRetention();
    return config.log.admit(docId, signalFor(options), async (signal) => {
      const current = await inspect(docId, signal);
      if (!current) return null;
      const { topic, target, stored, tail } = current;
      if (tail?.restoreRevision !== undefined && tail.restoreRevision !== stored.restoreRevision)
        throw new SharedTextBoundaryError("GENERATION_CHANGED");
      if (
        options.freezeCursor &&
        (target !== options.freezeCursor ||
          tail?.room?.state !== "frozen" ||
          tail.room.expiresAt <= Date.now() + SHARED_TEXT_FREEZE_SAFETY_MS)
      )
        throw new ConflictError("The shared text freeze lease is no longer owned");
      if (tail?.room?.state === "closed") {
        if (state === "closed") return target;
        throw new SharedTextBoundaryError("DOCUMENT_CLOSED");
      }
      signal.throwIfAborted();
      return (
        await topic.publish({
          tenantId: docId,
          expectedAfter: target,
          data: {
            kind: "freeze",
            payload: "",
            restoreRevision: stored.restoreRevision,
            originNodeId: sharedTextNodeId,
            originPeerId: null,
            room: { state },
          },
        })
      ).cursor;
    });
  };
  return {
    async freeze(docId: string, options: { signal?: AbortSignal } = {}): Promise<SharedTextRoomFreeze | null> {
      requireRetention();
      if (!config.flushNow) throw new Error("Room freeze requires snapshots.flushNow");
      const signal = signalFor(options);
      const drained = await config.log.admit(docId, signal, async (signal) => {
        const current = await inspect(docId, signal);
        if (!current) return null;
        const { stored, topic, target, tail } = current;
        checkSharedTextBoundary(tail, stored.restoreRevision);
        const doc = createDoc(stored);
        try {
          if (target)
            await config.log.replay({ docId, after: stored.cursor, until: target, doc, restoreRevision: stored.restoreRevision, signal });
          if (doc.store.pendingStructs || doc.store.pendingDs) throw new Error("Cannot freeze unresolved shared text dependencies");
          const version = Y.snapshot(doc);
          const text = doc.getText(SHARED_TEXT_NAME).toString();
          const leaseExpiresAt = Date.now() + LEASE_MS;
          const expiresAt = leaseExpiresAt - SHARED_TEXT_FREEZE_SAFETY_MS;
          signal.throwIfAborted();
          const marker = await topic.publish({
            tenantId: docId,
            expectedAfter: target,
            data: {
              kind: "freeze",
              payload: "",
              restoreRevision: stored.restoreRevision,
              originNodeId: sharedTextNodeId,
              originPeerId: null,
              room: { state: "frozen", expiresAt: leaseExpiresAt },
            },
          });
          return { version, text, marker, expiresAt, stored, topic };
        } finally {
          doc.destroy();
        }
      });
      if (!drained) return null;
      const { version, text, marker, expiresAt, stored, topic } = drained;
      const persisted = await config.flushNow(docId, { signal, restoreRevision: stored.restoreRevision, targetCursor: marker.cursor });
      signal.throwIfAborted();
      if (!persisted?.state || persisted.text !== text) throw new Error("Shared text flush differs from the drained freeze state");
      const saved = createDoc(persisted);
      try {
        // GC and update merging can encode the same state differently. Compare
        // causal coverage and deletions as well as the canonical visible text.
        if (saved.getText(SHARED_TEXT_NAME).toString() !== text || !Y.equalSnapshots(version, Y.snapshot(saved)))
          throw new Error("Shared text flush differs from the drained freeze state");
      } finally {
        saved.destroy();
      }
      if (Date.now() >= expiresAt || (await topic.latestCursor({ tenantId: docId })) !== marker.cursor)
        throw new ConflictError("The shared text freeze lease expired or was released during flush");
      return { state: persisted.state, text, cursor: marker.cursor, restoreRevision: stored.restoreRevision, expiresAt };
    },
    thaw: (docId: string, options?: SharedTextRoomLifecycleOptions) => publish(docId, "open", options),
    closeDocument: (docId: string, options?: SharedTextRoomLifecycleOptions) => publish(docId, "closed", options),
  };
};
