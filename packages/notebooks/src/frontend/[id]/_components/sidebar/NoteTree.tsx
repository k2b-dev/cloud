import { navigateTo, refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  AppWorkspace,
  type AppWorkspaceNavTreeMove,
  Button,
  type DropdownAction,
  type DropdownItem,
  Placeholder,
  prompts,
  Select,
  toast,
  useLocale,
} from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { isHandOrdered } from "../../../../lib/note-order";
import type { PresentationMode } from "../../../../lib/presentation-mode";
import type { SidebarNote } from "../../../../lib/sidebar-tree";
import { navigateToNotebookNote } from "../../../lib/soft-navigation";
import { buildNoteUrl } from "../../../params";
import { notebookWorkspaceMessages } from "../../messages";
import { useDuplicateNote } from "../detail/duplicate-note";
import { readErrorMessage } from "../settings/utils";
import { NoteRowLabel, NoteRowMenu, NoteRowsContextMenu } from "./note-rows";
import type { SidebarTree } from "./sidebar-tree";

type Props = {
  tree: SidebarTree;
  /** The title on screen, which may run ahead of the saved one while someone types. */
  titleOf: (note: SidebarNote) => string;
  /** Notebook short-id (6 readable characters). Used both for URL building
   *  (`buildNoteUrl`, etc.) and for API path params — the API resolves
   *  short-ids to UUIDs at the boundary, so islands never need both
   *  forms. Same convention applies to `noteId` references below. */
  notebookId: string;
  selectedNoteId: string | null;
  presentationMode?: PresentationMode;
  /** The notebook's homepage, shown with a home icon instead of the note icon. */
  homepageId?: string | null;
  /** Lets writers rearrange the notes on screen; the tree reports the requested place. */
  onMove?: (move: AppWorkspaceNavTreeMove) => void;
  /** A note's menu, from its ⋯ button, a right-click, the Context Menu key or Shift+F10. */
  noteMenu?: (node: SidebarNote, level: SidebarNote[]) => DropdownItem[];
};

/**
 * A new place among the siblings on screen: the level the person saw and a neighbour in it. Naming the
 * level makes the server refuse a neighbour that has left it instead of moving the note after it.
 */
export type NotePlacement = { parentId: string | null } & ({ before: string } | { after: string });

/** Where a note sits in the notebook order on screen; absent where another order is shown. */
export type NoteOrderContext = {
  /** The note's level as displayed, the pinned homepage first. */
  level: SidebarNote[];
  /** The note's own sub-notes as far as they are loaded; their order offers "Sort alphabetically". */
  children?: SidebarNote[];
  homepageId: string | null;
};

/** The place between two neighbours: before the next one, or after the last one. */
const placementBetween = (
  parentId: string | null,
  after: SidebarNote | undefined,
  before: SidebarNote | undefined,
): NotePlacement | null => (before ? { parentId, before: before.id } : after ? { parentId, after: after.id } : null);

export const placementForMove = (move: AppWorkspaceNavTreeMove): NotePlacement | null =>
  move.beforeId
    ? { parentId: move.parentId, before: move.beforeId }
    : move.afterId
      ? { parentId: move.parentId, after: move.afterId }
      : null;

// =============================================================================
// Note Actions
// =============================================================================

export function useNoteActions(
  notebookId: string,
  options: { onOrderChanged?: () => void; findNote?: (id: string) => SidebarNote | undefined } = {},
) {
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
    onError: (err) => toast.error(err.message),
  });

  const moveNoteMut = mutations.create({
    // Without a place the note joins the end of a level arranged by hand, or the title order.
    mutation: async (data: { noteId: string; parentId: string | null }) => {
      const res = await apiClient[":id"].notes[":noteId"].move.$post({
        param: { id: notebookId, noteId: data.noteId },
        json: { parentId: data.parentId },
      });
      if (!res.ok) throw new Error(await readErrorMessage(res, t().failedMoveNote));
      return res.json();
    },
    onSuccess: () => refreshCurrentPath(),
    onError: (err) => toast.error(err.message),
  });

  const placeNoteMut = mutations.create<unknown, { noteId: string; placement: NotePlacement }>({
    mutation: async (data: { noteId: string; placement: NotePlacement }) => {
      const res = await apiClient[":id"].notes[":noteId"].move.$post({
        param: { id: notebookId, noteId: data.noteId },
        json: data.placement,
      });
      // The note or its neighbour left the level on screen; nothing moved.
      if (res.status === 400 || res.status === 404 || res.status === 409) throw new Error(t().noteOrderChanged);
      if (!res.ok) throw new Error(await readErrorMessage(res, t().failedMoveNote));
      return res.json();
    },
    onSuccess: () => options.onOrderChanged?.(),
    // Either way the tree shows the current order again.
    onError: (err) => {
      toast.error(err.message);
      options.onOrderChanged?.();
    },
  });

  const sortAlphabeticallyMut = mutations.create<unknown, string | null>({
    mutation: async (parentId: string | null) => {
      const res = await apiClient[":id"]["note-order"].reset.$post({ param: { id: notebookId }, json: { parentId } });
      if (!res.ok) throw new Error(await readErrorMessage(res, t().failedSortNotes));
      return res.json();
    },
    onSuccess: () => options.onOrderChanged?.(),
    onError: (err) => toast.error(err.message),
  });

  const duplicateNote = useDuplicateNote(notebookId);

  const deleteNoteMut = mutations.create({
    mutation: async (noteId: string) => {
      const res = await apiClient[":id"].notes[":noteId"].$delete({
        param: { id: notebookId, noteId },
      });
      if (!res.ok) throw new Error(await readErrorMessage(res, t().failedDeleteNote));
    },
    onSuccess: () => {
      navigateTo(`/app/notebooks/${notebookId}`);
    },
    onError: (err) => toast.error(err.message),
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

  /** Notes to move a note under, by title: the top level first, a search across the notebook as the person types. */
  const loadMoveTargets = async (node: SidebarNote, query: string, signal: AbortSignal) => {
    const root = { value: "", label: t().rootLevel, icon: "ti ti-home" };
    const res = query.trim()
      ? await apiClient[":id"].notes.$get({ param: { id: notebookId }, query: { q: query.trim(), per_page: "20" } }, { init: { signal } })
      : await apiClient[":id"].tree.levels.$get({ param: { id: notebookId }, query: { levels: ":0:20" } }, { init: { signal } });
    if (!res.ok) throw new Error(t().failedLoadNotes);
    const payload = (await res.json()) as { data?: Array<{ id: string; title: string }>; levels?: Array<{ items: SidebarNote[] }> };
    const notes = payload.data ?? payload.levels?.[0]?.items ?? [];
    return [
      ...(query.trim() ? [] : [root]),
      ...notes
        .filter((note) => note.id !== node.id)
        .map((note) => ({ value: note.id, label: note.title || t().untitled, description: `#${note.id}`, icon: "ti ti-file-text" })),
    ];
  };

  const handleMove = async (node: SidebarNote) => {
    const result = await prompts.dialog<{ parentId: string | null }>(
      (close) => {
        const [selected, setSelected] = createSignal<string | null>(node.parentId ?? "");
        const parent = node.parentId ? options.findNote?.(node.parentId) : undefined;
        return (
          <div class="flex flex-col gap-3">
            <p class="text-sm text-secondary">{t().moveTo({ title: node.title || t().untitled })}</p>
            <Select
              label={t().moveTarget}
              value={selected}
              onValueChange={setSelected}
              selectedLabel={() => (node.parentId ? (parent?.title ?? `#${node.parentId}`) : t().rootLevel)}
              loadOptions={(query, signal) => loadMoveTargets(node, query, signal)}
              searchPlaceholder={t().searchMoveTarget}
              placeholder={t().searchMoveTarget}
            />
            <div class="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => close(undefined)}>
                {t().cancel}
              </Button>
              <Button
                onClick={() => close({ parentId: selected() || null })}
                disabled={selected() === null || (selected() || null) === node.parentId}
              >
                {t().move}
              </Button>
            </div>
          </div>
        );
      },
      { title: t().moveNote, icon: "ti ti-arrow-move-right" },
    );

    if (result) {
      moveNoteMut.mutate({ noteId: node.id, parentId: result.parentId });
    }
  };

  const handleCopy = (node: SidebarNote) => duplicateNote.duplicate(node.id);

  const handleDelete = async (node: SidebarNote) => {
    const hasKids = node.hasChildren;
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

  const handleLock = async (node: SidebarNote) => {
    const confirmed = await prompts.confirm(t().lockConfirm({ title: node.title }), {
      title: t().lockNote,
      icon: "ti ti-lock",
      variant: "danger",
      confirmText: t().lockPermanently,
    });
    if (confirmed) {
      lockNoteMut.mutate(node.id);
    }
  };

  const handlePlace = (noteId: string, placement: NotePlacement | null) => {
    if (placement) void placeNoteMut.mutate({ noteId, placement });
  };
  const handleSortAlphabetically = (parentId: string | null) => {
    void sortAlphabeticallyMut.mutate(parentId);
  };

  return {
    handleCreateNote,
    handleMove,
    handlePlace,
    handleSortAlphabetically,
    handleCopy,
    handleDelete,
    handleLock,
    loading: () =>
      createNoteMut.loading() ||
      moveNoteMut.loading() ||
      placeNoteMut.loading() ||
      sortAlphabeticallyMut.loading() ||
      duplicateNote.loading() ||
      deleteNoteMut.loading() ||
      lockNoteMut.loading(),
  };
}

/** Move up and down, plus the way back to the title order where a level was arranged by hand. */
const noteOrderItems = (
  node: SidebarNote,
  actions: ReturnType<typeof useNoteActions>,
  t: ReturnType<(typeof notebookWorkspaceMessages)["resolve"]>["t"],
  order: NoteOrderContext,
): DropdownAction[] => {
  const { level, homepageId } = order;
  const index = level.findIndex((sibling) => sibling.id === node.id);
  // The homepage leads its level, so it keeps that place and nothing moves above it.
  const up =
    index > 0 && node.id !== homepageId && level[index - 1]!.id !== homepageId
      ? placementBetween(node.parentId, level[index - 2], level[index - 1])
      : null;
  const down = index >= 0 && node.id !== homepageId ? placementBetween(node.parentId, level[index + 1], level[index + 2]) : null;
  return [
    { icon: "ti ti-arrow-up", label: t.moveUp, disabled: !up, action: () => actions.handlePlace(node.id, up) },
    { icon: "ti ti-arrow-down", label: t.moveDown, disabled: !down, action: () => actions.handlePlace(node.id, down) },
    ...(order.children && isHandOrdered(order.children)
      ? [{ icon: "ti ti-sort-a-z", label: t.sortSubnotesAlphabetically, action: () => actions.handleSortAlphabetically(node.id) }]
      : []),
    ...(node.parentId === null && isHandOrdered(level)
      ? [{ icon: "ti ti-sort-a-z", label: t.sortTopLevelAlphabetically, action: () => actions.handleSortAlphabetically(null) }]
      : []),
  ];
};

export const noteActionItems = (
  node: SidebarNote,
  actions: ReturnType<typeof useNoteActions>,
  t: ReturnType<(typeof notebookWorkspaceMessages)["resolve"]>["t"],
  canDeleteOrLock: boolean,
  order?: NoteOrderContext,
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
      ...(order ? noteOrderItems(node, actions, t, order) : []),
      {
        icon: "ti ti-copy",
        label: t.duplicate,
        action: () => actions.handleCopy(node),
      },
    ],
  },
  ...(node.lockedAt
    ? []
    : ([
        {
          sectionLabel: t.security,
          items: [
            canDeleteOrLock
              ? { icon: "ti ti-lock", label: t.lockNote, variant: "danger", action: () => actions.handleLock(node) }
              : { icon: "ti ti-lock", label: t.lockNote, description: t.lockAdminOnly, disabled: true },
          ],
        },
      ] satisfies DropdownItem[])),
  {
    sectionLabel: "",
    items: [
      canDeleteOrLock
        ? { icon: "ti ti-trash", label: t.delete, variant: "danger", action: () => actions.handleDelete(node) }
        : { icon: "ti ti-trash", label: t.delete, description: t.deleteAdminOnly, disabled: true },
    ],
  },
];

/** Moves focus to a row that just loaded, so keyboard and screen reader users continue where the new notes begin. */
export const focusTreeRow = (id: string | undefined) => {
  if (!id) return;
  queueMicrotask(() =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-k2b-nav-tree-id]"))
      .find((row) => row.dataset.k2bNavTreeId === id)
      ?.focus(),
  );
};

/** Notes with sub-notes get the stacked icon, so a branch reads as one before it is opened. */
export const noteIcon = (node: SidebarNote, homepageId: string | null | undefined): string =>
  node.id === homepageId ? "ti ti-home" : node.hasChildren ? "ti ti-files" : "ti ti-file-text";

/**
 * One level of the tree as far as it is loaded: its rows, a row that loads earlier ones above them, and one that
 * loads more below. An open branch that has not loaded yet says so in its place.
 */
function NoteTreeLevel(props: {
  parentId: string | null;
  tree: SidebarTree;
  titleOf: (note: SidebarNote) => string;
  notebookId: string;
  presentationMode?: PresentationMode;
  homepageId: string | null;
  movable: boolean;
  noteMenu?: (node: SidebarNote, level: SidebarNote[]) => DropdownItem[];
}) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const level = () => props.tree.level(props.parentId);
  const items = () => level()?.items ?? [];
  const key = () => props.parentId ?? "";
  const earlier = () => level()?.offset ?? 0;
  const later = () => {
    const loaded = level();
    return loaded ? loaded.total - loaded.offset - loaded.items.length : 0;
  };
  return (
    <Show
      when={level()}
      fallback={<AppWorkspace.NavTree.Item id={`loading:${key()}`} label={t().loadingNotes} icon="ti ti-loader-2 animate-spin" disabled />}
    >
      <Show when={earlier() > 0}>
        <AppWorkspace.NavTree.Item
          id={`earlier:${key()}`}
          label={t().earlierNotes({ count: earlier() })}
          icon={props.tree.isPending(props.parentId) ? "ti ti-loader-2 animate-spin" : "ti ti-chevrons-up"}
          class="notebook-tree-more"
          onSelect={() => {
            const shown = items().length;
            void props.tree
              .showEarlier(props.parentId)
              .then(() => focusTreeRow(items()[items().length - shown - 1]?.id))
              .catch(() => undefined);
          }}
        />
      </Show>
      <For each={items()}>
        {(node) => (
          <AppWorkspace.NavTree.Item
            id={node.id}
            label={<NoteRowLabel note={node} title={props.titleOf(node)} />}
            icon={noteIcon(node, props.homepageId)}
            iconLabel={node.id === props.homepageId ? t().homepage : undefined}
            href={buildNoteUrl(props.notebookId, node.id, props.presentationMode)}
            navigation="document"
            movable={props.movable && node.id !== props.homepageId}
            hasChildren={node.hasChildren}
            actions={props.noteMenu ? <NoteRowMenu note={node} items={props.noteMenu(node, items())} /> : undefined}
          >
            <Show when={node.hasChildren && props.tree.isExpanded(node.id)}>
              <NoteTreeLevel {...props} parentId={node.id} />
            </Show>
          </AppWorkspace.NavTree.Item>
        )}
      </For>
      <Show when={later() > 0}>
        <AppWorkspace.NavTree.Item
          id={`more:${key()}`}
          label={t().moreNotes({ count: later() })}
          icon={props.tree.isPending(props.parentId) ? "ti ti-loader-2 animate-spin" : "ti ti-chevrons-down"}
          class="notebook-tree-more"
          onSelect={() => {
            const shown = items().length;
            void props.tree
              .showMore(props.parentId)
              .then(() => focusTreeRow(items()[shown]?.id))
              .catch(() => undefined);
          }}
        />
      </Show>
    </Show>
  );
}

// =============================================================================
// Main Component
// =============================================================================

export default function NoteTree(props: Props) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const contextMenu = (id: string) => {
    const node = props.tree.findNote(id);
    return node && props.noteMenu ? props.noteMenu(node, props.tree.level(node.parentId)?.items ?? [node]) : [];
  };

  // An empty notebook shows one line where the first note would be, not a stretched empty tree.
  return (
    <Show
      when={(props.tree.level(null)?.total ?? 0) > 0}
      fallback={<Placeholder variant="inline" align="left" icon="ti ti-file-text" description={t().noNotes} />}
    >
      <NoteRowsContextMenu menu={contextMenu}>
        <AppWorkspace.NavTree
          ariaLabel={t().notes}
          selectedId={props.selectedNoteId}
          expandedIds={props.tree.expandedIds()}
          onExpandedIdsChange={(ids) => {
            const next = new Set(ids);
            const current = new Set(props.tree.expandedIds());
            for (const id of next) if (!current.has(id)) props.tree.setOpen(id, true);
            for (const id of current) if (!next.has(id)) props.tree.setOpen(id, false);
          }}
          onMove={props.onMove}
        >
          <NoteTreeLevel
            parentId={null}
            tree={props.tree}
            titleOf={props.titleOf}
            notebookId={props.notebookId}
            presentationMode={props.presentationMode}
            homepageId={props.homepageId ?? null}
            movable={Boolean(props.onMove)}
            noteMenu={props.noteMenu}
          />
        </AppWorkspace.NavTree>
      </NoteRowsContextMenu>
    </Show>
  );
}
