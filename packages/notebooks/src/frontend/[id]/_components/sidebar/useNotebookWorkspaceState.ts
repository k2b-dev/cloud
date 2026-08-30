import { query } from "@k2b/stdlib/solid";
import { createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { apiClient } from "@/api/client";
import { NOTE_SOFT_NAVIGATED_EVENT, NOTE_TITLE_CHANGED_EVENT } from "../detail/events";
import type { Notebook, NotebookContext, NoteTreeNode, TagSummary } from "./types";
import { WORKSPACE_EVENT, type WorkspaceEventDetail } from "./workspace-events";

type WorkspaceState = {
  notebook: Notebook;
  tree: NoteTreeNode[];
  favoriteNoteIds: string[];
  tags: TagSummary[];
  attachmentCount: number;
};

type LoadedWorkspaceState = {
  source: string;
  state: WorkspaceState;
};

const applyOptimisticTitles = (nodes: NoteTreeNode[], titles: ReadonlyMap<string, string>): NoteTreeNode[] =>
  nodes.map((node) => ({
    ...node,
    title: titles.get(node.id) ?? node.title,
    children: applyOptimisticTitles(node.children, titles),
  }));

const loadWorkspaceState = async (source: string, abortSignal: AbortSignal): Promise<LoadedWorkspaceState> => {
  const response = await apiClient[":id"]["workspace-state"].$get({ param: { id: source } }, { init: { signal: abortSignal } });
  if (!response.ok) throw new Error(`Failed to load notebook workspace (${response.status})`);
  return { source, state: (await response.json()) as WorkspaceState };
};

export function useNotebookWorkspaceState(ctx: NotebookContext) {
  const source = () => ctx.notebook.id;
  const workspace = query.create<string, LoadedWorkspaceState, { cursor: string | null }>({
    source,
    initial: {
      source: ctx.notebook.id,
      data: {
        source: ctx.notebook.id,
        state: {
          notebook: ctx.notebook,
          tree: ctx.tree,
          favoriteNoteIds: ctx.favoriteNoteIds,
          tags: ctx.tags,
          attachmentCount: ctx.attachmentCount,
        },
      },
    },
    load: (nextSource, { abortSignal }) => loadWorkspaceState(nextSource, abortSignal),
  });
  const [selectedNoteId, setSelectedNoteId] = createSignal(ctx.selectedNoteId);
  const [optimisticTitles, setOptimisticTitles] = createSignal<ReadonlyMap<string, string>>(new Map());
  const current = createMemo(() => {
    const loaded = workspace.data();
    return loaded?.source === source() ? loaded.state : null;
  });
  const notebook = createMemo(() => current()?.notebook ?? ctx.notebook);
  const noteTree = createMemo(() => applyOptimisticTitles(current()?.tree ?? ctx.tree, optimisticTitles()));
  const favoriteNoteIds = createMemo(() => new Set(current()?.favoriteNoteIds ?? ctx.favoriteNoteIds));
  const tags = createMemo(() => current()?.tags ?? ctx.tags);
  const attachmentCount = createMemo(() => current()?.attachmentCount ?? ctx.attachmentCount);

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
      const coverage = workspace.invalidate({ cursor: detail.cursor });
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
      if (detail?.noteId) setSelectedNoteId(detail.noteId);
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
    noteTree,
    favoriteNoteIds,
    selectedNoteId,
    tags,
    attachmentCount,
    workspaceError: workspace.error,
    workspaceRefreshing: workspace.refreshing,
    refreshWorkspace: workspace.refresh,
  };
}
