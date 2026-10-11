import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import { dates } from "@k2b/stdlib";
import {
  AppWorkspace,
  Button,
  createNavigation,
  Dropdown,
  type DropdownItem,
  IconButton,
  IconButtonLink,
  type NavigationItem,
  NoticeCard,
  Placeholder,
  SelectChip,
  Tooltip,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js";
import { isServer } from "solid-js/web";
import { mayDeleteOrLockNotes } from "../../../../lib/note-delete-permission";
import { parseSidebarFilter, type SidebarFilter, withSidebarFilter } from "../../../../lib/sidebar-filter";
import { requestSoftNoteNavigation } from "../../../lib/soft-navigation";
import { extractTags } from "../../../lib/tag-extract";
import { buildAttachmentsUrl, buildNoteUrl } from "../../../params";
import { notebookWorkspaceMessages } from "../../messages";
import { NOTE_SOFT_NAVIGATED_EVENT } from "../detail/events";
import { resolveSameNotebookNoteTarget } from "../editor/note-navigation";
import { openNoteSearchPrompt } from "../search/openNoteSearchPrompt";
import NotebookSettingsButton from "../settings/NotebookSettingsButton";
import { openNotebookSettingsDialog } from "../settings/NotebookSettingsPanel";
import { writeSettings } from "../settings/NotebookSettingsStore";
import NavigationVisibilityControls from "./NavigationVisibilityControls";
import NotebookSwitcher from "./NotebookSwitcher";
import NoteTree, { findNoteInLevel, noteActionItems, noteIcon, placementForMove, useNoteActions } from "./NoteTree";
import { createNavigationHidden, followStoredNavigationHidden, NOTEBOOK_NAVIGATION_ID, setNavigationHidden } from "./navigation-visibility";
import { NoteRowLabel, NoteRowMenu, NoteRowsContextMenu } from "./note-rows";
import { filterNotes, homepageFirst, type NoteTreeSort, sortNoteTree } from "./tree-utils";
import type { NotebookContext, NoteTreeNode } from "./types";
import { useFavoriteNotes } from "./useFavoriteNotes";
import { useNotebookWorkspaceState } from "./useNotebookWorkspaceState";

type Props = {
  ctx: NotebookContext;
  /** The page's editor toolbar shows the navigation toggle, so the sidebar adds no control of its own. */
  editorToolbar?: boolean;
};

/** The filter in the address; showing a hidden navigation mounts the sidebar again after the address may have changed. */
const currentFilter = (ctx: NotebookContext): SidebarFilter =>
  isServer ? ctx.sidebarFilter : parseSidebarFilter(new URLSearchParams(window.location.search));

const sameFilter = (left: SidebarFilter, right: SidebarFilter) => left.view === right.view && left.tag === right.tag;

/**
 * The notebook's one sidebar: the notebook name, search, quick filters for favorites, recent notes and tags, and the
 * note tree. A filter turns the tree into a list with dates and tags, newest first. On phones the same content is
 * Cloud's navigation menu.
 */
export default function NotebookSidebar(props: Props) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const {
    notebook,
    noteTree,
    favoriteNoteIds,
    selectedNoteId,
    tags,
    attachmentCount,
    workspaceError,
    workspaceRefreshing,
    refreshWorkspace,
  } = useNotebookWorkspaceState(props.ctx);
  const canWrite = props.ctx.permission === "write" || props.ctx.permission === "admin";
  const canDeleteOrLockNotes = () => mayDeleteOrLockNotes(props.ctx.permission, notebook().noteDeletePermission);
  const [treeSort, setTreeSort] = createSignal<NoteTreeSort>(props.ctx.settings.treeSort);
  // Like the start page of a Book, the homepage leads its own level whatever the sort order.
  const sortedTree = createMemo(() => homepageFirst(sortNoteTree(noteTree(), treeSort(), locale()), notebook().homepageNoteId));
  // Writers rearrange the notebook order only where it is the order on screen.
  const orderable = () => canWrite && treeSort() === "title";
  const treeSortOptions = () => [
    { value: "title" as const, label: t().notebookOrderSort },
    { value: "updated" as const, label: t().updatedSort },
    { value: "created" as const, label: t().createdSort },
  ];
  const changeTreeSort = (value: NoteTreeSort) => {
    setTreeSort(value);
    writeSettings(notebook().id, { treeSort: value });
  };
  const attachmentsHref = () => buildAttachmentsUrl(notebook().id, props.ctx.presentationMode);
  const navigationHidden = createNavigationHidden(props.ctx.navigationHidden);
  followStoredNavigationHidden(navigationHidden);

  // --- Filter -------------------------------------------------------------------------------------------------------

  const [filter, setFilterState] = createSignal<SidebarFilter>(currentFilter(props.ctx));
  /** The address keeps the filter, so a reload, a shared link and the next note from the list show the same list. */
  const setFilter = (next: SidebarFilter) => {
    setFilterState(next);
    const href = withSidebarFilter(`${window.location.pathname}${window.location.search}`, next);
    window.history.replaceState(window.history.state, "", `${href}${window.location.hash}`);
  };
  const toggleFilter = (view: "favorites" | "recents") => setFilter(filter().view === view ? {} : { view });
  onMount(() => {
    const follow = (next: SidebarFilter) => {
      if (!sameFilter(next, filter())) setFilterState(next);
    };
    // The editor announces another note before the history shows its address, so the event names that address.
    const onSoftNavigated = (event: Event) => {
      const { href } = (event as CustomEvent<{ href: string }>).detail;
      follow(parseSidebarFilter(new URL(href, window.location.href).searchParams));
    };
    const onPopState = () => follow(currentFilter(props.ctx));
    window.addEventListener(NOTE_SOFT_NAVIGATED_EVENT, onSoftNavigated);
    window.addEventListener("popstate", onPopState);
    onCleanup(() => {
      window.removeEventListener(NOTE_SOFT_NAVIGATED_EVENT, onSoftNavigated);
      window.removeEventListener("popstate", onPopState);
    });
  });

  const favorites = useFavoriteNotes({ notebookId: notebook().id, initialFavoriteNoteIds: () => [...favoriteNoteIds()] });
  // The order on screen, taken when a filter is chosen or the page loads, so a live change never moves a row under the
  // pointer; choosing the filter again sorts the list anew.
  const listOrder = createMemo(() => {
    const current = filter();
    return untrack(() => filterNotes(noteTree(), current, favorites.favoriteNoteIds()).map((note) => note.id));
  });
  const listedNotes = createMemo(() => filterNotes(noteTree(), filter(), favorites.favoriteNoteIds(), listOrder()));
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
  const listHref = (note: NoteTreeNode) => withSidebarFilter(buildNoteUrl(notebook().id, note.id, props.ctx.presentationMode), filter());
  /** Date and the first two tags under a listed note's title. */
  const listMeta = (note: NoteTreeNode) =>
    [
      dates.formatDateTimeRelative(note.updatedAt, props.ctx.dateConfig),
      extractTags(note.contentMd)
        .slice(0, 2)
        .map((tag) => `#${tag}`)
        .join(" "),
    ]
      .filter(Boolean)
      .join(" · ");

  // --- Note menu ----------------------------------------------------------------------------------------------------

  const actions = useNoteActions(notebook().id, noteTree, { onOrderChanged: () => void refreshWorkspace() });
  /** Everyone keeps favorites; writers also get the note's actions, with arranging where the notebook order shows. */
  const noteMenu = (node: NoteTreeNode, level: NoteTreeNode[] | null): DropdownItem[] => {
    const favorite = favorites.favoriteNoteIds().has(node.id);
    const favoriteItem: DropdownItem = {
      icon: favorite ? "ti ti-star-off" : "ti ti-star",
      label: favorite ? t().removeFavorite : t().addFavorite,
      action: () => void favorites.toggleFavorite(node),
    };
    if (!canWrite) return [favoriteItem];
    const [newSubnote, ...rest] = noteActionItems(
      node,
      actions,
      t(),
      canDeleteOrLockNotes(),
      level && orderable() ? { level, homepageId: notebook().homepageNoteId } : undefined,
    );
    return [newSubnote!, favoriteItem, ...rest];
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

  const isHomepage = (node: NoteTreeNode) => node.id === notebook().homepageNoteId;
  /** Menu items flattened for the phone menu, where a note's actions are one list. */
  const phoneActions = (node: NoteTreeNode, level: NoteTreeNode[] | null): NavigationItem[] =>
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
  const noteEntry = (node: NoteTreeNode, level: NoteTreeNode[] | null, description?: string): NavigationItem => ({
    id: `note:${node.id}`,
    label: node.title || t().untitled,
    description,
    icon: isHomepage(node) ? "ti ti-home" : node.lockedAt ? "ti ti-lock" : noteIcon(node, null),
    iconLabel: isHomepage(node) ? t().homepage : undefined,
    // The home icon takes the lock's place, so the homepage shows its lock at the row's end; the empty slot keeps the label in place.
    status: isHomepage(node) ? (node.lockedAt ? { icon: "ti ti-lock", label: t().locked } : null) : undefined,
    href: level ? buildNoteUrl(notebook().id, node.id, props.ctx.presentationMode) : listHref(node),
    active: selectedNoteId() === node.id,
    children: level ? node.children.map((child) => noteEntry(child, node.children)) : undefined,
    actions: phoneActions(node, level),
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
  const mobileNavigation = createNavigation({
    items: () => [
      ...(canWrite ? [{ id: "new", label: t().newNote, icon: "ti ti-pencil-plus", action: "new", disabled: actions.loading() }] : []),
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
            label: `${filterLabel()} · ${t().noteCount({ count: listedNotes().length })}`,
            section: true,
            children: [
              { id: "filter:clear", label: t().clearFilter, icon: "ti ti-x", action: "filter:clear", keepOpen: true },
              ...listedNotes().map((note) => noteEntry(note, null, listMeta(note))),
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
              ...sortedTree().map((node) => noteEntry(node, sortedTree())),
            ],
          },
      { id: "all", label: t().allNotebooks, icon: "ti ti-library", href: "/app/notebooks" },
      { id: "attachments", label: t().attachments, icon: "ti ti-paperclip", href: attachmentsHref(), badge: attachmentCount() },
      { id: "settings", label: t().settings, icon: "ti ti-settings", action: "settings" },
    ],
    onNavigate: handleSameNotebookNoteNavigate,
    onAction: async (action) => {
      if (action === "new") {
        actions.handleCreateNote();
        return;
      }
      if (action === "retry") {
        await refreshWorkspace();
        return;
      }
      if (action === "settings") {
        await openNotebookSettingsDialog({
          notebook: notebook(),
          tree: noteTree(),
          isAdmin: props.ctx.permission === "admin",
          canWrite,
          dateConfig: props.ctx.dateConfig,
        });
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
      if (action.startsWith("note-action:")) {
        const rest = action.slice(12);
        const index = rest.indexOf(":");
        const id = rest.slice(0, index);
        const found = filter().view ? null : findNoteInLevel(sortedTree(), id);
        const node = found?.node ?? listedNotes().find((note) => note.id === id);
        const item =
          node &&
          noteMenu(node, found?.level ?? null)
            .flatMap((entry) => ("items" in entry ? entry.items : [entry]))
            .find((entry) => entry.label === rest.slice(index + 1));
        if (item && !item.disabled && "action" in item) item.action?.();
      }
    },
  });

  // --- Desktop ------------------------------------------------------------------------------------------------------

  return (
    <>
      <WorkspaceNavigationProvider navigation={mobileNavigation} label={notebook().name} />
      <AppWorkspace.Sidebar
        id={NOTEBOOK_NAVIGATION_ID}
        class="notebook-sidebar"
        label={t().navigation}
        resizable
        defaultSize={256}
        hidden={navigationHidden()}
        onHiddenChange={setNavigationHidden}
      >
        <AppWorkspace.SidebarDesktop>
          <div class="notebook-sidebar-head">
            <NotebookSwitcher notebook={notebook()} />
            <Show when={canWrite}>
              <IconButton
                label={t().newNote}
                tooltip={t().newNoteShortcut}
                onClick={() => actions.handleCreateNote()}
                disabled={actions.loading()}
                loading={actions.loading()}
                loadingLabel={t().creatingNote}
              >
                <i class="ti ti-pencil-plus" />
              </IconButton>
            </Show>
          </div>

          <Button
            variant="input"
            align="start"
            class="notebook-sidebar-search"
            onClick={() => openNoteSearchPrompt(notebook().id, notebook().name)}
          >
            <i class="ti ti-search" aria-hidden="true" />
            <span>{t().searchNotes}</span>
          </Button>

          <div class="notebook-sidebar-chips">
            <Button
              size="xs"
              variant="subtle"
              class="notebook-sidebar-chip"
              aria-pressed={filter().view === "favorites"}
              onClick={() => toggleFilter("favorites")}
            >
              <i class="ti ti-star" aria-hidden="true" />
              <span>{t().favorites}</span>
            </Button>
            <Button
              size="xs"
              variant="subtle"
              class="notebook-sidebar-chip"
              aria-pressed={filter().view === "recents"}
              onClick={() => toggleFilter("recents")}
            >
              <i class="ti ti-clock" aria-hidden="true" />
              <span>{t().recent}</span>
            </Button>
            <Show when={tags().length > 0 || tagFilter()}>
              <Dropdown.Root
                position="bottom-left"
                label={t().tags}
                items={[
                  {
                    sectionLabel: t().tags,
                    items: tags().map((tag) => ({
                      icon: "ti ti-hash",
                      label: tag.tag,
                      description: t().noteCount({ count: tag.count }),
                      choice: "radio" as const,
                      checked: tagFilter() === tag.tag,
                      action: () => toggleTag(tag.tag),
                    })),
                  },
                ]}
              >
                <Dropdown.Trigger
                  size="xs"
                  variant="subtle"
                  class="notebook-sidebar-chip"
                  label={tagFilter() ? t().tagFilter({ tag: tagFilter()! }) : t().tags}
                  aria-current={tagFilter() ? "true" : undefined}
                >
                  <i class="ti ti-hash" aria-hidden="true" />
                  <span>{tagFilter() ?? t().tags}</span>
                  <i class="ti ti-chevron-down notebook-sidebar-chip__chevron" aria-hidden="true" />
                </Dropdown.Trigger>
              </Dropdown.Root>
            </Show>
          </div>

          <Show when={workspaceError()}>
            <NoticeCard role="alert" tone="danger" title={t().updateLoadFailed}>
              <Button variant="secondary" size="xs" loading={workspaceRefreshing()} onClick={() => void refreshWorkspace()}>
                {t().retry}
              </Button>
            </NoticeCard>
          </Show>

          <AppWorkspace.SidebarBody scrollPreserveKey={`notebooks-sidebar-${notebook().id}`}>
            <Show
              when={filter().view}
              fallback={
                <AppWorkspace.SidebarSection
                  title={t().notes}
                  class="min-h-0 flex-1"
                  actions={
                    <Tooltip.Anchor content={t().sortNotes}>
                      <SelectChip
                        aria-label={t().sortNotes}
                        value={treeSort()}
                        onValueChange={changeTreeSort}
                        icon="ti ti-arrows-sort"
                        iconOnly
                        size="xs"
                        options={treeSortOptions()}
                      />
                    </Tooltip.Anchor>
                  }
                >
                  <NoteTree
                    tree={sortedTree()}
                    notebookId={notebook().id}
                    selectedNoteId={selectedNoteId()}
                    presentationMode={props.ctx.presentationMode}
                    homepageId={notebook().homepageNoteId}
                    onMove={orderable() ? (move) => actions.handlePlace(move.id, placementForMove(move)) : undefined}
                    noteMenu={noteMenu}
                  />
                </AppWorkspace.SidebarSection>
              }
            >
              <div class="notebook-sidebar-filter">
                <span class="notebook-sidebar-filter__label">
                  {filterLabel()} <small>{t().noteCount({ count: listedNotes().length })}</small>
                </span>
                <IconButton size="xs" label={t().clearFilter} tooltip={t().clearFilter} onClick={() => setFilter({})}>
                  <i class="ti ti-x" />
                </IconButton>
              </div>
              <Show
                when={listedNotes().length > 0}
                fallback={
                  <Placeholder
                    variant="inline"
                    align="left"
                    icon={filter().view === "favorites" ? "ti ti-star" : "ti ti-file-text"}
                    description={filter().view === "favorites" ? t().noFavorites : t().noNotesHere}
                  />
                }
              >
                <NoteRowsContextMenu menu={listMenu}>
                  <AppWorkspace.NavTree ariaLabel={filterLabel()} selectedId={selectedNoteId()}>
                    <For each={listedNotes()}>
                      {(note) => (
                        <AppWorkspace.NavTree.Item
                          id={note.id}
                          label={<NoteRowLabel note={note} />}
                          description={listMeta(note)}
                          icon={isHomepage(note) ? "ti ti-home" : "ti ti-file-text"}
                          iconLabel={isHomepage(note) ? t().homepage : undefined}
                          href={listHref(note)}
                          navigation="document"
                          actions={<NoteRowMenu note={note} items={noteMenu(note, null)} />}
                        />
                      )}
                    </For>
                  </AppWorkspace.NavTree>
                </NoteRowsContextMenu>
              </Show>
            </Show>
          </AppWorkspace.SidebarBody>

          <AppWorkspace.SidebarFooter>
            {/* The start of the footer stays free for who is in the notebook. */}
            <div class="notebook-sidebar-foot">
              <IconButtonLink href={attachmentsHref()} label={t().attachments} tooltip={t().attachmentCount({ count: attachmentCount() })}>
                <i class="ti ti-paperclip" />
              </IconButtonLink>
              <NotebookSettingsButton
                notebook={notebook()}
                tree={noteTree()}
                permission={props.ctx.permission}
                dateConfig={props.ctx.dateConfig}
              />
            </div>
          </AppWorkspace.SidebarFooter>
        </AppWorkspace.SidebarDesktop>
      </AppWorkspace.Sidebar>
      {/* Views without the editor toolbar, such as an empty notebook, Read-only or
          the attachments, still need a visible way back. */}
      <NavigationVisibilityControls hidden={navigationHidden()} showControl={!props.editorToolbar} />
    </>
  );
}
