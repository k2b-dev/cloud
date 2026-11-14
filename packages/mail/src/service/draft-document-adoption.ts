import type { SharedTextSyncEvent } from "@k2b/cloud/shared-text";
import * as Y from "yjs";
import { normalizeDraftDocumentContent, readDraftDocument } from "../lib/draft-document";

/** Retained admission authorship survives a failed SQL save and a different projector. */
export const hasHumanDraftDocumentEdit = async (input: {
  state: Uint8Array;
  generation: string;
  events: AsyncIterable<{ data: SharedTextSyncEvent }>;
}): Promise<boolean> => {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, input.state);
    for await (const event of input.events) {
      if (event.data.kind !== "sync" || event.data.restoreRevision !== input.generation) continue;
      const previous = JSON.stringify(normalizeDraftDocumentContent(readDraftDocument(doc)));
      Y.applyUpdate(doc, Buffer.from(event.data.payload, "base64"));
      if (event.data.actor?.kind === "user" && previous !== JSON.stringify(normalizeDraftDocumentContent(readDraftDocument(doc))))
        return true;
    }
    return false;
  } finally {
    doc.destroy();
  }
};
