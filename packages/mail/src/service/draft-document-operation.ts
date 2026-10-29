import { fromBase64, type SharedTextActor, type SharedTextSyncEvent } from "@k2b/cloud/shared-text";
import * as Y from "yjs";
import type { DraftEditableContent } from "../contracts";
import { normalizeDraftDocumentContent, readDraftDocument } from "../lib/draft-document";

/** Reserved by the revision writer; ordinary byte admission must strip it. */
export const DRAFT_REVISION_OPERATION_ORIGIN = "mail:revision:v1";

// Two existing 8,000,000-character base64 pending envelopes, decoded at 3/4.
// Current/frozen bases are required state and are pinned outside this cache.
export const DRAFT_REVISION_HISTORY_BYTES = (2 * 8_000_000 * 3) / 4;

export const draftRevisionOperationContent = (base: Uint8Array, input: DraftEditableContent): DraftEditableContent => {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, base);
    return normalizeDraftDocumentContent({
      ...input,
      signatureTemplateId: input.signatureTemplateId === undefined ? readDraftDocument(doc).signatureTemplateId : input.signatureTemplateId,
    });
  } finally {
    doc.destroy();
  }
};

/**
 * The ordered publication is the receipt, including when SQL rolls back.
 * No hash is converted into a Yjs client ID. Match exact content reconstructed
 * on the authenticated base as well as server provenance, actor and lineage.
 * A missing receipt is meaningful only after COMPLETE replay from that base;
 * gaps, invalid receipts and cancellation must propagate, never mean "new".
 */
export const findDraftRevisionOperation = async (input: {
  base: Uint8Array;
  content: DraftEditableContent;
  actor: SharedTextActor;
  generation: string;
  expectedRevision: number;
  events: AsyncIterable<{ data: SharedTextSyncEvent; cursor: string }>;
  deadline: number;
  signal?: AbortSignal;
}): Promise<{ cursor: string; update: Uint8Array } | null> => {
  const wanted = JSON.stringify(normalizeDraftDocumentContent(input.content));
  const checkBudget = () => {
    input.signal?.throwIfAborted();
    if (!Number.isFinite(input.deadline) || Date.now() >= input.deadline) throw new Error("Draft operation receipt deadline exceeded");
  };
  checkBudget();
  for await (const event of input.events) {
    checkBudget();
    const data = event.data;
    if (
      data.kind !== "sync" ||
      data.originNodeId !== DRAFT_REVISION_OPERATION_ORIGIN ||
      data.originPeerId !== String(input.expectedRevision) ||
      data.restoreRevision !== input.generation ||
      data.actor?.kind !== input.actor.kind ||
      data.actor.id !== input.actor.id
    )
      continue;
    const update = fromBase64(data.payload);
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, input.base);
      Y.applyUpdate(doc, update);
      if (JSON.stringify(normalizeDraftDocumentContent(readDraftDocument(doc))) === wanted) return { cursor: event.cursor, update };
    } finally {
      doc.destroy();
    }
  }
  checkBudget();
  return null;
};
