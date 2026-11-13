import * as Y from "yjs";

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
      Y.equalSnapshots(Y.snapshot(a), Y.snapshot(b))
    );
  } finally {
    a.destroy();
    b.destroy();
  }
};
