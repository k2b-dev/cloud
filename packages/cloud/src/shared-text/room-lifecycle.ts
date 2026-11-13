import { ConflictError } from "@k2b/sync";
import * as Y from "yjs";
import { checkSharedTextBoundary, SHARED_TEXT_FREEZE_SAFETY_MS, SharedTextBoundaryError } from "./boundary";
import { createDoc } from "./documents";
import { SHARED_TEXT_NAME, sharedTextNodeId } from "./events";
import { checkLifecycleAdmission } from "./lifecycle-store";
import type { sharedText } from "./log";
import type { SharedTextStoredState, SharedTextSyncEvent } from "./types";

export type SharedTextRoomFreeze = { state: Uint8Array; text: string; cursor: string; restoreRevision: string; expiresAt: number };
export type SharedTextRoomLifecycleOptions = { signal?: AbortSignal; freezeCursor?: string };
export type SharedTextRoomCloseOptions = { signal?: AbortSignal; freezeCursor: string };

/** Durable compacted authority fences admission; log markers order drainage and notify live peers. */
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
      throw new Error("Room lifecycle requires a non-expiring document log with whenFull: reject");
    if (!config.log.lifecycle) throw new Error("Room lifecycle requires sharedText.define({ lifecycle: { maxBytes } })");
    return config.log.lifecycle;
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
    const authority = requireRetention();
    return config.log.admit(docId, signalFor(options), async (signal) => {
      let entry = await authority.get(docId);
      const value = entry?.value;
      if (state === "closed") {
        if (!options.freezeCursor) throw new ConflictError("Closing shared text requires a freeze cursor");
        if (value?.state === "closed") {
          if (value.freezeCursor !== options.freezeCursor) throw new ConflictError("The shared text freeze lease is no longer owned");
          if (value.closeCursor) return value.closeCursor;
          // A crash after durable close but before notification completes here.
        } else if (value?.state !== "frozen" || value.freezeCursor !== options.freezeCursor) {
          throw new ConflictError("The shared text freeze lease is no longer owned");
        }
      } else {
        if (value?.state === "closed") throw new SharedTextBoundaryError("DOCUMENT_CLOSED");
        if (options.freezeCursor && (value?.state !== "frozen" || value.freezeCursor !== options.freezeCursor))
          throw new ConflictError("The shared text freeze lease is no longer owned");
      }
      // A successful domain commit may retire or delete the snapshot row.
      // The freeze token carries everything needed to finish close without it.
      const current =
        value?.state === "frozen" || value?.state === "closed"
          ? {
              topic: config.log.topic(),
              target: await config.log.topic().latestCursor({ tenantId: docId }),
              restoreRevision: value.restoreRevision,
            }
          : await inspect(docId, signal).then((current) =>
              current ? { ...current, restoreRevision: current.stored.restoreRevision } : null,
            );
      if (!current) return null;
      const { topic, target, restoreRevision } = current;
      if ("tail" in current && current.tail?.restoreRevision !== undefined && current.tail.restoreRevision !== restoreRevision)
        throw new SharedTextBoundaryError("GENERATION_CHANGED");
      signal.throwIfAborted();
      // Persist authority BEFORE its notification. Unknown outcomes fail closed;
      // close retries use the same freeze token and finish the notification.
      entry = await authority.put(
        docId,
        entry,
        state === "closed"
          ? { state: "closed", freezeCursor: options.freezeCursor!, closeCursor: null, restoreRevision }
          : { state: "open" },
      );
      signal.throwIfAborted();
      const marker = await topic.publish({
        tenantId: docId,
        expectedAfter: target,
        data: {
          kind: "freeze",
          payload: "",
          restoreRevision,
          originNodeId: sharedTextNodeId,
          originPeerId: null,
          room: { state },
        },
      });
      if (state === "closed")
        await authority.put(docId, entry, {
          state: "closed",
          freezeCursor: options.freezeCursor!,
          closeCursor: marker.cursor,
          restoreRevision,
        });
      return marker.cursor;
    });
  };
  return {
    async freeze(docId: string, options: { signal?: AbortSignal } = {}): Promise<SharedTextRoomFreeze | null> {
      const authority = requireRetention();
      if (!config.flushNow) throw new Error("Room freeze requires snapshots.flushNow");
      const signal = signalFor(options);
      const drained = await config.log.admit(docId, signal, async (signal) => {
        const current = await inspect(docId, signal);
        if (!current) return null;
        const { stored, topic, target, tail } = current;
        await checkLifecycleAdmission(authority, docId);
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
          const previous = await authority.get(docId);
          const preparing = await authority.put(docId, previous, {
            state: "frozen",
            expiresAt: leaseExpiresAt,
            freezeCursor: null,
            restoreRevision: stored.restoreRevision,
          });
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
          await authority.put(docId, preparing, {
            state: "frozen",
            expiresAt: leaseExpiresAt,
            freezeCursor: marker.cursor,
            restoreRevision: stored.restoreRevision,
          });
          return { version, text, marker, expiresAt, stored };
        } finally {
          doc.destroy();
        }
      });
      if (!drained) return null;
      const { version, text, marker, expiresAt, stored } = drained;
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
      const current = (await authority.get(docId))?.value;
      if (Date.now() >= expiresAt || current?.state !== "frozen" || current.freezeCursor !== marker.cursor)
        throw new ConflictError("The shared text freeze lease expired or was released during flush");
      return { state: persisted.state, text, cursor: marker.cursor, restoreRevision: stored.restoreRevision, expiresAt };
    },
    thaw: (docId: string, options?: SharedTextRoomLifecycleOptions) => publish(docId, "open", options),
    closeDocument: (docId: string, options: SharedTextRoomCloseOptions) => publish(docId, "closed", options),
  };
};
