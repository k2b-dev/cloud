import { RetentionGapError, type TopicConfig } from "@k2b/sync";
import type * as Y from "yjs";
import { getProcessSync } from "../_internal/process-sync";
import { compareStreamCursor } from "./cursor";
import { bindDocuments } from "./documents";
import { applySharedTextEvent, MalformedSharedTextEventError } from "./events";
import { snapshots } from "./snapshots";
import type { SharedTextContributor, SharedTextStore, SharedTextSyncEvent } from "./types";

const define = (topicConfig: Readonly<Pick<TopicConfig, "id" | "retention" | "deadLetterRetention" | "maxPayloadBytes">>) => {
  const topic = () => getProcessSync().topic<SharedTextSyncEvent>(topicConfig);
  const replay = async (config: {
    docId: string;
    after: string | null;
    until: string;
    doc: Y.Doc;
    restoreRevision?: string;
    signal?: AbortSignal;
  }): Promise<SharedTextContributor[]> => {
    const contributors = new Map<string, SharedTextContributor>();
    const handle = topic();
    const after = config.after ?? handle.cursorAt(0);
    if (compareStreamCursor(after, config.until) >= 0) return [];
    let reachedTarget = false;
    for await (const event of handle.replay({ tenantId: config.docId, after, until: config.until, signal: config.signal })) {
      const applied = applySharedTextEvent(config.doc, event, config.docId, config.restoreRevision);
      if (applied && event.data.actor)
        contributors.set(`${event.data.actor.kind}:${event.data.actor.id}`, {
          ...event.data.actor,
          lastContributedAt: event.publishedAt,
        });
      reachedTarget = event.cursor === config.until;
    }
    if (!reachedTarget) throw new Error(`Target cursor "${config.until}" was not reached during replay`);
    return [...contributors.values()];
  };

  const recover = async (config: {
    docId: string;
    after: string | null;
    until: string;
    doc: Y.Doc;
    restoreRevision?: string;
    signal?: AbortSignal;
  }): Promise<{ recoveredUpdates: number; malformedUpdates: number; historyGaps: number }> => {
    const handle = topic();
    let recoveredUpdates = 0;
    let malformedUpdates = 0;
    let historyGaps = 0;
    let after = config.after ?? handle.cursorAt(0);
    while (compareStreamCursor(after, config.until) < 0) {
      config.signal?.throwIfAborted();
      try {
        for await (const event of handle.replay({ tenantId: config.docId, after, until: config.until, signal: config.signal })) {
          try {
            if (applySharedTextEvent(config.doc, event, config.docId, config.restoreRevision)) recoveredUpdates++;
          } catch (error) {
            if (!(error instanceof MalformedSharedTextEventError)) throw error;
            malformedUpdates++;
          }
          after = event.cursor;
        }
        // The replay covered every document event up to the captured head.
        after = config.until;
      } catch (error) {
        if (!(error instanceof RetentionGapError) || !error.resumeAfter || compareStreamCursor(error.resumeAfter, after) <= 0) throw error;
        historyGaps++;
        // Skip only unavailable sequences; include the first retained event.
        // Strict forward progress and a fixed head bound this loop even if
        // retention advances concurrently. Never advance past the captured head.
        after = compareStreamCursor(error.resumeAfter, config.until) > 0 ? config.until : error.resumeAfter;
      }
    }
    config.signal?.throwIfAborted();
    return { recoveredUpdates, malformedUpdates, historyGaps };
  };

  return {
    id: topicConfig.id,
    topicConfig,
    topic,
    replay,
    recover,
    async firstSequence(): Promise<number> {
      for await (const entry of getProcessSync().listTopics({ idPrefix: topicConfig.id })) {
        if (entry.id === topicConfig.id) return entry.firstSequence;
      }
      return 0;
    },
    withStore<Saved, Context>(store: SharedTextStore<Saved, Context>) {
      return bindDocuments(
        {
          topic,
          replay,
          maxEventBytes: topicConfig.maxPayloadBytes,
          async *events(docId, after, until, signal) {
            const handle = topic();
            const exact = after === until;
            const start = exact ? handle.cursorAt(handle.cursorSequence(until) - 1) : (after ?? handle.cursorAt(0));
            let reached = false;
            for await (const event of handle.replay({ tenantId: docId, after: start, until, signal })) {
              reached = event.cursor === until;
              if (!exact || event.cursor === until) yield event;
            }
            if (!reached) throw new Error("The structural receipt history is unavailable");
          },
        },
        store,
      );
    },
  };
};

/** Server-only document logs. Applications authorize callers before read/edit. */
export const sharedText = { define, snapshots };
