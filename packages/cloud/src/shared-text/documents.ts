import type { Topic } from "@k2b/sync";
import * as Y from "yjs";
import { compareStreamCursor } from "./cursor";
import { SHARED_TEXT_NAME, sharedTextNodeId, toBase64 } from "./events";
import { minimalTextDiff } from "./text-diff";
import type {
  SharedTextActor,
  SharedTextContributor,
  SharedTextEditResult,
  SharedTextSnapshot,
  SharedTextStore,
  SharedTextStoredState,
  SharedTextSyncEvent,
} from "./types";

type DocumentLog = {
  topic(): Pick<Topic<SharedTextSyncEvent>, "latestCursor" | "publish">;
  replay(config: {
    docId: string;
    after: string | null;
    until: string;
    doc: Y.Doc;
    signal?: AbortSignal;
  }): Promise<SharedTextContributor[]>;
};

const createDoc = (stored: SharedTextStoredState): Y.Doc => {
  const doc = new Y.Doc({ gc: true });
  try {
    if (stored.state) Y.applyUpdate(doc, stored.state, "snapshot");
    else if (stored.text) doc.getText(SHARED_TEXT_NAME).insert(0, stored.text);
    return doc;
  } catch (error) {
    doc.destroy();
    throw error;
  }
};

export const bindDocuments = <Saved, Context>({ topic, replay }: DocumentLog, store: SharedTextStore<Saved, Context>) => {
  return {
    async read(docId: string, options: { signal?: AbortSignal } = {}): Promise<SharedTextSnapshot | null> {
      const stored = await store.load(docId, options);
      if (!stored) return null;
      const latest = await topic().latestCursor({ tenantId: docId });
      if (!latest || (stored.cursor && compareStreamCursor(latest, stored.cursor) <= 0))
        return { state: stored.state, text: stored.text, cursor: stored.cursor };
      const doc = createDoc(stored);
      try {
        await replay({ docId, after: stored.cursor, until: latest, doc, signal: options.signal });
        return { state: Y.encodeStateAsUpdate(doc), text: doc.getText(SHARED_TEXT_NAME).toString(), cursor: latest };
      } finally {
        doc.destroy();
      }
    },
    async edit(
      docId: string,
      options: { actor: SharedTextActor | null; context?: Context; signal?: AbortSignal },
      update: (current: { text: string; contributors: SharedTextContributor[]; state(): Uint8Array }) => string | Promise<string>,
    ): Promise<SharedTextEditResult<Saved>> {
      const requestedAt = Date.now();
      const stored = await store.load(docId, { signal: options.signal });
      if (!stored) return { status: "notFound" };
      const handle = topic();
      const target = await handle.latestCursor({ tenantId: docId });
      const doc = createDoc(stored);
      try {
        let contributors: SharedTextContributor[] = [];
        try {
          if (target) contributors = await replay({ docId, after: stored.cursor, until: target, doc, signal: options.signal });
        } catch (error) {
          return { status: "syncFailed", error };
        }
        const ytext = doc.getText(SHARED_TEXT_NAME);
        const text = ytext.toString();
        const next = await update({ text, contributors, state: () => Y.encodeStateAsUpdate(doc) });
        if (next === text) return { status: "unchanged", text };
        // A request cancelled while the callback ran must not publish a write.
        options.signal?.throwIfAborted();
        const diff = minimalTextDiff(text, next);
        const beforeEditState = Y.encodeStateVector(doc);
        doc.transact(() => {
          if (diff.deleteCount > 0) ytext.delete(diff.index, diff.deleteCount);
          if (diff.insert.length > 0) ytext.insert(diff.index, diff.insert);
        }, "cli-edit");
        const actor = options.actor;
        const published = await handle.publish({
          tenantId: docId,
          data: {
            kind: "sync",
            payload: toBase64(Y.encodeStateAsUpdate(doc, beforeEditState)),
            originNodeId: sharedTextNodeId,
            originPeerId: null,
            ...(actor ? { actor } : {}),
          },
        });
        let persistedDoc: Y.Doc | undefined;
        try {
          persistedDoc = createDoc(stored);
          await replay({ docId, after: stored.cursor, until: published.cursor, doc: persistedDoc, signal: options.signal });
          const persistedText = persistedDoc.getText(SHARED_TEXT_NAME).toString();
          const credited = new Map(contributors.map((contributor) => [`${contributor.kind}:${contributor.id}`, contributor]));
          if (actor) credited.set(`${actor.kind}:${actor.id}`, { ...actor, lastContributedAt: new Date(requestedAt) });
          const saved = await store.save(
            docId,
            {
              state: Y.encodeStateAsUpdate(persistedDoc),
              text: persistedText,
              cursor: published.cursor,
              restoreRevision: stored.restoreRevision,
              requestedAt,
              actor,
              contributors: [...credited.values()],
            },
            options.context,
          );
          return { status: "edited", text: persistedText, cursor: published.cursor, saved };
        } catch (error) {
          return { status: "persistFailed", cursor: published.cursor, error };
        } finally {
          persistedDoc?.destroy();
        }
      } finally {
        doc.destroy();
      }
    },
  };
};
