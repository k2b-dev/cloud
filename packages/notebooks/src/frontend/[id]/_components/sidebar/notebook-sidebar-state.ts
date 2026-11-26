import { useCloudIdCopy } from "@k2b/cloud/browser/cloud-id";
import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import { dates } from "@k2b/stdlib";
import { type AppWorkspaceNavTreeMove, createNavigation, type DropdownItem, type NavigationItem, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount } from "solid-js";
import { isServer } from "solid-js/web";
import { mayDeleteOrLockNotes } from "../../../../lib/note-delete-permission";
import { parseSidebarFilter, type SidebarFilter, withSidebarFilter } from "../../../../lib/sidebar-filter";
import type { SidebarListNote, SidebarNote, SidebarTreeSort } from "../../../../lib/sidebar-tree";
import { requestSoftNoteNavigation } from "../../../lib/soft-navigation";
import { buildAttachmentsUrl, buildGraphUrl, buildNoteUrl } from "../../../params";
import { notebookWorkspaceMessages } from "../../messages";
import {
  NOTE_SOFT_NAVIGATED_EVENT,
  OPEN_NOTEBOOK_SETTINGS_EVENT,
  type OpenNotebookSettingsEventDetail,
  SIDEBAR_FILTER_CHANGED_EVENT,
} from "../detail/events";
import { resolveSameNotebookNoteTarget } from "../editor/note-navigation";
import { openNoteSearchPrompt } from "../search/openNoteSearchPrompt";
import { openNotebookSettingsDialog } from "../settings/NotebookSettingsPanel";
import { writeSettings } from "../settings/NotebookSettingsStore";
import { showRestoredVersionNotice } from "../versions/restore-notice";
import { noteActionItems, noteIcon, useNoteActions } from "./NoteTree";
import { createNavigationHidden, followStoredNavigationHidden, NOTEBOOK_NAVIGATION_ID } from "./navigation-visibility";
import { createNotebookSwitcher } from "./notebook-switcher";
import type { NewNoteMenuChoice } from "./page-template-menu";
import type { NotebookContext } from "./types";
import { useFavoriteNotes } from "./useFavoriteNotes";
import { useNotebookWorkspaceState } from "./useNotebookWorkspaceState";

export type NotebookSidebarProps = {
  ctx: NotebookContext;
  /** The page's editor toolbar shows the navigation toggle, so the sidebar adds no control of its own. */
  editorToolbar?: boolean;
  /** The notebook page this sidebar stands beside, when it is one of the footer's items. */
  current?: "attachments" | "graph";
  /** The page Links returns to on Close when this page is not a note: its own address, or the graph's return page. */
  graphBack?: string;
};

/** The filter in the address; showing a hidden navigation mounts the sidebar again after the address may have changed. */
const currentFilter = (ctx: NotebookContext): SidebarFilter =>
  isServer ? ctx.sidebarFilter : parseSidebarFilter(new URLSearchParams(window.location.search));

const sameFilter = (left: SidebarFilter, right: SidebarFilter) => left.view === right.view && left.tag === right.tag;

/** The rows that load earlier or more notes are no places: a note dropped beside one lands beside the nearest note. */
export const withoutPagingRows = (move: AppWorkspaceNavTreeMove): AppWorkspaceNavTreeMove => {
  const note = (id: string | null) => (id && !id.includes(":") ? id : null);
  return { ...move, beforeId: note(move.beforeId), afterId: note(move.afterId) };
};

/**
 * Everything the notebook sidebar knows and does, apart from how it draws: the tree, the filtered list, the note menus,
 * new notes, settings, the filter in the address and the phone menu. The v1 sidebar and the v2 `NotebookNav` draw it.
 */
export function useNotebookSidebar(props: NotebookSidebarProps) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const [treeSort, setTreeSort] = createSignal<SidebarTreeSort>(props.ctx.settings.treeSort);
  const {
    notebook,
    tree,
    list,
    titleOf,
    favoriteNoteIds,
    selectedNoteId,
    tags,
    attachmentCount,
    pageTemplates,
    workspaceError,
    workspaceRefreshing,
    refreshWorkspace,
  } = useNotebookWorkspaceState(props.ctx, treeSort);
  const canWrite = props.ctx.permission === "write" || props.ctx.permission === "admin";
  const canDeleteOrLockNotes = () => mayDeleteOrLockNotes(props.ctx.permission, notebook().noteDeletePermission);
  // Writers rearrange the notebook order only where it is the order on screen.
  const orderable = () => canWrite && treeSort() === "title";
  const treeSortOptions = () => [
    { value: "title" as const, label: t().notebookOrderSort },
    { value: "updated" as const, label: t().updatedSort },
    { value: "created" as const, label: t().createdSort },
  ];
  // The server sorts every level, the homepage leading its own; another order reads the open levels from their start.
  const changeTreeSort = (value: SidebarTreeSort) => {
    setTreeSort(value);
    writeSettings(notebook().id, { treeSort: value });
    void tree.refresh(true).catch(() => undefined);
  };
  const attachmentsHref = () => buildAttachmentsUrl(notebook().id, props.ctx.presentationMode);
  // The graph starts from the open note and keeps the sidebar filter. It carries the page it opened from, so Close
  // returns there; while it shows, its footer item is the current page instead of that note.
  const graphHref = () => {
    const note = selectedNoteId();
    const back =
      props.graphBack ?? (note ? withSidebarFilter(buildNoteUrl(notebook().id, note, props.ctx.presentationMode), filter()) : undefined);
    return withSidebarFilter(buildGraphUrl(notebook().id, note, props.ctx.presentationMode, back), filter());
  };
  const currentNoteId = () => (props.current === "graph" ? null : selectedNoteId());
  const openSettings = (initialTab?: string) =>
    openNotebookSettingsDialog({
      initialTab,
      notebook: notebook(),
      isAdmin: props.ctx.permission === "admin",
      canWrite,
      dateConfig: props.ctx.dateConfig,
      host: () => document.getElementById(NOTEBOOK_NAVIGATION_ID) ?? document.documentElement,
    });
  const chooseNewNote = (choice: NewNoteMenuChoice) => {
    if (choice.type === "blank") actions.handleCreateNote();
    else if (choice.type === "template") actions.handleCreateFromTemplate(choice.template.id);
    else void openSettings("templates");
  };
  const navigationHidden = createNavigationHidden(props.ctx.navigationHidden);
  followStoredNavigationHidden(navigationHidden);

  // --- Filter -------------------------------------------------------------------------------------------------------

  const filter = list.filter;
  /** The address keeps the filter, so a reload, a shared link and the next note from the list show the same list. */
  const setFilter = (next: SidebarFilter) => {
    list.choose(next);
    const href = withSidebarFilter(`${window.location.pathname}${window.location.search}`, next);
    window.history.replaceState(window.history.state, "", `${href}${window.location.hash}`);
    window.dispatchEvent(new Event(SIDEBAR_FILTER_CHANGED_EVENT));
  };
  const toggleFilter = (view: "favorites" | "recents") => setFilter(filter().view === view ? {} : { view });
  onMount(() => {
    // The sidebar is the island on every view of a note, so it confirms a version restore wherever the note opens.
    const noteId = selectedNoteId();
    if (noteId) showRestoredVersionNotice({ notebookId: notebook().id, noteId, t: t() });
    const follow = (next: SidebarFilter) => {
      if (!sameFilter(next, filter())) list.follow(next);
    };
    // The editor announces another note before the history shows its address, so the event names that address.
    const onSoftNavigated = (event: Event) => {
      const { href } = (event as CustomEvent<{ href: string }>).detail;
      follow(parseSidebarFilter(new URL(href, window.location.href).searchParams));
    };
    const onPopState = () => follow(currentFilter(props.ctx));
    // The detail panel's "Manage access" opens the settings this sidebar owns.
    const onOpenSettings = (event: Event) => void openSettings((event as CustomEvent<OpenNotebookSettingsEventDetail>).detail?.tab);
    window.addEventListener(NOTE_SOFT_NAVIGATED_EVENT, onSoftNavigated);
    window.addEventListener("popstate", onPopState);
    window.addEventListener(OPEN_NOTEBOOK_SETTINGS_EVENT, onOpenSettings);
    onCleanup(() => {
      window.removeEventListener(NOTE_SOFT_NAVIGATED_EVENT, onSoftNavigated);
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener(OPEN_NOTEBOOK_SETTINGS_EVENT, onOpenSettings);
    });
  });

  const favorites = useFavoriteNotes({ notebookId: notebook().id, initialFavoriteNoteIds: () => [...favoriteNoteIds()] });
  // The list keeps the order it showed when the filter was chosen, so a live change never moves a row under the
  // pointer; choosing the filter again sorts it anew.
  const listedNotes = list.items;
  const filterLabel = () => {
    const current = filter();
    if (current.view === "favorites") return t().favorites;
    if (current.view === "recents") return t().recentlyChanged;
    return current.view === "tag" ? `#${current.tag}` : t().notes;
  };
  const tagFilter = () => {
    const current = filter();
    return current.view === "tag" ? current.tag : null;
  };
  const toggleTag = (tag: string) => setFilter(tagFilter() === tag ? {} : { view: "tag", tag });
  const listHref = (note: SidebarNote) => withSidebarFilter(buildNoteUrl(notebook().id, note.id, props.ctx.presentationMode), filter());
  /** Date and the first two tags under a listed note's title. */
  const listMeta = (note: SidebarListNote) =>
    [
      dates.formatDateTimeRelative(note.updatedAt, props.ctx.dateConfig),
      note.tags
        .slice(0, 2)
        .map((tag) => `#${tag}`)
        .join(" "),
    ]
      .filter(Boolean)
      .join(" · ");

  // --- Note menu ----------------------------------------------------------------------------------------------------

  const actions = useNoteActions(notebook().id, { onOrderChanged: () => void refreshWorkspace(), findNote: tree.findNote });
  const cloudId = useCloudIdCopy();
  /** Everyone keeps favorites and the Cloud ID; writers also get the note's actions, with arranging where the notebook order shows. */
  const noteMenu = (node: SidebarNote, level: SidebarNote[] | null): DropdownItem[] => {
    const favorite = favorites.favoriteNoteIds().has(node.id);
    const favoriteItem: DropdownItem = {
      icon: favorite ? "ti ti-star-off" : "ti ti-star",
      label: favorite ? t().removeFavorite : t().addFavorite,
      action: () => void favorites.toggleFavorite(node),
    };
    const cloudIdItems = cloudId.section({ type: "notebooks.note", id: node.id });
    if (!canWrite) return [favoriteItem, ...cloudIdItems];
    const [newSubnote, ...rest] = noteActionItems(
      node,
      actions,
      t(),
      canDeleteOrLockNotes(),
      level && orderable() ? { level, children: tree.level(node.id)?.items, homepageId: notebook().homepageNoteId } : undefined,
    );
    return [newSubnote!, favoriteItem, ...rest, ...cloudIdItems];
  };
  const listMenu = (id: string) => {
    const note = listedNotes().find((candidate) => candidate.id === id);
    return note ? noteMenu(note, null) : [];
  };

  // --- Phone menu ---------------------------------------------------------------------------------------------------

  const handleSameNotebookNoteNavigate = async (nav: LinkNavigateEvent) => {
    const target = resolveSameNotebookNoteTarget(nav.url.href, window.location.href, notebook().id)?.canonicalHref;
    if (!target) {
      nav.fallback();
      return;
    }

    if (`${window.location.pathname}${window.location.search}` === target) {
      nav.replaceWith(target);
      return;
    }

    const result = await requestSoftNoteNavigation(target, { push: false });
    if (result.kind === "fallback") {
      nav.fallback(target);
      return;
    }
    if (result.kind === "applied") nav.push(result.href);
  };

  const isHomepage = (node: SidebarNote) => node.id === notebook().homepageNoteId;
  /** Menu items flattened for the phone menu, where a note's actions are one list. */
  const phoneActions = (node: SidebarNote, level: SidebarNote[] | null): NavigationItem[] =>
    noteMenu(node, level)
      .flatMap((item) => ("items" in item ? item.items : [item]))
      .map((item) => ({
        // Labels are unique in a note's menu and fixed for the page, so a tap runs the action it showed even if the menu changed since.
        id: `note-action:${node.id}:${item.label}`,
        action: `note-action:${node.id}:${item.label}`,
        label: item.label,
        description: item.description,
        icon: item.icon,
        disabled: item.disabled || actions.loading(),
      }));
  /** One level of the phone menu as far as it is loaded, with the rows that load earlier or more notes. */
  const levelEntries = (parentId: string | null): NavigationItem[] => {
    const level = tree.level(parentId);
    const key = parentId ?? "";
    if (!level)
      return [{ id: `loading:${key}`, label: t().loadingNotes, icon: "ti ti-loader-2", disabled: true, action: `loading:${key}` }];
    const later = level.total - level.offset - level.items.length;
    return [
      ...(level.offset > 0
        ? [
            {
              id: `earlier:${key}`,
              label: t().earlierNotes({ count: level.offset }),
              icon: "ti ti-chevrons-up",
              action: `earlier:${key}`,
              keepOpen: true,
            },
          ]
        : []),
      ...level.items.map((child) => noteEntry(child, level.items)),
      ...(later > 0
        ? [
            {
              id: `more:${key}`,
              label: t().moreNotes({ count: later }),
              icon: "ti ti-chevrons-down",
              action: `more:${key}`,
              keepOpen: true,
            },
          ]
        : []),
    ];
  };
  const noteEntry = (node: SidebarNote, level: SidebarNote[] | null, description?: string): NavigationItem => ({
    id: `note:${node.id}`,
    label: titleOf(node) || t().untitled,
    description,
    icon: isHomepage(node) ? "ti ti-home" : node.lockedAt ? "ti ti-lock" : noteIcon(node, null),
    iconLabel: isHomepage(node) ? t().homepage : undefined,
    // The home icon takes the lock's place, so the homepage shows its lock at the row's end; the empty slot keeps the label in place.
    status: isHomepage(node) ? (node.lockedAt ? { icon: "ti ti-lock", label: t().locked } : null) : undefined,
    href: level ? buildNoteUrl(notebook().id, node.id, props.ctx.presentationMode) : listHref(node),
    active: currentNoteId() === node.id,
    children: level && node.hasChildren ? (tree.isExpanded(node.id) ? levelEntries(node.id) : [loadingEntry(node.id)]) : undefined,
    expanded: level && node.hasChildren ? tree.isExpanded(node.id) : undefined,
    actions: phoneActions(node, level),
  });
  // A closed branch holds one quiet row, so the menu offers to open it before its notes load.
  const loadingEntry = (parentId: string): NavigationItem => ({
    id: `loading:${parentId}`,
    label: t().loadingNotes,
    icon: "ti ti-loader-2",
    disabled: true,
    action: `loading:${parentId}`,
  });
  // Filters and the sort order change only what the menu shows, so the menu stays open to show the result.
  const filterEntries = (): NavigationItem[] => [
    {
      id: "filter:favorites",
      label: t().favorites,
      icon: "ti ti-star",
      action: "filter:favorites",
      keepOpen: true,
      active: filter().view === "favorites",
    },
    {
      id: "filter:recents",
      label: t().recent,
      icon: "ti ti-clock",
      action: "filter:recents",
      keepOpen: true,
      active: filter().view === "recents",
    },
    ...(tags().length > 0 || tagFilter()
      ? [
          {
            id: "filter:tags",
            label: t().tags,
            icon: "ti ti-hash",
            defaultExpanded: Boolean(tagFilter()),
            children: tags().map((tag) => ({
              id: `filter:tag:${tag.tag}`,
              label: tag.tag,
              icon: "ti ti-hash",
              badge: tag.count,
              action: `filter:tag:${tag.tag}`,
              keepOpen: true,
              active: tagFilter() === tag.tag,
            })),
          },
        ]
      : []),
  ];
  const switcher = createNotebookSwitcher(notebook, Boolean(props.ctx.userId));
  const mobileNavigation = createNavigation({
    switcher,
    items: () => [
      ...(canWrite
        ? [
            { id: "new", label: t().newNote, icon: "ti ti-pencil-plus", action: "new", disabled: actions.loading() },
            {
              id: "new-from-template",
              label: t().newFromTemplate,
              icon: "ti ti-template",
              defaultExpanded: false,
              children: pageTemplates().map((template) => ({
                id: `template:${template.id}`,
                label: template.name,
                icon: template.icon,
                action: `template:${template.id}`,
                disabled: actions.loading(),
              })),
            },
          ]
        : []),
      { id: "search", label: t().searchNotes, icon: "ti ti-search", action: "search" },
      ...filterEntries(),
      ...(workspaceError()
        ? [
            {
              id: "retry",
              label: t().retry,
              description: t().updateLoadFailed,
              icon: "ti ti-refresh",
              action: "retry",
              disabled: workspaceRefreshing(),
            },
          ]
        : []),
      filter().view
        ? {
            id: "filtered",
            label: `${filterLabel()} · ${t().noteCount({ count: list.total() })}`,
            section: true,
            children: [
              { id: "filter:clear", label: t().clearFilter, icon: "ti ti-x", action: "filter:clear", keepOpen: true },
              ...listedNotes().map((note) => noteEntry(note, null, listMeta(note))),
              ...(list.hasMore()
                ? [
                    {
                      id: "list:more",
                      label: t().moreNotes({ count: list.total() - listedNotes().length }),
                      icon: "ti ti-chevrons-down",
                      action: "list:more",
                      keepOpen: true,
                    },
                  ]
                : []),
            ],
          }
        : {
            id: "notes",
            label: t().notes,
            section: true,
            children: [
              {
                id: "sort",
                label: t().sortNotes,
                icon: "ti ti-arrows-sort",
                defaultExpanded: false,
                children: treeSortOptions().map((option) => ({
                  id: `sort:${option.value}`,
                  label: option.label,
                  action: `sort:${option.value}`,
                  keepOpen: true,
                  active: treeSort() === option.value,
                })),
              },
              ...levelEntries(null),
            ],
          },
      { id: "graph", label: t().noteLinks, icon: "ti ti-affiliate", href: graphHref(), active: props.current === "graph" },
      {
        id: "attachments",
        label: t().attachments,
        icon: "ti ti-paperclip",
        href: attachmentsHref(),
        badge: attachmentCount(),
        active: props.current === "attachments",
      },
      { id: "settings", label: t().settings, icon: "ti ti-settings", action: "settings" },
    ],
    onNavigate: handleSameNotebookNoteNavigate,
    onExpandedChange: (id, expanded) => {
      if (id.startsWith("note:")) tree.setOpen(id.slice(5), expanded);
    },
    onAction: async (action) => {
      if (action === "new") {
        actions.handleCreateNote();
        return;
      }
      if (action.startsWith("template:")) {
        actions.handleCreateFromTemplate(action.slice(9));
        return;
      }
      if (action === "retry") {
        await refreshWorkspace();
        return;
      }
      if (action === "settings") {
        await openSettings();
        return;
      }
      if (action === "search") {
        openNoteSearchPrompt(notebook().id, notebook().name);
        return;
      }
      if (action === "filter:favorites" || action === "filter:recents") {
        toggleFilter(action === "filter:favorites" ? "favorites" : "recents");
        return;
      }
      if (action === "filter:clear") {
        setFilter({});
        return;
      }
      if (action.startsWith("filter:tag:")) {
        toggleTag(action.slice(11));
        return;
      }
      if (action.startsWith("sort:")) {
        const option = treeSortOptions().find((option) => `sort:${option.value}` === action);
        if (option) changeTreeSort(option.value);
        return;
      }
      if (action.startsWith("more:") || action.startsWith("earlier:")) {
        const parentId = action.slice(action.indexOf(":") + 1) || null;
        await (action.startsWith("more:") ? tree.showMore(parentId) : tree.showEarlier(parentId)).catch(() => undefined);
        return;
      }
      if (action === "list:more") {
        await list.showMore();
        return;
      }
      if (action.startsWith("note-action:")) {
        const rest = action.slice(12);
        const index = rest.indexOf(":");
        const id = rest.slice(0, index);
        const found = filter().view ? undefined : tree.findNote(id);
        const node = found ?? listedNotes().find((note) => note.id === id);
        const item =
          node &&
          noteMenu(node, found ? (tree.level(found.parentId)?.items ?? null) : null)
            .flatMap((entry) => ("items" in entry ? entry.items : [entry]))
            .find((entry) => entry.label === rest.slice(index + 1));
        if (item && !item.disabled && "action" in item) item.action?.();
      }
    },
  });

  return {
    t,
    notebook,
    tree,
    list,
    titleOf,
    tags,
    attachmentCount,
    pageTemplates,
    workspaceError,
    workspaceRefreshing,
    refreshWorkspace,
    treeSort,
    treeSortOptions,
    changeTreeSort,
    canWrite,
    orderable,
    attachmentsHref,
    graphHref,
    currentNoteId,
    presentationMode: props.ctx.presentationMode,
    openSettings,
    chooseNewNote,
    navigationHidden,
    filter,
    setFilter,
    toggleFilter,
    listedNotes,
    filterLabel,
    tagFilter,
    toggleTag,
    listHref,
    listMeta,
    actions,
    noteMenu,
    listMenu,
    isHomepage,
    switcher,
    mobileNavigation,
  };
}
