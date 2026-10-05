import type { WorkspaceRevision } from "../../../service/workspace-revision";

export type RevisionSnapshot = WorkspaceRevision & { canWrite: boolean; canAdmin: boolean };

/**
 * One in-flight check plus one coalesced follow-up; never acknowledges failed
 * checks. Only the active resources matter: a changed structure or lost
 * permission informs, a deleted active resource revokes the surface.
 */
export const createWorkspaceRevisionController = (options: {
  initial: RevisionSnapshot;
  activeKeys: string[];
  load: (signal: AbortSignal) => Promise<RevisionSnapshot>;
  apply: (state: { changed: boolean; revoked: boolean }) => void;
  onError: (error: unknown) => void;
}) => {
  let disposed = false;
  let running = false;
  let pending = false;
  let abort: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const baseline = { ...options.initial.resources };
  let generation = 0;
  let latest: RevisionSnapshot | undefined;
  const apply = (next: RevisionSnapshot) => {
    const revoked = options.activeKeys.some((key) => options.initial.resources[key] && !next.resources[key]);
    const changed =
      revoked ||
      (options.initial.canAdmin && !next.canAdmin) ||
      (options.initial.canWrite && !next.canWrite) ||
      options.activeKeys.some((key) => baseline[key] !== next.resources[key]);
    options.apply({ changed, revoked });
  };
  const drain = async () => {
    if (disposed || running || !pending) return;
    running = true;
    pending = false;
    const coveringGeneration = generation;
    abort = new AbortController();
    try {
      const next = await options.load(abort.signal);
      if (disposed) return;
      if (coveringGeneration !== generation) return;
      latest = next;
      apply(next);
    } catch (error) {
      if (!disposed) options.onError(error);
    } finally {
      running = false;
      if (!disposed && pending) void drain();
    }
  };
  return {
    acknowledge: (key: string, revision: string) => {
      if (disposed || !baseline[key]) return;
      baseline[key] = revision;
      generation++;
      if (latest?.resources[key] === revision) apply(latest);
    },
    /** `reset` discards a check that is already running: it may have read the state before the change. */
    check: (reset = false) => {
      if (disposed) return;
      if (reset) generation++;
      pending = true;
      if (running || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void drain();
      }, 250);
    },
    dispose: () => {
      disposed = true;
      abort?.abort();
      if (timer) clearTimeout(timer);
    },
  };
};
