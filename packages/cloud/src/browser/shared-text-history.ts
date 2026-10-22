import * as Y from "yjs";

/**
 * One outstanding structural action per editor. Register before its request and
 * apply its receipt in log order, before any untracked application of its bytes.
 * HTTP receipts alone are not causal coverage of preceding stream events.
 */
export const createSharedTextActionHistory = (doc: Y.Doc, history: Y.UndoManager, onChange?: () => void) => {
  const origin = {};
  history.addTrackedOrigin(origin);
  let pending: { id: string; resolve(): void; reject(reason: unknown): void } | null = null;
  let disposed = false;
  const cancel = (id: string, reason: unknown) => {
    if (pending?.id !== id) return;
    const action = pending;
    pending = null;
    action.reject(reason);
    onChange?.();
  };
  return {
    isRemoteOrigin: (value: unknown) => value === origin,
    hasPending: () => pending !== null,
    begin(id: string) {
      if (disposed || pending || !id) throw new Error("A table action is unavailable or still awaiting its receipt");
      const applied = new Promise<void>((resolve, reject) => {
        pending = { id, resolve, reject };
      });
      // Request failure can precede the caller awaiting the receipt. The caller
      // still observes this rejection when it awaits the original promise.
      void applied.catch(() => {});
      onChange?.();
      return { applied, cancel: (reason: unknown) => cancel(id, reason) };
    },
    apply(update: Uint8Array, actionId?: string) {
      Y.decodeUpdate(update);
      if (!pending || pending.id !== actionId) {
        Y.applyUpdate(doc, update, "remote");
        return;
      }
      // Pending structs integrate under the later prerequisite's origin. Never
      // insert a receipt into pending state and silently lose its undo item.
      const probe = new Y.Doc();
      try {
        Y.applyUpdate(probe, Y.encodeStateAsUpdate(doc));
        Y.applyUpdate(probe, update);
        if (probe.store.pendingStructs || probe.store.pendingDs) throw new Error("The table action is missing preceding updates");
      } finally {
        probe.destroy();
      }
      history.stopCapturing();
      try {
        Y.applyUpdate(doc, update, origin);
      } finally {
        history.stopCapturing();
      }
      const action = pending;
      pending = null;
      action.resolve();
      onChange?.();
    },
    cancelPending(reason: unknown) {
      if (pending) cancel(pending.id, reason);
    },
    dispose() {
      disposed = true;
      if (pending) cancel(pending.id, new Error("The editor closed before the table action was confirmed"));
      history.removeTrackedOrigin(origin);
    },
  };
};
