import { query } from "@k2b/stdlib/solid";
import { createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { apiClient } from "@/api/client";
import type { SidebarTreeSort } from "../../../../lib/sidebar-tree";
import { NOTE_SOFT_NAVIGATED_EVENT, NOTE_TITLE_CHANGED_EVENT } from "../detail/events";
import { createSidebarList } from "./sidebar-list";
import { createSidebarTree } from "./sidebar-tree";
import type { Notebook, NotebookContext, TagSummary } from "./types";
import { WORKSPACE_EVENT, type WorkspaceEventDetail } from "./workspace-events";

type WorkspaceState = {
  notebook: Notebook;
  favoriteNoteIds: string[];
  tags: TagSummary[];
  attachmentCount: number;
};

type LoadedWorkspaceState = {
  source: string;
  state: WorkspaceState;
};

const loadWorkspaceState = async (source: string, abortSignal: AbortSignal): Promise<LoadedWorkspaceState> => {
  const response = await apiClient[":id"]["workspace-state"].$get({ param: { id: source } }, { init: { signal: abortSignal } });
  if (!response.ok) throw new Error(`Failed to load notebook workspace (${response.status})`);
  return { source, state: (await response.json()) as WorkspaceState };
};

/**
 * The sidebar's live state: the notebook, favorites, tags and attachment count from one small snapshot, and the note
 * tree and filtered list as bounded windows. A change anywhere in the notebook reads them again; none of it ever
 * loads every note.
 */
export function useNotebookWorkspaceState(ctx: NotebookContext, sort: () => SidebarTreeSort) {
  const source = () => ctx.notebook.id;
  const workspace = query.create<string, LoadedWorkspaceState, { cursor: string | null }>({
    source,
    initial: {
      source: ctx.notebook.id,
      data: {
        source: ctx.notebook.id,
        state: {
          notebook: ctx.notebook,
          favoriteNoteIds: ctx.favoriteNoteIds,
          tags: ctx.tags,
          attachmentCount: ctx.attachmentCount,
        },
      },
    },
    load: (nextSource, { abortSignal }) => loadWorkspaceState(nextSource, abortSignal),
  });
  const tree = createSidebarTree({ notebookId: source, initial: ctx.sidebarTree, sort });
  const list = createSidebarList({ notebookId: source, initial: { filter: ctx.sidebarFilter, list: ctx.sidebarList } });
  const [selectedNoteId, setSelectedNoteId] = createSignal(ctx.selectedNoteId);
  const [optimisticTitles, setOptimisticTitles] = createSignal<ReadonlyMap<string, string>>(new Map());
  const [refreshing, setRefreshing] = createSignal(false);
  const [refreshError, setRefreshError] = createSignal<unknown>(null);
  const current = createMemo(() => {
    const loaded = workspace.data();
    return loaded?.source === source() ? loaded.state : null;
  });
  const notebook = createMemo(() => current()?.notebook ?? ctx.notebook);
  const favoriteNoteIds = createMemo(() => new Set(current()?.favoriteNoteIds ?? ctx.favoriteNoteIds));
  const tags = createMemo(() => current()?.tags ?? ctx.tags);
  const attachmentCount = createMemo(() => current()?.attachmentCount ?? ctx.attachmentCount);
  /** A title typed in the editor shows in the sidebar before the next save reaches every reader. */
  const titleOf = (note: { id: string; title: string }) => optimisticTitles().get(note.id) ?? note.title;

  const refreshViews = async () => {
    await Promise.all([tree.refresh(), list.refresh()]);
  };
  const refreshWorkspace = async () => {
    setRefreshing(true);
    try {
      await Promise.all([workspace.refresh(), refreshViews()]);
      setRefreshError(null);
    } catch (error) {
      setRefreshError(error);
    } finally {
      setRefreshing(false);
    }
  };

  onMount(() => {
    const onWorkspaceEvent = (raw: Event) => {
      const detail = (raw as CustomEvent<WorkspaceEventDetail>).detail;
      if (detail.event.type === "note.favorite.changed" && detail.event.userId !== ctx.userId) {
        detail.cover(Promise.resolve());
        return;
      }
      if (detail.event.type === "note.comments.changed") {
        // The note-bound discussion query owns this event. Keep the workspace
        // tree snapshot stable while still covering events for non-selected notes.
        detail.cover(Promise.resolve());
        return;
      }
      const views = refreshViews().then(
        () => setRefreshError(null),
        (error: unknown) => {
          setRefreshError(error);
          throw error;
        },
      );
      const coverage = Promise.all([workspace.invalidate({ cursor: detail.cursor }), views]).then(() => undefined);
      detail.cover(coverage);
      if (detail.event.type === "note.updated" || detail.event.type === "workspace.invalidated") {
        const noteId = detail.event.type === "note.updated" ? detail.event.note.id : null;
        void coverage
          .then(() => {
            setOptimisticTitles((currentTitles) => {
              if (currentTitles.size === 0) return currentTitles;
              if (!noteId) return new Map();
              const next = new Map(currentTitles);
              next.delete(noteId);
              return next;
            });
          })
          .catch(() => undefined);
      }
    };
    const onSoftNavigated = (raw: Event) => {
      const detail = (raw as CustomEvent<{ noteId?: string }>).detail;
      if (!detail?.noteId) return;
      setSelectedNoteId(detail.noteId);
      // The note may sit in a branch that is closed or not loaded; its way down opens.
      void tree.reveal(detail.noteId).catch(() => undefined);
    };
    const onTitleChanged = (raw: Event) => {
      const detail = (raw as CustomEvent<{ noteId?: string; title?: string }>).detail;
      if (!detail?.noteId || !detail.title) return;
      setOptimisticTitles((currentTitles) => {
        const next = new Map(currentTitles);
        next.set(detail.noteId!, detail.title!);
        return next;
      });
    };
    window.addEventListener(WORKSPACE_EVENT, onWorkspaceEvent);
    window.addEventListener(NOTE_SOFT_NAVIGATED_EVENT, onSoftNavigated);
    window.addEventListener(NOTE_TITLE_CHANGED_EVENT, onTitleChanged);
    onCleanup(() => {
      window.removeEventListener(WORKSPACE_EVENT, onWorkspaceEvent);
      window.removeEventListener(NOTE_SOFT_NAVIGATED_EVENT, onSoftNavigated);
      window.removeEventListener(NOTE_TITLE_CHANGED_EVENT, onTitleChanged);
    });
  });

  return {
    notebook,
    tree,
    list,
    titleOf,
    favoriteNoteIds,
    selectedNoteId,
    tags,
    attachmentCount,
    workspaceError: () => workspace.error() ?? refreshError() ?? tree.error(),
    workspaceRefreshing: () => workspace.refreshing() || refreshing(),
    refreshWorkspace,
  };
}
