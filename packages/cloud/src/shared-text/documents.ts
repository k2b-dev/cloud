import type { Topic } from "@k2b/sync";
import * as Y from "yjs";
import { validateChanges } from "./changes";
import { compareStreamCursor, maxStreamCursor } from "./cursor";
import { SHARED_TEXT_NAME, sharedTextNodeId, toBase64 } from "./events";
import {
  createStructuralIngressValidation,
  planStructuralInverse,
  prepareIngressHistory,
  prepareStructuralHistory,
  type SharedTextStructuralHistory,
} from "./structural-history";
import { TableActionRejectedError } from "./table-actions";
import { minimalTextDiff } from "./text-diff";
import type {
  SharedTextActor,
  SharedTextChange,
  SharedTextContributor,
  SharedTextEditResult,
  SharedTextSnapshot,
  SharedTextStore,
  SharedTextStoredState,
  SharedTextSyncEvent,
} from "./types";

type DocumentLog = {
  maxEventBytes?: number;
  events?(
    docId: string,
    after: string | null,
    until: string,
    signal?: AbortSignal,
  ): AsyncIterable<{ cursor: string; data: SharedTextSyncEvent }>;
  topic(): Pick<Topic<SharedTextSyncEvent>, "latestCursor" | "publish">;
  replay(config: {
    docId: string;
    after: string | null;
    until: string;
    doc: Y.Doc;
    restoreRevision?: string;
    signal?: AbortSignal;
  }): Promise<SharedTextContributor[]>;
};

/**
 * Fallback text becomes the same Yjs items in every copy: an update published
 * against one copy then applies to the next one, which a random client ID
 * would leave pending and silently drop from the saved state.
 */
const FALLBACK_CLIENT_ID = 0;

export const createDoc = (stored: SharedTextStoredState): Y.Doc => {
  const doc = new Y.Doc({ gc: true });
  try {
    if (stored.state) Y.applyUpdate(doc, stored.state, "snapshot");
    else if (stored.text) {
      const clientID = doc.clientID;
      doc.clientID = FALLBACK_CLIENT_ID;
      doc.getText(SHARED_TEXT_NAME).insert(0, stored.text);
      doc.clientID = clientID;
    }
    return doc;
  } catch (error) {
    doc.destroy();
    throw error;
  }
};

export const bindDocuments = <Saved, Context>(
  { topic, replay, events, maxEventBytes }: DocumentLog,
  store: SharedTextStore<Saved, Context>,
) => {
  const write = async (
    docId: string,
    options: {
      actor: SharedTextActor | null;
      context?: Context;
      signal?: AbortSignal;
      actionId?: string;
      inverseOf?: string;
      retained?: () => boolean;
      validate?: () => Promise<void>;
    },
    update: (current: {
      text: string;
      restoreRevision: string;
      contributors: SharedTextContributor[];
      state(): Uint8Array;
    }) => string | readonly SharedTextChange[] | Promise<string | readonly SharedTextChange[]>,
    maxLength?: number,
  ): Promise<SharedTextEditResult<Saved>> => {
    if (maxLength !== undefined && (!Number.isSafeInteger(maxLength) || maxLength < 0))
      throw new RangeError("maxLength must be a nonnegative safe integer");
    const requestedAt = Date.now();
    const stored = await store.load(docId, { signal: options.signal });
    if (!stored) return { status: "notFound" };
    const handle = topic();
    const target = await handle.latestCursor({ tenantId: docId });
    const doc = createDoc(stored);
    try {
      let contributors: SharedTextContributor[] = [];
      try {
        if (target)
          contributors = await replay({
            docId,
            after: stored.cursor,
            until: target,
            doc,
            restoreRevision: stored.restoreRevision,
            signal: options.signal,
          });
      } catch (error) {
        // A cancelled request is not a sync failure: it throws like every other abort before publication.
        options.signal?.throwIfAborted();
        return { status: "syncFailed", error };
      }
      options.signal?.throwIfAborted();
      if (maxLength !== undefined && (doc.store.pendingStructs || doc.store.pendingDs))
        return { status: "syncFailed", error: new Error("Shared text has unresolved update dependencies") };
      const ytext = doc.getText(SHARED_TEXT_NAME);
      const text = ytext.toString();
      const next = await update({ text, restoreRevision: stored.restoreRevision, contributors, state: () => Y.encodeStateAsUpdate(doc) });
      let changes: readonly SharedTextChange[];
      if (maxLength === undefined) {
        if (typeof next !== "string") throw new TypeError("edit must return text");
        if (next === text) return { status: "unchanged", text };
        const diff = minimalTextDiff(text, next);
        changes = [{ from: diff.index, to: diff.index + diff.deleteCount, insert: diff.insert }];
      } else {
        if (typeof next === "string") throw new TypeError("change must return disjoint edits");
        changes = validateChanges(text, next, maxLength);
      }
      if (!changes.length && !options.inverseOf) return { status: "unchanged", text };
      // A request cancelled while the callback ran must not publish a write.
      options.signal?.throwIfAborted();
      const beforeEditState = Y.encodeStateVector(doc);
      const finishHistory = options.actionId ? prepareStructuralHistory(ytext, changes) : undefined;
      doc.transact(() => {
        for (let index = changes.length - 1; index >= 0; index--) {
          const change = changes[index]!;
          if (change.to > change.from) ytext.delete(change.from, change.to - change.from);
          if (change.insert.length) ytext.insert(change.from, change.insert);
        }
      }, "cli-edit");
      const actor = options.actor;
      const updateBytes = Y.encodeStateAsUpdate(doc, beforeEditState);
      const receipt = options.actionId ? { actionId: options.actionId, update: updateBytes } : undefined;
      const history: SharedTextStructuralHistory = finishHistory?.() ?? { patches: [], tables: [], ingressBarrier: true };
      if (history && options.inverseOf) {
        history.inverseOf = options.inverseOf;
        history.retained = options.retained?.() ?? false;
      }
      const event: SharedTextSyncEvent = {
        kind: "sync",
        payload: toBase64(updateBytes),
        ...(options.actionId ? { actionId: options.actionId } : {}),
        ...(history ? { history } : {}),
        restoreRevision: stored.restoreRevision,
        originNodeId: sharedTextNodeId,
        originPeerId: null,
        ...(actor ? { actor } : {}),
      };
      if (maxEventBytes !== undefined && new TextEncoder().encode(JSON.stringify(event)).length > maxEventBytes)
        throw new RangeError("The structural receipt exceeds the document log payload budget");
      await options.validate?.();
      options.signal?.throwIfAborted();
      const published = await handle.publish({
        tenantId: docId,
        ...(maxLength !== undefined ? { expectedAfter: target } : {}),
        data: event,
      });
      let persistedDoc: Y.Doc | undefined;
      try {
        persistedDoc = createDoc(stored);
        await replay({
          docId,
          after: stored.cursor,
          until: published.cursor,
          doc: persistedDoc,
          restoreRevision: stored.restoreRevision,
          signal: options.signal,
        });
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
        return { status: "edited", text: persistedText, cursor: published.cursor, saved, ...(receipt ? { receipt } : {}) };
      } catch (error) {
        return { status: "persistFailed", cursor: published.cursor, error, ...(receipt ? { receipt } : {}) };
      } finally {
        persistedDoc?.destroy();
      }
    } finally {
      doc.destroy();
    }
  };
  return {
    /** A retained cursor is authority only after document, actor and lineage checks. */
    async inverse(
      docId: string,
      options: {
        actor: SharedTextActor;
        context?: Context;
        signal?: AbortSignal;
        actionId: string;
        receiptCursor: string;
        restoreRevision: string;
        maxLength: number;
        validate?: () => Promise<void>;
      },
    ): Promise<SharedTextEditResult<Saved>> {
      if (!events) throw new Error("This document log cannot read structural receipts");
      let retained = false;
      return write(
        docId,
        { ...options, inverseOf: options.receiptCursor, retained: () => retained },
        async (current) => {
          let receipt: SharedTextSyncEvent | undefined;
          // Exact cursor lookup, independent of snapshot progress. A missing or
          // expired event fails visibly; snapshots do not pin receipt history.
          try {
            for await (const event of events(docId, options.receiptCursor, options.receiptCursor, options.signal)) receipt = event.data;
          } catch {
            throw new TableActionRejectedError();
          }
          if (
            !receipt?.history ||
            !receipt.actionId ||
            receipt.actor?.kind !== options.actor.kind ||
            receipt.actor.id !== options.actor.id ||
            receipt.restoreRevision !== options.restoreRevision ||
            current.restoreRevision !== options.restoreRevision
          )
            throw new TableActionRejectedError();
          const copy = new Y.Doc();
          try {
            Y.applyUpdate(copy, current.state());
            const planned = planStructuralInverse(copy.getText(SHARED_TEXT_NAME), receipt.history);
            retained = planned.retained;
            return planned.changes;
          } finally {
            copy.destroy();
          }
        },
        options.maxLength,
      );
    },
    /** Validate before retained publication; rejected bytes remain client-owned. */
    async accept(
      docId: string,
      options: {
        actor: SharedTextActor;
        update: Uint8Array;
        baseCursor: string | null;
        restoreRevision: string;
        originNodeId: string;
        originPeerId: string | null;
        signal?: AbortSignal;
        validate?: () => Promise<boolean>;
        /** Application-owned limit on the merged canonical UTF-16 text. */
        maxLength?: number;
      },
    ): Promise<{ status: "accepted"; cursor: string } | { status: "recoveryRequired" | "notFound" }> {
      if (options.maxLength !== undefined && (!Number.isSafeInteger(options.maxLength) || options.maxLength < 0))
        throw new RangeError("maxLength must be a nonnegative safe integer");
      Y.decodeUpdate(options.update);
      if (!events) throw new Error("This document log cannot validate ingress");
      const stored = await store.load(docId, { signal: options.signal });
      if (!stored) return { status: "notFound" };
      if (stored.restoreRevision !== options.restoreRevision) return { status: "recoveryRequired" };
      const handle = topic();
      const target = await handle.latestCursor({ tenantId: docId });
      // Idle notes use a shared-topic watermark, which may be ahead of their
      // own last retained event (or have no retained event at all). CAS still
      // targets the tenant head; browser coverage belongs to the snapshot too.
      const covered = maxStreamCursor(stored.cursor, target);
      if (options.baseCursor) {
        try {
          if (!covered || compareStreamCursor(options.baseCursor, covered) > 0) return { status: "recoveryRequired" };
        } catch {
          return { status: "recoveryRequired" };
        }
      }
      if (!target && stored.cursor !== options.baseCursor) return { status: "recoveryRequired" };
      const doc = createDoc(stored);
      try {
        if (target)
          await replay({
            docId,
            after: stored.cursor,
            until: target,
            doc,
            restoreRevision: stored.restoreRevision,
            signal: options.signal,
          });
        const validation = createStructuralIngressValidation(doc, options.update);
        try {
          if (target && (!options.baseCursor || compareStreamCursor(options.baseCursor, target) < 0)) {
            try {
              for await (const event of events(docId, options.baseCursor, target, options.signal)) {
                options.signal?.throwIfAborted();
                if (event.data.restoreRevision !== undefined && event.data.restoreRevision !== options.restoreRevision) continue;
                // Old/unclassified retained events cannot prove that an edit's
                // original table/row targets survived. Do not guess at ingress.
                const history = event.data.history;
                if (!history) return { status: "recoveryRequired" };
                let inverseSource: SharedTextStructuralHistory | undefined;
                if (history.inverseOf && history.patches.some((patch) => patch.inserted.length > 0)) {
                  // A pure removal can be recreated by a LATER inverse receipt.
                  // Its old IDs must not be acknowledged as a removal of the
                  // new target. Exact retained lookup keeps this proof bounded.
                  for await (const original of events(docId, history.inverseOf, history.inverseOf, options.signal)) {
                    if (original.data.restoreRevision === options.restoreRevision) inverseSource = original.data.history;
                  }
                }
                if (!validation.check(history, inverseSource)) return { status: "recoveryRequired" };
              }
            } catch {
              options.signal?.throwIfAborted();
              return { status: "recoveryRequired" };
            }
          }
        } finally {
          validation.dispose();
        }
        // A retained echo confirms input, not a promise that missing causal
        // predecessors might arrive later. Never strand confirmed bytes behind
        // a predecessor which was rejected for requiring recovery.
        const finishHistory = prepareIngressHistory(doc.getText(SHARED_TEXT_NAME));
        Y.applyUpdate(doc, options.update, "ingress-probe");
        if (doc.store.pendingStructs || doc.store.pendingDs) return { status: "recoveryRequired" };
        if (options.maxLength !== undefined && doc.getText(SHARED_TEXT_NAME).length > options.maxLength)
          return { status: "recoveryRequired" };
        options.signal?.throwIfAborted();
        if (options.validate && !(await options.validate())) return { status: "recoveryRequired" };
        options.signal?.throwIfAborted();
        const published = await handle.publish({
          tenantId: docId,
          expectedAfter: target,
          data: {
            kind: "sync",
            payload: toBase64(options.update),
            history: finishHistory(),
            actor: options.actor,
            restoreRevision: options.restoreRevision,
            originNodeId: options.originNodeId,
            originPeerId: options.originPeerId,
          },
        });
        return { status: "accepted", cursor: published.cursor };
      } finally {
        doc.destroy();
      }
    },
    async read(docId: string, options: { signal?: AbortSignal } = {}): Promise<SharedTextSnapshot | null> {
      const stored = await store.load(docId, options);
      if (!stored) return null;
      const latest = await topic().latestCursor({ tenantId: docId });
      if (!latest || (stored.cursor && compareStreamCursor(latest, stored.cursor) <= 0))
        return { state: stored.state, text: stored.text, cursor: stored.cursor, restoreRevision: stored.restoreRevision };
      const doc = createDoc(stored);
      try {
        await replay({ docId, after: stored.cursor, until: latest, doc, restoreRevision: stored.restoreRevision, signal: options.signal });
        return {
          state: Y.encodeStateAsUpdate(doc),
          text: doc.getText(SHARED_TEXT_NAME).toString(),
          cursor: latest,
          restoreRevision: stored.restoreRevision,
        };
      } finally {
        doc.destroy();
      }
    },
    edit(
      docId: string,
      options: { actor: SharedTextActor | null; context?: Context; signal?: AbortSignal },
      update: (current: { text: string; contributors: SharedTextContributor[]; state(): Uint8Array }) => string | Promise<string>,
    ): Promise<SharedTextEditResult<Saved>> {
      return write(docId, options, update);
    },
    /** Disjoint original-source changes, accepted only while the captured tenant head is unchanged. */
    async change(
      docId: string,
      options: { actor: SharedTextActor | null; context?: Context; signal?: AbortSignal; maxLength: number; actionId?: string },
      update: (current: {
        text: string;
        restoreRevision: string;
        contributors: SharedTextContributor[];
        state(): Uint8Array;
      }) => readonly SharedTextChange[] | Promise<readonly SharedTextChange[]>,
    ): Promise<SharedTextEditResult<Saved>> {
      if (!Number.isSafeInteger(options.maxLength) || options.maxLength < 0)
        throw new RangeError("maxLength must be a nonnegative safe integer");
      return write(docId, options, update, options.maxLength);
    },
  };
};
