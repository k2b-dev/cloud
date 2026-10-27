import { query } from "@k2b/stdlib/solid";
import { batch, createEffect, createSignal, onCleanup } from "solid-js";
import type { BasesResult, DirectoryResult, EditorLaunch, EntryResult, FileEntry, MarkedEntry, SharePage } from "../contracts";

/**
 * A folder page or a search page. A search that failed keeps its place with `failure`, the stable error code,
 * so the search field and filters stay usable to narrow it.
 */
export type DirectoryView = Omit<DirectoryResult, "items"> & {
  items: (FileEntry & { highlight?: [number, number][] })[];
  query?: string;
  scope?: "folder" | "tree";
  total?: number | null;
  failure?: string;
};
export type WorkspaceSnapshot = {
  source: string;
  bases: BasesResult;
  selectedId: string | null;
  directory: DirectoryView | null;
  errorCode: string | null;
  detail?: EntryResult | null;
  shares?: SharePage;
  editor?: EditorLaunch | null;
  marks?: MarkedEntry[];
};

type Transition = {
  source: string;
  commit: () => void;
  rollback: () => void;
  resolve: () => void;
};

/** The query owns snapshots; this coordinator only owns uncommitted navigation. */
export function createWorkspaceState<T extends { source: string }>(options: {
  initial: T;
  load: (source: string, signal: AbortSignal) => Promise<T>;
}) {
  const [source, setSource] = createSignal(options.initial.source);
  const [enabled, setEnabled] = createSignal(true);
  const [pending, setPending] = createSignal<Transition | null>(null);
  const [failure, setFailure] = createSignal<{ source: string; message: string } | null>(null);
  let committedSource = options.initial.source;
  let lastApplied = options.initial;
  let previousError: Error | null = null;
  const state = query.create({
    source,
    enabled,
    initial: { source: options.initial.source, data: options.initial },
    load: (target, { abortSignal }) => options.load(target, abortSignal),
  });

  createEffect(() => {
    const loaded = state.data();
    const transition = pending();
    if (!transition || !loaded || loaded === lastApplied || loaded.source !== transition.source || loaded.source !== source()) return;
    lastApplied = loaded;
    committedSource = loaded.source;
    batch(() => {
      setPending(null);
      setFailure(null);
    });
    transition.commit();
    transition.resolve();
  });

  createEffect(() => {
    const error = state.error();
    const transition = pending();
    if (!error || error === previousError || !transition || transition.source !== source()) return;
    batch(() => {
      // Do not launch a background load for a target whose navigation failed.
      setEnabled(false);
      setSource(committedSource);
      setFailure({ source: transition.source, message: error.message });
      setPending(null);
    });
    transition.rollback();
    transition.resolve();
  });

  const navigate = (target: string, commit: () => void = () => {}, rollback: () => void = () => {}) => {
    pending()?.resolve();
    // A retry can begin before the query clears its previous failed attempt.
    previousError = state.error();
    return new Promise<void>((resolve) => {
      const sameSource = source() === target;
      batch(() => {
        setFailure(null);
        setSource(target);
        setEnabled(true);
        setPending({ source: target, commit, rollback, resolve });
      });
      // After a failed load the query is disabled; a same-source retry must still refresh or the transition never settles.
      if (sameSource) void state.refresh();
    });
  };
  onCleanup(() => pending()?.resolve());
  return {
    snapshot: () => state.data() ?? options.initial,
    pending: () => pending() !== null,
    /** The address a navigation is loading, or null. */
    pendingSource: () => pending()?.source ?? null,
    failure,
    navigate,
    committedSource: () => committedSource,
    // Selection may replace the URL without loading a different directory.
    rememberSource: (target: string) => {
      committedSource = target;
    },
  };
}
