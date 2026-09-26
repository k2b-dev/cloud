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
  markApplied: (cursor: string | null) => void;
  onError: (error: unknown) => void;
}) => {
  let disposed = false;
  let running = false;
  let pending = false;
  let cursor: string | null = null;
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
    const coveringCursor = cursor;
    const coveringGeneration = generation;
    abort = new AbortController();
    try {
      const next = await options.load(abort.signal);
      if (disposed) return;
      if (coveringGeneration !== generation) return;
      latest = next;
      apply(next);
      if (!disposed) options.markApplied(coveringCursor);
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
    check: (nextCursor?: string | null) => {
      if (disposed) return;
      if (nextCursor === null) generation++;
      if (nextCursor !== undefined) cursor = nextCursor;
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
