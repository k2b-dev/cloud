import { onCleanup, batch as together } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { createUploadRetryBudget, nextUploadRetry, sleepUploadRetry } from "../upload-retry";
import {
  appendFiles,
  cancelBatch,
  createBatch,
  failGroup,
  finishRow,
  nextRow,
  reportProgress,
  retryRows,
  settleBatch,
  startRow,
  type UploadAnnouncement,
  type UploadBatch,
  waitRow,
} from "./upload-batch";

export type UploadItem = { file: File; path: string };
export type UploadOutcome = { status: "uploaded"; path: string } | { status: "skipped" } | { status: "cancel" };

/** What one kind of upload (a storage folder, a public inbox) does with its files; the queue owns order and state. */
export type UploadAdapter<G> = {
  /** Runs once before the first file of a group, again after a failure; folders are created here. */
  prepare?: (group: G, signal: AbortSignal) => Promise<void>;
  upload: (
    group: G,
    item: UploadItem,
    options: {
      signal: AbortSignal;
      onProgress: (bytes: number) => void;
      /** Cloud answered this attempt, so the network is back; a new try after a busy or silent server waits for progress. */
      alive: () => void;
    },
  ) => Promise<UploadOutcome>;
  /** The short reason a failed row shows. */
  reason: (error: unknown) => string;
};

export type UploadQueue<G> = {
  batch: UploadBatch;
  add: (group: G, target: { key: string; label: string }, items: readonly UploadItem[]) => void;
  cancel: () => void;
  retry: (ids?: readonly number[]) => void;
  /** Forgets a batch that is no longer running. */
  close: () => void;
  listen: (listener: (announcement: UploadAnnouncement) => void) => () => void;
  /** Once the queue drains, hears each group that created or uploaded something since, with its last uploaded path. */
  onSettled: (listener: (group: G, last: string | null) => void) => () => void;
};

/** Offline browsers wait for a useful event; an online hint alone still needs a successful attempt. */
function waitForNetwork(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      window.removeEventListener("online", finish);
      document.removeEventListener("visibilitychange", visible);
      resolve();
    };
    const visible = () => {
      if (document.visibilityState === "visible" && navigator.onLine !== false) finish();
    };
    signal.addEventListener("abort", finish, { once: true });
    window.addEventListener("online", finish);
    document.addEventListener("visibilitychange", visible);
    if (navigator.onLine !== false)
      timer = setTimeout(() => {
        if (navigator.onLine !== false) finish();
      }, delay);
  });
}

/*
 * Files upload one at a time in the order they were added; files added meanwhile join the same batch. The batch
 * lives as long as its owner, not the folder view, so navigating or opening the editor does not stop it. Byte
 * progress reaches the store at most once per animation frame.
 */
export function createUploadQueue<G>(adapter: UploadAdapter<G>): UploadQueue<G> {
  const [batch, setBatch] = createStore<UploadBatch>(createBatch());
  let groups: { value: G; prepared: boolean; changed: boolean; last: string | null }[] = [];
  let items: UploadItem[] = [];
  const listeners = new Set<(announcement: UploadAnnouncement) => void>();
  const settledListeners = new Set<(group: G, last: string | null) => void>();
  let controller: AbortController | null = null;
  let running = false;
  let disposed = false;
  // Closing starts a new batch; an upload of the old one that is still unwinding must not touch it.
  let generation = 0;

  const apply = (transition: (draft: UploadBatch) => UploadAnnouncement | null | void, of = generation) => {
    if (disposed || of !== generation) return;
    let announcement: UploadAnnouncement | null | void = null;
    setBatch(
      produce((draft) => {
        announcement = transition(draft);
      }),
    );
    if (announcement) for (const listener of listeners) listener(announcement);
  };

  const run = async () => {
    if (running) return;
    running = true;
    try {
      for (let id = nextRow(batch); id !== null && !disposed; id = nextRow(batch)) {
        const row = batch.rows[id]!;
        const group = groups[row.group]!;
        const request = new AbortController();
        const turn = generation;
        controller = request;
        apply((draft) => startRow(draft, id!));
        let frame = 0;
        let latest = 0;
        const stale = () => request.signal.aborted || disposed || turn !== generation;
        let attempting = false;
        const clearWait = (only?: "network") => {
          const wait = batch.rows[id!]?.wait;
          if (stale() || !attempting || !wait || (only && wait !== only)) return;
          apply((draft) => waitRow(draft, id!, null), turn);
        };
        const alive = () => clearWait("network");
        const onProgress = (bytes: number) => {
          if (stale() || !attempting) return;
          clearWait();
          latest = bytes;
          if (frame) return;
          frame = requestAnimationFrame(() => {
            frame = 0;
            if (!stale()) apply((draft) => reportProgress(draft, id!, latest), turn);
          });
        };
        const budget = createUploadRetryBudget();
        try {
          while (!stale()) {
            attempting = true;
            try {
              if (!group.prepared) {
                await adapter.prepare?.(group.value, request.signal);
                if (stale()) break;
                group.prepared = true;
                group.changed = true;
              }
              const outcome = await adapter.upload(group.value, items[id]!, { signal: request.signal, onProgress, alive });
              if (stale()) break;
              if (outcome.status === "cancel") {
                cancel();
                break;
              }
              if (outcome.status === "uploaded") {
                group.changed = true;
                group.last = outcome.path;
              }
              apply((draft) => finishRow(draft, id!, { status: outcome.status === "uploaded" ? "success" : "skipped" }), turn);
              break;
            } catch (error) {
              if (stale()) break;
              attempting = false;
              const retry = nextUploadRetry(error, budget, "browser");
              if (!retry) {
                const reason = adapter.reason(error);
                apply((draft) => {
                  const said = finishRow(draft, id!, { status: "failed", reason });
                  if (!group.prepared) failGroup(draft, row.group, reason);
                  return said;
                }, turn);
                break;
              }
              apply((draft) => waitRow(draft, id!, retry.kind), turn);
              await (retry.kind === "network"
                ? waitForNetwork(retry.delay, request.signal)
                : sleepUploadRetry(retry.delay, request.signal));
              if (stale()) break;
              if (retry.kind !== "network") apply((draft) => waitRow(draft, id!, "retrying"), turn);
            }
          }
        } finally {
          attempting = false;
          if (frame) cancelAnimationFrame(frame);
          if (controller === request) controller = null;
        }
      }
    } finally {
      running = false;
    }
    if (disposed) return;
    apply(settleBatch);
    for (const group of groups) {
      if (!group.changed) continue;
      group.changed = false;
      for (const listener of settledListeners) listener(group.value, group.last);
    }
  };

  const cancel = () => {
    controller?.abort();
    apply(cancelBatch);
  };
  const close = () => {
    if (batch.phase === "running") return;
    generation++;
    // A cancelled upload may still be unwinding; groups it changed are still heard once the queue drains.
    groups = groups.filter((group) => group.changed);
    items = [];
    setBatch(createBatch());
  };

  onCleanup(() => {
    disposed = true;
    controller?.abort();
  });

  return {
    batch,
    add: (group, target, added) => {
      if (!added.length) return;
      // Files after a cancel start a new batch: the cancelled files stay out of its totals. One update, so the panel stays.
      together(() => {
        if (batch.phase === "cancelled") close();
        const index = groups.push({ value: group, prepared: false, changed: false, last: null }) - 1;
        items = [...items, ...added];
        apply((draft) =>
          appendFiles(
            draft,
            target,
            index,
            added.map((item) => ({ path: item.path, size: item.file.size })),
          ),
        );
      });
      void run();
    },
    cancel,
    retry: (ids) => {
      apply((draft) => retryRows(draft, ids));
      void run();
    },
    close,
    listen: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onSettled: (listener) => {
      settledListeners.add(listener);
      return () => settledListeners.delete(listener);
    },
  };
}
