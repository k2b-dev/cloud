import type { TopicConfig } from "@k2b/sync";
import type * as Y from "yjs";
import { getProcessSync } from "../_internal/process-sync";
import { compareStreamCursor } from "./cursor";
import { bindDocuments } from "./documents";
import { applySharedTextEvent } from "./events";
import type { SharedTextContributor, SharedTextStore, SharedTextSyncEvent } from "./types";

const define = (topicConfig: Readonly<Pick<TopicConfig, "id" | "retention" | "deadLetterRetention" | "maxPayloadBytes">>) => {
  const topic = () => getProcessSync().topic<SharedTextSyncEvent>(topicConfig);
  const replay = async (config: {
    docId: string;
    after: string | null;
    until: string;
    doc: Y.Doc;
    signal?: AbortSignal;
  }): Promise<SharedTextContributor[]> => {
    const contributors = new Map<string, SharedTextContributor>();
    const handle = topic();
    const after = config.after ?? handle.cursorAt(0);
    if (compareStreamCursor(after, config.until) >= 0) return [];
    let reachedTarget = false;
    for await (const event of handle.replay({ tenantId: config.docId, after, until: config.until, signal: config.signal })) {
      applySharedTextEvent(config.doc, event, config.docId);
      if (event.data.actor)
        contributors.set(`${event.data.actor.kind}:${event.data.actor.id}`, {
          ...event.data.actor,
          lastContributedAt: event.publishedAt,
        });
      reachedTarget = event.cursor === config.until;
    }
    if (!reachedTarget) throw new Error(`Target cursor "${config.until}" was not reached during replay`);
    return [...contributors.values()];
  };

  return {
    id: topicConfig.id,
    topicConfig,
    topic,
    replay,
    withStore<Saved, Context>(store: SharedTextStore<Saved, Context>) {
      return bindDocuments({ topic, replay }, store);
    },
  };
};

/** Server-only document logs. Applications authorize callers before read/edit. */
export const sharedText = { define };
