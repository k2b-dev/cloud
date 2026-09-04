import { type DateContext, dates, searchParams } from "@k2b/stdlib";
import { AppWorkspace, Dropdown, IconButton, Placeholder, prompts, ScrollArea, SelectChip, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { type NavigatorQuery, parseNavigatorQuery, withNavigatorQuery } from "../../../../lib/navigator-url";
import type { PresentationMode } from "../../../../lib/presentation-mode";
import { navigateToNotebookNote } from "../../../lib/soft-navigation";
import { buildAttachmentsUrl, buildNoteUrl } from "../../../params";
import { NOTE_SOFT_NAVIGATED_EVENT } from "../detail/events";
import SearchButton from "../search/SearchButton";
import NotebookSettingsButton from "../settings/NotebookSettingsButton";
import { type NotebookSettings, writeSettings } from "../settings/NotebookSettingsStore";
import { noteActionItems, useNoteActions } from "./NoteTree";
import { flattenTree } from "./tree-utils";
import type { Notebook, NoteTreeNode, TagSummary } from "./types";
import { useFavoriteNotes } from "./useFavoriteNotes";
import { notebookWorkspaceMessages } from "../../messages";

type SortMode = NotebookSettings["navigatorSort"];
type TreeMode = "deep" | "level";
type RootMode = "favorites" | "recents";

type Props = {
  notebook: Notebook;
  tree: NoteTreeNode[];
  selectedNoteId: string | null;
  permission: string;
  canWrite: boolean;
  favoriteNoteIds: string[];
  tags: TagSummary[];
  initialSortMode: SortMode;
  dateConfig: DateContext;
  initialQuery: NavigatorQuery;
  mode?: "roots" | "list";
  presentationMode?: PresentationMode;
};

type Selection =
  | { root: "favorites" }
  | { root: "recents" }
  | { root: "notes"; noteId: string | null }
  | { root: "tags"; tag: string | null };

const noteCardClass = (active: boolean) =>
  `group relative rounded-[var(--ui-radius-surface)] border border-[var(--ui-border)] bg-[var(--ui-surface)] shadow-[var(--ui-shadow-surface)] transition-colors hover:bg-[var(--ui-hover)] ${active ? "bg-[var(--ui-selected)]" : ""}`;

const directChildren = (nodes: NoteTreeNode[], parentId: string | null): NoteTreeNode[] => {
  if (!parentId) return nodes;
  for (const node of flattenTree(nodes)) {
    if (node.id === parentId) return node.children;
  }
  return [];
};

const subtree = (nodes: NoteTreeNode[], noteId: string | null): NoteTreeNode[] => {
  if (!noteId) return flattenTree(nodes);
  const start = flattenTree(nodes).find((note) => note.id === noteId);
  return start ? [start, ...flattenTree(start.children)] : [];
};

const branchNodes = (nodes: NoteTreeNode[]): NoteTreeNode[] =>
  nodes.filter((note) => note.children.length > 0).map((note) => ({ ...note, children: branchNodes(note.children) }));

const noteFolderContext = (nodes: NoteTreeNode[], selectedNoteId: string | null): string | null => {
  if (!selectedNoteId) return null;
  const selected = flattenTree(nodes).find((note) => note.id === selectedNoteId);
  if (!selected) return null;
  return selected.children.length > 0 ? selected.id : selected.parentId;
};

const selectionFromQuery = (query: NavigatorQuery, nodes: NoteTreeNode[], selectedNoteId: string | null): Selection => {
  if (query.view === "favorites" || query.view === "recents") return { root: query.view };
  if (query.view === "tag") return { root: "tags", tag: query.tag };
  if (query.view === "folder") {
    const folder = flattenTree(nodes).find((note) => note.id === query.folder);
    if (folder) return { root: "notes", noteId: folder.id };
  }
  return { root: "notes", noteId: noteFolderContext(nodes, selectedNoteId) };
};

const queryFromSelection = (selection: Selection, nodes: NoteTreeNode[]): NavigatorQuery => {
  if (selection.root === "favorites" || selection.root === "recents") return { view: selection.root };
  if (selection.root === "tags" && selection.tag) return { view: "tag", tag: selection.tag };
  if (selection.root === "notes" && selection.noteId) {
    const folder = flattenTree(nodes).find((note) => note.id === selection.noteId);
    if (folder) return { view: "folder", folder: folder.id };
  }
  return {};
};

const tagsFromMarkdown = (md: string | null): string[] => {
  if (!md) return [];
  const tags = new Set<string>();
  for (const match of md.replace(/```[\s\S]*?```/g, "").matchAll(/(?:^|\s)#([a-zA-Z][\w-]*(?:\/[\w-]+)*)/g)) {
    tags.add(match[1]!.toLowerCase());
  }
  return [...tags];
};

const plainPreview = (md: string | null): string => {
  if (!md) return "";
  const text = md
    .replace(/^---[\s\S]*?\n---\n/, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/:::[\s\S]*?:::/g, " ")
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[[^\]]+]\([^)]+\)/g, (value) => value.match(/^\[([^\]]+)]/)?.[1] ?? " ")
    .replace(/[#*_`>\-[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
};

const noteTreeId = (noteId: string) => `note:${noteId}`;
const tagTreeId = (tag: string) => `tag:${tag}`;

const expandedNavigationIds = (nodes: NoteTreeNode[]): string[] => [
  "notes",
  "tags",
  ...flattenTree(nodes)
    .filter((note) => note.children.length > 0)
    .map((note) => noteTreeId(note.id)),
];

const NoteNavigationItems = (props: { nodes: NoteTreeNode[]; onSelect: (id: string) => void }) => {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  return (
    <For each={props.nodes}>
      {(note) => (
        <AppWorkspace.NavTree.Item
          id={noteTreeId(note.id)}
          label={note.title || t().untitled}
          icon="ti ti-folder"
          onSelect={() => props.onSelect(note.id)}
        >
          <NoteNavigationItems nodes={note.children} onSelect={props.onSelect} />
        </AppWorkspace.NavTree.Item>
      )}
    </For>
  );
};

export default function NotebookNavigator(props: Props) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const roots = () => [
    { id: "favorites" as const, label: t().favorites, icon: "ti ti-star" },
    { id: "recents" as const, label: t().recents, icon: "ti ti-clock" },
  ];
  const sortOptions = () => [
    { value: "updated" as const, label: t().updatedSort },
    { value: "created" as const, label: t().createdSort },
    { value: "title" as const, label: t().nameSort },
  ];
  const treeModeOptions = () => [
    { value: "deep" as const, label: t().descendants },
    { value: "level" as const, label: t().children },
  ];
  const [selection, setSelection] = createSignal<Selection>(selectionFromQuery(props.initialQuery, props.tree, props.selectedNoteId));
  const [sortMode, setSortMode] = createSignal<SortMode>(props.initialSortMode);
  const [treeMode, setTreeMode] = createSignal<TreeMode>("deep");
  const [activeNoteId, setActiveNoteId] = createSignal(props.selectedNoteId);
  const actions = useNoteActions(props.notebook.id, () => props.tree);
  const { favoriteNoteIds: favoriteIds, toggleFavorite } = useFavoriteNotes({
    notebookId: props.notebook.id,
    initialFavoriteNoteIds: () => props.favoriteNoteIds,
  });

  const allNotes = createMemo(() => flattenTree(props.tree));
  const notesById = createMemo(() => new Map(allNotes().map((note) => [note.id, note])));
  const branchTree = createMemo(() => branchNodes(props.tree));
  const [expandedTreeIds, setExpandedTreeIds] = createSignal<readonly string[]>(expandedNavigationIds(branchTree()));
  const homepageNote = createMemo(() => (props.notebook.homepageNoteId ? (notesById().get(props.notebook.homepageNoteId) ?? null) : null));
  const selectedRoot = () => selection().root;
  const selectedNoteRootId = () => {
    const current = selection();
    return current.root === "notes" ? current.noteId : null;
  };
  const selectedNavigationId = () => {
    const current = selection();
    if (current.root === "notes") return current.noteId ? noteTreeId(current.noteId) : "notes";
    if (current.root === "tags" && current.tag) return tagTreeId(current.tag);
    return null;
  };
  const attachmentsHref = () => buildAttachmentsUrl(props.notebook.id, props.presentationMode);
  const noteHref = (note: NoteTreeNode) =>
    withNavigatorQuery(buildNoteUrl(props.notebook.id, note.id, props.presentationMode), queryFromSelection(selection(), props.tree));

  const noteTags = (note: NoteTreeNode) => tagsFromMarkdown(note.contentMd);

  const visibleNotes = createMemo(() => {
    const current = selection();
    let notes: NoteTreeNode[] = [];
    if (current.root === "favorites") notes = allNotes().filter((note) => favoriteIds().has(note.id));
    if (current.root === "recents") notes = allNotes();
    if (current.root === "notes") {
      notes = treeMode() === "deep" ? subtree(props.tree, current.noteId) : directChildren(props.tree, current.noteId);
      if (current.noteId) notes = notes.filter((note) => note.id !== current.noteId);
      else if (homepageNote()) notes = notes.filter((note) => note.id !== homepageNote()!.id);
    }
    if (current.root === "tags") {
      const tag = current.tag;
      notes = tag ? allNotes().filter((note) => noteTags(note).includes(tag)) : [];
    }

    return [...notes].sort((left, right) => {
      if (sortMode() === "title") return left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
      const leftDate = sortMode() === "created" ? left.createdAt : left.updatedAt;
      const rightDate = sortMode() === "created" ? right.createdAt : right.updatedAt;
      return rightDate.localeCompare(leftDate) || left.title.localeCompare(right.title);
    });
  });

  const pinnedNote = createMemo(() => {
    const current = selection();
    if (current.root !== "notes") return null;
    if (current.noteId) return notesById().get(current.noteId) ?? null;
    return homepageNote();
  });

  const vt = (key: string) => `notebook-navigator-${props.notebook.id}-${key}`;

  const changeSortMode = (mode: SortMode) => {
    setSortMode(mode);
    writeSettings(props.notebook.id, { navigatorSort: mode });
  };

  const select = (next: Selection, history: "push" | "replace" = "push") => {
    setSelection(next);
    const href = withNavigatorQuery(window.location.pathname + window.location.search, queryFromSelection(next, props.tree));
    if (href === window.location.pathname + window.location.search) return;
    window.history[history === "push" ? "pushState" : "replaceState"]({}, "", href);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  createEffect(() => {
    if (props.selectedNoteId) setActiveNoteId(props.selectedNoteId);
  });

  onMount(() => {
    const onSoftNavigated = (event: Event) => {
      const detail = (event as CustomEvent<{ noteId?: string }>).detail;
      if (!detail?.noteId) return;
      setActiveNoteId(detail.noteId);
      const noteVisibleInCurrentRoot = visibleNotes().some((note) => note.id === detail.noteId) || pinnedNote()?.id === detail.noteId;
      if (!noteVisibleInCurrentRoot) {
        select({ root: "notes", noteId: noteFolderContext(props.tree, detail.noteId) }, "replace");
      }
    };
    const offSearchParams = searchParams.onChange(() => {
      setSelection(selectionFromQuery(parseNavigatorQuery(new URLSearchParams(window.location.search)), props.tree, activeNoteId()));
    });
    window.addEventListener(NOTE_SOFT_NAVIGATED_EVENT, onSoftNavigated);
    onCleanup(() => {
      offSearchParams();
      window.removeEventListener(NOTE_SOFT_NAVIGATED_EVENT, onSoftNavigated);
    });
  });

  const openHomepage = () => {
    const home = homepageNote();
    if (!home) {
      void prompts.alert(t().noHomepageDescription, { title: t().noHomepage, icon: "ti ti-home" });
      return;
    }
    setActiveNoteId(home.id);
    void navigateToNotebookNote(noteHref(home));
  };

  return props.mode !== "list" ? (
    <>
      <AppWorkspace.SidebarBody scrollPreserveKey={`notebooks-navigator-roots-${props.notebook.id}`}>
        <AppWorkspace.SidebarSection>
          <AppWorkspace.SidebarIconGrid columns={2}>
            <For each={roots()}>
              {(root) => (
                <AppWorkspace.SidebarIconAction
                  icon={root.icon}
                  label={root.label}
                  active={selectedRoot() === root.id}
                  onClick={() => select({ root: root.id })}
                />
              )}
            </For>
            <AppWorkspace.SidebarIconAction
              icon="ti ti-home"
              label={t().homepage}
              active={homepageNote()?.id === activeNoteId()}
              onClick={openHomepage}
            />
            <SearchButton notebookId={props.notebook.id} notebookName={props.notebook.name} variant="workspace-icon" />
          </AppWorkspace.SidebarIconGrid>
        </AppWorkspace.SidebarSection>

        <AppWorkspace.SidebarSection>
          <AppWorkspace.NavTree
            ariaLabel={t().foldersAndTags}
            selectedId={selectedNavigationId()}
            expandedIds={expandedTreeIds()}
            onExpandedIdsChange={setExpandedTreeIds}
          >
            <AppWorkspace.NavTree.Item
              id="notes"
              label={t().allNotes}
              icon="ti ti-folder"
              onSelect={() => select({ root: "notes", noteId: null })}
            >
              <NoteNavigationItems nodes={branchTree()} onSelect={(noteId) => select({ root: "notes", noteId })} />
            </AppWorkspace.NavTree.Item>
            <AppWorkspace.NavTree.Item id="tags" label={t().tags} icon="ti ti-tags">
              <For each={props.tags}>
                {(tag) => (
                  <AppWorkspace.NavTree.Item
                    id={tagTreeId(tag.tag)}
                    label={`#${tag.tag}`}
                    icon="ti ti-tag"
                    meta={tag.count}
                    onSelect={() => select({ root: "tags", tag: tag.tag })}
                  />
                )}
              </For>
            </AppWorkspace.NavTree.Item>
          </AppWorkspace.NavTree>
        </AppWorkspace.SidebarSection>
      </AppWorkspace.SidebarBody>

      <AppWorkspace.SidebarFooter>
        <AppWorkspace.SidebarItem href="/app/notebooks" icon="ti ti-library" navigation="document">
          {t().allNotebooks}
        </AppWorkspace.SidebarItem>
        <AppWorkspace.SidebarItem href={attachmentsHref()} icon="ti ti-paperclip" navigation="document">
          {t().attachments}
        </AppWorkspace.SidebarItem>
        <NotebookSettingsButton
          notebook={props.notebook}
          tree={props.tree}
          permission={props.permission}
          dateConfig={props.dateConfig}
          viewTransitionName={vt("settings-desktop")}
        />
      </AppWorkspace.SidebarFooter>
    </>
  ) : (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <div class="flex min-w-0 shrink-0 items-center gap-2 pb-2">
        <SelectChip class="min-w-0" value={treeMode()} options={treeModeOptions()} onValueChange={setTreeMode} icon="ti ti-list-tree" />
        <SelectChip
          class="min-w-0"
          value={sortMode()}
          options={sortOptions()}
          onValueChange={changeSortMode}
          icon="ti ti-sort-descending"
        />
        <Show when={props.canWrite}>
          <IconButton
            class="ml-auto shrink-0 text-green-600 dark:text-green-400"
            label={t().newNote}
            onClick={() => actions.handleCreateNote()}
          >
            <i class="ti ti-plus" />
          </IconButton>
        </Show>
      </div>

      <ScrollArea class="flex-1" scrollPreserveKey={`notebooks-navigator-list-${props.notebook.id}`}>
        <Show
          when={visibleNotes().length > 0 || pinnedNote()}
          fallback={<Placeholder surface="paper" align="left" description={t().noNotesHere} />}
        >
          <div class="flex flex-col gap-2">
            <Show when={pinnedNote()}>
              {(note) => {
                const active = () => note().id === activeNoteId();
                return (
                  <div class={noteCardClass(active())} style={{ "border-color": active() ? "var(--ui-app-accent-border)" : undefined }}>
                    <a
                      href={noteHref(note())}
                      class="block p-3 pr-10 no-underline"
                      onClick={(event) => {
                        event.preventDefault();
                        setActiveNoteId(note().id);
                        void navigateToNotebookNote(noteHref(note()));
                      }}
                    >
                      <div class="min-w-0">
                        <p class="flex min-w-0 items-center gap-2 truncate text-sm font-semibold text-primary">
                          <i
                            class={`ti ${selectedNoteRootId() ? "ti-folder" : "ti-home"} shrink-0 text-sm text-zinc-500 dark:text-zinc-400`}
                          />
                          <span class={`min-w-0 truncate ${active() ? "app-accent-text" : "text-dimmed dark:text-primary"}`}>
                            {note().title || t().untitled}
                          </span>
                          <Show when={note().lockedAt}>
                            <i class="ti ti-lock shrink-0 text-xs text-amber-500" title={t().locked} />
                          </Show>
                        </p>
                      </div>
                    </a>
                    <div class="absolute right-2 top-2">
                      <Show when={props.canWrite}>
                        <Dropdown.Root position="bottom-right" width="12rem" items={noteActionItems(note(), actions, t())}>
                          <Dropdown.Trigger
                            iconOnly
                            label={t().noteActions({ title: note().title || t().untitled })}
                            size="xs"
                            class="opacity-70 group-hover:opacity-100"
                          >
                            <i class="ti ti-dots text-xs" />
                          </Dropdown.Trigger>
                        </Dropdown.Root>
                      </Show>
                    </div>
                  </div>
                );
              }}
            </Show>
            <For each={visibleNotes()}>
              {(note) => {
                const href = () => noteHref(note);
                const active = () => note.id === activeNoteId();
                const tags = () => noteTags(note).slice(0, 3);
                return (
                  <div class={noteCardClass(active())} style={{ "border-color": active() ? "var(--ui-app-accent-border)" : undefined }}>
                    <a
                      href={href()}
                      class="block p-3 pr-16 no-underline"
                      onClick={(event) => {
                        event.preventDefault();
                        setActiveNoteId(note.id);
                        void navigateToNotebookNote(href());
                      }}
                    >
                      <div class="min-w-0">
                        <p class="flex min-w-0 items-center gap-1.5 truncate text-xs font-semibold text-primary">
                          <span class={`min-w-0 truncate ${active() ? "app-accent-text" : "text-dimmed dark:text-primary"}`}>
                            {note.title || t().untitled}
                          </span>
                          <Show when={note.lockedAt}>
                            <i class="ti ti-lock shrink-0 text-xs text-amber-500" title={t().locked} />
                          </Show>
                        </p>
                        <Show when={plainPreview(note.contentMd)}>
                          <p class="mt-0.5 line-clamp-2 text-[11px] leading-snug text-dimmed">{plainPreview(note.contentMd)}</p>
                        </Show>
                      </div>
                      <div class="mt-2 flex items-center gap-1.5">
                        <For each={tags()}>
                          {(tag) => (
                            <span class="truncate rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                              #{tag}
                            </span>
                          )}
                        </For>
                        <span class="ml-auto shrink-0 text-[10px] text-dimmed">
                          {dates.formatDateTimeRelative(note.updatedAt, props.dateConfig)}
                        </span>
                      </div>
                    </a>
                    <div class="absolute right-2 top-2 flex items-center gap-0.5">
                      <IconButton
                        size="xs"
                        class={`opacity-70 group-hover:opacity-100 ${
                          favoriteIds().has(note.id) ? "!text-amber-500 hover:!text-amber-500" : ""
                        }`}
                        title={favoriteIds().has(note.id) ? t().removeFavorite : t().addFavorite}
                        label={favoriteIds().has(note.id) ? t().removeFavorite : t().addFavorite}
                        onClick={(event) => void toggleFavorite(note, event)}
                      >
                        <i class="ti ti-star" />
                      </IconButton>
                      <Show when={props.canWrite}>
                        <Dropdown.Root position="bottom-right" width="12rem" items={noteActionItems(note, actions, t())}>
                          <Dropdown.Trigger
                            iconOnly
                            label={t().noteActions({ title: note.title || t().untitled })}
                            size="xs"
                            class="opacity-70 group-hover:opacity-100"
                          >
                            <i class="ti ti-dots text-xs" />
                          </Dropdown.Trigger>
                        </Dropdown.Root>
                      </Show>
                    </div>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </ScrollArea>
    </div>
  );
}
