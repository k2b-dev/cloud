import { navigateTo, refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { AppWorkspace, Button, Dropdown, type DropdownItem, IconButton, Placeholder, prompts, useLocale } from "@k2b/ui";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { navigateToNotebookNote } from "../../../lib/soft-navigation";
import { buildNoteUrl } from "../../../params";
import type { PresentationMode } from "../../../../lib/presentation-mode";
import { NOTE_SOFT_NAVIGATED_EVENT } from "../detail/events";
import SearchButton from "../search/SearchButton";
import { listAccessibleNotebooks } from "./notebooks";
import { flattenTree, getNodeDepthLabel } from "./tree-utils";
import type { Notebook, NoteTreeNode } from "./types";
import { useFavoriteNotes } from "./useFavoriteNotes";
import { notebookWorkspaceMessages } from "../../messages";

type Props = {
  tree: NoteTreeNode[];
  /** Notebook short-id (6 readable characters). Used both for URL building
   *  (`buildNoteUrl`, etc.) and for API path params — the API resolves
   *  short-ids to UUIDs at the boundary, so islands never need both
   *  forms. Same convention applies to `noteId` references below. */
  notebookId: string;
  notebookName: string;
  selectedNoteId: string | null;
  canWrite?: boolean;
  showSearch?: boolean;
  showHeaderActions?: boolean;
  favoriteNoteIds?: string[];
  presentationMode?: PresentationMode;
};

// =============================================================================
// Note Actions
// =============================================================================

export function useNoteActions(notebookId: string, tree: () => NoteTreeNode[]) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const createNoteMut = mutations.create<{ id: string }, { parentId?: string }>({
    mutation: async (data: { parentId?: string }) => {
      const res = await apiClient[":id"].notes.$post({
        param: { id: notebookId },
        json: data,
      });
      if (!res.ok) throw new Error(t().failedCreateNote);
      return (await res.json()) as { id: string };
    },
    onSuccess: (data) => {
      void navigateToNotebookNote(buildNoteUrl(notebookId, data.id), { selectInitialTitle: data.id });
    },
    onError: (err) => prompts.error(err.message),
  });

  const moveNoteMut = mutations.create({
    mutation: async (data: { noteId: string; parentId: string | null; position: number }) => {
      const res = await apiClient[":id"].notes[":noteId"].move.$post({
        param: { id: notebookId, noteId: data.noteId },
        json: { parentId: data.parentId, position: data.position },
      });
      if (!res.ok) throw new Error(t().failedMoveNote);
      return res.json();
    },
    onSuccess: () => refreshCurrentPath(),
    onError: (err) => prompts.error(err.message),
  });

  const copyNoteMut = mutations.create<
    { id: string; notebookId: string },
    { noteId: string; targetNotebookId: string; targetParentId?: string | null }
  >({
    mutation: async (data: { noteId: string; targetNotebookId: string; targetParentId?: string | null }) => {
      const res = await apiClient[":id"].notes[":noteId"].copy.$post({
        param: { id: notebookId, noteId: data.noteId },
        json: {
          targetNotebookId: data.targetNotebookId,
          targetParentId: data.targetParentId,
        },
      });
      if (!res.ok) throw new Error(t().failedDuplicateNote);
      return (await res.json()) as { id: string; notebookId: string };
    },
    onSuccess: (data) => {
      void navigateToNotebookNote(buildNoteUrl(data.notebookId, data.id));
    },
    onError: (err) => prompts.error(err.message),
  });

  const deleteNoteMut = mutations.create({
    mutation: async (noteId: string) => {
      const res = await apiClient[":id"].notes[":noteId"].$delete({
        param: { id: notebookId, noteId },
      });
      if (!res.ok) throw new Error(t().failedDeleteNote);
    },
    onSuccess: () => {
      navigateTo(`/app/notebooks/${notebookId}`);
    },
    onError: (err) => prompts.error(err.message),
  });

  const lockNoteMut = mutations.create<unknown, string>({
    mutation: async (noteId: string) => {
      const res = await apiClient[":id"].notes[":noteId"].lock.$post({
        param: { id: notebookId, noteId },
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message ?? t().failedLockNote);
      }
      return res.json();
    },
    onSuccess: () => refreshCurrentPath(),
    onError: (err) => prompts.error(err.message),
  });

  const handleCreateNote = (parentId?: string) => createNoteMut.mutate({ parentId });

  const handleMove = async (node: NoteTreeNode) => {
    const allFlat = flattenTree(tree(), node.id);

    const result = await prompts.dialog<{ parentId: string | null }>(
      (close) => {
        const [selected, setSelected] = createSignal<string | null>(node.parentId);

        return (
          <div class="flex flex-col gap-2">
            <p class="text-sm text-secondary">
              {t().moveTo({ title: node.title })}
            </p>

            <div class="flex flex-col gap-1 max-h-64 overflow-y-auto">
              {/* Root level option */}
              <Button
                variant={selected() === null ? "subtle" : "ghost"}
                size="sm"
                onClick={() => setSelected(null)}
                class="w-full justify-start text-left"
              >
                <i class="ti ti-home text-xs mr-1.5" />
                {t().rootLevel}
              </Button>

              <For each={allFlat}>
                {(target) => (
                  <Button
                    variant={selected() === target.id ? "subtle" : "ghost"}
                    size="sm"
                    onClick={() => setSelected(target.id)}
                    class="w-full justify-start text-left"
                  >
                    <i class="ti ti-file-text text-xs mr-1.5" />
                    {getNodeDepthLabel(target, allFlat)}
                  </Button>
                )}
              </For>
            </div>

            <div class="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => close(undefined)}>
                {t().cancel}
              </Button>
              <Button onClick={() => close({ parentId: selected() })} disabled={selected() === node.parentId}>
                {t().move}
              </Button>
            </div>
          </div>
        );
      },
      { title: t().moveNote, icon: "ti ti-arrow-move-right" },
    );

    if (result) {
      moveNoteMut.mutate({
        noteId: node.id,
        parentId: result.parentId,
        position: 0,
      });
    }
  };

  const handleCopy = async (node: NoteTreeNode) => {
    let allNotebooks: Notebook[] = [];
    try {
      allNotebooks = await listAccessibleNotebooks();
    } catch (error) {
      prompts.error(error instanceof Error ? error.message : t().failedLoadNotebooks);
      return;
    }

    if (allNotebooks.length === 0) {
      await prompts.error(t().noNotebooks);
      return;
    }

    const result = await prompts.form({
      title: t().duplicateNote,
      icon: "ti ti-copy",
      fields: {
        targetNotebookId: {
          type: "select" as const,
          label: t().targetNotebook,
          required: true,
          default: notebookId,
          options: allNotebooks.map((nb) => ({
            id: nb.id,
            label: nb.name,
            icon: `ti ${nb.icon || "ti-notebook"}`,
          })),
        },
      },
    });

    if (result) {
      copyNoteMut.mutate({
        noteId: node.id,
        targetNotebookId: result.targetNotebookId,
      });
    }
  };

  const handleDelete = async (node: NoteTreeNode) => {
    const hasKids = node.children.length > 0;
    const confirmed = await prompts.confirm(
      hasKids ? t().deleteNoteTreeConfirm({ title: node.title }) : t().deleteNoteConfirm({ title: node.title }),
      {
        title: t().deleteNote,
        icon: "ti ti-trash",
        variant: "danger",
        confirmText: t().delete,
      },
    );
    if (confirmed) {
      deleteNoteMut.mutate(node.id);
    }
  };

  const handleLock = async (node: NoteTreeNode) => {
    const confirmed = await prompts.confirm(
      t().lockConfirm({ title: node.title }),
      {
        title: t().lockNote,
        icon: "ti ti-lock",
        variant: "danger",
        confirmText: t().lockPermanently,
      },
    );
    if (confirmed) {
      lockNoteMut.mutate(node.id);
    }
  };

  return {
    handleCreateNote,
    handleMove,
    handleCopy,
    handleDelete,
    handleLock,
    loading: () =>
      createNoteMut.loading() || moveNoteMut.loading() || copyNoteMut.loading() || deleteNoteMut.loading() || lockNoteMut.loading(),
  };
}

export const noteActionItems = (
  node: NoteTreeNode,
  actions: ReturnType<typeof useNoteActions>,
  t: ReturnType<(typeof notebookWorkspaceMessages)["resolve"]>["t"],
): DropdownItem[] => [
  {
    icon: "ti ti-file-plus",
    label: t.newSubnote,
    action: () => actions.handleCreateNote(node.id),
  },
  {
    sectionLabel: t.manage,
    items: [
      ...(node.lockedAt
        ? []
        : [
            {
              icon: "ti ti-arrow-move-right",
              label: t.move,
              action: () => actions.handleMove(node),
            },
          ]),
      {
        icon: "ti ti-copy",
        label: t.duplicate,
        action: () => actions.handleCopy(node),
      },
    ],
  },
  ...(node.lockedAt
    ? []
    : [
        {
          sectionLabel: t.security,
          items: [
            {
              icon: "ti ti-lock",
              label: t.lockNote,
              variant: "danger" as const,
              action: () => actions.handleLock(node),
            },
          ],
        },
      ]),
  {
    sectionLabel: "",
    items: [
      {
        icon: "ti ti-trash",
        label: t.delete,
        variant: "danger",
        action: () => actions.handleDelete(node),
      },
    ],
  },
];

function NoteTreeItems(props: {
  nodes: NoteTreeNode[];
  notebookId: string;
  presentationMode?: PresentationMode;
  canWrite: boolean;
  actions: ReturnType<typeof useNoteActions>;
  favoriteNoteIds?: () => Set<string>;
  onToggleFavorite?: (node: NoteTreeNode, event: MouseEvent) => void;
}) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  return (
    <For each={props.nodes}>
      {(node) => {
        const favorite = () => props.favoriteNoteIds?.().has(node.id) ?? false;
        const label = () => node.title || t().untitled;
        return (
          <AppWorkspace.NavTree.Item
            id={node.id}
            label={
              <span class="flex min-w-0 items-center gap-1.5">
                <span class="truncate">{label()}</span>
                <Show when={node.lockedAt}>
                  <i class="ti ti-lock shrink-0 text-xs text-amber-500" title={t().locked} />
                </Show>
              </span>
            }
            icon="ti ti-file-text"
            href={buildNoteUrl(props.notebookId, node.id, props.presentationMode)}
            navigation="document"
            actions={
              props.onToggleFavorite || props.canWrite ? (
                <>
                  <Show when={props.onToggleFavorite}>
                    {(toggleFavorite) => (
                      <AppWorkspace.SidebarItemActions visibility={favorite() ? "always" : "hover"}>
                        <IconButton
                          label={favorite() ? t().removeFavorite : t().addFavorite}
                          size="xs"
                          class={favorite() ? "!text-amber-500 hover:!text-amber-500" : undefined}
                          title={favorite() ? t().removeFavorite : t().addFavorite}
                          onClick={(event) => toggleFavorite()(node, event)}
                        >
                          <i class="ti ti-star text-xs" />
                        </IconButton>
                      </AppWorkspace.SidebarItemActions>
                    )}
                  </Show>
                  <Show when={props.canWrite}>
                    <AppWorkspace.SidebarItemActions visibility="hover">
                      <Dropdown.Root position="bottom-right" width="12rem" items={noteActionItems(node, props.actions, t())}>
                        <Dropdown.Trigger iconOnly label={t().noteActions({ title: label() })} size="xs">
                          <i class="ti ti-dots text-xs" />
                        </Dropdown.Trigger>
                      </Dropdown.Root>
                    </AppWorkspace.SidebarItemActions>
                  </Show>
                </>
              ) : undefined
            }
          >
            <NoteTreeItems
              nodes={node.children}
              notebookId={props.notebookId}
              presentationMode={props.presentationMode}
              canWrite={props.canWrite}
              actions={props.actions}
              favoriteNoteIds={props.favoriteNoteIds}
              onToggleFavorite={props.onToggleFavorite}
            />
          </AppWorkspace.NavTree.Item>
        );
      }}
    </For>
  );
}

// =============================================================================
// Main Component
// =============================================================================

export default function NoteTree(props: Props) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const actions = useNoteActions(props.notebookId, () => props.tree);
  const showHeaderActions = () => props.showHeaderActions ?? true;
  const [selectedNoteId, setSelectedNoteId] = createSignal(props.selectedNoteId);
  const { favoriteNoteIds, toggleFavorite } = useFavoriteNotes({
    notebookId: props.notebookId,
    initialFavoriteNoteIds: () => props.favoriteNoteIds ?? [],
  });

  onMount(() => {
    const onSoftNavigated = (event: Event) => {
      const detail = (event as CustomEvent<{ noteId?: string }>).detail;
      if (!detail?.noteId) return;
      setSelectedNoteId(detail.noteId);
    };
    window.addEventListener(NOTE_SOFT_NAVIGATED_EVENT, onSoftNavigated);
    onCleanup(() => window.removeEventListener(NOTE_SOFT_NAVIGATED_EVENT, onSoftNavigated));
  });

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      {/* Header with search + add buttons */}
      <Show when={showHeaderActions()}>
        <div class="flex items-center justify-between px-2 py-1">
          <span class="section-label mb-0">{t().notes}</span>
          <div class="flex items-center gap-1">
            <Show when={props.showSearch}>
              <SearchButton notebookId={props.notebookId} notebookName={props.notebookName} variant="compact" />
            </Show>
            <Show when={props.canWrite}>
              <IconButton
                label={t().newNote}
                size="xs"
                onClick={() => actions.handleCreateNote()}
                disabled={actions.loading()}
                loading={actions.loading()}
                loadingLabel={t().creatingNote}
                title={`${t().newNote} (Mod+Alt+N)`}
              >
                <i class="ti ti-plus text-xs" />
              </IconButton>
            </Show>
          </div>
        </div>
      </Show>

      <div class="min-h-0 flex-1">
        <AppWorkspace.NavTree
          ariaLabel={t().notes}
          selectedId={selectedNoteId()}
          defaultExpandedIds={flattenTree(props.tree)
            .filter((node) => node.children.length > 0)
            .map((node) => node.id)}
        >
          <NoteTreeItems
            nodes={props.tree}
            notebookId={props.notebookId}
            presentationMode={props.presentationMode}
            canWrite={props.canWrite ?? false}
            actions={actions}
            favoriteNoteIds={favoriteNoteIds}
            onToggleFavorite={toggleFavorite}
          />
        </AppWorkspace.NavTree>
      </div>

      {props.tree.length === 0 && <Placeholder icon="ti ti-file-text" class="py-4" description={t().noNotes} />}
    </div>
  );
}
