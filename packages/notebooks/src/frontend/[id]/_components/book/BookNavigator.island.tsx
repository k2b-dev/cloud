import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { AppWorkspace, Button, createNavigation, type NavigationItem, NoticeCard, Placeholder, useLocale } from "@k2b/ui";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { withPresentationMode } from "../../../../lib/presentation-url";
import type { SidebarTreeState } from "../../../../lib/sidebar-tree";
import { buildGraphUrl, buildNoteUrl, buildTagPageUrl } from "../../../params";
import { notebookWorkspaceMessages } from "../../messages";
import NavigationVisibilityControls from "../sidebar/NavigationVisibilityControls";
import { focusTreeRow } from "../sidebar/NoteTree";
import {
  createNavigationHidden,
  followStoredNavigationHidden,
  NOTEBOOK_NAVIGATION_ID,
  setNavigationHidden,
} from "../sidebar/navigation-visibility";
import { createNotebookSwitcher } from "../sidebar/notebook-switcher";
import { createSidebarTree, type SidebarTree } from "../sidebar/sidebar-tree";
import { WORKSPACE_EVENT, type WorkspaceEventDetail } from "../sidebar/workspace-events";
import { BOOK_SNAPSHOT_EVENT, type BookMetadata, requestBookNavigation } from "./book-state";
import { bookMessages } from "./messages";

export type BookTreeNode = { id: string; title: string; children: BookTreeNode[] };
export type BookNavigatorProps = {
  userId?: string;
  notebookId: string;
  notebookName: string;
  notebookIcon: string | null;
  selectedNoteId: string | null;
  /** The levels of the reading order on arrival: the way to the open page and its own sub-pages. */
  navigation: SidebarTreeState;
  tags: { tag: string; count: number }[];
  activeTag?: string;
  /** The current Book address; Write keeps its query (sidebar filters) and only switches the mode. */
  currentHref: string;
  canWrite?: boolean;
  locked?: boolean;
  /** The notebook navigation preference: a hidden contents list renders no page titles at all. */
  navigationHidden: boolean;
  /** The Book page this navigation stands beside, when it is its footer item; the open note then is not the current page. */
  current?: "graph";
  /** While the graph shows: the page it opened from, which its Links item keeps. */
  graphBack?: string;
};

/**
 * One level of the reading order as far as it is loaded, with rows that load earlier or more pages. A branch that has
 * not loaded yet says so in its place.
 */
function BookTreeLevel(props: { parentId: string | null; tree: SidebarTree; notebookId: string }) {
  const locale = useLocale();
  const t = () => bookMessages.resolve([locale()]).t;
  const level = () => props.tree.level(props.parentId);
  const items = () => level()?.items ?? [];
  const key = () => props.parentId ?? "";
  const later = () => {
    const loaded = level();
    return loaded ? loaded.total - loaded.offset - loaded.items.length : 0;
  };
  return (
    <Show
      when={level()}
      fallback={<AppWorkspace.NavTree.Item id={`loading:${key()}`} label={t().loadingPages} icon="ti ti-loader-2 animate-spin" disabled />}
    >
      <Show when={(level()?.offset ?? 0) > 0}>
        <AppWorkspace.NavTree.Item
          id={`earlier:${key()}`}
          label={t().earlierPages({ count: level()!.offset })}
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
            label={node.title}
            icon="ti ti-file-text"
            href={withPresentationMode(buildNoteUrl(props.notebookId, node.id), "book")}
            hasChildren={node.hasChildren}
          >
            <Show when={node.hasChildren && props.tree.isExpanded(node.id)}>
              <BookTreeLevel parentId={node.id} tree={props.tree} notebookId={props.notebookId} />
            </Show>
          </AppWorkspace.NavTree.Item>
        )}
      </For>
      <Show when={later() > 0}>
        <AppWorkspace.NavTree.Item
          id={`more:${key()}`}
          label={t().morePages({ count: later() })}
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

/** Reading navigation deliberately has no dependency on the editor or inspector. */
export default function BookNavigator(props: BookNavigatorProps) {
  const locale = useLocale();
  const t = () => bookMessages.resolve([locale()]).t;
  const workspaceText = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const [state, setState] = createSignal(props);
  // The reading order a level at a time, as the workspace sidebar loads it.
  const tree = createSidebarTree({ notebookId: () => props.notebookId, initial: props.navigation, sort: () => "title", book: true });
  // Book view's contents list is the notebook navigation and follows the same hidden preference.
  const navigationHidden = createNavigationHidden(props.navigationHidden);
  followStoredNavigationHidden(navigationHidden);
  // A page load also unfolds the open note, so its sub-notes stay reachable before or without JavaScript.
  // After that, folding belongs to the reader: opening another note only reveals it, and its own
  // sub-notes and every later snapshot of the same note (live refreshes) leave the folds as they are.
  onMount(() => {
    const update = (event: Event) => {
      const next = (event as CustomEvent<BookMetadata>).detail;
      const opened = next.selectedNoteId !== state().selectedNoteId;
      setState({ ...props, ...next, activeTag: next.activeTag, currentHref: next.href });
      if (opened && next.selectedNoteId) void tree.reveal(next.selectedNoteId).catch(() => undefined);
    };
    // A change in the notebook reads the open levels again; the article refreshes on its own.
    const onWorkspaceEvent = (raw: Event) => {
      const detail = (raw as CustomEvent<WorkspaceEventDetail>).detail;
      if (detail.event.notebookId !== props.notebookId) return;
      if (detail.event.type === "note.comments.changed" || detail.event.type === "note.favorite.changed") return;
      detail.cover(tree.refresh());
    };
    window.addEventListener(BOOK_SNAPSHOT_EVENT, update);
    window.addEventListener(WORKSPACE_EVENT, onWorkspaceEvent);
    onCleanup(() => {
      window.removeEventListener(BOOK_SNAPSHOT_EVENT, update);
      window.removeEventListener(WORKSPACE_EVENT, onWorkspaceEvent);
    });
  });
  // The graph starts from the open note and keeps Book, so its links lead into Book; Close returns to the page it opened from.
  const graphHref = () =>
    buildGraphUrl(props.notebookId, state().selectedNoteId, "book", props.current === "graph" ? props.graphBack : state().currentHref);
  const currentNoteId = () => (props.current === "graph" ? null : state().selectedNoteId);
  // A writer leaves Book from the top of the navigation: an unlocked note opens in Write, the
  // same target as the floating edit button; without a note or with a locked one, the read-only workspace.
  // Both entries fill the same slot, so switching between them never moves the contents list.
  const workspaceEntry = () => {
    const current = state();
    if (!current.canWrite) return null;
    if (current.selectedNoteId && !current.locked)
      return { label: t().write, icon: "ti ti-pencil", href: withPresentationMode(current.currentHref, "write") };
    return {
      label: t().openWorkspace,
      icon: "ti ti-layout-sidebar",
      href: withPresentationMode(
        current.selectedNoteId ? buildNoteUrl(props.notebookId, current.selectedNoteId) : `/app/notebooks/${props.notebookId}`,
        "readonly",
      ),
    };
  };
  const navigation = () => (
    <>
      <Show when={workspaceEntry()}>
        {(entry) => (
          <AppWorkspace.SidebarItem href={entry().href} icon={entry().icon}>
            {entry().label}
          </AppWorkspace.SidebarItem>
        )}
      </Show>
      <AppWorkspace.SidebarSection title={t().notes}>
        {/* A level that could not load says so, and Retry reads every open level again. */}
        <Show when={tree.error()}>
          <NoticeCard role="alert" tone="danger" title={t().navigationFailed}>
            <Button variant="secondary" size="xs" onClick={() => void tree.refresh().catch(() => undefined)}>
              {t().retry}
            </Button>
          </NoticeCard>
        </Show>
        <Show
          when={(tree.level(null)?.total ?? 0) > 0}
          fallback={<Placeholder variant="inline" align="left" icon="ti ti-file-text" description={t().empty} />}
        >
          <AppWorkspace.NavTree
            ariaLabel={t().notes}
            selectedId={currentNoteId()}
            expandedIds={tree.expandedIds()}
            onExpandedIdsChange={(ids) => {
              const next = new Set(ids);
              const current = new Set(tree.expandedIds());
              for (const id of next) if (!current.has(id)) tree.setOpen(id, true);
              for (const id of current) if (!next.has(id)) tree.setOpen(id, false);
            }}
          >
            <BookTreeLevel parentId={null} tree={tree} notebookId={props.notebookId} />
          </AppWorkspace.NavTree>
        </Show>
      </AppWorkspace.SidebarSection>
      {state().tags.length > 0 && (
        <AppWorkspace.SidebarSection title={t().tags}>
          <For each={state().tags}>
            {(item) => (
              <AppWorkspace.SidebarItem
                href={withPresentationMode(buildTagPageUrl(props.notebookId, item.tag), "book")}
                active={state().activeTag === item.tag}
                icon="ti ti-hash"
                meta={item.count}
              >
                {item.tag}
              </AppWorkspace.SidebarItem>
            )}
          </For>
        </AppWorkspace.SidebarSection>
      )}
    </>
  );
  // Reading pages open in the reading shell, so this island and the reader's folds outlive the sheet.
  // An action keeps that request outside the link's view transition; modified clicks still use the URL.
  const readingPage = (href: string) => ({ href, action: `open:${href}` });
  const openReadingPage = (href: string) => {
    if (!requestBookNavigation(href)) window.location.assign(href);
  };
  /** One level of the phone sheet as far as it is loaded, with the rows that load earlier or more pages. */
  const levelEntries = (parentId: string | null): NavigationItem[] => {
    const level = tree.level(parentId);
    const key = parentId ?? "";
    const text = t();
    if (!level)
      return [{ id: `loading:${key}`, label: text.loadingPages, icon: "ti ti-loader-2", disabled: true, action: `loading:${key}` }];
    const later = level.total - level.offset - level.items.length;
    return [
      ...(level.offset > 0
        ? [
            {
              id: `earlier:${key}`,
              label: text.earlierPages({ count: level.offset }),
              icon: "ti ti-chevrons-up",
              action: `earlier:${key}`,
              keepOpen: true,
            },
          ]
        : []),
      ...level.items.map((node) => noteEntry(node)),
      ...(later > 0
        ? [
            {
              id: `more:${key}`,
              label: text.morePages({ count: later }),
              icon: "ti ti-chevrons-down",
              action: `more:${key}`,
              keepOpen: true,
            },
          ]
        : []),
    ];
  };
  const noteEntry = (node: { id: string; title: string; hasChildren: boolean }): NavigationItem => ({
    id: `note:${node.id}`,
    label: node.title,
    icon: "ti ti-file-text",
    ...readingPage(withPresentationMode(buildNoteUrl(props.notebookId, node.id), "book")),
    active: currentNoteId() === node.id,
    // The sheet shows the same folds as the sidebar tree and hands its toggles back to this island.
    expanded: node.hasChildren ? tree.isExpanded(node.id) : undefined,
    children: node.hasChildren
      ? tree.isExpanded(node.id)
        ? levelEntries(node.id)
        : [{ id: `loading:${node.id}`, label: t().loadingPages, icon: "ti ti-loader-2", disabled: true, action: `loading:${node.id}` }]
      : undefined,
  });
  const switcher = createNotebookSwitcher(
    () => ({ id: props.notebookId, name: state().notebookName, icon: props.notebookIcon }),
    Boolean(props.userId),
  );
  const mobileNavigation = createNavigation({
    switcher,
    items: () => [
      ...[workspaceEntry()].flatMap((entry) => (entry ? [{ id: "workspace", ...entry }] : [])),
      ...(tree.error()
        ? [{ id: "retry", label: t().retry, description: t().navigationFailed, icon: "ti ti-refresh", action: "retry" }]
        : []),
      { id: "notes", label: t().notes, children: levelEntries(null) },
      ...(state().tags.length
        ? [
            {
              id: "tags",
              label: t().tags,
              children: state().tags.map((item) => ({
                id: `tag:${item.tag}`,
                label: item.tag,
                icon: "ti ti-hash",
                badge: item.count,
                active: state().activeTag === item.tag,
                ...readingPage(withPresentationMode(buildTagPageUrl(props.notebookId, item.tag), "book")),
              })),
            },
          ]
        : []),
      { id: "graph", label: workspaceText().noteLinks, icon: "ti ti-affiliate", href: graphHref(), active: props.current === "graph" },
    ],
    onAction: async (action) => {
      if (action.startsWith("more:") || action.startsWith("earlier:")) {
        const parentId = action.slice(action.indexOf(":") + 1) || null;
        await (action.startsWith("more:") ? tree.showMore(parentId) : tree.showEarlier(parentId)).catch(() => undefined);
        return;
      }
      if (action === "retry") {
        await tree.refresh().catch(() => undefined);
        return;
      }
      if (action.startsWith("open:")) openReadingPage(action.slice("open:".length));
    },
    onExpandedChange: (id, open) => {
      if (id.startsWith("note:")) tree.setOpen(id.slice("note:".length), open);
    },
  });
  return (
    <>
      <WorkspaceNavigationProvider navigation={mobileNavigation} label={state().notebookName} />
      <AppWorkspace.Sidebar
        id={NOTEBOOK_NAVIGATION_ID}
        label={workspaceText().navigation}
        resizable
        hidden={navigationHidden()}
        onHiddenChange={setNavigationHidden}
      >
        <AppWorkspace.SidebarDesktop>
          <AppWorkspace.SidebarSwitcher {...switcher()} />
          <AppWorkspace.SidebarBody>{navigation()}</AppWorkspace.SidebarBody>
          {/* Marking the graph as the current page also names it, so the workspace head shows no way up beside it. */}
          <AppWorkspace.SidebarFooter class="notebook-sidebar-foot">
            <AppWorkspace.SidebarItem icon="ti ti-affiliate" href={graphHref()} active={props.current === "graph"}>
              {workspaceText().noteLinks}
            </AppWorkspace.SidebarItem>
          </AppWorkspace.SidebarFooter>
        </AppWorkspace.SidebarDesktop>
      </AppWorkspace.Sidebar>
      {/* Book view has no editor toolbar, so it offers the visible way back; the graph's own toolbar holds the toggle. */}
      <NavigationVisibilityControls hidden={navigationHidden()} showControl={props.current !== "graph"} />
    </>
  );
}
