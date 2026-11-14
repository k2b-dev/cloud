import * as Y from "yjs";
import { readDraftDocument } from "../lib/draft-document";

/** Compare causal coverage and deletions even when equivalent updates encode differently. */
export const sameDraftDocumentState = (left: Uint8Array | null, right: Uint8Array): boolean => {
  if (!left) return false;
  const a = new Y.Doc();
  const b = new Y.Doc();
  try {
    Y.applyUpdate(a, left);
    Y.applyUpdate(b, right);
    return (
      !a.store.pendingStructs &&
      !a.store.pendingDs &&
      !b.store.pendingStructs &&
      !b.store.pendingDs &&
      Y.equalSnapshots(Y.snapshot(a), Y.snapshot(b)) &&
      JSON.stringify(readDraftDocument(a)) === JSON.stringify(readDraftDocument(b))
    );
  } catch {
    return false;
  } finally {
    a.destroy();
    b.destroy();
  }
};
